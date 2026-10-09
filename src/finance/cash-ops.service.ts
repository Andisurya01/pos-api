import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { hasPermission, type Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { businessDate } from '../common/business-date.js';
import { DB, type Database, type DbExecutor, type DbTransaction } from '../database/database.module.js';
import {
  accounts,
  cashTransactions,
  cashTransfers,
  edcSettlements,
  financeCategories,
  journalLines,
  manualJournalLines,
  manualJournals,
  paymentMethods,
  shiftCashMovements,
  shifts,
  terminals,
} from '../database/schema/index.js';
import { DocumentNumberService } from './document-number.service.js';
import { JournalService } from './journal.service.js';

const CATEGORY_TEMPLATE: [kind: 'EXPENSE' | 'INCOME', name: string, accountCode: string][] = [
  ['EXPENSE', 'Listrik', '6-1100'], ['EXPENSE', 'Air', '6-1200'], ['EXPENSE', 'Internet dan telepon', '6-1300'],
  ['EXPENSE', 'Sewa', '6-1400'], ['EXPENSE', 'Gaji dan upah', '6-1500'], ['EXPENSE', 'Transport', '6-1600'],
  ['EXPENSE', 'ATK', '6-1700'], ['EXPENSE', 'Kebersihan', '6-1800'], ['EXPENSE', 'Perbaikan', '6-1900'],
  ['EXPENSE', 'Lain-lain', '6-1990'], ['INCOME', 'Pendapatan lain-lain', '4-2900'],
];
const CASH_KINDS = ['CASH', 'PETTY_CASH', 'BANK'];

export async function accountBalance(tx: DbExecutor, accountId: string) {
  const [row] = await tx
    .select({ v: sql<number>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::bigint`.mapWith(Number) })
    .from(journalLines)
    .where(eq(journalLines.accountId, accountId));
  return row.v;
}

/**
 * Kas & bank documents (docs/alur/07 §1–4): kas keluar/masuk, mutasi kas, jurnal umum,
 * EDC/QRIS settlement. Every posting is one transaction with its journal.
 */
@Injectable()
export class CashOpsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CashOpsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly journals: JournalService,
    private readonly numbers: DocumentNumberService,
  ) {}

  async onApplicationBootstrap() {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('finance-categories-seed'))`);
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(financeCategories);
      if (count > 0) return;
      const rows = await tx.select({ id: accounts.id, code: accounts.code }).from(accounts).where(inArray(accounts.code, CATEGORY_TEMPLATE.map((c) => c[2])));
      if (rows.length !== CATEGORY_TEMPLATE.length) return; // chart not installed yet
      await tx.insert(financeCategories).values(CATEGORY_TEMPLATE.map(([kind, name, code], i) => ({ kind, name, accountId: rows.find((r) => r.code === code)!.id, sortOrder: i })));
      this.logger.log('Created default finance categories');
    });
  }

  listCategories() {
    return this.db.select().from(financeCategories).orderBy(asc(financeCategories.sortOrder));
  }

  async createCategory(actor: Principal, input: { kind: 'EXPENSE' | 'INCOME'; name: string; accountId: string }) {
    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, input.accountId));
    const wanted = input.kind === 'EXPENSE' ? 'EXPENSE' : 'REVENUE';
    if (!account?.isPostable || account.type !== wanted || account.isControl) throw new BadRequestException(`Pilih akun ${input.kind === 'EXPENSE' ? 'beban' : 'pendapatan'} yang bisa dijurnal`);
    const [row] = await this.db.insert(financeCategories).values({ ...input, sortOrder: 100, createdBy: actor.userId, updatedBy: actor.userId }).returning();
    return row;
  }

  // ------------------------------------------------------------ kas keluar/masuk

  /**
   * From the drawer: only during the cashier's own open shift, posted at once.
   * Other cash/bank accounts: kas keluar waits for approval unless the creator may approve.
   */
  async createCashTransaction(
    actor: Principal,
    input: { id: string; direction: 'OUT' | 'IN'; categoryId: string; cashAccountId: string; amount: number; description: string },
  ) {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: cashTransactions.id }).from(cashTransactions).where(eq(cashTransactions.id, input.id));
      if (existing) return;
      const [category] = await tx.select().from(financeCategories).where(eq(financeCategories.id, input.categoryId));
      if (!category?.isActive || category.kind !== (input.direction === 'OUT' ? 'EXPENSE' : 'INCOME')) throw new BadRequestException('Kategori tidak sesuai');
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, input.cashAccountId));
      if (!account?.isActive || !account.isPostable) throw new BadRequestException('Akun kas tidak valid');

      let shiftId: string | null = null;
      if (account.cashKind === 'DRAWER') {
        const code = input.direction === 'OUT' ? 'penjualan.shift.kas_keluar' : 'penjualan.shift.kas_masuk';
        this.require(actor, code);
        const [shift] = await tx
          .select({ id: shifts.id })
          .from(shifts)
          .innerJoin(terminals, eq(terminals.id, shifts.terminalId))
          .where(and(eq(shifts.cashierId, actor.userId), eq(shifts.status, 'OPEN'), eq(terminals.cashAccountId, account.id)));
        if (!shift) throw new BadRequestException('Kas laci hanya bisa dipakai saat shift Anda di laci itu terbuka');
        shiftId = shift.id;
      } else {
        if (!CASH_KINDS.includes(account.cashKind ?? '')) throw new BadRequestException('Pilih akun kas atau bank');
        this.require(actor, input.direction === 'OUT' ? 'keuangan.pengeluaran.buat' : 'keuangan.kas_masuk.buat');
      }
      const autoPost = input.direction === 'IN' || shiftId !== null || hasPermission(actor, 'keuangan.pengeluaran.setujui');
      await tx.insert(cashTransactions).values({
        id: input.id, docNo: `DRAFT-${input.id.slice(0, 8)}`, direction: input.direction, status: 'PENDING_APPROVAL',
        categoryId: category.id, cashAccountId: account.id, shiftId, amount: input.amount, description: input.description,
        businessDate: businessDate(), createdBy: actor.userId, updatedBy: actor.userId,
      });
      if (autoPost) await this.postCashTransaction(tx, actor, input.id);
    });
    return this.cashTransaction(input.id);
  }

  async approveCashTransaction(actor: Principal, id: string) {
    await this.db.transaction(async (tx) => {
      const [doc] = await tx.select().from(cashTransactions).where(eq(cashTransactions.id, id)).for('update');
      if (!doc) throw new NotFoundException('Dokumen kas tidak ditemukan');
      if (doc.status !== 'PENDING_APPROVAL') throw new BadRequestException('Dokumen tidak menunggu persetujuan');
      await this.postCashTransaction(tx, actor, id);
    });
    return this.cashTransaction(id);
  }

  async cancelCashTransaction(actor: Principal, id: string) {
    const [doc] = await this.db.update(cashTransactions).set({ status: 'CANCELLED', updatedAt: new Date(), updatedBy: actor.userId }).where(and(eq(cashTransactions.id, id), eq(cashTransactions.status, 'PENDING_APPROVAL'))).returning({ id: cashTransactions.id });
    if (!doc) throw new BadRequestException('Hanya dokumen yang menunggu persetujuan yang bisa dibatalkan');
    return this.cashTransaction(id);
  }

  private async postCashTransaction(tx: DbTransaction, actor: Principal, id: string) {
    const [doc] = await tx.select().from(cashTransactions).where(eq(cashTransactions.id, id));
    const [category] = await tx.select().from(financeCategories).where(eq(financeCategories.id, doc.categoryId));
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, doc.cashAccountId)).for('update');
    if (doc.direction === 'OUT' && account.cashKind !== 'BANK' && doc.amount > (await accountBalance(tx, account.id))) {
      throw new BadRequestException('Saldo kas tidak cukup');
    }
    const date = businessDate();
    const type = doc.direction === 'OUT' ? 'KK' : 'KM';
    const docNo = await this.numbers.next(tx, type, date);
    const cash = { accountId: account.id };
    const other = { accountId: category.accountId };
    const journal = await this.journals.post(tx, actor, {
      journalNo: docNo, journalDate: date, source: 'AUTO', sourceDocType: type, sourceDocId: id, description: `${category.name}: ${doc.description}`,
      lines: doc.direction === 'OUT' ? [{ account: other, debit: doc.amount }, { account: cash, credit: doc.amount }] : [{ account: cash, debit: doc.amount }, { account: other, credit: doc.amount }],
    });
    await tx.update(cashTransactions).set({ docNo, status: 'POSTED', businessDate: date, approvedBy: actor.userId, approvedAt: new Date(), journalId: journal.id }).where(eq(cashTransactions.id, id));
    if (doc.shiftId) {
      await tx.insert(shiftCashMovements).values({ shiftId: doc.shiftId, kind: doc.direction === 'OUT' ? 'CASH_OUT' : 'CASH_IN', amount: doc.amount, reason: `${category.name}: ${doc.description}`, journalId: journal.id, cashTransactionId: id, createdBy: actor.userId });
    }
    await this.audit.log({ action: 'post', entityType: 'cash_transaction', entityId: id, userId: actor.userId, after: { docNo, amount: doc.amount } }, tx);
  }

  async cashTransaction(id: string) {
    const [doc] = await this.db.select().from(cashTransactions).where(eq(cashTransactions.id, id));
    if (!doc) throw new NotFoundException('Dokumen kas tidak ditemukan');
    return doc;
  }

  // ---------------------------------------------------------------- mutasi kas

  async transfer(actor: Principal, input: { id: string; fromAccountId: string; toAccountId: string; amount: number; description?: string | null }) {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: cashTransfers.id }).from(cashTransfers).where(eq(cashTransfers.id, input.id));
      if (existing) return;
      if (input.fromAccountId === input.toAccountId) throw new BadRequestException('Akun asal dan tujuan sama');
      const rows = await tx.select().from(accounts).where(inArray(accounts.id, [input.fromAccountId, input.toAccountId])).for('update');
      const from = rows.find((a) => a.id === input.fromAccountId);
      const to = rows.find((a) => a.id === input.toAccountId);
      if (!from || !to || ![from, to].every((a) => a.isActive && a.isPostable && CASH_KINDS.includes(a.cashKind ?? ''))) {
        throw new BadRequestException('Mutasi hanya antar akun kas besar, kas kecil, atau bank');
      }
      if (from.cashKind !== 'BANK' && input.amount > (await accountBalance(tx, from.id))) throw new BadRequestException('Saldo akun asal tidak cukup');
      const date = businessDate();
      const docNo = await this.numbers.next(tx, 'MK', date);
      const journal = await this.journals.post(tx, actor, {
        journalNo: docNo, journalDate: date, source: 'AUTO', sourceDocType: 'MK', sourceDocId: input.id,
        description: input.description || `Mutasi ${from.name} → ${to.name}`,
        lines: [{ account: { accountId: to.id }, debit: input.amount }, { account: { accountId: from.id }, credit: input.amount }],
      });
      await tx.insert(cashTransfers).values({ ...input, description: input.description ?? null, docNo, businessDate: date, journalId: journal.id, createdBy: actor.userId, updatedBy: actor.userId });
      await this.audit.log({ action: 'post', entityType: 'cash_transfer', entityId: input.id, userId: actor.userId, after: { docNo, amount: input.amount } }, tx);
    });
    const [doc] = await this.db.select().from(cashTransfers).where(eq(cashTransfers.id, input.id));
    return doc;
  }

  // --------------------------------------------------------- EDC/QRIS settlement

  /** Money from the QRIS/card provider reaches the bank net of MDR (docs/alur/07). */
  async settle(actor: Principal, input: { id: string; paymentMethodId: string; bankAccountId: string; settlementDate?: string; grossAmount: number; mdrAmount: number }) {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: edcSettlements.id }).from(edcSettlements).where(eq(edcSettlements.id, input.id));
      if (existing) return;
      const [method] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, input.paymentMethodId));
      if (!method || !['QRIS', 'CARD'].includes(method.kind) || !method.accountId) throw new BadRequestException('Pilih metode QRIS atau kartu');
      const [bank] = await tx.select().from(accounts).where(eq(accounts.id, input.bankAccountId));
      if (bank?.cashKind !== 'BANK' || !bank.isPostable) throw new BadRequestException('Pilih rekening bank');
      if (input.mdrAmount >= input.grossAmount) throw new BadRequestException('Potongan MDR harus lebih kecil dari nilai settlement');
      if (input.grossAmount > (await accountBalance(tx, method.accountId))) throw new BadRequestException('Nilai settlement melebihi piutang yang tercatat');
      const date = input.settlementDate ?? businessDate();
      const docNo = await this.numbers.next(tx, 'MK', date);
      const net = input.grossAmount - input.mdrAmount;
      const journal = await this.journals.post(tx, actor, {
        journalNo: docNo, journalDate: date, source: 'AUTO', sourceDocType: 'EDC', sourceDocId: input.id, description: `Settlement ${method.name}`,
        lines: [
          { account: { accountId: bank.id }, debit: net },
          ...(input.mdrAmount > 0 ? [{ account: 'MDR_EXPENSE' as const, debit: input.mdrAmount }] : []),
          { account: { accountId: method.accountId }, credit: input.grossAmount },
        ],
      });
      await tx.insert(edcSettlements).values({ id: input.id, docNo, paymentMethodId: method.id, bankAccountId: bank.id, settlementDate: date, grossAmount: input.grossAmount, mdrAmount: input.mdrAmount, netAmount: net, journalId: journal.id, createdBy: actor.userId, updatedBy: actor.userId });
    });
    const [doc] = await this.db.select().from(edcSettlements).where(eq(edcSettlements.id, input.id));
    return doc;
  }

  // ------------------------------------------------------------- jurnal umum

  async saveManualJournal(actor: Principal, input: { id: string; journalDate: string; description: string; lines: { accountId: string; debit: number; credit: number; memo?: string | null }[] }) {
    await this.db.transaction(async (tx) => {
      const [doc] = await tx.select().from(manualJournals).where(eq(manualJournals.id, input.id)).for('update');
      if (doc && doc.status !== 'DRAFT') throw new BadRequestException('Hanya draft yang bisa diubah');
      if (doc && doc.createdBy !== actor.userId) throw new ForbiddenException('Draft ini milik pengguna lain');
      await this.validateManualLines(tx, input.lines);
      if (doc) {
        await tx.update(manualJournals).set({ journalDate: input.journalDate, description: input.description, updatedAt: new Date(), updatedBy: actor.userId }).where(eq(manualJournals.id, input.id));
        await tx.delete(manualJournalLines).where(eq(manualJournalLines.manualJournalId, input.id));
      } else {
        await tx.insert(manualJournals).values({ id: input.id, docNo: `DRAFT-${input.id.slice(0, 8)}`, journalDate: input.journalDate, description: input.description, createdBy: actor.userId, updatedBy: actor.userId });
      }
      await tx.insert(manualJournalLines).values(input.lines.map((l) => ({ ...l, memo: l.memo ?? null, manualJournalId: input.id })));
    });
    return this.manualJournal(input.id);
  }

  async submitManualJournal(actor: Principal, id: string) {
    const [doc] = await this.db.update(manualJournals).set({ status: 'PENDING_APPROVAL', submittedAt: new Date(), rejectedReason: null }).where(and(eq(manualJournals.id, id), eq(manualJournals.status, 'DRAFT'), eq(manualJournals.createdBy, actor.userId))).returning({ id: manualJournals.id });
    if (!doc) throw new BadRequestException('Hanya draft milik Anda yang bisa diajukan');
    return this.manualJournal(id);
  }

  async rejectManualJournal(actor: Principal, id: string, reason: string) {
    const [doc] = await this.db.update(manualJournals).set({ status: 'DRAFT', rejectedReason: reason, updatedAt: new Date(), updatedBy: actor.userId }).where(and(eq(manualJournals.id, id), eq(manualJournals.status, 'PENDING_APPROVAL'))).returning({ id: manualJournals.id });
    if (!doc) throw new BadRequestException('Jurnal tidak menunggu persetujuan');
    return this.manualJournal(id);
  }

  /** Four-eyes rule: the approver must not be the person who drafted it. */
  async approveManualJournal(actor: Principal, id: string) {
    await this.db.transaction(async (tx) => {
      const [doc] = await tx.select().from(manualJournals).where(eq(manualJournals.id, id)).for('update');
      if (!doc) throw new NotFoundException('Jurnal tidak ditemukan');
      if (doc.status !== 'PENDING_APPROVAL') throw new BadRequestException('Jurnal tidak menunggu persetujuan');
      if (doc.createdBy === actor.userId) throw new ForbiddenException('Pembuat jurnal tidak boleh menyetujui jurnalnya sendiri');
      const lines = await tx.select().from(manualJournalLines).where(eq(manualJournalLines.manualJournalId, id));
      const docNo = await this.numbers.next(tx, 'JU', doc.journalDate);
      const journal = await this.journals.post(tx, actor, {
        journalNo: docNo, journalDate: doc.journalDate, source: 'MANUAL', sourceDocType: 'JU', sourceDocId: id, description: doc.description,
        lines: lines.map((l) => ({ account: { accountId: l.accountId }, debit: l.debit, credit: l.credit, memo: l.memo })),
      });
      await tx.update(manualJournals).set({ docNo, status: 'POSTED', approvedBy: actor.userId, approvedAt: new Date(), journalId: journal.id }).where(eq(manualJournals.id, id));
      await this.audit.log({ action: 'post', entityType: 'manual_journal', entityId: id, userId: actor.userId, after: { docNo } }, tx);
    });
    return this.manualJournal(id);
  }

  /** "Balik jurnal": a new posted JU mirroring the original. */
  async reverseManualJournal(actor: Principal, id: string) {
    return this.db.transaction(async (tx) => {
      const [doc] = await tx.select().from(manualJournals).where(eq(manualJournals.id, id));
      if (doc?.status !== 'POSTED' || !doc.journalId) throw new BadRequestException('Hanya jurnal yang sudah diposting yang bisa dibalik');
      const date = businessDate();
      const docNo = await this.numbers.next(tx, 'JU', date);
      return this.journals.reverse(tx, actor, doc.journalId, { journalNo: docNo, journalDate: date, description: `Balik ${doc.docNo}: ${doc.description}` });
    });
  }

  async manualJournal(id: string) {
    const [doc] = await this.db.select().from(manualJournals).where(eq(manualJournals.id, id));
    if (!doc) throw new NotFoundException('Jurnal tidak ditemukan');
    const lines = await this.db.select().from(manualJournalLines).where(eq(manualJournalLines.manualJournalId, id));
    return { ...doc, lines };
  }

  private async validateManualLines(tx: DbTransaction, lines: { accountId: string; debit: number; credit: number }[]) {
    if (lines.length < 2) throw new BadRequestException('Jurnal minimal dua baris');
    if (lines.some((l) => (l.debit > 0) === (l.credit > 0))) throw new BadRequestException('Setiap baris berisi debit atau kredit, tidak keduanya');
    const debit = lines.reduce((s, l) => s + l.debit, 0);
    const credit = lines.reduce((s, l) => s + l.credit, 0);
    if (debit !== credit) throw new BadRequestException(`Jurnal tidak seimbang: debit ${debit}, kredit ${credit}`);
    const rows = await tx.select().from(accounts).where(inArray(accounts.id, [...new Set(lines.map((l) => l.accountId))]));
    for (const a of rows) {
      if (a.isControl) throw new BadRequestException(`Akun ${a.code} ${a.name} hanya bisa diubah lewat dokumen modulnya`);
      if (!a.isPostable || !a.isActive) throw new BadRequestException(`Akun ${a.code} tidak bisa dijurnal`);
    }
    if (rows.length !== new Set(lines.map((l) => l.accountId)).size) throw new BadRequestException('Ada akun yang tidak ditemukan');
  }

  private require(actor: Principal, code: Parameters<typeof hasPermission>[1]) {
    if (!hasPermission(actor, code)) throw new ForbiddenException({ message: 'Anda tidak punya izin untuk aksi ini', missingPermissions: [code] });
  }
}
