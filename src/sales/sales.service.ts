import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { PinService } from '../access/pin.service.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { displayName, ProductsService } from '../catalog/products.service.js';
import { businessDate } from '../common/business-date.js';
import { DB, type Database, type DbTransaction } from '../database/database.module.js';
import {
  batches,
  bundleComponents,
  heldSales,
  locations,
  members,
  paymentMethods,
  products,
  promotions,
  promotionTargets,
  saleLineComponents,
  saleLines,
  salePayments,
  sales,
  settings,
  shifts,
  skus,
  skuUnits,
  stockBalances,
  terminals,
} from '../database/schema/index.js';
import { DocumentNumberService } from '../finance/document-number.service.js';
import { type JournalLineInput, JournalService } from '../finance/journal.service.js';
import { baseQtyOf } from '../purchasing/purchase-orders.service.js';
import type { PostingContext } from '../stock/stock.service.js';
import { StockService } from '../stock/stock.service.js';
import { fromMilli, toMilli, type ValuationState } from '../stock/valuation.js';
import { CartError, type CartLine, calculateCart, type Promo, settle } from './cart-calculator.js';

export interface SaleLineInput {
  skuUnitId: string;
  qty: string;
  scannedCode?: string | null;
  overrideUnitPrice?: number | null;
  priceOverridePinId?: string | null;
}

export interface SaleInput {
  id: string;
  memberId?: string | null;
  lines: SaleLineInput[];
  manualDiscount: number;
  manualDiscountPinId?: string | null;
  stockPinApprovalId?: string | null;
  payments: { methodId: string; amount: number; referenceNo?: string | null }[];
}

/** PPN setting; without one the store charges PPN 11% (keputusan sementara, see KEPUTUSAN.md). */
export async function taxSetting(tx: DbTransaction | Database) {
  const [row] = await tx.select().from(settings).where(eq(settings.key, 'tax.ppn'));
  const value = row?.value as { enabled?: boolean; rate?: number | string } | undefined;
  return { enabled: value?.enabled ?? true, rate: String(value?.rate ?? '11') };
}

/**
 * Penjualan kasir (docs/alur/04 §2–3). One database transaction per sale: prices and
 * promos recomputed on the server, stock out, journal in, receipt data back.
 */
