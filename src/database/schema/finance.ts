// ERD 06 — Keuangan, core part: chart of accounts, mappings, periods, journals
// (docs/erd/06-keuangan.md). Cash documents and bank reconciliation follow later.
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { money } from './catalog.js';
import { timestamptz } from './columns.js';
import { auditColumns, users } from './system.js';

export const accountType = pgEnum('account_type', [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'EXPENSE',
]);
export const debitCredit = pgEnum('dc', ['DEBIT', 'CREDIT']);
export const cashKind = pgEnum('cash_kind', ['DRAWER', 'CASH', 'PETTY_CASH', 'BANK', 'CLEARING']);
export const cashFlowGroup = pgEnum('cash_flow_group', ['OPERATING', 'INVESTING', 'FINANCING']);
export const mappingKey = pgEnum('mapping_key', [
  'INVENTORY',
  'GRNI',
  'COGS',
  'SALES',
  'SALES_DISCOUNT',
  'SALES_RETURN',
  'VAT_OUT',
  'ROUNDING_GAIN',
  'ROUNDING_LOSS',
  'ACCOUNTS_PAYABLE',
  'VAT_IN',
  'PURCHASE_RETURN_VARIANCE',
  'MAIN_CASH',
  'CASH_OVER',
  'CASH_SHORT',
  'MDR_EXPENSE',
  'BANK_FEE',
  'INV_SHRINKAGE',
  'INV_GAIN',
  'DAMAGE_EXPENSE',
  'SELF_USE_EXPENSE',
  'PROMO_EXPENSE',
  'OPENING_EQUITY',
  'CURRENT_YEAR_EARNINGS',
  'RETAINED_EARNINGS',
]);
export const periodStatus = pgEnum('period_status', ['OPEN', 'CLOSED']);
export const journalSource = pgEnum('journal_source', ['AUTO', 'MANUAL', 'OPENING', 'CLOSING']);
export const journalStatus = pgEnum('journal_status', ['DRAFT', 'PENDING_APPROVAL', 'POSTED']);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid().primaryKey().defaultRandom(),
    code: text().notNull().unique(),
    name: text().notNull(),
    type: accountType().notNull(),
    normalBalance: debitCredit().notNull(),
    parentId: uuid().references((): AnyPgColumn => accounts.id),
    isPostable: boolean().notNull().default(true),
    isControl: boolean().notNull().default(false),
    cashKind: cashKind(),
    cashFlowGroup: cashFlowGroup(),
    isSystem: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    ...auditColumns(),
  },
  (t) => [index('accounts_parent_idx').on(t.parentId)],
);

export const accountMappings = pgTable('account_mappings', {
  key: mappingKey().primaryKey(),
  accountId: uuid()
    .notNull()
    .references(() => accounts.id),
  updatedAt: timestamptz().notNull().defaultNow(),
  updatedBy: uuid().references(() => users.id),
});

export const bankAccounts = pgTable('bank_accounts', {
  accountId: uuid()
    .primaryKey()
    .references(() => accounts.id),
  bankName: text().notNull(),
  accountNo: text().notNull(),
  holderName: text().notNull(),
  importMapping: text(),
});

export const periods = pgTable(
  'periods',
  {
    id: char({ length: 7 }).primaryKey(), // YYYY-MM
    startsOn: date().notNull(),
    endsOn: date().notNull(),
    status: periodStatus().notNull().default('OPEN'),
    closedAt: timestamptz(),
    closedBy: uuid().references(() => users.id),
    reopenedAt: timestamptz(),
    reopenedBy: uuid().references(() => users.id),
    reopenReason: text(),
    closingJournalId: uuid(),
  },
  (t) => [check('periods_range_check', sql`${t.endsOn} >= ${t.startsOn}`)],
);

/** Posted journals are immutable (trigger); a correction is a new journal with reversal_of_id. */
export const journals = pgTable(
  'journals',
  {
    id: uuid().primaryKey().defaultRandom(),
    journalNo: text().notNull().unique(),
    journalDate: date().notNull(),
    periodId: char({ length: 7 })
      .notNull()
      .references(() => periods.id),
    source: journalSource().notNull(),
    sourceDocType: text(),
    sourceDocId: uuid(),
    description: text().notNull(),
    status: journalStatus().notNull().default('POSTED'),
    reversalOfId: uuid()
      .unique()
      .references((): AnyPgColumn => journals.id),
    approvedBy: uuid().references(() => users.id),
    postedAt: timestamptz(),
    ...auditColumns(),
  },
  (t) => [
    index('journals_source_doc_idx').on(t.sourceDocType, t.sourceDocId),
    index('journals_date_idx').on(t.journalDate),
  ],
);

/** Append-only; balanced per journal (deferred constraint trigger, see migration). */
export const journalLines = pgTable(
  'journal_lines',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    journalId: uuid()
      .notNull()
      .references(() => journals.id),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id),
    debit: money().notNull().default(0),
    credit: money().notNull().default(0),
    memo: text(),
    journalDate: date().notNull(),
    supplierId: uuid(),
    skuId: uuid(),
  },
  (t) => [
    index('journal_lines_account_date_idx').on(t.accountId, t.journalDate),
    index('journal_lines_journal_idx').on(t.journalId),
    check(
      'journal_lines_amount_check',
      sql`${t.debit} >= 0 and ${t.credit} >= 0 and (${t.debit} = 0) <> (${t.credit} = 0)`,
    ),
  ],
);
