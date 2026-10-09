// ERD 04 — Penjualan, part 1: cash drawers, payment methods, shifts (docs/erd/04-penjualan.md).
// Part 2 below: sales, voids, returns, held sales.
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
import { members, money, priceLevel, promotions, qty, skus, skuUnits } from './catalog.js';
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

// ---------------------------------------------------------------- part 2: sales

export const saleStatus = pgEnum('sale_status', ['POSTED', 'VOIDED']);
export const discountMode = pgEnum('discount_mode', ['NONE', 'ITEM', 'TOTAL']);
export const returnCondition = pgEnum('return_condition', ['SELLABLE', 'DAMAGED']);

/** Penjualan (PJ). Posted when paid; every amount is stored so returns never recompute. */
export const sales = pgTable(
  'sales',
  {
    id: uuid().primaryKey(),
    docNo: text().notNull().unique(),
    businessDate: date().notNull(),
    shiftId: uuid()
      .notNull()
      .references(() => shifts.id),
    terminalId: uuid()
      .notNull()
      .references(() => terminals.id),
    cashierId: uuid()
      .notNull()
      .references(() => users.id),
    memberId: uuid().references(() => members.id),
    status: saleStatus().notNull().default('POSTED'),
    discountMode: discountMode().notNull(),
    totalPromoId: uuid().references(() => promotions.id),
    grossAmount: money().notNull(),
    promoDiscountAmount: money().notNull(),
    manualDiscountAmount: money().notNull(),
    manualDiscountPinId: uuid().references(() => pinApprovals.id),
    netAmount: money().notNull(),
    taxRate: text().notNull(),
    taxBase: money().notNull(),
    taxAmount: money().notNull(),
    roundingAmount: money().notNull(),
    amountDue: money().notNull(),
    paidAmount: money().notNull(),
    changeAmount: money().notNull(),
    costAmount: money().notNull(),
    reprintCount: smallint().notNull().default(0),
    postedAt: timestamptz().notNull().defaultNow(),
    journalId: uuid().references(() => journals.id),
  },
  (t) => [index('sales_shift_idx').on(t.shiftId), index('sales_date_idx').on(t.businessDate)],
);

export const saleLines = pgTable('sale_lines', {
  id: uuid().primaryKey().defaultRandom(),
  saleId: uuid()
    .notNull()
    .references(() => sales.id),
  lineNo: smallint().notNull(),
  skuId: uuid()
    .notNull()
    .references(() => skus.id),
  skuUnitId: uuid()
    .notNull()
    .references(() => skuUnits.id),
  qty: qty().notNull(),
  baseQty: qty().notNull(),
  priceLevel: priceLevel().notNull(),
  unitPrice: money().notNull(),
  originalUnitPrice: money(),
  priceOverridePinId: uuid().references(() => pinApprovals.id),
  grossAmount: money().notNull(),
  itemPromoId: uuid().references(() => promotions.id),
  promoDiscount: money().notNull(),
  manualDiscount: money().notNull(),
  netAmount: money().notNull(),
  isTaxable: boolean().notNull(),
  taxAmount: money().notNull(),
  costAmount: money().notNull(),
  scannedCode: text(),
  returnedBaseQty: qty().notNull().default('0'),
});

/** Bundle lines: the components that left the stock. */
export const saleLineComponents = pgTable('sale_line_components', {
  id: uuid().primaryKey().defaultRandom(),
  saleLineId: uuid()
    .notNull()
    .references(() => saleLines.id),
  componentSkuId: uuid()
    .notNull()
    .references(() => skus.id),
  baseQty: qty().notNull(),
  costAmount: money().notNull(),
});

export const salePayments = pgTable('sale_payments', {
  id: uuid().primaryKey().defaultRandom(),
  saleId: uuid()
    .notNull()
    .references(() => sales.id),
  paymentMethodId: uuid()
    .notNull()
    .references(() => paymentMethods.id),
  amount: money().notNull(),
  tendered: money(),
  change: money(),
  referenceNo: text(),
});

export const saleVoids = pgTable('sale_voids', {
  id: uuid().primaryKey(),
  docNo: text().notNull().unique(),
  saleId: uuid()
    .notNull()
    .unique()
    .references(() => sales.id),
  shiftId: uuid()
    .notNull()
    .references(() => shifts.id),
  reason: text().notNull(),
  pinApprovalId: uuid().references(() => pinApprovals.id),
  businessDate: date().notNull(),
  postedAt: timestamptz().notNull().defaultNow(),
  postedBy: uuid().references(() => users.id),
  journalId: uuid().references(() => journals.id),
});

export const salesReturns = pgTable('sales_returns', {
  id: uuid().primaryKey(),
  docNo: text().notNull().unique(),
  saleId: uuid()
    .notNull()
    .references(() => sales.id),
  shiftId: uuid()
    .notNull()
    .references(() => shifts.id),
  reason: text().notNull(),
  pinApprovalId: uuid().references(() => pinApprovals.id),
  refundAmount: money().notNull(),
  taxAmount: money().notNull(),
  roundingAmount: money().notNull(),
  businessDate: date().notNull(),
  postedAt: timestamptz().notNull().defaultNow(),
  postedBy: uuid().references(() => users.id),
  journalId: uuid().references(() => journals.id),
});

export const salesReturnLines = pgTable('sales_return_lines', {
  id: uuid().primaryKey().defaultRandom(),
  returnId: uuid()
    .notNull()
    .references(() => salesReturns.id),
  saleLineId: uuid()
    .notNull()
    .references(() => saleLines.id),
  baseQty: qty().notNull(),
  condition: returnCondition().notNull(),
  toLocationId: uuid()
    .notNull()
    .references(() => locations.id),
  refundAmount: money().notNull(),
  taxAmount: money().notNull(),
  costAmount: money().notNull(),
});

export const salesReturnRefunds = pgTable('sales_return_refunds', {
  id: uuid().primaryKey().defaultRandom(),
  returnId: uuid()
    .notNull()
    .references(() => salesReturns.id),
  paymentMethodId: uuid()
    .notNull()
    .references(() => paymentMethods.id),
  amount: money().notNull(),
  referenceNo: text(),
});

/** Transaksi ditahan: no stock or journal effect; removed when the shift closes. */
export const heldSales = pgTable('held_sales', {
  id: uuid().primaryKey(),
  shiftId: uuid()
    .notNull()
    .references(() => shifts.id),
  label: text(),
  memberId: uuid().references(() => members.id),
  cart: jsonb().notNull(),
  createdAt: timestamptz().notNull().defaultNow(),
  createdBy: uuid().references(() => users.id),
});
