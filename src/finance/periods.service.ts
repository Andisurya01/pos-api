import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, between, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { periodRange } from '../common/business-date.js';
import { DB, type Database, type DbTransaction } from '../database/database.module.js';
import {
  accounts,
  cashTransactions,
  journalLines,
  journals,
  manualJournals,
  periods,
  shifts,
  stockAdjustments,
  stockOpnames,
} from '../database/schema/index.js';
import { type JournalLineInput, JournalService } from './journal.service.js';

export interface CloseCheck {
  code: string;
  label: string;
  passed: boolean;
  detail?: string;
}

/**
 * Tutup periode (docs/alur/07 §6). A closed month refuses every posting dated in it —
 * enforced again by database triggers on journal_lines and stock_ledger.
 */
@Injectable()
export class PeriodsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly journals: JournalService,
  ) {}

  /** The checklist shown before closing; every item must pass. */
  async checklist(periodId: string, tx: DbTransaction | Database = this.db): Promise<CloseCheck[]> {
    const { startsOn, endsOn } = periodRange(`${periodId}-01`);
    const count = async (q: Promise<{ n: number }[]>) => (await q)[0].n;
    const n = sql<number>`count(*)::int`;
    const openShifts = await count(tx.select({ n }).from(shifts).where(and(eq(shifts.status, 'OPEN'), between(shifts.businessDate, startsOn, endsOn))));
    const pending =
      (await count(tx.select({ n }).from(stockAdjustments).where(and(inArray(stockAdjustments.status, ['DRAFT', 'PENDING_APPROVAL']), between(stockAdjustments.businessDate, startsOn, endsOn))))) +
      (await count(tx.select({ n }).from(stockOpnames).where(and(inArray(stockOpnames.status, ['COUNTING', 'PENDING_APPROVAL']), between(stockOpnames.businessDate, startsOn, endsOn))))) +
      (await count(tx.select({ n }).from(cashTransactions).where(and(eq(cashTransactions.status, 'PENDING_APPROVAL'), between(cashTransactions.businessDate, startsOn, endsOn))))) +
      (await count(tx.select({ n }).from(manualJournals).where(and(eq(manualJournals.status, 'PENDING_APPROVAL'), between(manualJournals.journalDate, startsOn, endsOn)))));
    const earlierOpen = await count(tx.select({ n }).from(periods).where(and(lt(periods.id, periodId), eq(periods.status, 'OPEN'))));
    return [
      { code: 'EARLIER_CLOSED', label: 'Periode sebelumnya sudah ditutup', passed: earlierOpen === 0, detail: earlierOpen ? `${earlierOpen} periode sebelumnya masih terbuka` : undefined },
      { code: 'SHIFTS_CLOSED', label: 'Semua shift di bulan ini sudah ditutup', passed: openShifts === 0, detail: openShifts ? `${openShifts} shift masih terbuka` : undefined },
      { code: 'NOTHING_PENDING', label: 'Tidak ada dokumen menunggu persetujuan', passed: pending === 0, detail: pending ? `${pending} dokumen masih menunggu` : undefined },
      // Pemeriksaan integritas harian (modul laporan) joins this list once it exists.
    ];
  }

  async close(actor: Principal, periodId: string) {
    await this.db.transaction(async (tx) => {
      const period = await this.lock(tx, periodId);
      if (period.status === 'CLOSED') throw new BadRequestException('Periode sudah ditutup');
      const failed = (await this.checklist(periodId, tx)).filter((c) => !c.passed);
      if (failed.length) throw new BadRequestException({ message: 'Periode belum bisa ditutup', checks: failed });

      let closingJournalId: string | null = null;
      if (periodId.endsWith('-12')) closingJournalId = await this.closeYear(tx, actor, periodId.slice(0, 4), period.endsOn);
      await tx.update(periods).set({ status: 'CLOSED', closedAt: new Date(), closedBy: actor.userId, closingJournalId }).where(eq(periods.id, periodId));
      await this.audit.log({ action: 'period.close', entityType: 'period', entityId: periodId, userId: actor.userId, after: { closingJournalId } }, tx);
    });
    return this.get(periodId);
  }

  /** Owner only (permission). Later periods open again too; a year-end closing journal is reversed. */
  async reopen(actor: Principal, periodId: string, reason: string) {
    await this.db.transaction(async (tx) => {
      const period = await this.lock(tx, periodId);
      if (period.status !== 'CLOSED') throw new BadRequestException('Periode belum ditutup');
      const affected = await tx.select().from(periods).where(gte(periods.id, periodId)).orderBy(asc(periods.id)).for('update');
      await tx.update(periods).set({ status: 'OPEN', reopenedAt: new Date(), reopenedBy: actor.userId, reopenReason: reason, closingJournalId: null }).where(gte(periods.id, periodId));
      for (const p of affected.filter((x) => x.status === 'CLOSED' && x.closingJournalId)) {
        await this.journals.reverse(tx, actor, p.closingJournalId!, { journalNo: `BUKA-TUTUP/${p.id.slice(0, 4)}/${Date.now()}`, journalDate: p.endsOn, description: `Batal tutup tahun ${p.id.slice(0, 4)}: ${reason}` });
      }
      await this.audit.log({ action: 'period.reopen', entityType: 'period', entityId: periodId, userId: actor.userId, after: { reason, periods: affected.map((p) => p.id) } }, tx);
    });
    return this.get(periodId);
  }

  async get(periodId: string) {
    const [period] = await this.db.select().from(periods).where(eq(periods.id, periodId));
    if (!period) throw new NotFoundException('Periode tidak ditemukan');
    return { ...period, checklist: period.status === 'OPEN' ? await this.checklist(periodId) : [] };
  }

  /**
   * Jurnal penutup: every revenue and expense account of the year back to zero, the
   * year's profit or loss moved to Laba ditahan.
   */
  private async closeYear(tx: DbTransaction, actor: Principal, year: string, lastDay: string) {
    const balances = await tx
      .select({ accountId: accounts.id, balance: sql<number>`sum(${journalLines.debit} - ${journalLines.credit})::bigint`.mapWith(Number) })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(inArray(accounts.type, ['REVENUE', 'EXPENSE']), between(journalLines.journalDate, `${year}-01-01`, lastDay), sql`${journals.source} <> 'CLOSING'`))
      .groupBy(accounts.id);
    const lines: JournalLineInput[] = balances
      .filter((b) => b.balance !== 0)
      .map((b) => (b.balance > 0 ? { account: { accountId: b.accountId }, credit: b.balance } : { account: { accountId: b.accountId }, debit: -b.balance }));
    if (!lines.length) return null;
    const result = balances.reduce((s, b) => s + b.balance, 0); // debit − credit; negative = profit
    if (result < 0) lines.push({ account: 'RETAINED_EARNINGS', credit: -result });
    if (result > 0) lines.push({ account: 'RETAINED_EARNINGS', debit: result });
    const journal = await this.journals.post(tx, actor, {
      journalNo: `TUTUP/${year}`, journalDate: lastDay, source: 'CLOSING', description: `Jurnal penutup tahun ${year}`, lines,
    });
    return journal.id;
  }

  private async lock(tx: DbTransaction, periodId: string) {
    const [period] = await tx.select().from(periods).where(eq(periods.id, periodId)).for('update');
    if (!period) throw new NotFoundException('Periode belum pernah dipakai');
    return period;
  }
}
