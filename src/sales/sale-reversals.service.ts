import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { PinService } from '../access/pin.service.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { DB, type Database } from '../database/database.module.js';
import {
  journalLines,
  locations,
  paymentMethods,
  saleLineComponents,
  saleLines,
  sales,
  salesReturnLines,
  salesReturnRefunds,
  salesReturns,
  saleVoids,
  settings,
  shifts,
  skus,
  stockLedger,
} from '../database/schema/index.js';
import { DocumentNumberService } from '../finance/document-number.service.js';
import { type JournalLineInput, JournalService } from '../finance/journal.service.js';
import { StockService } from '../stock/stock.service.js';
import { fromMilli, roundDiv, toMilli } from '../stock/valuation.js';
import { roundCash } from './cart-calculator.js';
import { SalesService } from './sales.service.js';

export interface ReturnInput {
  id: string;
  saleId: string;
  reason: string;
  pinApprovalId?: string | null;
  lines: { saleLineId: string; baseQty: string; condition: 'SELLABLE' | 'DAMAGED' }[];
  /** Non-cash refunds; whatever is left is paid in cash from the drawer. */
  refunds: { methodId: string; amount: number; referenceNo?: string | null }[];
}

/** Void (VD) and retur penjualan (RJ), docs/alur/04 §4–5. */
@Injectable()
export class SaleReversalsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbers: DocumentNumberService,
    private readonly journals: JournalService,
    private readonly stock: StockService,
    private readonly pins: PinService,
    private readonly salesService: SalesService,
  ) {}

  /** Same shift, still open: everything goes back exactly as it came (stock at its cost, journal mirrored). */
  async voidSale(actor: Principal, saleId: string, input: { reason: string; pinApprovalId?: string | null }) {
    await this.db.transaction(async (tx) => {
      const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).for('update');
      if (!sale) throw new NotFoundException('Transaksi tidak ditemukan');
      if (sale.status !== 'POSTED') throw new BadRequestException('Transaksi sudah di-void');
      const [shift] = await tx.select().from(shifts).where(eq(shifts.id, sale.shiftId));
      if (shift.status !== 'OPEN') throw new BadRequestException('Shift transaksi ini sudah ditutup; gunakan retur');
      const [returned] = await tx.select({ id: salesReturns.id }).from(salesReturns).where(eq(salesReturns.saleId, saleId)).limit(1);
      if (returned) throw new BadRequestException('Transaksi yang sudah diretur tidak bisa di-void');
      const id = crypto.randomUUID();
      const pinApprovalId = await this.pins.authorize(tx, actor, 'penjualan.transaksi.void', input.pinApprovalId, { type: 'sale_void', id: saleId });

      const docNo = await this.numbers.next(tx, 'VD', shift.businessDate);
      const ctx = { docType: 'VD', docId: id, businessDate: shift.businessDate, userId: actor.userId };
      const moves = await tx.select().from(stockLedger).where(and(eq(stockLedger.docType, 'PJ'), eq(stockLedger.docId, saleId), lt(stockLedger.qty, '0')));
      const states = await this.stock.lock(tx, moves.map((m) => m.skuId));
      for (const m of moves) {
        await this.stock.receive(tx, ctx, states, { skuId: m.skuId, locationId: m.locationId!, batchId: m.batchId, docLineId: m.docLineId }, fromMilli(-toMilli(m.qty)), -m.value, 'SALE_VOID');
      }
      const journal = await this.journals.reverse(tx, actor, sale.journalId!, { journalNo: docNo, journalDate: shift.businessDate, description: `Void ${sale.docNo}: ${input.reason}` });
      await tx.insert(saleVoids).values({ id, docNo, saleId, shiftId: shift.id, reason: input.reason, pinApprovalId, businessDate: shift.businessDate, postedBy: actor.userId, journalId: journal.id });
      await tx.update(sales).set({ status: 'VOIDED' }).where(eq(sales.id, saleId));
      await this.audit.log({ action: 'void', entityType: 'sale', entityId: saleId, userId: actor.userId, pinApprovalId, after: { docNo, reason: input.reason } }, tx);
    });
    return this.salesService.detail(saleId);
  }

  /**
   * Refund = what the customer actually paid per unit (discounts and PPN included);
   * goods return at the cost they left with. Cash refunds are rounded to Rp100.
   */
  async returnSale(actor: Principal, input: ReturnInput) {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: salesReturns.id }).from(salesReturns).where(eq(salesReturns.id, input.id));
      if (existing) return;
      const [sale] = await tx.select().from(sales).where(eq(sales.id, input.saleId)).for('update');
      if (!sale || sale.status !== 'POSTED') throw new BadRequestException('Transaksi asal tidak ditemukan atau sudah di-void');
      const { shift, terminal } = await this.salesService.openShiftOf(tx, actor);
      const [daysRow] = await tx.select().from(settings).where(eq(settings.key, 'sales.return_days'));
      const days = Number(daysRow?.value ?? 7);
      const age = (Date.parse(shift.businessDate) - Date.parse(sale.businessDate)) / 86_400_000;
      if (age > days) throw new BadRequestException(`Batas retur ${days} hari sudah lewat`);
      const pinApprovalId = await this.pins.authorize(tx, actor, 'penjualan.retur.buat', input.pinApprovalId, { type: 'sales_return', id: input.id });

      const lines = await tx.select({ line: saleLines, kind: skus.kind }).from(saleLines).innerJoin(skus, eq(skus.id, saleLines.skuId)).where(inArray(saleLines.id, input.lines.map((l) => l.saleLineId))).for('update', { of: saleLines });
      const [damaged] = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.type, 'DAMAGED'), eq(locations.isActive, true))).limit(1);
      const plan = input.lines.map((l, i) => {
        const row = lines.find((r) => r.line.id === l.saleLineId && r.line.saleId === sale.id);
        const at = `Baris ${i + 1}: `;
        if (!row) throw new BadRequestException(`${at}baris tidak ada di transaksi ini`);
        const q = toMilli(l.baseQty);
        const open = toMilli(row.line.baseQty) - toMilli(row.line.returnedBaseQty);
        if (q <= 0n || q > open) throw new BadRequestException(`${at}jumlah retur maksimal ${fromMilli(open)}`);
        if (row.kind === 'BUNDLE' && q % 1000n !== 0n) throw new BadRequestException(`${at}bundel hanya bisa diretur utuh`);
        if (l.condition === 'DAMAGED' && !damaged) throw new BadRequestException('Belum ada lokasi barang rusak');
        const base = toMilli(row.line.baseQty);
        const share = (amount: number) => Number(roundDiv(BigInt(amount) * q, base));
        return { input: l, line: row.line, isBundle: row.kind === 'BUNDLE', q, refund: share(row.line.netAmount), tax: share(row.line.taxAmount), cost: share(row.line.costAmount), toLocationId: l.condition === 'DAMAGED' ? damaged!.id : terminal.salesLocationId };
      });

      const refundTotal = plan.reduce((s, p) => s + p.refund, 0);
      const taxTotal = plan.reduce((s, p) => s + p.tax, 0);
      const methods = input.refunds.length ? await tx.select().from(paymentMethods).where(inArray(paymentMethods.id, input.refunds.map((r) => r.methodId))) : [];
      const nonCash = input.refunds.reduce((s, r) => s + r.amount, 0);
      if (methods.some((m) => m.kind === 'CASH') || nonCash > refundTotal) throw new BadRequestException('Refund non-tunai tidak valid');
      const cashPart = refundTotal - nonCash;
      const cashOut = cashPart > 0 ? roundCash(cashPart) : 0;
      const rounding = cashOut - cashPart; // > 0: the store pays a little more
      const [drawer] = await tx
        .select({ balance: sql<number>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::bigint`.mapWith(Number) })
        .from(journalLines)
        .where(eq(journalLines.accountId, terminal.cashAccountId));
      if (cashOut > drawer.balance) throw new BadRequestException('Uang di laci tidak cukup untuk refund tunai');

      const docNo = await this.numbers.next(tx, 'RJ', shift.businessDate);
      await tx.insert(salesReturns).values({ id: input.id, docNo, saleId: sale.id, shiftId: shift.id, reason: input.reason, pinApprovalId, refundAmount: refundTotal, taxAmount: taxTotal, roundingAmount: rounding, businessDate: shift.businessDate, postedBy: actor.userId });
      const ctx = { docType: 'RJ', docId: input.id, businessDate: shift.businessDate, userId: actor.userId };
      const components = await tx.select().from(saleLineComponents).where(inArray(saleLineComponents.saleLineId, plan.filter((p) => p.isBundle).map((p) => p.line.id)));
      const states = await this.stock.lock(tx, [...plan.map((p) => p.line.skuId), ...components.map((c) => c.componentSkuId)]);
      let costTotal = 0;
      for (const p of plan) {
        const [row] = await tx.insert(salesReturnLines).values({ returnId: input.id, saleLineId: p.line.id, baseQty: fromMilli(p.q), condition: p.input.condition, toLocationId: p.toLocationId, refundAmount: p.refund, taxAmount: p.tax, costAmount: p.cost }).returning({ id: salesReturnLines.id });
        if (p.isBundle) {
          let left = p.cost;
          const parts = components.filter((c) => c.saleLineId === p.line.id);
          for (const [i, c] of parts.entries()) {
            const qty = fromMilli(roundDiv(toMilli(c.baseQty) * p.q, toMilli(p.line.baseQty)));
            const value = i === parts.length - 1 ? left : Number(roundDiv(BigInt(c.costAmount) * p.q, toMilli(p.line.baseQty)));
            left -= value;
            await this.stock.receive(tx, ctx, states, { skuId: c.componentSkuId, locationId: p.toLocationId, batchId: null, docLineId: row.id }, qty, value, 'SALE_RETURN');
          }
        } else {
          await this.stock.receive(tx, ctx, states, { skuId: p.line.skuId, locationId: p.toLocationId, batchId: null, docLineId: row.id }, fromMilli(p.q), p.cost, 'SALE_RETURN');
        }
        await tx.update(saleLines).set({ returnedBaseQty: sql`${saleLines.returnedBaseQty} + ${fromMilli(p.q)}::numeric` }).where(eq(saleLines.id, p.line.id));
        costTotal += p.cost;
      }
      for (const r of input.refunds) {
        await tx.insert(salesReturnRefunds).values({ returnId: input.id, paymentMethodId: r.methodId, amount: r.amount, referenceNo: r.referenceNo ?? null });
      }

      const jl: JournalLineInput[] = [{ account: 'SALES_RETURN', debit: refundTotal - taxTotal }];
      if (taxTotal > 0) jl.push({ account: 'VAT_OUT', debit: taxTotal });
      if (cashOut > 0) jl.push({ account: { accountId: terminal.cashAccountId }, credit: cashOut });
      for (const r of input.refunds) jl.push({ account: { accountId: methods.find((m) => m.id === r.methodId)!.accountId! }, credit: r.amount });
      if (rounding > 0) jl.push({ account: 'ROUNDING_LOSS', debit: rounding });
      if (rounding < 0) jl.push({ account: 'ROUNDING_GAIN', credit: -rounding });
      if (costTotal > 0) jl.push({ account: 'INVENTORY', debit: costTotal }, { account: 'COGS', credit: costTotal });
      const journal = await this.journals.post(tx, actor, {
        journalNo: docNo, journalDate: shift.businessDate, source: 'AUTO', sourceDocType: 'RJ', sourceDocId: input.id,
        description: `Retur ${sale.docNo}: ${input.reason}`, lines: jl.filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0),
      });
      await tx.update(salesReturns).set({ journalId: journal.id }).where(eq(salesReturns.id, input.id));
      await this.audit.log({ action: 'post', entityType: 'sales_return', entityId: input.id, userId: actor.userId, pinApprovalId, after: { docNo, refundTotal, cashOut } }, tx);
    });
    const [doc] = await this.db.select().from(salesReturns).where(eq(salesReturns.id, input.id));
    const lines = await this.db.select().from(salesReturnLines).where(eq(salesReturnLines.returnId, input.id));
    return { ...doc, cashRefund: doc.refundAmount + doc.roundingAmount - (await this.db.select().from(salesReturnRefunds).where(eq(salesReturnRefunds.returnId, input.id))).reduce((s, r) => s + r.amount, 0), lines };
  }
}
