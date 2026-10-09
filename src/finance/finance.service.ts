import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, type SQL, sql } from 'drizzle-orm';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { paginated } from '../common/pagination.js';
import { DB, type Database } from '../database/database.module.js';
import {
  accountMappings,
  accounts,
  journalLines,
  journals,
  periods,
} from '../database/schema/index.js';
import { type MappingKey, normalBalanceOf } from './chart-template.js';

type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

export interface CreateAccountInput {
  code: string;
  name: string;
  parentId: string;
  isPostable: boolean;
  contra: boolean;
  cashKind?: 'DRAWER' | 'CASH' | 'PETTY_CASH' | 'BANK' | 'CLEARING' | null;
}

/** Chart of accounts, mappings and read access to periods and journals. */
@Injectable()
export class FinanceService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async listAccounts() {
    const rows = await this.db.select().from(accounts).orderBy(asc(accounts.code));
    const maps = await this.db.select().from(accountMappings);
    return rows.map((a) => ({
      ...a,
      mappedAs: maps.filter((m) => m.accountId === a.id).map((m) => m.key),
    }));
  }

  /** New accounts always sit under a header of the same type (keeps reports grouped). */
  async createAccount(actor: Principal, input: CreateAccountInput) {
    const [parent] = await this.db.select().from(accounts).where(eq(accounts.id, input.parentId));
    if (!parent) throw new BadRequestException('Akun induk tidak ditemukan');
    if (parent.isPostable) {
      throw new BadRequestException('Akun induk harus akun kelompok, bukan akun transaksi');
    }
    const type = parent.type as AccountType;
    const [row] = await this.db
      .insert(accounts)
      .values({
        code: input.code,
        name: input.name,
        type,
        normalBalance: normalBalanceOf(type, input.contra),
        parentId: parent.id,
        isPostable: input.isPostable,
        isControl: input.cashKind === 'DRAWER' || input.cashKind === 'CLEARING',
        cashKind: input.cashKind ?? null,
        cashFlowGroup: input.cashKind ? null : 'OPERATING',
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();
    await this.audit.log({
      action: 'account.create',
      entityType: 'account',
      entityId: row.id,
      userId: actor.userId,
      after: row,
    });
    return row;
  }

  async updateAccount(actor: Principal, id: string, input: { name: string; isActive: boolean }) {
    const [before] = await this.db.select().from(accounts).where(eq(accounts.id, id));
    if (!before) throw new NotFoundException('Akun tidak ditemukan');
    if (!input.isActive && before.isActive) {
      const [mapped] = await this.db
        .select({ key: accountMappings.key })
        .from(accountMappings)
        .where(eq(accountMappings.accountId, id));
      if (mapped) {
        throw new ConflictException(`Akun dipakai jurnal otomatis (${mapped.key}), tidak bisa dinonaktifkan`);
      }
    }
    const [after] = await this.db
      .update(accounts)
      .set({ name: input.name, isActive: input.isActive, updatedAt: new Date(), updatedBy: actor.userId })
      .where(eq(accounts.id, id))
      .returning();
    await this.audit.log({
      action: 'account.update',
      entityType: 'account',
      entityId: id,
      userId: actor.userId,
      before,
      after,
    });
    return after;
  }

  listMappings() {
    return this.db
      .select({
        key: accountMappings.key,
        accountId: accounts.id,
        code: accounts.code,
        name: accounts.name,
      })
      .from(accountMappings)
      .innerJoin(accounts, eq(accounts.id, accountMappings.accountId))
      .orderBy(asc(accountMappings.key));
  }

  async setMapping(actor: Principal, key: MappingKey, accountId: string) {
    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, accountId));
    if (!account?.isActive || !account.isPostable) {
      throw new BadRequestException('Akun harus akun transaksi yang aktif');
    }
    const [before] = await this.db.select().from(accountMappings).where(eq(accountMappings.key, key));
    await this.db
      .insert(accountMappings)
      .values({ key, accountId, updatedBy: actor.userId })
      .onConflictDoUpdate({
        target: accountMappings.key,
        set: { accountId, updatedAt: new Date(), updatedBy: actor.userId },
      });
    await this.audit.log({
      action: 'account_mapping.change',
      entityType: 'account_mapping',
      entityId: key,
      userId: actor.userId,
      before: before ?? null,
      after: { key, accountId },
    });
  }

  listPeriods() {
    return this.db.select().from(periods).orderBy(desc(periods.id));
  }

  async listJournals(query: { from?: string; to?: string; page: number; limit: number }) {
    const filters: SQL[] = [];
    if (query.from) filters.push(gte(journals.journalDate, query.from));
    if (query.to) filters.push(lte(journals.journalDate, query.to));
    const where = and(...filters);
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: journals.id,
          journalNo: journals.journalNo,
          journalDate: journals.journalDate,
          source: journals.source,
          sourceDocType: journals.sourceDocType,
          sourceDocId: journals.sourceDocId,
          description: journals.description,
          status: journals.status,
          reversalOfId: journals.reversalOfId,
          total: sql<number>`(select coalesce(sum(debit), 0)::bigint from journal_lines l where l.journal_id = "journals"."id")`.mapWith(Number),
        })
        .from(journals)
        .where(where)
        .orderBy(desc(journals.journalDate), desc(journals.journalNo))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      this.db.select({ total: sql<number>`count(*)::int` }).from(journals).where(where),
    ]);
    return paginated(rows, total, { ...query, includeInactive: false });
  }

  async journalDetail(id: string) {
    const [journal] = await this.db.select().from(journals).where(eq(journals.id, id));
    if (!journal) throw new NotFoundException('Jurnal tidak ditemukan');
    const lines = await this.db
      .select({
        id: journalLines.id,
        accountId: accounts.id,
        accountCode: accounts.code,
        accountName: accounts.name,
        debit: journalLines.debit,
        credit: journalLines.credit,
        memo: journalLines.memo,
      })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(eq(journalLines.journalId, id))
      .orderBy(asc(journalLines.id));
    return { ...journal, lines };
  }
}
