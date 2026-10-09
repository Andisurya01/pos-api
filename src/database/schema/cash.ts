// ERD 06 — Keuangan, part 2: cash documents, manual journals, EDC settlement (docs/alur/07).
import { boolean, date, pgEnum, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { money } from './catalog.js';
import { timestamptz } from './columns.js';
import { accounts, journals } from './finance.js';
import { paymentMethods, shifts } from './sales.js';
import { auditColumns, users } from './system.js';

export const financeCategoryKind = pgEnum('finance_category_kind', ['EXPENSE', 'INCOME']);
export const cashDirection = pgEnum('cash_direction', ['OUT', 'IN']);
export const financeDocStatus = pgEnum('finance_doc_status', ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'CANCELLED']);

export const financeCategories = pgTable('finance_categories', {
  id: uuid().primaryKey().defaultRandom(),
  kind: financeCategoryKind().notNull(),
  name: text().notNull(),
  accountId: uuid()
    .notNull()
    .references(() => accounts.id),
  sortOrder: smallint().notNull().default(0),
  isActive: boolean().notNull().default(true),
  ...auditColumns(),
});

/** Kas keluar (KK) / kas masuk lain-lain (KM). */
export const cashTransactions = pgTable('cash_transactions', {
  id: uuid().primaryKey(),
  docNo: text().notNull().unique(),
  direction: cashDirection().notNull(),
  status: financeDocStatus().notNull(),
  categoryId: uuid()
    .notNull()
    .references(() => financeCategories.id),
  cashAccountId: uuid()
    .notNull()
    .references(() => accounts.id),
  shiftId: uuid().references(() => shifts.id),
  amount: money().notNull(),
  description: text().notNull(),
  businessDate: date().notNull(),
  approvedBy: uuid().references(() => users.id),
  approvedAt: timestamptz(),
  journalId: uuid().references(() => journals.id),
  ...auditColumns(),
});

/** Mutasi kas antar akun (MK): setoran ke bank, isi kas kecil, tarik tunai. */
export const cashTransfers = pgTable('cash_transfers', {
  id: uuid().primaryKey(),
  docNo: text().notNull().unique(),
  fromAccountId: uuid()
    .notNull()
    .references(() => accounts.id),
  toAccountId: uuid()
    .notNull()
    .references(() => accounts.id),
  amount: money().notNull(),
  description: text(),
  businessDate: date().notNull(),
  journalId: uuid().references(() => journals.id),
  ...auditColumns(),
});

/** Jurnal umum (JU): drafted by one person, approved and posted by another. */
export const manualJournals = pgTable('manual_journals', {
  id: uuid().primaryKey(),
  docNo: text().notNull().unique(),
  status: financeDocStatus().notNull().default('DRAFT'),
  journalDate: date().notNull(),
  description: text().notNull(),
  submittedAt: timestamptz(),
  approvedBy: uuid().references(() => users.id),
  approvedAt: timestamptz(),
  rejectedReason: text(),
  journalId: uuid().references(() => journals.id),
  ...auditColumns(),
});

export const manualJournalLines = pgTable('manual_journal_lines', {
  id: uuid().primaryKey().defaultRandom(),
  manualJournalId: uuid()
    .notNull()
    .references(() => manualJournals.id, { onDelete: 'cascade' }),
  accountId: uuid()
    .notNull()
    .references(() => accounts.id),
  debit: money().notNull().default(0),
  credit: money().notNull().default(0),
  memo: text(),
});

/** Pencairan QRIS/kartu ke bank, net of MDR. */
export const edcSettlements = pgTable('edc_settlements', {
  id: uuid().primaryKey(),
  docNo: text().notNull().unique(),
  paymentMethodId: uuid()
    .notNull()
    .references(() => paymentMethods.id),
  bankAccountId: uuid()
    .notNull()
    .references(() => accounts.id),
  settlementDate: date().notNull(),
  grossAmount: money().notNull(),
  mdrAmount: money().notNull(),
  netAmount: money().notNull(),
  journalId: uuid().references(() => journals.id),
  ...auditColumns(),
});
