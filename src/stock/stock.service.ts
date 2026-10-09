import { BadRequestException, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbTransaction } from '../database/database.module.js';
import { batches, skuValuations, stockBalances, stockLedger } from '../database/schema/index.js';
import {
  averageOf,
  fromMilli,
  issue as issueValuation,
  receive as receiveValuation,
  toMilli,
  type ValuationState,
} from './valuation.js';

type Movement = (typeof stockLedger.$inferInsert)['movement'];

export interface PostingContext {
  docType: string;
  docId: string;
  businessDate: string;
  userId: string;
}

interface Place {
  skuId: string;
  locationId: string;
  batchId: string | null;
  docLineId?: string | null;
}

/**
 * The only writer of stock_ledger, stock_balances and sku_valuations. Every call runs
 * inside the caller's posting transaction (docs/alur/README.md §2).
 */
@Injectable()
export class StockService {
  /**
   * Locks the valuation rows of these SKUs in id order (no deadlocks between two
   * cashiers) and returns their state. Call once per posting before any movement.
   */
  async lock(tx: DbTransaction, skuIds: string[]) {
    const ids = [...new Set(skuIds)].sort();
    const states = new Map<string, ValuationState>();
    if (ids.length === 0) return states;
    await tx
      .insert(skuValuations)
      .values(ids.map((skuId) => ({ skuId })))
      .onConflictDoNothing();
    const rows = await tx
      .select()
      .from(skuValuations)
      .where(inArray(skuValuations.skuId, ids))
      .orderBy(asc(skuValuations.skuId))
      .for('update');
    for (const r of rows) {
      states.set(r.skuId, { qty: toMilli(r.qty), value: r.value, lastAvgCost: r.lastAvgCost });
    }
    return states;
  }

  /** Goods in at a known value. Returns the negative-stock correction to journal (Dr HPP / Cr Persediaan). */
  async receive(
    tx: DbTransaction,
    ctx: PostingContext,
    states: Map<string, ValuationState>,
    place: Place,
    quantity: string,
    value: number,
    movement: Movement,
  ) {
    const state = this.stateOf(states, place.skuId);
    const result = receiveValuation(state, toMilli(quantity), value);
    await this.writeLedger(tx, ctx, place, movement, quantity, value);
    if (result.correction !== 0) {
      await this.writeLedger(
        tx,
        ctx,
        { ...place, locationId: null, batchId: null },
        'NEGATIVE_COVER',
        '0.000',
        -result.correction,
      );
    }
    await this.changeBalance(tx, place, toMilli(quantity), false);
    await this.saveState(tx, states, place.skuId, result.next);
    return { correction: result.correction };
  }

  /** Goods out at moving-average cost. Returns the cost to journal. */
  async issue(
    tx: DbTransaction,
    ctx: PostingContext,
    states: Map<string, ValuationState>,
    place: Place,
    quantity: string,
    movement: Movement,
    options: { allowNegative?: boolean } = {},
  ) {
    const state = this.stateOf(states, place.skuId);
    const out = toMilli(quantity);
    if (!options.allowNegative && state.qty < out) {
      throw new BadRequestException('Stok tidak cukup');
    }
    const result = issueValuation(state, out);
    await this.writeLedger(tx, ctx, place, movement, fromMilli(-out), -result.cost);
    await this.changeBalance(tx, place, -out, options.allowNegative ?? false);
    await this.saveState(tx, states, place.skuId, result.next);
    return { cost: result.cost };
  }

  /** Between locations: quantities move, the SKU value does not. */
  async move(
    tx: DbTransaction,
    ctx: PostingContext,
    place: Place,
    toLocationId: string,
    quantity: string,
  ) {
    const q = toMilli(quantity);
    await this.writeLedger(tx, ctx, place, 'TRANSFER_OUT', fromMilli(-q), 0);
    await this.changeBalance(tx, place, -q, false);
    const target = { ...place, locationId: toLocationId };
    await this.writeLedger(tx, ctx, target, 'TRANSFER_IN', quantity, 0);
    await this.changeBalance(tx, target, q, false);
  }

