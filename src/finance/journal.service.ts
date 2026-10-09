import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { isIsoDate, periodOf, periodRange } from '../common/business-date.js';
import type { DbTransaction } from '../database/database.module.js';
import {
  accountMappings,
  accounts,
  journalLines,
  journals,
  periods,
} from '../database/schema/index.js';
import type { MappingKey } from './chart-template.js';

export interface JournalLineInput {
  /** A mapping key for automatic journals, or a concrete account. */
  account: MappingKey | { accountId: string };
  debit?: number;
  credit?: number;
  memo?: string | null;
  supplierId?: string | null;
  skuId?: string | null;
}

export interface PostJournalInput {
  journalNo: string;
  journalDate: string;
  source: 'AUTO' | 'MANUAL' | 'OPENING' | 'CLOSING';
  sourceDocType?: string | null;
  sourceDocId?: string | null;
  description: string;
  lines: JournalLineInput[];
  /** Set when this journal reverses another (posted journals cannot be updated afterwards). */
  reversalOfId?: string | null;
}

/**
 * The only way money enters the general ledger. Always called inside the caller's
 * posting transaction so the document, stock ledger and journal commit together.
 * The database re-checks balance, immutability and closed periods (0004_ledger_guards).
 */
@Injectable()
export class JournalService {
  async post(tx: DbTransaction, actor: { userId: string }, input: PostJournalInput) {
    if (!isIsoDate(input.journalDate)) {
      throw new BadRequestException('Tanggal jurnal tidak valid');
    }
    const lines = input.lines.map((l) => ({
      ...l,
      debit: l.debit ?? 0,
      credit: l.credit ?? 0,
    }));
    if (lines.length < 2) throw new BadRequestException('Jurnal minimal dua baris');
    for (const l of lines) {
      const valid =
        Number.isSafeInteger(l.debit) &&
        Number.isSafeInteger(l.credit) &&
        l.debit >= 0 &&
        l.credit >= 0 &&
        (l.debit === 0) !== (l.credit === 0);
      if (!valid) {
        throw new BadRequestException('Setiap baris jurnal berisi debit atau kredit (rupiah bulat), tidak keduanya');
      }
    }
    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
    if (totalDebit !== totalCredit) {
      throw new BadRequestException(
        `Jurnal tidak seimbang: debit ${totalDebit}, kredit ${totalCredit}`,
      );
    }

    const accountIds = await this.resolveAccounts(tx, lines.map((l) => l.account));
    const accountRows = await tx
      .select()
      .from(accounts)
      .where(inArray(accounts.id, [...new Set(accountIds)]));
    const byId = new Map(accountRows.map((a) => [a.id, a]));
    for (const id of accountIds) {
      const account = byId.get(id);
      if (!account) throw new BadRequestException('Akun jurnal tidak ditemukan');
      if (!account.isPostable || !account.isActive) {
        throw new BadRequestException(`Akun ${account.code} tidak bisa dijurnal`);
      }
      if (input.source === 'MANUAL' && account.isControl) {
        throw new BadRequestException(
          `Akun ${account.code} ${account.name} hanya bisa diubah lewat dokumen modulnya`,
        );
      }
    }

    const periodId = await this.ensureOpenPeriod(tx, input.journalDate);
    const [journal] = await tx
      .insert(journals)
      .values({
        journalNo: input.journalNo,
        journalDate: input.journalDate,
        periodId,
        source: input.source,
        sourceDocType: input.sourceDocType ?? null,
        sourceDocId: input.sourceDocId ?? null,
        description: input.description,
        reversalOfId: input.reversalOfId ?? null,
        status: 'POSTED',
        postedAt: new Date(),
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning({ id: journals.id, journalNo: journals.journalNo });
    await tx.insert(journalLines).values(
      lines.map((l, i) => ({
        journalId: journal.id,
        accountId: accountIds[i],
        debit: l.debit,
        credit: l.credit,
        memo: l.memo ?? null,
        journalDate: input.journalDate,
        supplierId: l.supplierId ?? null,
        skuId: l.skuId ?? null,
      })),
    );
    return journal;
  }

  /** Posts the mirror image of a journal; the original stays untouched. */
  async reverse(
    tx: DbTransaction,
    actor: { userId: string },
    journalId: string,
    input: { journalNo: string; journalDate: string; description: string },
  ) {
    const [original] = await tx.select().from(journals).where(eq(journals.id, journalId));
    if (!original) throw new NotFoundException('Jurnal tidak ditemukan');
    const [already] = await tx
      .select({ id: journals.id })
      .from(journals)
      .where(eq(journals.reversalOfId, journalId));
    if (already) throw new ConflictException('Jurnal ini sudah pernah dibalik');
    const lines = await tx.select().from(journalLines).where(eq(journalLines.journalId, journalId));

    return this.post(tx, actor, {
      journalNo: input.journalNo,
      journalDate: input.journalDate,
      source: original.source === 'MANUAL' ? 'MANUAL' : 'AUTO',
      sourceDocType: original.sourceDocType,
      sourceDocId: original.sourceDocId,
      description: input.description,
      lines: lines.map((l) => ({
        account: { accountId: l.accountId },
        debit: l.credit,
        credit: l.debit,
        memo: l.memo,
        supplierId: l.supplierId,
        skuId: l.skuId,
      })),
      reversalOfId: journalId,
    });
  }

  /** Creates the period row on first use; refuses closed periods with a clear message. */
  async ensureOpenPeriod(tx: DbTransaction, date: string) {
    const range = periodRange(date);
    await tx.insert(periods).values(range).onConflictDoNothing();
    // FOR SHARE: a concurrent period close (FOR UPDATE) waits for this posting.
    const [period] = await tx
      .select({ status: periods.status })
      .from(periods)
      .where(eq(periods.id, periodOf(date)))
      .for('share');
    if (period.status === 'CLOSED') {
      throw new BadRequestException(`Periode ${range.id} sudah ditutup`);
    }
    return range.id;
  }

  private async resolveAccounts(tx: DbTransaction, refs: JournalLineInput['account'][]) {
    const keys = [...new Set(refs.filter((r): r is MappingKey => typeof r === 'string'))];
    const mapped = keys.length
      ? await tx
          .select({ key: accountMappings.key, accountId: accountMappings.accountId })
          .from(accountMappings)
          .where(inArray(accountMappings.key, keys))
      : [];
    const byKey = new Map(mapped.map((m) => [m.key as string, m.accountId]));
    return refs.map((r) => {
      if (typeof r !== 'string') return r.accountId;
      const id = byKey.get(r);
      if (!id) throw new BadRequestException(`Pemetaan akun ${r} belum diatur`);
      return id;
    });
  }
}
