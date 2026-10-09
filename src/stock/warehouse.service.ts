import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lt, lte, ne, type SQL, sql } from 'drizzle-orm';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { businessDate } from '../common/business-date.js';
import { isWholeQuantity } from '../common/quantity.js';
import { DB, type Database } from '../database/database.module.js';
import {
  batches,
  locations,
  products,
  skus,
  stockBalances,
  stockLedger,
  stockTransferLines,
  stockTransfers,
  units,
} from '../database/schema/index.js';
import { displayName } from '../catalog/products.service.js';
import { DocumentNumberService } from '../finance/document-number.service.js';
import { StockService } from './stock.service.js';
import { fromMilli, toMilli } from './valuation.js';

type LocationType = 'STORAGE' | 'DISPLAY' | 'DAMAGED' | 'TRANSIT';

/** Locations, transfers (PM) and stock read models: balances and kartu stok. */
@Injectable()
export class WarehouseService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly numbers: DocumentNumberService,
  ) {}

  listLocations() {
    return this.db.select().from(locations).orderBy(asc(locations.code));
  }

  async saveLocation(
    actor: Principal,
    input: { code: string; name: string; type: LocationType; parentId?: string | null; isActive: boolean },
    id?: string,
  ) {
    if (id && !input.isActive) {
      const [held] = await this.db
        .select({ id: stockBalances.id })
        .from(stockBalances)
        .where(and(eq(stockBalances.locationId, id), ne(stockBalances.qty, '0')))
        .limit(1);
      if (held) throw new ConflictException('Lokasi masih menyimpan stok');
    }
    const values = { ...input, parentId: input.parentId ?? null };
    const [row] = id
      ? await this.db.update(locations).set({ ...values, updatedAt: new Date(), updatedBy: actor.userId }).where(eq(locations.id, id)).returning()
      : await this.db.insert(locations).values({ ...values, createdBy: actor.userId, updatedBy: actor.userId }).returning();
    if (!row) throw new NotFoundException('Lokasi tidak ditemukan');
    await this.audit.log({ action: id ? 'location.update' : 'location.create', entityType: 'location', entityId: row.id, userId: actor.userId, after: row });
    return row;
  }

  /** Pemindahan is posted immediately (docs/alur/06 §1); no journal because value does not change. */
  async transfer(
    actor: Principal,
    input: { id: string; fromLocationId: string; toLocationId: string; note?: string | null; lines: { skuId: string; batchId?: string | null; qty: string }[] },
  ) {
    if (input.fromLocationId === input.toLocationId) throw new BadRequestException('Lokasi asal dan tujuan sama');
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: stockTransfers.id }).from(stockTransfers).where(eq(stockTransfers.id, input.id));
      if (existing) return; // idempotent retry
      const locs = await tx.select().from(locations).where(inArray(locations.id, [input.fromLocationId, input.toLocationId]));
      if (locs.length !== 2 || locs.some((l) => !l.isActive || l.type === 'TRANSIT')) {
        throw new BadRequestException('Lokasi asal atau tujuan tidak valid');
      }
      const skuRows = await tx
        .select({ id: skus.id, kind: skus.kind, trackBatch: skus.trackBatch, allowsDecimal: units.allowsDecimal })
        .from(skus)
        .innerJoin(units, eq(units.id, skus.baseUnitId))
        .where(inArray(skus.id, [...new Set(input.lines.map((l) => l.skuId))]));
      for (const [i, l] of input.lines.entries()) {
        const sku = skuRows.find((s) => s.id === l.skuId);
        if (!sku || sku.kind !== 'STANDARD') throw new BadRequestException(`Baris ${i + 1}: barang tidak valid`);
        if (sku.trackBatch !== Boolean(l.batchId)) throw new BadRequestException(`Baris ${i + 1}: ${sku.trackBatch ? 'pilih batch' : 'barang ini tidak memakai batch'}`);
        if (!sku.allowsDecimal && !isWholeQuantity(l.qty)) throw new BadRequestException(`Baris ${i + 1}: jumlah harus bilangan bulat`);
      }

      const date = businessDate();
      const docNo = await this.numbers.next(tx, 'PM', date);
      await tx.insert(stockTransfers).values({
        id: input.id,
        docNo,
        status: 'POSTED',
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        note: input.note ?? null,
        businessDate: date,
        postedAt: new Date(),
        postedBy: actor.userId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      const ctx = { docType: 'PM', docId: input.id, businessDate: date, userId: actor.userId };
      for (const l of input.lines) {
        const [line] = await tx
          .insert(stockTransferLines)
          .values({ transferId: input.id, skuId: l.skuId, batchId: l.batchId ?? null, qty: l.qty })
          .returning({ id: stockTransferLines.id });
        await this.stock.move(tx, ctx, { skuId: l.skuId, locationId: input.fromLocationId, batchId: l.batchId ?? null, docLineId: line.id }, input.toLocationId, l.qty);
      }
      await this.audit.log({ action: 'post', entityType: 'stock_transfer', entityId: input.id, userId: actor.userId, after: { docNo } }, tx);
    });
    const [doc] = await this.db.select().from(stockTransfers).where(eq(stockTransfers.id, input.id));
    const lines = await this.db.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, input.id));
    return { ...doc, lines };
  }

  async balances(query: { skuId?: string; locationId?: string; includeZero: boolean }) {
    const filters: SQL[] = [];
    if (query.skuId) filters.push(eq(stockBalances.skuId, query.skuId));
    if (query.locationId) filters.push(eq(stockBalances.locationId, query.locationId));
    if (!query.includeZero) filters.push(ne(stockBalances.qty, '0'));
    const rows = await this.db
      .select({
        skuId: skus.id,
        skuCode: skus.skuCode,
        productName: products.name,
        variantName: skus.variantName,
        location: { id: locations.id, code: locations.code, name: locations.name, type: locations.type },
        batch: { id: batches.id, batchNo: batches.batchNo, expiryDate: batches.expiryDate },
        qty: stockBalances.qty,
      })
      .from(stockBalances)
      .innerJoin(skus, eq(skus.id, stockBalances.skuId))
      .innerJoin(products, eq(products.id, skus.productId))
      .innerJoin(locations, eq(locations.id, stockBalances.locationId))
      .leftJoin(batches, eq(batches.id, stockBalances.batchId))
      .where(and(...filters))
      .orderBy(asc(products.name), asc(locations.code), asc(batches.expiryDate));
    return rows.map(({ productName, variantName, batch, ...r }) => ({
      ...r,
      displayName: displayName(productName, variantName),
      batch: batch?.id ? batch : null,
    }));
  }

  /** Kartu stok (docs/alur/06 §5): opening balance, every movement with a running balance. */
  async stockCard(query: { skuId: string; from: string; to: string; locationId?: string }, showValue: boolean) {
    const place: SQL[] = [eq(stockLedger.skuId, query.skuId)];
    if (query.locationId) place.push(eq(stockLedger.locationId, query.locationId));
    const [opening] = await this.db
      .select({ qty: sql<string>`coalesce(sum(${stockLedger.qty}), 0)::numeric(18,3)`, value: sql<number>`coalesce(sum(${stockLedger.value}), 0)::bigint`.mapWith(Number) })
      .from(stockLedger)
      .where(and(...place, lt(stockLedger.businessDate, query.from)));
    const rows = await this.db
      .select({
        id: stockLedger.id,
        businessDate: stockLedger.businessDate,
        postedAt: stockLedger.postedAt,
        movement: stockLedger.movement,
        docType: stockLedger.docType,
        docId: stockLedger.docId,
        locationCode: locations.code,
        qty: stockLedger.qty,
        value: stockLedger.value,
      })
      .from(stockLedger)
      .leftJoin(locations, eq(locations.id, stockLedger.locationId))
      .where(and(...place, gte(stockLedger.businessDate, query.from), lte(stockLedger.businessDate, query.to)))
      .orderBy(asc(stockLedger.postedAt), asc(stockLedger.id));

    let running = toMilli(opening.qty);
    let runningValue = opening.value;
    const movements = rows
      .filter((r) => showValue || toMilli(r.qty) !== 0n) // value-only rows mean nothing without values
      .map((r) => {
        running += toMilli(r.qty);
        runningValue += r.value;
        const base = { ...r, qtyIn: toMilli(r.qty) > 0n ? r.qty : '0.000', qtyOut: toMilli(r.qty) < 0n ? fromMilli(-toMilli(r.qty)) : '0.000', balance: fromMilli(running) };
        const { value: _v, ...withoutValue } = base;
        return showValue ? { ...base, balanceValue: runningValue } : withoutValue;
      });
    return {
      skuId: query.skuId,
      from: query.from,
      to: query.to,
      openingQty: opening.qty,
      ...(showValue ? { openingValue: opening.value } : {}),
      movements,
      closingQty: fromMilli(running),
      ...(showValue ? { closingValue: runningValue } : {}),
    };
  }
}
