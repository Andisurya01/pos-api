import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { businessDate } from '../common/business-date.js';
import { DB, type Database, type DbTransaction } from '../database/database.module.js';
import {
  accounts,
  goodsReceiptLines,
  goodsReceipts,
  locations,
  purchaseReturnLines,
  purchaseReturns,
  skus,
  supplierBills,
  supplierPaymentAllocations,
  supplierPayments,
  suppliers,
} from '../database/schema/index.js';
import { DocumentNumberService } from '../finance/document-number.service.js';
import { type JournalLineInput, JournalService } from '../finance/journal.service.js';
import { StockService } from '../stock/stock.service.js';
import { fromMilli, roundDiv, toMilli } from '../stock/valuation.js';

export interface PaymentInput {
  id: string;
  supplierId: string;
  paymentDate?: string;
  sourceAccountId: string;
  bankFee: number;
  referenceNo?: string | null;
  allocations: { billId: string; amount: number }[];
  debitNotes: { purchaseReturnId: string; billId: string; amount: number }[];
}

export interface ReturnInput {
  id: string;
  supplierId: string;
  fromLocationId: string;
  taxAmount: number;
  note?: string | null;
  lines: { receiptLineId?: string | null; skuId?: string | null; batchId?: string | null; baseQty: string; lineAmount?: number | null }[];
}