  /**
   * Value-only change (bill price variance, shipping). Returns false when the SKU has no
   * stock left, in which case the caller books the amount to HPP instead (docs/alur/05 §4).
   */
  async adjustValue(
    tx: DbTransaction,
    ctx: PostingContext,
    states: Map<string, ValuationState>,
    skuId: string,
    amount: number,
    docLineId: string | null,
  ) {
    const state = this.stateOf(states, skuId);
    if (amount === 0) return true;
    if (state.qty <= 0n) return false;
    await this.writeLedger(tx, ctx, { skuId, locationId: null, batchId: null, docLineId }, 'VALUE_ADJUSTMENT', '0.000', amount);
    const value = state.value + amount;
    await this.saveState(tx, states, skuId, { qty: state.qty, value, lastAvgCost: averageOf(state.qty, value, state.lastAvgCost) });
    return true;
  }

  /** Harga beli terakhir & tertinggi per satuan dasar: reference prices for selling (not journaled). */
  async recordPurchaseCost(tx: DbTransaction, skuId: string, unitCost: string) {
    await tx
      .update(skuValuations)
      .set({
        lastPurchaseCost: unitCost,
        highestPurchaseCost: sql`greatest(coalesce(${skuValuations.highestPurchaseCost}, 0), ${unitCost}::numeric)`,
        highestPurchaseAt: sql`case when ${unitCost}::numeric > coalesce(${skuValuations.highestPurchaseCost}, 0) then now() else ${skuValuations.highestPurchaseAt} end`,
      })
      .where(eq(skuValuations.skuId, skuId));
  }

  /** Finds or creates the batch for incoming goods (batch number and/or expiry date). */
  async resolveBatch(tx: DbTransaction, skuId: string, batchNo: string | null, expiryDate: string | null) {
    await tx.insert(batches).values({ skuId, batchNo, expiryDate }).onConflictDoNothing();
    const [row] = await tx
      .select({ id: batches.id })
      .from(batches)
      .where(
        and(
          eq(batches.skuId, skuId),
          batchNo ? eq(batches.batchNo, batchNo) : isNull(batches.batchNo),
          expiryDate ? eq(batches.expiryDate, expiryDate) : isNull(batches.expiryDate),
        ),
      );
    return row.id;
  }

  private stateOf(states: Map<string, ValuationState>, skuId: string) {
    const state = states.get(skuId);
    if (!state) throw new Error(`valuation of ${skuId} was not locked before posting`);
    return state;
  }

  private async writeLedger(
    tx: DbTransaction,
    ctx: PostingContext,
    place: Omit<Place, 'locationId'> & { locationId: string | null },
    movement: Movement,
    quantity: string,
    value: number,
  ) {
    await tx.insert(stockLedger).values({
      skuId: place.skuId,
      locationId: place.locationId,
      batchId: place.batchId,
      movement,
      qty: quantity,
      value,
      docType: ctx.docType,
      docId: ctx.docId,
      docLineId: place.docLineId ?? null,
      businessDate: ctx.businessDate,
      createdBy: ctx.userId,
    });
  }

  private async changeBalance(tx: DbTransaction, place: Place, delta: bigint, allowNegative: boolean) {
    const [row] = await tx
      .insert(stockBalances)
      .values({
        skuId: place.skuId,
        locationId: place.locationId,
        batchId: place.batchId,
        qty: fromMilli(delta),
      })
      .onConflictDoUpdate({
        target: [stockBalances.skuId, stockBalances.locationId, stockBalances.batchId],
        set: { qty: sql`${stockBalances.qty} + excluded.qty`, updatedAt: new Date() },
      })
      .returning({ qty: stockBalances.qty });
    if (!allowNegative && toMilli(row.qty) < 0n) {
      throw new BadRequestException('Stok di lokasi/batch ini tidak cukup');
    }
  }

  private async saveState(
    tx: DbTransaction,
    states: Map<string, ValuationState>,
    skuId: string,
    next: ValuationState,
  ) {
    states.set(skuId, next);
    await tx
      .update(skuValuations)
      .set({
        qty: fromMilli(next.qty),
        value: next.value,
        lastAvgCost: next.lastAvgCost,
        updatedAt: new Date(),
      })
      .where(eq(skuValuations.skuId, skuId));
  }
}
