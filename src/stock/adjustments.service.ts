import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { hasPermission, type Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { businessDate } from '../common/business-date.js';
import { isWholeQuantity } from '../common/quantity.js';
import { DB, type Database, type DbTransaction } from '../database/database.module.js';
import {
  batches,
  locations,
  settings,
  skus,
  skuValuations,
  stockAdjustmentLines,
  stockAdjustments,
  units,
} from '../database/schema/index.js';
import type { MappingKey } from '../finance/chart-template.js';
import { DocumentNumberService } from '../finance/document-number.service.js';
import { type JournalLineInput, JournalService } from '../finance/journal.service.js';
import { StockService } from './stock.service.js';
import { toMilli, valueAt } from './valuation.js';

export type AdjustmentReason =
  | 'DAMAGED' | 'EXPIRED' | 'LOST' | 'SELF_USE' | 'SAMPLE' | 'FOUND' | 'OPENING';

export interface AdjustmentLineInput {
  skuId: string;
  locationId: string;
  qty: string; // signed
  batchId?: string | null;
  batchNo?: string | null;
  expiryDate?: string | null;
  unitCost?: string | null;
}

/** Which way each reason may move stock, and the account opposite Persediaan (docs/alur/06). */
const REASONS: Record<AdjustmentReason | 'OPNAME', { sign: -1 | 1 | 0; account: MappingKey }> = {
  DAMAGED: { sign: -1, account: 'DAMAGE_EXPENSE' },
  EXPIRED: { sign: -1, account: 'DAMAGE_EXPENSE' },
  LOST: { sign: -1, account: 'INV_SHRINKAGE' },
  SELF_USE: { sign: -1, account: 'SELF_USE_EXPENSE' },
  SAMPLE: { sign: -1, account: 'PROMO_EXPENSE' },
  FOUND: { sign: 1, account: 'INV_GAIN' },
  OPENING: { sign: 1, account: 'OPENING_EQUITY' },
  OPNAME: { sign: 0, account: 'INV_SHRINKAGE' },
};

/**
 * Penyesuaian stok and saldo awal stok: draft → submitted → approved (= posted).
 * Posting writes the stock ledger and the journal in one transaction.
 */
@Injectable()
export class AdjustmentsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly journals: JournalService,
    private readonly numbers: DocumentNumberService,
  ) {}

  async createDraft(
    actor: Principal,
    input: { id: string; reason: AdjustmentReason; note?: string | null; lines: AdjustmentLineInput[] },
  ) {
    this.assertCreatePermission(actor, input.reason);
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: stockAdjustments.id })
        .from(stockAdjustments)
        .where(eq(stockAdjustments.id, input.id));
      if (existing) return; // idempotent retry with the same client id
      if (input.reason === 'OPENING') await this.assertOpeningOpen(tx);
      await this.validateLines(tx, input.reason, input.lines);
      await tx.insert(stockAdjustments).values({
        id: input.id,
        docNo: `DRAFT-${input.id.slice(0, 8)}`,
        reason: input.reason,
        note: input.note ?? null,
        businessDate: businessDate(),
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      await tx.insert(stockAdjustmentLines).values(
        input.lines.map((l) => ({
          adjustmentId: input.id,
          skuId: l.skuId,
          locationId: l.locationId,
          batchId: l.batchId ?? null,
          batchNo: l.batchNo ?? null,
          expiryDate: l.expiryDate ?? null,
          qty: l.qty,
          unitCost: l.unitCost ?? null,
        })),
      );
    });
    return this.detail(input.id);
  }

  async submit(actor: Principal, id: string) {
    await this.db.transaction(async (tx) => {
      const doc = await this.lockDoc(tx, id);
      if (doc.status !== 'DRAFT') throw new BadRequestException('Hanya draft yang bisa diajukan');
      this.assertCreatePermission(actor, doc.reason as AdjustmentReason);
      await tx
        .update(stockAdjustments)
        .set({ status: 'PENDING_APPROVAL', submittedAt: new Date(), submittedBy: actor.userId, rejectedReason: null })
        .where(eq(stockAdjustments.id, id));
    });
    return this.detail(id);
  }

  async reject(actor: Principal, id: string, reason: string) {
    await this.db.transaction(async (tx) => {
      const doc = await this.lockDoc(tx, id);
      if (doc.status !== 'PENDING_APPROVAL') throw new BadRequestException('Dokumen tidak menunggu persetujuan');
      this.assertApprovePermission(actor, doc.reason as AdjustmentReason);
      await tx
        .update(stockAdjustments)
        .set({ status: 'DRAFT', rejectedReason: reason, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(stockAdjustments.id, id));
    });
    return this.detail(id);
  }

  async cancel(actor: Principal, id: string) {
    await this.db.transaction(async (tx) => {
      const doc = await this.lockDoc(tx, id);
      if (doc.status === 'POSTED') throw new BadRequestException('Dokumen yang sudah diposting tidak bisa dibatalkan');
      this.assertCreatePermission(actor, doc.reason as AdjustmentReason);
      await tx
        .update(stockAdjustments)
        .set({ status: 'CANCELLED', updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(stockAdjustments.id, id));
    });
    return this.detail(id);
  }

  /** Approval posts the document: stock ledger + valuation + journal, all or nothing. */
  async approve(actor: Principal, id: string) {
    await this.db.transaction(async (tx) => {
      const doc = await this.lockDoc(tx, id);
      if (doc.status !== 'PENDING_APPROVAL') throw new BadRequestException('Dokumen tidak menunggu persetujuan');
      const reason = doc.reason as AdjustmentReason;
      this.assertApprovePermission(actor, reason);
      if (reason === 'OPENING') await this.assertOpeningOpen(tx);

      await this.post(tx, actor, id, reason);
    });
    return this.detail(id);
  }

  /**
   * Creates and posts the adjustment that settles an approved stock opname, inside the
   * opname approval transaction (docs/alur/06 §2).
   */
  async postOpnameAdjustment(
    tx: DbTransaction,
    actor: Principal,
    opnameId: string,
    lines: AdjustmentLineInput[],
  ) {
    const id = crypto.randomUUID();
    await tx.insert(stockAdjustments).values({
      id,
      docNo: `DRAFT-${id.slice(0, 8)}`,
      reason: 'OPNAME',
      opnameId,
      status: 'PENDING_APPROVAL',
      businessDate: businessDate(),
      submittedAt: new Date(),
      submittedBy: actor.userId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    await tx.insert(stockAdjustmentLines).values(
      lines.map((l) => ({ adjustmentId: id, skuId: l.skuId, locationId: l.locationId, batchId: l.batchId ?? null, qty: l.qty })),
    );
    await this.post(tx, actor, id, 'OPNAME');
    return id;
  }

  /** Stock ledger + valuation + journal for one adjustment document. */
  private async post(tx: DbTransaction, actor: Principal, id: string, reason: AdjustmentReason | 'OPNAME') {
    {
      const lines = await tx.select().from(stockAdjustmentLines).where(eq(stockAdjustmentLines.adjustmentId, id));
      await this.validateLines(tx, reason, lines);
      const date = businessDate();
      const docNo = await this.numbers.next(tx, reason === 'OPENING' ? 'SA' : 'PS', date);
      const ctx = { docType: reason === 'OPENING' ? 'SA' : 'PS', docId: id, businessDate: date, userId: actor.userId };
      const states = await this.stock.lock(tx, lines.map((l) => l.skuId));
      const valuations = await tx
        .select()
        .from(skuValuations)
        .where(inArray(skuValuations.skuId, lines.map((l) => l.skuId)));

      let issuedCost = 0;
      let receivedValue = 0;
      let correction = 0;
      for (const line of lines) {
        const place = { skuId: line.skuId, locationId: line.locationId, batchId: line.batchId, docLineId: line.id };
        const qtyMilli = toMilli(line.qty);
        let value: number;
        if (qtyMilli < 0n) {
          const { cost } = await this.stock.issue(tx, ctx, states, place, line.qty.replace('-', ''), 'ADJUSTMENT');
          value = -cost;
          issuedCost += cost;
        } else {
          place.batchId = await this.resolveBatch(tx, line);
          const cost = line.unitCost ?? this.fallbackCost(states.get(line.skuId)!.lastAvgCost, valuations.find((v) => v.skuId === line.skuId)?.lastPurchaseCost);
          if (!cost) {
            throw new BadRequestException(`Barang ${line.skuId} belum punya harga pokok; isi harga per unit`);
          }
          value = valueAt(qtyMilli, cost);
          const result = await this.stock.receive(tx, ctx, states, place, line.qty, value, reason === 'OPENING' ? 'OPENING' : 'ADJUSTMENT');
          receivedValue += value;
          correction += result.correction;
        }
        await tx
          .update(stockAdjustmentLines)
          .set({ value, batchId: place.batchId })
          .where(eq(stockAdjustmentLines.id, line.id));
      }

      const journalLines: JournalLineInput[] = [];
      const pair = (debit: MappingKey, credit: MappingKey, amount: number) => {
        if (amount === 0) return;
        const [d, c] = amount > 0 ? [debit, credit] : [credit, debit];
        journalLines.push({ account: d, debit: Math.abs(amount) }, { account: c, credit: Math.abs(amount) });
      };
      pair(REASONS[reason].account, 'INVENTORY', issuedCost);
      pair('INVENTORY', reason === 'OPNAME' ? 'INV_GAIN' : REASONS[reason].account, receivedValue);
      pair('COGS', 'INVENTORY', correction);
      const journal = journalLines.length
        ? await this.journals.post(tx, actor, {
            journalNo: docNo,
            journalDate: date,
            source: reason === 'OPENING' ? 'OPENING' : 'AUTO',
            sourceDocType: ctx.docType,
            sourceDocId: id,
            description: `${reason === 'OPENING' ? 'Saldo awal stok' : reason === 'OPNAME' ? 'Selisih stock opname' : 'Penyesuaian stok'} ${docNo}`,
            lines: journalLines,
          })
        : null;

      await tx
        .update(stockAdjustments)
        .set({
          docNo,
          status: 'POSTED',
          businessDate: date,
          approvedAt: new Date(),
          approvedBy: actor.userId,
          postedAt: new Date(),
          postedBy: actor.userId,
          journalId: journal?.id ?? null,
        })
        .where(eq(stockAdjustments.id, id));
      await this.audit.log(
        { action: 'post', entityType: 'stock_adjustment', entityId: id, userId: actor.userId, after: { docNo, issuedCost, receivedValue, correction } },
        tx,
      );
    }
  }

  async detail(id: string) {
    const [doc] = await this.db.select().from(stockAdjustments).where(eq(stockAdjustments.id, id));
    if (!doc) throw new NotFoundException('Dokumen penyesuaian tidak ditemukan');
    const lines = await this.db.select().from(stockAdjustmentLines).where(eq(stockAdjustmentLines.adjustmentId, id));
    return { ...doc, lines };
  }

  // --------------------------------------------------------------- helpers

  private fallbackCost(lastAvg: string | null, lastPurchase: string | null | undefined) {
    return lastAvg ?? lastPurchase ?? null;
  }

  private assertCreatePermission(actor: Principal, reason: AdjustmentReason) {
    const code = reason === 'OPENING' ? 'gudang.saldo_awal.buat' : 'gudang.penyesuaian.buat';
    if (!hasPermission(actor, code)) throw new ForbiddenException({ message: 'Anda tidak punya izin untuk aksi ini', missingPermissions: [code] });
  }

  private assertApprovePermission(actor: Principal, reason: AdjustmentReason) {
    const code = reason === 'OPENING' ? 'gudang.saldo_awal.setujui' : 'gudang.penyesuaian.setujui';
    if (!hasPermission(actor, code)) throw new ForbiddenException({ message: 'Anda tidak punya izin untuk aksi ini', missingPermissions: [code] });
  }

  /** Once opening balances are locked (docs/alur/01 §6), corrections go through normal documents. */
  private async assertOpeningOpen(tx: DbTransaction) {
    const [row] = await tx.select().from(settings).where(eq(settings.key, 'opening.locked'));
    if (row?.value === true) throw new BadRequestException('Saldo awal sudah dikunci');
  }

  private async lockDoc(tx: DbTransaction, id: string) {
    const [doc] = await tx.select().from(stockAdjustments).where(eq(stockAdjustments.id, id)).for('update');
    if (!doc) throw new NotFoundException('Dokumen penyesuaian tidak ditemukan');
    return doc;
  }

  private async validateLines(tx: DbTransaction, reason: AdjustmentReason | 'OPNAME', lines: AdjustmentLineInput[]) {
    if (lines.length === 0) throw new BadRequestException('Minimal satu baris barang');
    const skuRows = await tx
      .select({ id: skus.id, kind: skus.kind, trackBatch: skus.trackBatch, allowsDecimal: units.allowsDecimal })
      .from(skus)
      .innerJoin(units, eq(units.id, skus.baseUnitId))
      .where(inArray(skus.id, [...new Set(lines.map((l) => l.skuId))]));
    const locRows = await tx.select().from(locations).where(inArray(locations.id, [...new Set(lines.map((l) => l.locationId))]));
    const sign = REASONS[reason].sign;
    for (const [i, l] of lines.entries()) {
      const at = `Baris ${i + 1}: `;
      const sku = skuRows.find((s) => s.id === l.skuId);
      const loc = locRows.find((x) => x.id === l.locationId);
      if (!sku) throw new BadRequestException(`${at}barang tidak ditemukan`);
      if (sku.kind !== 'STANDARD') throw new BadRequestException(`${at}bundel tidak punya stok sendiri`);
      if (!loc?.isActive || loc.type === 'TRANSIT') throw new BadRequestException(`${at}lokasi tidak valid`);
      const q = toMilli(l.qty);
      if (q === 0n) throw new BadRequestException(`${at}jumlah tidak boleh 0`);
      if (sign !== 0 && (q > 0n ? 1 : -1) !== sign) {
        throw new BadRequestException(`${at}alasan ini hanya untuk stok ${sign > 0 ? 'bertambah' : 'berkurang'}`);
      }
      if (!sku.allowsDecimal && !isWholeQuantity(l.qty.replace('-', ''))) {
        throw new BadRequestException(`${at}jumlah harus bilangan bulat`);
      }
      if (reason === 'OPENING' && l.unitCost == null) throw new BadRequestException(`${at}harga pokok per unit wajib diisi`);
      if (sku.trackBatch) {
        if (q < 0n && !l.batchId) throw new BadRequestException(`${at}pilih batch yang dikurangi`);
        if (q > 0n && !l.batchNo && !l.expiryDate) throw new BadRequestException(`${at}isi nomor batch atau tanggal kedaluwarsa`);
      } else if (l.batchId || l.batchNo || l.expiryDate) {
        throw new BadRequestException(`${at}barang ini tidak memakai batch`);
      }
    }
  }

  private async resolveBatch(tx: DbTransaction, line: AdjustmentLineInput & { skuId: string }) {
    if (line.batchId) return line.batchId;
    if (!line.batchNo && !line.expiryDate) return null;
    await tx
      .insert(batches)
      .values({ skuId: line.skuId, batchNo: line.batchNo ?? null, expiryDate: line.expiryDate ?? null })
      .onConflictDoNothing();
    const [row] = await tx
      .select({ id: batches.id })
      .from(batches)
      .where(
        and(
          eq(batches.skuId, line.skuId),
          line.batchNo ? eq(batches.batchNo, line.batchNo) : isNull(batches.batchNo),
          line.expiryDate ? eq(batches.expiryDate, line.expiryDate) : isNull(batches.expiryDate),
        ),
      );
    return row.id;
  }
}
