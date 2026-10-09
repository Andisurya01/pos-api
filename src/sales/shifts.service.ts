import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { PinService } from '../access/pin.service.js';
import { hasPermission, type Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { businessDate } from '../common/business-date.js';
import { DB, type Database, type DbExecutor, type DbTransaction } from '../database/database.module.js';
import { heldSales, journalLines, shiftCashMovements, shifts, terminals } from '../database/schema/index.js';
import { DocumentNumberService } from '../finance/document-number.service.js';
import { type JournalLineInput, JournalService } from '../finance/journal.service.js';

export interface CloseShiftInput {
  countedCash: number;
  depositAmount: number;
  differenceReason?: string | null;
  cashDenominations?: Record<string, number> | null;
  noncashSummary?: Record<string, unknown> | null;
}

/**
 * Shifts (docs/alur/04 §1, §6, §7). What should be in the drawer is the balance of the
 * drawer's own ledger account, so every posting that touches the drawer — opening float,
 * cash in/out, and later cash sales and refunds — is counted automatically.
 */
@Injectable()
export class ShiftsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly journals: JournalService,
    private readonly numbers: DocumentNumberService,
    private readonly pins: PinService,
  ) {}

  async open(actor: Principal, input: { id: string; terminalId: string; openingFloat?: number }) {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: shifts.id }).from(shifts).where(eq(shifts.id, input.id));
      if (existing) return;
      const [terminal] = await tx.select().from(terminals).where(eq(terminals.id, input.terminalId)).for('update');
      if (!terminal?.isActive) throw new BadRequestException('Laci kasir tidak ditemukan atau nonaktif');
      const [busy] = await tx
        .select({ cashierId: shifts.cashierId, terminalId: shifts.terminalId })
        .from(shifts)
        .where(and(eq(shifts.status, 'OPEN'), sql`(${shifts.terminalId} = ${terminal.id} or ${shifts.cashierId} = ${actor.userId})`));
      if (busy) {
        throw new ConflictException(busy.terminalId === terminal.id ? 'Laci ini masih dipakai shift yang belum ditutup' : 'Anda masih punya shift yang belum ditutup');
      }
      const openingFloat = input.openingFloat ?? terminal.defaultFloat;
      const date = businessDate();
      // Money already left in the drawer by the previous shift counts toward the float.
      const carried = await this.drawerBalance(tx, terminal.cashAccountId);
      const topUp = openingFloat - carried;
      let journalId: string | null = null;
      if (topUp !== 0) {
        const docNo = await this.numbers.next(tx, 'MK', date);
        const journal = await this.journals.post(tx, actor, {
          journalNo: docNo, journalDate: date, source: 'AUTO', sourceDocType: 'SHIFT', sourceDocId: input.id,
          description: `Modal awal shift ${terminal.code}`,
          lines: this.moveCash(terminal.cashAccountId, topUp),
        });
        journalId = journal.id;
      }
      await tx.insert(shifts).values({ id: input.id, terminalId: terminal.id, cashierId: actor.userId, businessDate: date, openingFloat, openingJournalId: journalId });
      await this.audit.log({ action: 'shift.open', entityType: 'shift', entityId: input.id, userId: actor.userId, terminalId: terminal.id, after: { openingFloat, carried } }, tx);
    });
    return this.summary(input.id);
  }

  async current(actor: Principal) {
    const [open] = await this.db.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.cashierId, actor.userId), eq(shifts.status, 'OPEN')));
    return open ? this.summary(open.id) : null;
  }

  /** Kas masuk/keluar di laci: between the drawer and kas besar (setoran tengah shift, tambah receh). */
  async cashMovement(actor: Principal, shiftId: string, input: { kind: 'CASH_IN' | 'CASH_OUT'; amount: number; reason: string }) {
    if (input.amount <= 0) throw new BadRequestException('Jumlah harus lebih dari 0');
    await this.db.transaction(async (tx) => {
      const { shift, terminal } = await this.lockOwnOpenShift(tx, actor, shiftId);
      if (input.kind === 'CASH_OUT' && input.amount > (await this.drawerBalance(tx, terminal.cashAccountId))) {
        throw new BadRequestException('Uang di laci tidak cukup');
      }
      const date = businessDate();
      const docNo = await this.numbers.next(tx, 'MK', date);
      const journal = await this.journals.post(tx, actor, {
        journalNo: docNo, journalDate: date, source: 'AUTO', sourceDocType: 'SHIFT', sourceDocId: shift.id,
        description: `${input.kind === 'CASH_IN' ? 'Kas masuk' : 'Kas keluar'} laci ${terminal.code}: ${input.reason}`,
        lines: this.moveCash(terminal.cashAccountId, input.kind === 'CASH_IN' ? input.amount : -input.amount),
      });
      await tx.insert(shiftCashMovements).values({ shiftId, kind: input.kind, amount: input.amount, reason: input.reason, journalId: journal.id, createdBy: actor.userId });
    });
    return this.summary(shiftId);
  }

  /** Opening the drawer without a sale is a [PIN] action and always logged. */
  async openDrawer(actor: Principal, shiftId: string, input: { reason: string; pinApprovalId?: string | null }) {
    await this.db.transaction(async (tx) => {
      await this.lockOwnOpenShift(tx, actor, shiftId);
      const pinApprovalId = await this.pins.authorize(tx, actor, 'penjualan.kasir.buka_laci', input.pinApprovalId, { type: 'shift', id: shiftId });
      await tx.insert(shiftCashMovements).values({ shiftId, kind: 'DRAWER_OPEN', amount: 0, reason: input.reason, pinApprovalId, createdBy: actor.userId });
    });
    return this.summary(shiftId);
  }

  /**
   * Tutup shift: the counted cash is compared with the drawer balance; the difference is
   * journaled (kurang → beban selisih kas, lebih → pendapatan selisih kas) and the deposit
   * moves to kas besar. Whatever is not deposited stays in the drawer for the next shift.
   */
  async close(actor: Principal, shiftId: string, input: CloseShiftInput) {
    await this.db.transaction(async (tx) => {
      const [shift] = await tx.select().from(shifts).where(eq(shifts.id, shiftId)).for('update');
      if (!shift) throw new NotFoundException('Shift tidak ditemukan');
      if (shift.status !== 'OPEN') throw new BadRequestException('Shift sudah ditutup');
      const forced = shift.cashierId !== actor.userId;
      if (forced && !hasPermission(actor, 'penjualan.shift.tutup_paksa')) {
        throw new ForbiddenException({ message: 'Hanya kasir pemilik shift yang bisa menutupnya', missingPermissions: ['penjualan.shift.tutup_paksa'] });
      }
      const [terminal] = await tx.select().from(terminals).where(eq(terminals.id, shift.terminalId));
      const expected = await this.drawerBalance(tx, terminal.cashAccountId);
      const difference = input.countedCash - expected;
      if (difference !== 0 && !input.differenceReason) throw new BadRequestException('Ada selisih kas; isi alasannya');
      if (input.depositAmount < 0 || input.depositAmount > input.countedCash) throw new BadRequestException('Setoran tidak boleh melebihi uang yang dihitung');

      const lines: JournalLineInput[] = [];
      const drawer = { accountId: terminal.cashAccountId };
      if (difference < 0) lines.push({ account: 'CASH_SHORT', debit: -difference }, { account: drawer, credit: -difference });
      if (difference > 0) lines.push({ account: drawer, debit: difference }, { account: 'CASH_OVER', credit: difference });
      if (input.depositAmount > 0) lines.push(...this.moveCash(terminal.cashAccountId, -input.depositAmount));
      const date = businessDate();
      let closingJournalId: string | null = null;
      if (lines.length) {
        const docNo = await this.numbers.next(tx, 'MK', date);
        closingJournalId = (await this.journals.post(tx, actor, {
          journalNo: docNo, journalDate: date, source: 'AUTO', sourceDocType: 'SHIFT', sourceDocId: shiftId,
          description: `Tutup shift ${terminal.code}`, lines,
        })).id;
      }
      // Held carts are discarded when the shift ends (docs/alur/04 §2).
      await tx.delete(heldSales).where(eq(heldSales.shiftId, shiftId));
      await tx
        .update(shifts)
        .set({
          status: 'CLOSED', closedAt: new Date(), closedBy: actor.userId, isForcedClose: forced,
          expectedCash: expected, countedCash: input.countedCash, cashDifference: difference,
          differenceReason: input.differenceReason ?? null, cashDenominations: input.cashDenominations ?? null,
          noncashSummary: input.noncashSummary ?? null, depositAmount: input.depositAmount,
          floatLeft: input.countedCash - input.depositAmount, closingJournalId,
        })
        .where(eq(shifts.id, shiftId));
      await this.audit.log({ action: 'shift.close', entityType: 'shift', entityId: shiftId, userId: actor.userId, terminalId: terminal.id, after: { expected, counted: input.countedCash, difference, forced } }, tx);
    });
    return this.summary(shiftId);
  }

  async summary(shiftId: string) {
    const [shift] = await this.db.select().from(shifts).where(eq(shifts.id, shiftId));
    if (!shift) throw new NotFoundException('Shift tidak ditemukan');
    const [terminal] = await this.db.select({ code: terminals.code, name: terminals.name, cashAccountId: terminals.cashAccountId }).from(terminals).where(eq(terminals.id, shift.terminalId));
    const movements = await this.db.select().from(shiftCashMovements).where(eq(shiftCashMovements.shiftId, shiftId)).orderBy(asc(shiftCashMovements.occurredAt));
    const drawerBalance = await this.drawerBalance(this.db, terminal.cashAccountId);
    return { ...shift, terminal: { code: terminal.code, name: terminal.name }, movements, drawerBalance: shift.status === 'OPEN' ? drawerBalance : null };
  }

  // ----------------------------------------------------------------- helpers

  private async lockOwnOpenShift(tx: DbTransaction, actor: Principal, shiftId: string) {
    const [shift] = await tx.select().from(shifts).where(eq(shifts.id, shiftId)).for('update');
    if (!shift) throw new NotFoundException('Shift tidak ditemukan');
    if (shift.status !== 'OPEN') throw new BadRequestException('Shift sudah ditutup');
    if (shift.cashierId !== actor.userId) throw new ForbiddenException('Ini bukan shift Anda');
    const [terminal] = await tx.select().from(terminals).where(eq(terminals.id, shift.terminalId));
    return { shift, terminal };
  }

  /** Current balance of a drawer account in the general ledger. */
  private async drawerBalance(tx: DbExecutor, accountId: string) {
    const [row] = await tx
      .select({ balance: sql<number>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::bigint`.mapWith(Number) })
      .from(journalLines)
      .where(eq(journalLines.accountId, accountId));
    return row.balance;
  }

  /** Positive amount: kas besar → laci. Negative: laci → kas besar. */
  private moveCash(drawerAccountId: string, amount: number): JournalLineInput[] {
    const drawer = { accountId: drawerAccountId };
    return amount > 0
      ? [{ account: drawer, debit: amount }, { account: 'MAIN_CASH', credit: amount }]
      : [{ account: 'MAIN_CASH', debit: -amount }, { account: drawer, credit: -amount }];
  }
}
