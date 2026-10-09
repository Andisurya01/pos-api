import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, getTableColumns, inArray, type SQL } from 'drizzle-orm';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { businessDate } from '../common/business-date.js';
import { isWholeQuantity } from '../common/quantity.js';
import { DB, type Database, type DbTransaction } from '../database/database.module.js';
import {
  purchaseOrderLines,
  purchaseOrders,
  skus,
  skuUnits,
  suppliers,
  units,
} from '../database/schema/index.js';
import { DocumentNumberService } from '../finance/document-number.service.js';
import { fromMilli, toMilli } from '../stock/valuation.js';

export interface PoLineInput {
  skuUnitId: string;
  qty: string;
  unitPrice: number;
}

export interface PoInput {
  id: string;
  supplierId: string;
  orderDate?: string;
  expectedDate?: string | null;
  note?: string | null;
  lines: PoLineInput[];
}

type PoStatus = (typeof purchaseOrders.$inferSelect)['status'];

/** Purchase orders (docs/alur/05 §1). No stock or journal effect; numbered at approval. */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbers: DocumentNumberService,
  ) {}

  async create(actor: Principal, input: PoInput) {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, input.id));
      if (existing) return;
      await this.assertSupplier(tx, input.supplierId);
      const lines = await this.buildLines(tx, input.lines);
      await tx.insert(purchaseOrders).values({
        id: input.id,
        docNo: `DRAFT-${input.id.slice(0, 8)}`,
        supplierId: input.supplierId,
        orderDate: input.orderDate ?? businessDate(),
        expectedDate: input.expectedDate ?? null,
        note: input.note ?? null,
        subtotal: lines.reduce((s, l) => s + l.lineAmount, 0),
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      await tx.insert(purchaseOrderLines).values(lines.map((l) => ({ ...l, poId: input.id })));
    });
    return this.detail(input.id);
  }

  /** Editing is only possible before any goods arrive; an approved PO goes back to draft. */
  async update(actor: Principal, id: string, input: Omit<PoInput, 'id'>) {
    await this.db.transaction(async (tx) => {
      const po = await this.lock(tx, id);
      if (!['DRAFT', 'APPROVED'].includes(po.status)) {
        throw new BadRequestException('PO hanya bisa diubah selama belum ada barang yang diterima');
      }
      await this.assertSupplier(tx, input.supplierId);
      const lines = await this.buildLines(tx, input.lines);
      await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.poId, id));
      await tx.insert(purchaseOrderLines).values(lines.map((l) => ({ ...l, poId: id })));
      await tx
        .update(purchaseOrders)
        .set({
          status: 'DRAFT',
          supplierId: input.supplierId,
          expectedDate: input.expectedDate ?? null,
          note: input.note ?? null,
          subtotal: lines.reduce((s, l) => s + l.lineAmount, 0),
          approvedAt: null,
          approvedBy: null,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(purchaseOrders.id, id));
      await this.audit.log({ action: 'po.update', entityType: 'purchase_order', entityId: id, userId: actor.userId, before: po, after: input }, tx);
    });
    return this.detail(id);
  }

  submit(actor: Principal, id: string) {
    return this.move(actor, id, ['DRAFT'], { status: 'PENDING_APPROVAL', submittedAt: new Date(), submittedBy: actor.userId, rejectedReason: null });
  }

  reject(actor: Principal, id: string, reason: string) {
    return this.move(actor, id, ['PENDING_APPROVAL'], { status: 'DRAFT', rejectedReason: reason });
  }

  cancel(actor: Principal, id: string) {
    return this.move(actor, id, ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'], { status: 'CANCELLED' });
  }

  /** "Tutup sisa": the remaining quantity will not come; receipts so far stay. */
  close(actor: Principal, id: string, reason: string) {
    return this.move(actor, id, ['PARTIALLY_RECEIVED'], { status: 'CLOSED', closedReason: reason });
  }

  async approve(actor: Principal, id: string) {
    await this.db.transaction(async (tx) => {
      const po = await this.lock(tx, id);
      if (po.status !== 'PENDING_APPROVAL') throw new BadRequestException('PO tidak menunggu persetujuan');
      // A PO approved before (then edited) keeps its number.
      const docNo = po.docNo.startsWith('DRAFT-') ? await this.numbers.next(tx, 'PO', businessDate()) : po.docNo;
      await tx
        .update(purchaseOrders)
        .set({ docNo, status: 'APPROVED', approvedAt: new Date(), approvedBy: actor.userId, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(purchaseOrders.id, id));
      await this.audit.log({ action: 'po.approve', entityType: 'purchase_order', entityId: id, userId: actor.userId, after: { docNo } }, tx);
    });
    return this.detail(id);
  }

  async list(query: { supplierId?: string; status?: PoStatus }) {
    const filters: SQL[] = [];
    if (query.supplierId) filters.push(eq(purchaseOrders.supplierId, query.supplierId));
    if (query.status) filters.push(eq(purchaseOrders.status, query.status));
    return this.db
      .select({ ...getTableColumns(purchaseOrders), supplierName: suppliers.name })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
      .where(and(...filters))
      .orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrders.createdAt));
  }

  async detail(id: string) {
    const [po] = await this.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
    if (!po) throw new NotFoundException('PO tidak ditemukan');
    const lines = await this.db
      .select({ ...getTableColumns(purchaseOrderLines), unitCode: units.code })
      .from(purchaseOrderLines)
      .innerJoin(skuUnits, eq(skuUnits.id, purchaseOrderLines.skuUnitId))
      .innerJoin(units, eq(units.id, skuUnits.unitId))
      .where(eq(purchaseOrderLines.poId, id));
    return {
      ...po,
      lines: lines.map((l) => ({ ...l, remainingBaseQty: fromMilli(toMilli(l.baseQty) - toMilli(l.receivedBaseQty)) })),
    };
  }

  // ----------------------------------------------------------------- helpers

  private async move(actor: Principal, id: string, from: PoStatus[], set: Partial<typeof purchaseOrders.$inferInsert>) {
    await this.db.transaction(async (tx) => {
      const po = await this.lock(tx, id);
      if (!from.includes(po.status)) throw new BadRequestException('Status PO tidak sesuai untuk aksi ini');
      await tx.update(purchaseOrders).set({ ...set, updatedAt: new Date(), updatedBy: actor.userId }).where(eq(purchaseOrders.id, id));
      await this.audit.log({ action: `po.${String(set.status).toLowerCase()}`, entityType: 'purchase_order', entityId: id, userId: actor.userId, before: { status: po.status }, after: set }, tx);
    });
    return this.detail(id);
  }

  async lock(tx: DbTransaction, id: string) {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for('update');
    if (!po) throw new NotFoundException('PO tidak ditemukan');
    return po;
  }

  private async assertSupplier(tx: DbTransaction, supplierId: string) {
    const [s] = await tx.select({ isActive: suppliers.isActive }).from(suppliers).where(eq(suppliers.id, supplierId));
    if (!s?.isActive) throw new BadRequestException('Supplier tidak ditemukan atau nonaktif');
  }

  /** Resolves units, base quantities and amounts; only purchasable SKUs. */
  private async buildLines(tx: DbTransaction, lines: PoLineInput[]) {
    if (lines.length === 0) throw new BadRequestException('Minimal satu baris barang');
    const rows = await tx
      .select({ skuUnitId: skuUnits.id, skuId: skus.id, factor: skuUnits.factor, isPurchasable: skus.isPurchasable, allowsDecimal: units.allowsDecimal })
      .from(skuUnits)
      .innerJoin(skus, eq(skus.id, skuUnits.skuId))
      .innerJoin(units, eq(units.id, skuUnits.unitId))
      .where(inArray(skuUnits.id, [...new Set(lines.map((l) => l.skuUnitId))]));
    return lines.map((l, i) => {
      const row = rows.find((r) => r.skuUnitId === l.skuUnitId);
      if (!row?.isPurchasable) throw new BadRequestException(`Baris ${i + 1}: barang tidak bisa dibeli`);
      if (!row.allowsDecimal && !isWholeQuantity(l.qty)) throw new BadRequestException(`Baris ${i + 1}: jumlah harus bilangan bulat`);
      return {
        skuId: row.skuId,
        skuUnitId: l.skuUnitId,
        qty: l.qty,
        baseQty: baseQtyOf(l.qty, row.factor),
        unitPrice: l.unitPrice,
        lineAmount: amountOf(l.qty, l.unitPrice),
      };
    });
  }
}

/** qty (in the unit) × factor, in base units, 3 decimals. */
export function baseQtyOf(quantity: string, factor: string) {
  return fromMilli((toMilli(quantity) * toMilli(factor)) / 1000n);
}

/** Rupiah amount of qty × unit price, rounded half up. */
export function amountOf(quantity: string, unitPrice: number) {
  const milli = toMilli(quantity) * BigInt(unitPrice);
  return Number((milli * 2n + 1000n) / 2000n);
}
