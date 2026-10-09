import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { businessDate } from '../common/business-date.js';
import { isWholeQuantity } from '../common/quantity.js';
import { DB, type Database, type DbTransaction } from '../database/database.module.js';
import {
  batches,
  locations,
  products,
  skus,
  skuValuations,
  stockBalances,
  stockOpnameLines,
  stockOpnames,
  units,
} from '../database/schema/index.js';
import { displayName } from '../catalog/products.service.js';
import { DocumentNumberService } from '../finance/document-number.service.js';
import { AdjustmentsService } from './adjustments.service.js';
import { fromMilli, toMilli, valueAt } from './valuation.js';

export interface CountInput {
  skuId: string;
  locationId: string;
  batchId?: string | null;
  countedQty: string;
}

/**
 * Stock opname (docs/alur/06 §2): draft → counting → pending approval → posted.
 * The store stays open: each count is compared with the ledger at the moment it was
 * counted, so sales before and after a shelf is counted are both handled correctly.
 */
@Injectable()
export class OpnameService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbers: DocumentNumberService,
    private readonly adjustments: AdjustmentsService,
  ) {}

  async create(
    actor: Principal,
    input: { id: string; scopeLocationIds: string[]; scopeCategoryIds: string[]; note?: string | null },
  ) {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: stockOpnames.id }).from(stockOpnames).where(eq(stockOpnames.id, input.id));
      if (existing) return;
      if (input.scopeLocationIds.length) {
        const found = await tx.select({ id: locations.id }).from(locations).where(inArray(locations.id, input.scopeLocationIds));
        if (found.length !== new Set(input.scopeLocationIds).size) throw new BadRequestException('Ada lokasi yang tidak ditemukan');
      }
      await tx.insert(stockOpnames).values({
        id: input.id,
        docNo: `DRAFT-${input.id.slice(0, 8)}`,
        scopeLocationIds: [...new Set(input.scopeLocationIds)],
        scopeCategoryIds: [...new Set(input.scopeCategoryIds)],
        note: input.note ?? null,
        businessDate: businessDate(),
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
    });
    return this.detail(input.id, false);
  }

  async start(actor: Principal, id: string) {
    await this.transition(actor, id, ['DRAFT'], { status: 'COUNTING', startedAt: new Date() });
    return this.detail(id, false);
  }

  /** Records counts; recounting a line overwrites it with a new counted_at. */
  async recordCounts(actor: Principal, id: string, counts: CountInput[]) {
    await this.db.transaction(async (tx) => {
      const doc = await this.lock(tx, id);
      if (doc.status !== 'COUNTING') throw new BadRequestException('Opname tidak sedang dihitung');
      await this.assertInScope(tx, doc, counts);
      const now = new Date();
      for (const c of counts) {
        await tx
          .insert(stockOpnameLines)
          .values({ opnameId: id, skuId: c.skuId, locationId: c.locationId, batchId: c.batchId ?? null, countedQty: c.countedQty, countedAt: now, countedBy: actor.userId })
          .onConflictDoUpdate({
            target: [stockOpnameLines.opnameId, stockOpnameLines.skuId, stockOpnameLines.locationId, stockOpnameLines.batchId],
            set: { countedQty: c.countedQty, countedAt: now, countedBy: actor.userId, systemQty: null, diffQty: null },
          });
      }
    });
    return this.detail(id, false);
  }

  /**
   * Ends counting. System quantities are read from the ledger as of each line's
   * counted_at. With ZERO, stock in scope that nobody counted is treated as gone.
   */
  async submit(actor: Principal, id: string, policy: 'IGNORE' | 'ZERO') {
    await this.db.transaction(async (tx) => {
      const doc = await this.lock(tx, id);
      if (doc.status !== 'COUNTING') throw new BadRequestException('Opname tidak sedang dihitung');
      if (policy === 'ZERO') {
        const uncounted = await this.uncountedBalances(tx, doc);
        const now = new Date();
        for (const b of uncounted) {
          await tx.insert(stockOpnameLines).values({ opnameId: id, skuId: b.skuId, locationId: b.locationId, batchId: b.batchId, countedQty: '0', countedAt: now, countedBy: actor.userId });
        }
      }
      const lines = await tx.select().from(stockOpnameLines).where(eq(stockOpnameLines.opnameId, id));
      if (lines.length === 0) throw new BadRequestException('Belum ada barang yang dihitung');
      for (const line of lines) {
        const [{ qty }] = await tx.execute<{ qty: string }>(sql`
          select coalesce(sum(qty), 0)::numeric(18,3)::text as qty from stock_ledger
           where sku_id = ${line.skuId} and location_id = ${line.locationId}
             and batch_id is not distinct from ${line.batchId}
             and posted_at <= ${line.countedAt.toISOString()}::timestamptz
        `).then((r) => r.rows);
        await tx
          .update(stockOpnameLines)
          .set({ systemQty: qty, diffQty: fromMilli(toMilli(line.countedQty) - toMilli(qty)) })
          .where(eq(stockOpnameLines.id, line.id));
      }
      await tx
        .update(stockOpnames)
        .set({ status: 'PENDING_APPROVAL', uncountedPolicy: policy, submittedAt: new Date(), submittedBy: actor.userId, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(stockOpnames.id, id));
    });
    return this.detail(id, false);
  }

  /** Sends the opname back for recounting specific shelves. */
  async reopen(actor: Principal, id: string) {
    await this.transition(actor, id, ['PENDING_APPROVAL'], { status: 'COUNTING', submittedAt: null, submittedBy: null });
    return this.detail(id, false);
  }

  async cancel(actor: Principal, id: string) {
    await this.transition(actor, id, ['DRAFT', 'COUNTING', 'PENDING_APPROVAL'], { status: 'CANCELLED' });
    return this.detail(id, false);
  }

  /** Approval posts one OPNAME adjustment for every line with a difference. */
  async approve(actor: Principal, id: string) {
    await this.db.transaction(async (tx) => {
      const doc = await this.lock(tx, id);
      if (doc.status !== 'PENDING_APPROVAL') throw new BadRequestException('Opname tidak menunggu persetujuan');
      const lines = await tx.select().from(stockOpnameLines).where(and(eq(stockOpnameLines.opnameId, id), ne(stockOpnameLines.diffQty, '0')));
      const adjustmentId = lines.length
        ? await this.adjustments.postOpnameAdjustment(
            tx,
            actor,
            id,
            lines.map((l) => ({ skuId: l.skuId, locationId: l.locationId, batchId: l.batchId, qty: l.diffQty! })),
          )
        : null;
      const docNo = await this.numbers.next(tx, 'SO', businessDate());
      await tx
        .update(stockOpnames)
        .set({ docNo, status: 'POSTED', approvedAt: new Date(), approvedBy: actor.userId, adjustmentId, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(stockOpnames.id, id));
      await this.audit.log({ action: 'post', entityType: 'stock_opname', entityId: id, userId: actor.userId, after: { docNo, adjustmentId, lines: lines.length } }, tx);
    });
    return this.detail(id, true);
  }

  /** Lines sorted by largest value difference first (docs/alur/06 §2 step 5). */
  async detail(id: string, showValue: boolean) {
    const [doc] = await this.db.select().from(stockOpnames).where(eq(stockOpnames.id, id));
    if (!doc) throw new NotFoundException('Opname tidak ditemukan');
    const rows = await this.db
      .select({
        id: stockOpnameLines.id,
        skuId: stockOpnameLines.skuId,
        productName: products.name,
        variantName: skus.variantName,
        location: { id: locations.id, code: locations.code },
        batchId: stockOpnameLines.batchId,
        batchNo: batches.batchNo,
        expiryDate: batches.expiryDate,
        countedQty: stockOpnameLines.countedQty,
        countedAt: stockOpnameLines.countedAt,
        systemQty: stockOpnameLines.systemQty,
        diffQty: stockOpnameLines.diffQty,
        lastAvgCost: skuValuations.lastAvgCost,
      })
      .from(stockOpnameLines)
      .innerJoin(skus, eq(skus.id, stockOpnameLines.skuId))
      .innerJoin(products, eq(products.id, skus.productId))
      .innerJoin(locations, eq(locations.id, stockOpnameLines.locationId))
      .leftJoin(batches, eq(batches.id, stockOpnameLines.batchId))
      .leftJoin(skuValuations, eq(skuValuations.skuId, stockOpnameLines.skuId))
      .where(eq(stockOpnameLines.opnameId, id))
      .orderBy(asc(products.name));
    const lines = rows
      .map(({ productName, variantName, lastAvgCost, ...r }) => {
        const diffValue = r.diffQty && lastAvgCost ? valueAt(toMilli(r.diffQty), lastAvgCost) : null;
        return { ...r, displayName: displayName(productName, variantName), ...(showValue ? { diffValue } : {}), _sort: Math.abs(diffValue ?? 0) };
      })
      .sort((a, b) => b._sort - a._sort)
      .map(({ _sort, ...r }) => r);
    return { ...doc, lines };
  }

  // ----------------------------------------------------------------- helpers

  private async lock(tx: DbTransaction, id: string) {
    const [doc] = await tx.select().from(stockOpnames).where(eq(stockOpnames.id, id)).for('update');
    if (!doc) throw new NotFoundException('Opname tidak ditemukan');
    return doc;
  }

  private async transition(
    actor: Principal,
    id: string,
    from: (typeof stockOpnames.$inferSelect)['status'][],
    set: Partial<typeof stockOpnames.$inferInsert>,
  ) {
    await this.db.transaction(async (tx) => {
      const doc = await this.lock(tx, id);
      if (!from.includes(doc.status)) throw new BadRequestException('Status opname tidak sesuai untuk aksi ini');
      await tx.update(stockOpnames).set({ ...set, updatedAt: new Date(), updatedBy: actor.userId }).where(eq(stockOpnames.id, id));
    });
  }

  private async assertInScope(tx: DbTransaction, doc: typeof stockOpnames.$inferSelect, counts: CountInput[]) {
    const skuRows = await tx
      .select({ id: skus.id, kind: skus.kind, trackBatch: skus.trackBatch, categoryId: products.categoryId, allowsDecimal: units.allowsDecimal })
      .from(skus)
      .innerJoin(products, eq(products.id, skus.productId))
      .innerJoin(units, eq(units.id, skus.baseUnitId))
      .where(inArray(skus.id, [...new Set(counts.map((c) => c.skuId))]));
    for (const [i, c] of counts.entries()) {
      const at = `Baris ${i + 1}: `;
      const sku = skuRows.find((s) => s.id === c.skuId);
      if (!sku || sku.kind !== 'STANDARD') throw new BadRequestException(`${at}barang tidak valid`);
      if (doc.scopeCategoryIds.length && !doc.scopeCategoryIds.includes(sku.categoryId)) throw new BadRequestException(`${at}barang di luar kategori opname`);
      if (doc.scopeLocationIds.length && !doc.scopeLocationIds.includes(c.locationId)) throw new BadRequestException(`${at}lokasi di luar cakupan opname`);
      if (sku.trackBatch !== Boolean(c.batchId)) throw new BadRequestException(`${at}${sku.trackBatch ? 'hitung per batch' : 'barang ini tidak memakai batch'}`);
      if (!sku.allowsDecimal && !isWholeQuantity(c.countedQty)) throw new BadRequestException(`${at}jumlah harus bilangan bulat`);
    }
  }

  /** Non-zero balances in scope without a counted line. */
  private async uncountedBalances(tx: DbTransaction, doc: typeof stockOpnames.$inferSelect) {
    const rows = await tx
      .select({ skuId: stockBalances.skuId, locationId: stockBalances.locationId, batchId: stockBalances.batchId, categoryId: products.categoryId })
      .from(stockBalances)
      .innerJoin(skus, eq(skus.id, stockBalances.skuId))
      .innerJoin(products, eq(products.id, skus.productId))
      .where(ne(stockBalances.qty, '0'));
    const counted = await tx.select().from(stockOpnameLines).where(eq(stockOpnameLines.opnameId, doc.id));
    return rows.filter(
      (b) =>
        (!doc.scopeLocationIds.length || doc.scopeLocationIds.includes(b.locationId)) &&
        (!doc.scopeCategoryIds.length || doc.scopeCategoryIds.includes(b.categoryId)) &&
        !counted.some((c) => c.skuId === b.skuId && c.locationId === b.locationId && c.batchId === b.batchId),
    );
  }
}