@Injectable()
export class SalesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbers: DocumentNumberService,
    private readonly journals: JournalService,
    private readonly stock: StockService,
    private readonly products: ProductsService,
    private readonly pins: PinService,
  ) {}

  async post(actor: Principal, input: SaleInput) {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: sales.id }).from(sales).where(eq(sales.id, input.id));
      if (existing) return; // idempotent retry: same receipt, nothing posted twice
      const { shift, terminal } = await this.openShiftOf(tx, actor);
      const entity = { type: 'sale', id: input.id };
      const now = new Date();

      const unitRows = await tx
        .select({
          skuUnitId: skuUnits.id, factor: skuUnits.factor, skuId: skus.id, kind: skus.kind, isTaxable: skus.isTaxable,
          isSellable: skus.isSellable, isActive: sql<boolean>`${skus.isActive} and ${products.isActive}`, isWeighed: skus.isWeighed,
          availableFrom: skus.availableFrom, availableUntil: skus.availableUntil, categoryId: products.categoryId, brandId: products.brandId,
        })
        .from(skuUnits)
        .innerJoin(skus, eq(skus.id, skuUnits.skuId))
        .innerJoin(products, eq(products.id, skus.productId))
        .where(inArray(skuUnits.id, [...new Set(input.lines.map((l) => l.skuUnitId))]));
      const today = businessDate(now);
      const prices = await this.products.currentPrices(tx, unitRows.map((u) => u.skuUnitId), now);
      const cartLines: CartLine[] = [];
      const overridePins: (string | null)[] = [];
      for (const [i, l] of input.lines.entries()) {
        const u = unitRows.find((r) => r.skuUnitId === l.skuUnitId);
        const at = `Baris ${i + 1}: `;
        if (!u?.isActive || !u.isSellable) throw new BadRequestException(`${at}barang tidak dijual`);
        if ((u.availableFrom && today < u.availableFrom) || (u.availableUntil && today > u.availableUntil)) {
          throw new BadRequestException(`${at}barang di luar periode jual`);
        }
        if (!u.isWeighed && !/^\d+(\.0+)?$/.test(l.qty)) throw new BadRequestException(`${at}jumlah harus bilangan bulat`);
        overridePins.push(
          l.overrideUnitPrice != null ? await this.pins.authorize(tx, actor, 'penjualan.kasir.ubah_harga', l.priceOverridePinId, entity) : null,
        );
        cartLines.push({
          lineId: String(i), skuId: u.skuId, categoryId: u.categoryId, brandId: u.brandId, qty: l.qty,
          isTaxable: u.isTaxable, prices: prices.get(u.skuUnitId) ?? [], overrideUnitPrice: l.overrideUnitPrice ?? null,
        });
      }
      const manualPinId = input.manualDiscount > 0
        ? await this.pins.authorize(tx, actor, 'penjualan.kasir.diskon_manual', input.manualDiscountPinId, entity)
        : null;

      let isMember = false;
      if (input.memberId) {
        const [m] = await tx.select({ isActive: members.isActive }).from(members).where(eq(members.id, input.memberId));
        if (!m?.isActive) throw new BadRequestException('Member tidak ditemukan atau nonaktif');
        isMember = true;
      }
      const tax = await taxSetting(tx);
      const methods = input.payments.length
        ? await tx.select().from(paymentMethods).where(inArray(paymentMethods.id, input.payments.map((p) => p.methodId)))
        : [];
      let cart;
      let settlement;
      try {
        cart = calculateCart({ lines: cartLines, promos: await this.activePromos(tx, now), isMember, at: now, manualDiscount: input.manualDiscount, tax });
        settlement = settle(cart.net, input.payments.map((p) => {
          const m = methods.find((x) => x.id === p.methodId);
          if (!m?.isActive) throw new CartError('Metode bayar tidak ditemukan');
          if (m.requiresReference && !p.referenceNo) throw new CartError(`${m.name} wajib diisi nomor referensi`);
          return { methodId: m.id, kind: m.kind, amount: p.amount };
        }));
      } catch (e) {
        if (e instanceof CartError) throw new BadRequestException(e.message);
        throw e;
      }

      const docNo = await this.numbers.next(tx, 'PJ', shift.businessDate);
      await tx.insert(sales).values({
        id: input.id, docNo, businessDate: shift.businessDate, shiftId: shift.id, terminalId: terminal.id, cashierId: actor.userId,
        memberId: input.memberId ?? null, discountMode: cart.discountMode, totalPromoId: cart.totalPromoId,
        grossAmount: cart.gross, promoDiscountAmount: cart.promoDiscount, manualDiscountAmount: cart.manualDiscount, manualDiscountPinId: manualPinId,
        netAmount: cart.net, taxRate: tax.enabled ? tax.rate : '0', taxBase: cart.taxBase, taxAmount: cart.tax,
        roundingAmount: settlement.rounding, amountDue: settlement.amountDue,
        paidAmount: settlement.payments.reduce((s, p) => s + (p.tendered ?? p.amount), 0), changeAmount: settlement.change, costAmount: 0,
      });

      // Stock: the store is one unit for selling; the sales location goes first.
      const components = await tx.select().from(bundleComponents).where(inArray(bundleComponents.bundleSkuId, unitRows.filter((u) => u.kind === 'BUNDLE').map((u) => u.skuId)));
      const skuIds = [...unitRows.map((u) => u.skuId), ...components.map((c) => c.componentSkuId)];
      const states = await this.stock.lock(tx, skuIds);
      const ctx: PostingContext = { docType: 'PJ', docId: input.id, businessDate: shift.businessDate, userId: actor.userId };
      const stockPin = { id: input.stockPinApprovalId, used: null as string | null };
      let totalCost = 0;
      for (const [i, l] of input.lines.entries()) {
        const u = unitRows.find((r) => r.skuUnitId === l.skuUnitId)!;
        const c = cart.lines[i];
        const baseQty = baseQtyOf(l.qty, u.factor);
        const [line] = await tx
          .insert(saleLines)
          .values({
            saleId: input.id, lineNo: i + 1, skuId: u.skuId, skuUnitId: u.skuUnitId, qty: l.qty, baseQty, priceLevel: c.priceLevel,
            unitPrice: c.unitPrice, originalUnitPrice: l.overrideUnitPrice != null ? (prices.get(u.skuUnitId)?.find((p) => p.level === 'RETAIL')?.price ?? null) : null,
            priceOverridePinId: overridePins[i], grossAmount: c.gross, itemPromoId: c.itemPromoId, promoDiscount: c.promoDiscount,
            manualDiscount: c.manualDiscount, netAmount: c.net, isTaxable: u.isTaxable, taxAmount: c.tax, costAmount: 0, scannedCode: l.scannedCode ?? null,
          })
          .returning({ id: saleLines.id });
        let cost = 0;
        if (u.kind === 'BUNDLE') {
          for (const comp of components.filter((x) => x.bundleSkuId === u.skuId)) {
            const compQty = fromMilli((toMilli(comp.qty) * toMilli(baseQty)) / 1000n);
            const compCost = await this.issueFromStore(tx, actor, ctx, states, comp.componentSkuId, compQty, terminal.salesLocationId, line.id, stockPin, entity);
            await tx.insert(saleLineComponents).values({ saleLineId: line.id, componentSkuId: comp.componentSkuId, baseQty: compQty, costAmount: compCost });
            cost += compCost;
          }
        } else {
          cost = await this.issueFromStore(tx, actor, ctx, states, u.skuId, baseQty, terminal.salesLocationId, line.id, stockPin, entity);
        }
        await tx.update(saleLines).set({ costAmount: cost }).where(eq(saleLines.id, line.id));
        totalCost += cost;
      }

      for (const p of settlement.payments) {
        const ref = input.payments.find((x) => x.methodId === p.methodId)?.referenceNo ?? null;
        await tx.insert(salePayments).values({ saleId: input.id, paymentMethodId: p.methodId, amount: p.amount, tendered: p.tendered, change: p.change, referenceNo: ref });
      }

      const jl: JournalLineInput[] = settlement.payments.map((p) => {
        const method = methods.find((m) => m.id === p.methodId)!;
        return { account: { accountId: p.kind === 'CASH' ? terminal.cashAccountId : method.accountId! }, debit: p.amount };
      });
      jl.push({ account: 'SALES', credit: cart.salesGrossBase });
      if (cart.salesDiscountBase > 0) jl.push({ account: 'SALES_DISCOUNT', debit: cart.salesDiscountBase });
      if (cart.tax > 0) jl.push({ account: 'VAT_OUT', credit: cart.tax });
      if (settlement.rounding > 0) jl.push({ account: 'ROUNDING_GAIN', credit: settlement.rounding });
      if (settlement.rounding < 0) jl.push({ account: 'ROUNDING_LOSS', debit: -settlement.rounding });
      if (totalCost > 0) jl.push({ account: 'COGS', debit: totalCost }, { account: 'INVENTORY', credit: totalCost });
      if (totalCost < 0) jl.push({ account: 'INVENTORY', debit: -totalCost }, { account: 'COGS', credit: -totalCost });
      const journal = await this.journals.post(tx, actor, {
        journalNo: docNo, journalDate: shift.businessDate, source: 'AUTO', sourceDocType: 'PJ', sourceDocId: input.id,
        description: `Penjualan ${docNo}`, lines: jl.filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0),
      });
      await tx.update(sales).set({ costAmount: totalCost, journalId: journal.id }).where(eq(sales.id, input.id));
      await this.audit.log({ action: 'post', entityType: 'sale', entityId: input.id, userId: actor.userId, terminalId: terminal.id, after: { docNo, net: cart.net, rounding: settlement.rounding } }, tx);
    });
    return this.detail(input.id);
  }

  /** Receipt data: lines with names, payments, change. */
  async detail(id: string) {
    const [sale] = await this.db.select().from(sales).where(eq(sales.id, id));
    if (!sale) throw new NotFoundException('Transaksi tidak ditemukan');
    const lines = await this.db
      .select({ line: saleLines, productName: products.name, variantName: skus.variantName })
      .from(saleLines)
      .innerJoin(skus, eq(skus.id, saleLines.skuId))
      .innerJoin(products, eq(products.id, skus.productId))
      .where(eq(saleLines.saleId, id))
      .orderBy(asc(saleLines.lineNo));
    const payments = await this.db
      .select({ payment: salePayments, methodName: paymentMethods.name, kind: paymentMethods.kind })
      .from(salePayments)
      .innerJoin(paymentMethods, eq(paymentMethods.id, salePayments.paymentMethodId))
      .where(eq(salePayments.saleId, id));
    return {
      ...sale,
      lines: lines.map((r) => ({ ...r.line, displayName: displayName(r.productName, r.variantName) })),
      payments: payments.map((r) => ({ ...r.payment, methodName: r.methodName, kind: r.kind })),
    };
  }

  /** Cetak ulang struk is a [PIN] action; the copy is marked SALINAN by the printer layout. */
  async reprint(actor: Principal, id: string, pinApprovalId?: string | null) {
    await this.db.transaction(async (tx) => {
      const [sale] = await tx.select({ id: sales.id }).from(sales).where(eq(sales.id, id)).for('update');
      if (!sale) throw new NotFoundException('Transaksi tidak ditemukan');
      await this.pins.authorize(tx, actor, 'penjualan.transaksi.cetak_ulang', pinApprovalId, { type: 'sale_reprint', id });
      await tx.update(sales).set({ reprintCount: sql`${sales.reprintCount} + 1` }).where(eq(sales.id, id));
    });
    return { ...(await this.detail(id)), isCopy: true };
  }

  async hold(actor: Principal, input: { id: string; label?: string | null; memberId?: string | null; cart: unknown }) {
    return this.db.transaction(async (tx) => {
      const { shift } = await this.openShiftOf(tx, actor);
      await tx.insert(heldSales).values({ id: input.id, shiftId: shift.id, label: input.label ?? null, memberId: input.memberId ?? null, cart: input.cart, createdBy: actor.userId }).onConflictDoNothing();
      return { id: input.id };
    });
  }

  /** Held carts of the terminal's open shift — they can be resumed from any drawer of that shift. */
  async listHeld(actor: Principal) {
    const [shift] = await this.db.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.cashierId, actor.userId), eq(shifts.status, 'OPEN')));
    if (!shift) return [];
    return this.db.select().from(heldSales).where(eq(heldSales.shiftId, shift.id)).orderBy(asc(heldSales.createdAt));
  }

  async releaseHeld(id: string) {
    const deleted = await this.db.delete(heldSales).where(eq(heldSales.id, id)).returning({ id: heldSales.id, createdBy: heldSales.createdBy });
    if (!deleted.length) throw new NotFoundException('Transaksi ditahan tidak ditemukan');
  }

  // ----------------------------------------------------------------- helpers

  async openShiftOf(tx: DbTransaction, actor: Principal) {
    const [shift] = await tx.select().from(shifts).where(and(eq(shifts.cashierId, actor.userId), eq(shifts.status, 'OPEN'))).for('share');
    if (!shift) throw new ForbiddenException('Buka shift dulu sebelum bertransaksi');
    const [terminal] = await tx.select().from(terminals).where(eq(terminals.id, shift.terminalId));
    return { shift, terminal };
  }

  private async activePromos(tx: DbTransaction, at: Date): Promise<Promo[]> {
    const rows = await tx
      .select()
      .from(promotions)
      .where(and(eq(promotions.isActive, true), lte(promotions.startsAt, at), gt(promotions.endsAt, at)));
    if (!rows.length) return [];
    const targets = await tx.select().from(promotionTargets).where(inArray(promotionTargets.promotionId, rows.map((r) => r.id)));
    return rows.map((r) => ({
      ...r,
      discountValue: r.discountValue,
      daysOfWeek: r.daysOfWeek ?? null,
      targets: targets.filter((t) => t.promotionId === r.id).map((t) => ({ targetType: t.targetType, targetId: t.targetId })),
    }));
  }

  /**
   * Takes `quantity` of a SKU from anywhere sellable in the store: the sales location
   * first, then the rest; batches with the nearest unexpired date first (FEFO). If the
   * whole store does not have it, a supervisor PIN lets the sales location go negative.
   */
  private async issueFromStore(
    tx: DbTransaction, actor: Principal, ctx: PostingContext, states: Map<string, ValuationState>,
    skuId: string, quantity: string, salesLocationId: string, docLineId: string,
    stockPin: { id?: string | null; used: string | null }, entity: { type: string; id: string },
  ) {
    const rows = await tx
      .select({ locationId: stockBalances.locationId, batchId: stockBalances.batchId, qty: stockBalances.qty, expiryDate: batches.expiryDate })
      .from(stockBalances)
      .innerJoin(locations, eq(locations.id, stockBalances.locationId))
      .leftJoin(batches, eq(batches.id, stockBalances.batchId))
      .where(and(eq(stockBalances.skuId, skuId), gt(stockBalances.qty, '0'), eq(locations.isActive, true), inArray(locations.type, ['STORAGE', 'DISPLAY'])))
      .orderBy(
        sql`case when ${stockBalances.locationId} = ${salesLocationId} then 0 else 1 end`,
        sql`${batches.expiryDate} asc nulls last`,
      );
    const today = ctx.businessDate;
    let left = toMilli(quantity);
    let cost = 0;
    for (const r of rows) {
      if (left === 0n) break;
      if (r.expiryDate && r.expiryDate < today) continue; // expired stock is not sold
      const take = toMilli(r.qty) < left ? toMilli(r.qty) : left;
      cost += (await this.stock.issue(tx, ctx, states, { skuId, locationId: r.locationId, batchId: r.batchId, docLineId }, fromMilli(take), 'SALE')).cost;
      left -= take;
    }
    if (left > 0n) {
      stockPin.used ??= await this.pins.authorize(tx, actor, 'penjualan.kasir.jual_stok_minus', stockPin.id, entity) ?? 'own-permission';
      cost += (await this.stock.issue(tx, ctx, states, { skuId, locationId: salesLocationId, batchId: null, docLineId }, fromMilli(left), 'SALE', { allowNegative: true })).cost;
    }
    return cost;
  }
}