/** Pembayaran hutang (BH) and retur pembelian (RB), docs/alur/05 §5–6. */
@Injectable()
export class PaymentsReturnsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbers: DocumentNumberService,
    private readonly journals: JournalService,
    private readonly stock: StockService,
  ) {}

  /**
   * Money allocations reduce the payable through the journal; debit notes were already
   * booked against the payable when the return was posted, so they only settle bills.
   */
  async pay(actor: Principal, input: PaymentInput) {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: supplierPayments.id }).from(supplierPayments).where(eq(supplierPayments.id, input.id));
      if (existing) return;
      const supplier = await this.supplier(tx, input.supplierId);
      const [source] = await tx.select().from(accounts).where(eq(accounts.id, input.sourceAccountId));
      if (!source?.isActive || !source.isPostable || !['CASH', 'PETTY_CASH', 'BANK'].includes(source.cashKind ?? '')) {
        throw new BadRequestException('Sumber dana harus akun kas atau bank yang aktif');
      }
      const cash = input.allocations.reduce((s, a) => s + a.amount, 0);
      if (cash === 0 && input.debitNotes.length === 0) throw new BadRequestException('Isi jumlah pembayaran');

      const billIds = [...new Set([...input.allocations, ...input.debitNotes].map((a) => a.billId))];
      const bills = await tx.select().from(supplierBills).where(inArray(supplierBills.id, billIds)).for('update');
      const applied = new Map<string, number>();
      for (const a of [...input.allocations, ...input.debitNotes]) {
        const bill = bills.find((b) => b.id === a.billId);
        if (!bill || bill.supplierId !== input.supplierId) throw new BadRequestException('Tagihan tidak ditemukan untuk supplier ini');
        if (a.amount <= 0) throw new BadRequestException('Jumlah alokasi harus lebih dari 0');
        applied.set(bill.id, (applied.get(bill.id) ?? 0) + a.amount);
      }
      for (const bill of bills) {
        if ((applied.get(bill.id) ?? 0) > bill.total - bill.paidAmount) {
          throw new BadRequestException(`Pembayaran melebihi sisa tagihan ${bill.supplierInvoiceNo}`);
        }
      }
      const returns = input.debitNotes.length
        ? await tx.select().from(purchaseReturns).where(inArray(purchaseReturns.id, input.debitNotes.map((d) => d.purchaseReturnId))).for('update')
        : [];
      for (const r of returns) {
        const use = input.debitNotes.filter((d) => d.purchaseReturnId === r.id).reduce((s, d) => s + d.amount, 0);
        if (r.supplierId !== input.supplierId || r.reduces !== 'PAYABLE') throw new BadRequestException('Nota debit tidak bisa dipakai untuk supplier ini');
        if (use > r.debitNoteAmount - r.appliedAmount) throw new BadRequestException(`Sisa nota debit ${r.docNo} tidak cukup`);
        await tx.update(purchaseReturns).set({ appliedAmount: r.appliedAmount + use }).where(eq(purchaseReturns.id, r.id));
      }
      if (returns.length !== new Set(input.debitNotes.map((d) => d.purchaseReturnId)).size) throw new BadRequestException('Nota debit tidak ditemukan');

      const date = input.paymentDate ?? businessDate();
      const docNo = await this.numbers.next(tx, 'BH', date);
      await tx.insert(supplierPayments).values({
        id: input.id, docNo, supplierId: input.supplierId, paymentDate: date, sourceAccountId: source.id, amount: cash, bankFee: input.bankFee,
        referenceNo: input.referenceNo ?? null, businessDate: date, postedBy: actor.userId, createdBy: actor.userId, updatedBy: actor.userId,
      });
      await tx.insert(supplierPaymentAllocations).values([
        ...input.allocations.map((a) => ({ paymentId: input.id, billId: a.billId, amount: a.amount })),
        ...input.debitNotes.map((d) => ({ paymentId: input.id, billId: d.billId, amount: d.amount, purchaseReturnId: d.purchaseReturnId })),
      ]);
      for (const bill of bills) {
        const paid = bill.paidAmount + (applied.get(bill.id) ?? 0);
        await tx
          .update(supplierBills)
          .set({ paidAmount: paid, status: paid >= bill.total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'POSTED', updatedAt: new Date() })
          .where(eq(supplierBills.id, bill.id));
      }

      const jl: JournalLineInput[] = [];
      if (cash > 0) jl.push({ account: 'ACCOUNTS_PAYABLE', debit: cash, supplierId: input.supplierId }, { account: { accountId: source.id }, credit: cash });
      if (input.bankFee > 0) jl.push({ account: 'BANK_FEE', debit: input.bankFee }, { account: { accountId: source.id }, credit: input.bankFee });
      if (jl.length) {
        const journal = await this.journals.post(tx, actor, { journalNo: docNo, journalDate: date, source: 'AUTO', sourceDocType: 'BH', sourceDocId: input.id, description: `Pembayaran hutang ${docNo} — ${supplier.name}`, lines: jl });
        await tx.update(supplierPayments).set({ journalId: journal.id }).where(eq(supplierPayments.id, input.id));
      }
      await this.audit.log({ action: 'post', entityType: 'supplier_payment', entityId: input.id, userId: actor.userId, after: { docNo, cash, debitNotes: input.debitNotes.length } }, tx);
    });
    return this.paymentDetail(input.id);
  }

  /**
   * Goods go back at moving-average cost; the supplier owes the agreed price. Returns of
   * goods not yet billed reduce "barang diterima belum ditagih", otherwise the payable.
   */
  async returnGoods(actor: Principal, input: ReturnInput) {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: purchaseReturns.id }).from(purchaseReturns).where(eq(purchaseReturns.id, input.id));
      if (existing) return;
      const supplier = await this.supplier(tx, input.supplierId);
      if (!supplier.isPkp && input.taxAmount > 0) throw new BadRequestException('Supplier non-PKP tidak memungut PPN');
      const [loc] = await tx.select().from(locations).where(eq(locations.id, input.fromLocationId));
      if (!loc?.isActive || loc.type === 'TRANSIT') throw new BadRequestException('Lokasi asal tidak valid');
      if (input.lines.length === 0) throw new BadRequestException('Minimal satu baris barang');

      const receiptLineIds = input.lines.map((l) => l.receiptLineId).filter((x): x is string => Boolean(x));
      const receiptLines = receiptLineIds.length
        ? await tx
            .select({ ...getTableColumns(goodsReceiptLines), supplierId: goodsReceipts.supplierId })
            .from(goodsReceiptLines)
            .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptLines.receiptId))
            .where(inArray(goodsReceiptLines.id, receiptLineIds))
            .for('update', { of: goodsReceiptLines })
        : [];
      const lines = await Promise.all(
        input.lines.map(async (l, i) => {
          const at = `Baris ${i + 1}: `;
          const rl = l.receiptLineId ? receiptLines.find((r) => r.id === l.receiptLineId) : undefined;
          if (l.receiptLineId && (!rl || rl.supplierId !== input.supplierId)) throw new BadRequestException(`${at}penerimaan tidak ditemukan untuk supplier ini`);
          const skuId = rl?.skuId ?? l.skuId;
          if (!skuId) throw new BadRequestException(`${at}pilih barang`);
          const [sku] = await tx.select({ trackBatch: skus.trackBatch }).from(skus).where(eq(skus.id, skuId));
          const batchId = l.batchId ?? rl?.batchId ?? null;
          if (sku?.trackBatch && !batchId) throw new BadRequestException(`${at}pilih batch`);
          if (rl && toMilli(l.baseQty) > toMilli(rl.baseQty) - toMilli(rl.returnedBaseQty)) throw new BadRequestException(`${at}melebihi jumlah yang diterima`);
          const lineAmount = l.lineAmount ?? (rl ? Number(roundDiv(BigInt(rl.lineValue) * toMilli(l.baseQty), toMilli(rl.baseQty))) : null);
          if (lineAmount == null) throw new BadRequestException(`${at}isi nilai retur yang disepakati`);
          const unbilled = rl ? toMilli(rl.baseQty) - toMilli(rl.billedBaseQty) - toMilli(rl.returnedBaseQty) : -1n;
          return { rl, skuId, batchId, baseQty: l.baseQty, lineAmount, againstGrni: unbilled >= toMilli(l.baseQty) };
        }),
      );
      const reduces = lines.every((l) => l.againstGrni) ? 'GRNI' : 'PAYABLE';
      if (reduces === 'GRNI' && input.taxAmount > 0) throw new BadRequestException('Barang yang belum ditagih tidak punya PPN untuk dikembalikan');

      const date = businessDate();
      const docNo = await this.numbers.next(tx, 'RB', date);
      const total = lines.reduce((s, l) => s + l.lineAmount, 0) + input.taxAmount;
      await tx.insert(purchaseReturns).values({
        id: input.id, docNo, supplierId: input.supplierId, fromLocationId: input.fromLocationId, reduces, debitNoteAmount: total, taxAmount: input.taxAmount,
        note: input.note ?? null, businessDate: date, postedBy: actor.userId, createdBy: actor.userId, updatedBy: actor.userId,
      });
      const ctx = { docType: 'RB', docId: input.id, businessDate: date, userId: actor.userId };
      const states = await this.stock.lock(tx, lines.map((l) => l.skuId));
      let cost = 0;
      for (const l of lines) {
        const [row] = await tx
          .insert(purchaseReturnLines)
          .values({ returnId: input.id, receiptLineId: l.rl?.id ?? null, skuId: l.skuId, batchId: l.batchId, baseQty: l.baseQty, lineAmount: l.lineAmount, costAmount: 0, variance: 0 })
          .returning({ id: purchaseReturnLines.id });
        const issued = await this.stock.issue(tx, ctx, states, { skuId: l.skuId, locationId: input.fromLocationId, batchId: l.batchId, docLineId: row.id }, l.baseQty, 'PURCHASE_RETURN');
        cost += issued.cost;
        await tx.update(purchaseReturnLines).set({ costAmount: issued.cost, variance: l.lineAmount - issued.cost }).where(eq(purchaseReturnLines.id, row.id));
        if (l.rl) {
          await tx
            .update(goodsReceiptLines)
            .set({ returnedBaseQty: sql`${goodsReceiptLines.returnedBaseQty} + ${l.baseQty}::numeric` })
            .where(eq(goodsReceiptLines.id, l.rl.id));
        }
      }

      const variance = total - input.taxAmount - cost;
      const jl: JournalLineInput[] = [
        reduces === 'GRNI'
          ? { account: 'GRNI', debit: total }
          : { account: 'ACCOUNTS_PAYABLE', debit: total, supplierId: input.supplierId },
        { account: 'INVENTORY', credit: cost },
      ];
      if (input.taxAmount > 0) jl.push({ account: 'VAT_IN', credit: input.taxAmount });
      if (variance > 0) jl.push({ account: 'PURCHASE_RETURN_VARIANCE', credit: variance });
      if (variance < 0) jl.push({ account: 'PURCHASE_RETURN_VARIANCE', debit: -variance });
      const journal = await this.journals.post(tx, actor, {
        journalNo: docNo, journalDate: date, source: 'AUTO', sourceDocType: 'RB', sourceDocId: input.id,
        description: `Retur pembelian ${docNo} — ${supplier.name}`, lines: jl.filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0),
      });
      await tx.update(purchaseReturns).set({ journalId: journal.id }).where(eq(purchaseReturns.id, input.id));
      await this.audit.log({ action: 'post', entityType: 'purchase_return', entityId: input.id, userId: actor.userId, after: { docNo, reduces, total, cost } }, tx);
    });
    return this.returnDetail(input.id);
  }

  async paymentDetail(id: string) {
    const [doc] = await this.db.select().from(supplierPayments).where(eq(supplierPayments.id, id));
    if (!doc) throw new NotFoundException('Pembayaran tidak ditemukan');
    const allocations = await this.db.select().from(supplierPaymentAllocations).where(eq(supplierPaymentAllocations.paymentId, id));
    return { ...doc, allocations };
  }

  async returnDetail(id: string) {
    const [doc] = await this.db.select().from(purchaseReturns).where(eq(purchaseReturns.id, id));
    if (!doc) throw new NotFoundException('Retur tidak ditemukan');
    const lines = await this.db.select().from(purchaseReturnLines).where(eq(purchaseReturnLines.returnId, id));
    return { ...doc, remainingDebitNote: doc.debitNoteAmount - doc.appliedAmount, lines: lines.map((l) => ({ ...l, baseQty: fromMilli(toMilli(l.baseQty)) })) };
  }

  private async supplier(tx: DbTransaction, id: string) {
    const [s] = await tx.select().from(suppliers).where(eq(suppliers.id, id));
    if (!s) throw new BadRequestException('Supplier tidak ditemukan');
    return s;
  }
}
