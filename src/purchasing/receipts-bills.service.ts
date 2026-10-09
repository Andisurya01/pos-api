import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { PinService } from '../access/pin.service.js';
import { hasPermission, type Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { businessDate } from '../common/business-date.js';
import { isWholeQuantity } from '../common/quantity.js';
import { DB, type Database, type DbTransaction } from '../database/database.module.js';
import {
  goodsReceiptLines,
  goodsReceipts,
  locations,
  purchaseOrderLines,
  purchaseOrders,
  skus,
  skuSupplierPrices,
  skuUnits,
  supplierBillLines,
  supplierBills,
  suppliers,
  units,
} from '../database/schema/index.js';
import { DocumentNumberService } from '../finance/document-number.service.js';
import { type JournalLineInput, JournalService } from '../finance/journal.service.js';
import { StockService } from '../stock/stock.service.js';
import { fromMilli, roundDiv, toMilli } from '../stock/valuation.js';
import { amountOf, baseQtyOf, PurchaseOrdersService } from './purchase-orders.service.js';

export interface ReceiptLineInput {
  poLineId?: string | null;
  skuUnitId?: string | null;
  qty: string;
  unitPrice?: number | null;
  locationId: string;
  batchNo?: string | null;
  expiryDate?: string | null;
}

export interface ReceiptInput {
  id: string;
  supplierId: string;
  poId?: string | null;
  supplierDeliveryNo?: string | null;
  overReceiptPinApprovalId?: string | null;
  lines: ReceiptLineInput[];
  /** Penerimaan langsung only: the supplier's invoice, booked as a bill right away. */
  bill?: { supplierInvoiceNo: string; taxInvoiceNo?: string | null; dueDate?: string | null; taxAmount: number } | null;
}

export interface BillInput {
  id: string;
  supplierId: string;
  supplierInvoiceNo: string;
  taxInvoiceNo?: string | null;
  billDate?: string;
  dueDate?: string | null;
  shippingCost: number;
  taxAmount: number;
  lines: { receiptLineId: string; qty: string; unitPrice: number }[];
}

/** Penerimaan barang (PB) and tagihan supplier (TG), docs/alur/05 §2–4. */
@Injectable()
export class ReceiptsBillsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbers: DocumentNumberService,
    private readonly journals: JournalService,
    private readonly stock: StockService,
    private readonly pos: PurchaseOrdersService,
    private readonly pins: PinService,
  ) {}

  async receive(actor: Principal, input: ReceiptInput) {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: goodsReceipts.id }).from(goodsReceipts).where(eq(goodsReceipts.id, input.id));
      if (existing) return; // idempotent retry
      const supplier = await this.supplier(tx, input.supplierId);
      const isDirect = !input.poId;
      if (isDirect && !hasPermission(actor, 'pembelian.penerimaan_langsung.buat')) {
        throw new ForbiddenException({ message: 'Anda tidak punya izin untuk penerimaan langsung', missingPermissions: ['pembelian.penerimaan_langsung.buat'] });
      }
      if (!isDirect && !hasPermission(actor, 'pembelian.penerimaan.buat')) {
        throw new ForbiddenException({ message: 'Anda tidak punya izin untuk aksi ini', missingPermissions: ['pembelian.penerimaan.buat'] });
      }
      if (isDirect && !input.bill) throw new BadRequestException('Penerimaan langsung wajib menyertakan data tagihan supplier');
      if (!isDirect && input.bill) throw new BadRequestException('Tagihan untuk penerimaan dengan PO dicatat terpisah');

      const lines = isDirect ? await this.directLines(tx, input.lines) : await this.poLines(tx, actor, input);
      await this.assertLocationsAndBatches(tx, lines);

      const date = businessDate();
      const docNo = await this.numbers.next(tx, 'PB', date);
      const ctx = { docType: 'PB', docId: input.id, businessDate: date, userId: actor.userId };
      const states = await this.stock.lock(tx, lines.map((l) => l.skuId));
      const total = lines.reduce((s, l) => s + l.lineValue, 0);
      await tx.insert(goodsReceipts).values({
        id: input.id,
        docNo,
        supplierId: input.supplierId,
        poId: input.poId ?? null,
        isDirect,
        supplierDeliveryNo: input.supplierDeliveryNo ?? null,
        totalValue: total,
        businessDate: date,
        postedBy: actor.userId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });

      let correction = 0;
      const receiptLineIds: string[] = [];
      for (const l of lines) {
        const batchId = l.trackBatch ? await this.stock.resolveBatch(tx, l.skuId, l.batchNo ?? null, l.expiryDate ?? null) : null;
        const [row] = await tx
          .insert(goodsReceiptLines)
          .values({ receiptId: input.id, poLineId: l.poLineId, skuId: l.skuId, skuUnitId: l.skuUnitId, qty: l.qty, baseQty: l.baseQty, unitPrice: l.unitPrice, lineValue: l.lineValue, locationId: l.locationId, batchId })
          .returning({ id: goodsReceiptLines.id });
        receiptLineIds.push(row.id);
        const result = await this.stock.receive(tx, ctx, states, { skuId: l.skuId, locationId: l.locationId, batchId, docLineId: row.id }, l.baseQty, l.lineValue, 'RECEIPT');
        correction += result.correction;
        await this.stock.recordPurchaseCost(tx, l.skuId, unitCostOf(l.lineValue, l.baseQty));
        await tx
          .insert(skuSupplierPrices)
          .values({ skuUnitId: l.skuUnitId, supplierId: input.supplierId, lastPrice: l.unitPrice, lastReceiptId: input.id })
          .onConflictDoUpdate({
            target: [skuSupplierPrices.skuUnitId, skuSupplierPrices.supplierId],
            set: { lastPrice: l.unitPrice, lastReceiptId: input.id, updatedAt: new Date() },
          });
        if (l.poLineId) {
          await tx
            .update(purchaseOrderLines)
            .set({ receivedBaseQty: sql`${purchaseOrderLines.receivedBaseQty} + ${l.baseQty}::numeric` })
            .where(eq(purchaseOrderLines.id, l.poLineId));
        }
      }

      const journalLines: JournalLineInput[] = [];
      if (total > 0) journalLines.push({ account: 'INVENTORY', debit: total }, { account: 'GRNI', credit: total });
      if (correction !== 0) {
        journalLines.push(
          { account: correction > 0 ? 'COGS' : 'INVENTORY', debit: Math.abs(correction) },
          { account: correction > 0 ? 'INVENTORY' : 'COGS', credit: Math.abs(correction) },
        );
      }
      const journal = journalLines.length
        ? await this.journals.post(tx, actor, { journalNo: docNo, journalDate: date, source: 'AUTO', sourceDocType: 'PB', sourceDocId: input.id, description: `Penerimaan barang ${docNo} — ${supplier.name}`, lines: journalLines })
        : null;
      if (journal) await tx.update(goodsReceipts).set({ journalId: journal.id }).where(eq(goodsReceipts.id, input.id));

      if (input.poId) await this.refreshPoStatus(tx, input.poId);
      await this.audit.log({ action: 'post', entityType: 'goods_receipt', entityId: input.id, userId: actor.userId, after: { docNo, total } }, tx);

      if (isDirect && input.bill) {
        await this.postBill(tx, actor, {
          id: crypto.randomUUID(),
          supplierId: input.supplierId,
          supplierInvoiceNo: input.bill.supplierInvoiceNo,
          taxInvoiceNo: input.bill.taxInvoiceNo,
          dueDate: input.bill.dueDate,
          shippingCost: 0,
          taxAmount: input.bill.taxAmount,
          lines: lines.map((l, i) => ({ receiptLineId: receiptLineIds[i], qty: l.qty, unitPrice: l.unitPrice })),
        }, input.id);
      }
    });
    return this.receiptDetail(input.id);
  }

  async bill(actor: Principal, input: BillInput) {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: supplierBills.id }).from(supplierBills).where(eq(supplierBills.id, input.id));
      if (existing) return;
      await this.postBill(tx, actor, input, null);
    });
    return this.billDetail(input.id);
  }

  /**
   * Three-way match: billed quantity ≤ received − billed − returned; a price different from
   * the receipt, plus shipping, re-values the stock (or HPP once it is sold out).
   */
  private async postBill(tx: DbTransaction, actor: Principal, input: BillInput, directReceiptId: string | null) {
    const supplier = await this.supplier(tx, input.supplierId);
    if (!supplier.isPkp && input.taxAmount > 0) throw new BadRequestException('Supplier non-PKP tidak memungut PPN');
    if (input.lines.length === 0) throw new BadRequestException('Minimal satu baris tagihan');
    const receiptLines = await tx
      .select({ ...getTableColumns(goodsReceiptLines), supplierId: goodsReceipts.supplierId, factor: skuUnits.factor })
      .from(goodsReceiptLines)
      .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptLines.receiptId))
      .innerJoin(skuUnits, eq(skuUnits.id, goodsReceiptLines.skuUnitId))
      .where(inArray(goodsReceiptLines.id, input.lines.map((l) => l.receiptLineId)))
      .for('update', { of: goodsReceiptLines });

    const date = input.billDate ?? businessDate();
    const lines = [];
    for (const [i, l] of input.lines.entries()) {
      const rl = receiptLines.find((r) => r.id === l.receiptLineId);
      if (!rl || rl.supplierId !== input.supplierId) throw new BadRequestException(`Baris ${i + 1}: penerimaan tidak ditemukan untuk supplier ini`);
      const base = baseQtyOf(l.qty, rl.factor);
      const open = toMilli(rl.baseQty) - toMilli(rl.billedBaseQty) - toMilli(rl.returnedBaseQty);
      if (toMilli(base) > open) throw new BadRequestException(`Baris ${i + 1}: jumlah melebihi barang yang diterima dan belum ditagih (${fromMilli(open)})`);
      const [{ billedValue }] = await tx
        .select({ billedValue: sql<number>`coalesce(sum(${supplierBillLines.receiptValue}), 0)::bigint`.mapWith(Number) })
        .from(supplierBillLines)
        .where(eq(supplierBillLines.receiptLineId, rl.id));
      // The last part billed takes exactly what is left of the receipt value.
      const closes = toMilli(base) === open && toMilli(rl.returnedBaseQty) === 0n;
      const receiptValue = closes ? rl.lineValue - billedValue : Number(roundDiv(BigInt(rl.lineValue) * toMilli(base), toMilli(rl.baseQty)));
      const lineAmount = amountOf(l.qty, l.unitPrice);
      lines.push({ rl, qty: l.qty, base, unitPrice: l.unitPrice, lineAmount, receiptValue, priceVariance: lineAmount - receiptValue, allocatedShipping: 0 });
    }
    const subtotal = lines.reduce((s, l) => s + l.lineAmount, 0);
    let left = input.shippingCost;
    lines.forEach((l, i) => {
      const share = i === lines.length - 1 ? left : subtotal ? Number(roundDiv(BigInt(input.shippingCost) * BigInt(l.lineAmount), BigInt(subtotal))) : 0;
      l.allocatedShipping = share;
      left -= share;
    });
    const hasVariance = lines.some((l) => l.priceVariance !== 0);
    if (hasVariance && !hasPermission(actor, 'pembelian.tagihan.setujui_selisih')) {
      throw new ForbiddenException({ message: 'Harga tagihan berbeda dengan penerimaan; perlu persetujuan selisih', missingPermissions: ['pembelian.tagihan.setujui_selisih'] });
    }

    const docNo = await this.numbers.next(tx, 'TG', date);
    const total = subtotal + input.shippingCost + input.taxAmount;
    await tx.insert(supplierBills).values({
      id: input.id,
      docNo,
      supplierId: input.supplierId,
      supplierInvoiceNo: input.supplierInvoiceNo,
      taxInvoiceNo: input.taxInvoiceNo ?? null,
      billDate: date,
      dueDate: input.dueDate ?? addDays(date, supplier.paymentTermDays),
      subtotal,
      shippingCost: input.shippingCost,
      taxAmount: input.taxAmount,
      total,
      varianceApprovedBy: hasVariance ? actor.userId : null,
      businessDate: date,
      postedBy: actor.userId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });

    const ctx = { docType: 'TG', docId: input.id, businessDate: date, userId: actor.userId };
    const states = await this.stock.lock(tx, lines.map((l) => l.rl.skuId));
    let inventoryAdj = 0;
    let cogsAdj = 0;
    for (const l of lines) {
      const [row] = await tx
        .insert(supplierBillLines)
        .values({ billId: input.id, receiptLineId: l.rl.id, qty: l.qty, baseQty: l.base, unitPrice: l.unitPrice, lineAmount: l.lineAmount, receiptValue: l.receiptValue, priceVariance: l.priceVariance, allocatedShipping: l.allocatedShipping })
        .returning({ id: supplierBillLines.id });
      await tx
        .update(goodsReceiptLines)
        .set({ billedBaseQty: sql`${goodsReceiptLines.billedBaseQty} + ${l.base}::numeric` })
        .where(eq(goodsReceiptLines.id, l.rl.id));
      const adj = l.priceVariance + l.allocatedShipping;
      if (await this.stock.adjustValue(tx, ctx, states, l.rl.skuId, adj, row.id)) inventoryAdj += adj;
      else cogsAdj += adj;
    }

    const grni = lines.reduce((s, l) => s + l.receiptValue, 0);
    const jl: JournalLineInput[] = [];
    if (grni > 0) jl.push({ account: 'GRNI', debit: grni });
    if (input.taxAmount > 0) jl.push({ account: 'VAT_IN', debit: input.taxAmount });
    for (const [account, amount] of [['INVENTORY', inventoryAdj], ['COGS', cogsAdj]] as const) {
      if (amount > 0) jl.push({ account, debit: amount });
      if (amount < 0) jl.push({ account, credit: -amount });
    }
    jl.push({ account: 'ACCOUNTS_PAYABLE', credit: total, supplierId: input.supplierId });
    const journal = await this.journals.post(tx, actor, { journalNo: docNo, journalDate: date, source: 'AUTO', sourceDocType: 'TG', sourceDocId: input.id, description: `Tagihan ${input.supplierInvoiceNo} — ${supplier.name}`, lines: jl });
    await tx.update(supplierBills).set({ journalId: journal.id }).where(eq(supplierBills.id, input.id));
    await this.audit.log({ action: 'post', entityType: 'supplier_bill', entityId: input.id, userId: actor.userId, after: { docNo, total, directReceiptId } }, tx);
  }

  async receiptDetail(id: string) {
    const [doc] = await this.db.select().from(goodsReceipts).where(eq(goodsReceipts.id, id));
    if (!doc) throw new NotFoundException('Penerimaan tidak ditemukan');
    const lines = await this.db
      .select({ ...getTableColumns(goodsReceiptLines), unitCode: units.code })
      .from(goodsReceiptLines)
      .innerJoin(skuUnits, eq(skuUnits.id, goodsReceiptLines.skuUnitId))
      .innerJoin(units, eq(units.id, skuUnits.unitId))
      .where(eq(goodsReceiptLines.receiptId, id));
    const [bill] = doc.isDirect
      ? await this.db.select({ id: supplierBillLines.billId }).from(supplierBillLines).where(inArray(supplierBillLines.receiptLineId, lines.map((l) => l.id))).limit(1)
      : [];
    return { ...doc, lines, directBillId: bill?.id ?? null };
  }

  async billDetail(id: string) {
    const [doc] = await this.db.select().from(supplierBills).where(eq(supplierBills.id, id));
    if (!doc) throw new NotFoundException('Tagihan tidak ditemukan');
    const lines = await this.db.select().from(supplierBillLines).where(eq(supplierBillLines.billId, id));
    return { ...doc, outstanding: doc.total - doc.paidAmount, lines };
  }

  /** Open bills of a supplier, nearest due date first (payment screen). */
  listOpenBills(supplierId: string) {
    return this.db
      .select({ ...getTableColumns(supplierBills), outstanding: sql<number>`${supplierBills.total} - ${supplierBills.paidAmount}`.mapWith(Number) })
      .from(supplierBills)
      .where(and(eq(supplierBills.supplierId, supplierId), sql`${supplierBills.status} <> 'PAID'`))
      .orderBy(supplierBills.dueDate);
  }

  // ----------------------------------------------------------------- helpers

  private async supplier(tx: DbTransaction, id: string) {
    const [s] = await tx.select().from(suppliers).where(eq(suppliers.id, id));
    if (!s?.isActive) throw new BadRequestException('Supplier tidak ditemukan atau nonaktif');
    return s;
  }

  private async poLines(tx: DbTransaction, actor: Principal, input: ReceiptInput) {
    const po = await this.pos.lock(tx, input.poId!);
    if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) throw new BadRequestException('PO belum disetujui atau sudah selesai');
    if (po.supplierId !== input.supplierId) throw new BadRequestException('Supplier berbeda dengan PO');
    const poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, po.id));
    const info = await this.skuInfo(tx, poLines.map((l) => l.skuUnitId));
    let over = false;
    const lines = input.lines.map((l, i) => {
      const pl = poLines.find((p) => p.id === l.poLineId);
      if (!pl) throw new BadRequestException(`Baris ${i + 1}: baris PO tidak ditemukan`);
      const sku = info.get(pl.skuUnitId)!;
      const baseQty = baseQtyOf(l.qty, sku.factor);
      if (toMilli(pl.receivedBaseQty) + toMilli(baseQty) > toMilli(pl.baseQty)) over = true;
      return { ...sku, poLineId: pl.id, skuUnitId: pl.skuUnitId, qty: l.qty, baseQty, unitPrice: pl.unitPrice, lineValue: amountOf(l.qty, pl.unitPrice), locationId: l.locationId, batchNo: l.batchNo, expiryDate: l.expiryDate };
    });
    if (over) {
      await this.pins.authorize(tx, actor, 'pembelian.penerimaan.lebih_dari_po', input.overReceiptPinApprovalId, { type: 'goods_receipt', id: input.id });
    }
    return lines;
  }

  private async directLines(tx: DbTransaction, lines: ReceiptLineInput[]) {
    const info = await this.skuInfo(tx, lines.map((l) => l.skuUnitId ?? ''));
    return lines.map((l, i) => {
      const sku = l.skuUnitId ? info.get(l.skuUnitId) : undefined;
      if (!sku || l.unitPrice == null) throw new BadRequestException(`Baris ${i + 1}: isi barang dan harga beli`);
      return { ...sku, poLineId: null, skuUnitId: l.skuUnitId!, qty: l.qty, baseQty: baseQtyOf(l.qty, sku.factor), unitPrice: l.unitPrice, lineValue: amountOf(l.qty, l.unitPrice), locationId: l.locationId, batchNo: l.batchNo, expiryDate: l.expiryDate };
    });
  }

  private async skuInfo(tx: DbTransaction, skuUnitIds: string[]) {
    const ids = [...new Set(skuUnitIds.filter(Boolean))];
    const rows = ids.length
      ? await tx
          .select({ skuUnitId: skuUnits.id, skuId: skus.id, factor: skuUnits.factor, isPurchasable: skus.isPurchasable, trackBatch: skus.trackBatch, allowsDecimal: units.allowsDecimal })
          .from(skuUnits)
          .innerJoin(skus, eq(skus.id, skuUnits.skuId))
          .innerJoin(units, eq(units.id, skuUnits.unitId))
          .where(inArray(skuUnits.id, ids))
      : [];
    return new Map(rows.filter((r) => r.isPurchasable).map((r) => [r.skuUnitId, r]));
  }

  private async assertLocationsAndBatches(
    tx: DbTransaction,
    lines: { locationId: string; qty: string; trackBatch: boolean; allowsDecimal: boolean; batchNo?: string | null; expiryDate?: string | null }[],
  ) {
    if (lines.length === 0) throw new BadRequestException('Minimal satu baris barang');
    const locs = await tx.select().from(locations).where(inArray(locations.id, [...new Set(lines.map((l) => l.locationId))]));
    for (const [i, l] of lines.entries()) {
      const loc = locs.find((x) => x.id === l.locationId);
      if (!loc?.isActive || loc.type === 'TRANSIT' || loc.type === 'DAMAGED') throw new BadRequestException(`Baris ${i + 1}: lokasi simpan tidak valid`);
      if (toMilli(l.qty) <= 0n) throw new BadRequestException(`Baris ${i + 1}: jumlah harus lebih dari 0`);
      if (!l.allowsDecimal && !isWholeQuantity(l.qty)) throw new BadRequestException(`Baris ${i + 1}: jumlah harus bilangan bulat`);
      if (l.trackBatch && !l.batchNo && !l.expiryDate) throw new BadRequestException(`Baris ${i + 1}: isi nomor batch atau tanggal kedaluwarsa`);
    }
  }

  private async refreshPoStatus(tx: DbTransaction, poId: string) {
    const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));
    const done = lines.every((l) => toMilli(l.receivedBaseQty) >= toMilli(l.baseQty));
    await tx.update(purchaseOrders).set({ status: done ? 'RECEIVED' : 'PARTIALLY_RECEIVED', updatedAt: new Date() }).where(eq(purchaseOrders.id, poId));
  }
}

/** Purchase cost per base unit, 4 decimals (harga beli terakhir/tertinggi). */
function unitCostOf(lineValue: number, baseQty: string) {
  const scaled = roundDiv(BigInt(lineValue) * 10_000_000n, toMilli(baseQty)); // ×10^4 ×10^3 milli
  return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, '0')}`;
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
