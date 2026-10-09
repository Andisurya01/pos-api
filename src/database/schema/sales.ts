// ERD 04 — Penjualan, part 1: cash drawers, payment methods, shifts (docs/erd/04-penjualan.md).
// Sales documents (sales, voids, returns) follow in the next migration.
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { money } from './catalog.js';
import { timestamptz } from './columns.js';
import { accounts, journals } from './finance.js';
import { locations } from './stock.js';
import { auditColumns, pinApprovals, users } from './system.js';

export const paymentKind = pgEnum('payment_kind', ['CASH', 'QRIS', 'CARD', 'TRANSFER']);
export const shiftStatus = pgEnum('shift_status', ['OPEN', 'CLOSED']);
export const drawerMovement = pgEnum('drawer_movement', ['CASH_IN', 'CASH_OUT', 'DRAWER_OPEN']);

export const terminals = pgTable('terminals', {
  id: uuid().primaryKey().defaultRandom(),
  code: text().notNull().unique(),
  name: text().notNull(),
  salesLocationId: uuid()
    .notNull()
    .references(() => locations.id),
  cashAccountId: uuid()
    .notNull()
    .unique()
    .references(() => accounts.id),
  defaultFloat: money().notNull().default(0),
  printerConfig: jsonb().notNull().default({}),
  customerDisplayEnabled: boolean().notNull().default(false),
  isActive: boolean().notNull().default(true),
  ...auditColumns(),
});

export const paymentMethods = pgTable('payment_methods', {
  id: uuid().primaryKey().defaultRandom(),
  code: text().notNull().unique(),
  name: text().notNull(),
  kind: paymentKind().notNull(),
  /** QRIS/CARD: clearing account; TRANSFER: bank; CASH: null (the drawer of the terminal). */
  accountId: uuid().references(() => accounts.id),
  requiresReference: boolean().notNull().default(false),
  sortOrder: smallint().notNull().default(0),
  isActive: boolean().notNull().default(true),
  ...auditColumns(),
});

export const shifts = pgTable(
  'shifts',
  {
    id: uuid().primaryKey(),
    terminalId: uuid()
      .notNull()
      .references(() => terminals.id),
    cashierId: uuid()
      .notNull()
      .references(() => users.id),
    status: shiftStatus().notNull().default('OPEN'),
    businessDate: date().notNull(),
    openedAt: timestamptz().notNull().defaultNow(),
    openingFloat: money().notNull(),
    openingJournalId: uuid().references(() => journals.id),
    closedAt: timestamptz(),
    closedBy: uuid().references(() => users.id),
    isForcedClose: boolean().notNull().default(false),
    expectedCash: money(),
    countedCash: money(),
    cashDifference: money(),
    differenceReason: text(),
    cashDenominations: jsonb(),
    noncashSummary: jsonb(),
    depositAmount: money(),
    floatLeft: money(),
    closingJournalId: uuid().references(() => journals.id),
  },
  (t) => [
    uniqueIndex('shifts_one_open_per_terminal_uq').on(t.terminalId).where(sql`${t.status} = 'OPEN'`),
    uniqueIndex('shifts_one_open_per_cashier_uq').on(t.cashierId).where(sql`${t.status} = 'OPEN'`),
    index('shifts_date_idx').on(t.businessDate),
  ],
);

export const shiftCashMovements = pgTable('shift_cash_movements', {
  id: uuid().primaryKey().defaultRandom(),
  shiftId: uuid()
    .notNull()
    .references(() => shifts.id),
  kind: drawerMovement().notNull(),
  amount: money().notNull(),
  reason: text().notNull(),
  journalId: uuid().references(() => journals.id),
  cashTransactionId: uuid(),
  supplierPaymentId: uuid(),
  pinApprovalId: uuid().references(() => pinApprovals.id),
  occurredAt: timestamptz().notNull().defaultNow(),
  createdBy: uuid().references(() => users.id),
});
