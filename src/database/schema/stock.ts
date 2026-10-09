// ERD 03 — Stok dan Gudang (docs/erd/03-stok-dan-gudang.md). Stock opname tables follow later.
import {
  type AnyPgColumn,
  bigint,
  boolean,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { money, qty, skus } from './catalog.js';
import { timestamptz } from './columns.js';
import { journals } from './finance.js';
import { auditColumns, users } from './system.js';

export const locationType = pgEnum('location_type', ['STORAGE', 'DISPLAY', 'DAMAGED', 'TRANSIT']);
export const stockMovement = pgEnum('stock_movement', [
  'OPENING',
  'RECEIPT',
  'SALE',
  'SALE_VOID',
  'SALE_RETURN',
  'PURCHASE_RETURN',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT',
  'VALUE_ADJUSTMENT',
  'NEGATIVE_COVER',
]);
export const stockDocStatus = pgEnum('stock_doc_status', [
  'DRAFT',
  'PENDING_APPROVAL',
  'POSTED',
  'CANCELLED',
]);
export const adjustmentReason = pgEnum('adjustment_reason', [
  'DAMAGED',
  'EXPIRED',
  'LOST',
  'SELF_USE',
  'SAMPLE',
  'FOUND',
  'OPNAME',
  'OPENING',
]);

/** Unit cost per base unit, for averages and reference prices only (never journaled directly). */
const unitCost = () => numeric({ precision: 18, scale: 4 });

export const locations = pgTable('locations', {
  id: uuid().primaryKey().defaultRandom(),
  parentId: uuid().references((): AnyPgColumn => locations.id),
  code: text().notNull().unique(),
  name: text().notNull(),
  type: locationType().notNull(),
  isActive: boolean().notNull().default(true),
  ...auditColumns(),
});

export const batches = pgTable(
  'batches',
  {
    id: uuid().primaryKey().defaultRandom(),
    skuId: uuid()
      .notNull()
      .references(() => skus.id),
    batchNo: text(),
    expiryDate: date(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    unique('batches_identity_uq').on(t.skuId, t.batchNo, t.expiryDate).nullsNotDistinct(),
    index('batches_expiry_idx').on(t.expiryDate),
  ],
);

/** Buku besar barang. Append-only (trigger). */
export const stockLedger = pgTable(
  'stock_ledger',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    skuId: uuid()
      .notNull()
      .references(() => skus.id),
    locationId: uuid().references(() => locations.id),
    batchId: uuid().references(() => batches.id),
    movement: stockMovement().notNull(),
    qty: qty().notNull(),
    value: money().notNull(),
    docType: text().notNull(),
    docId: uuid().notNull(),
    docLineId: uuid(),
    businessDate: date().notNull(),
    postedAt: timestamptz().notNull().defaultNow(),
    createdBy: uuid().references(() => users.id),
  },
  (t) => [
    index('stock_ledger_sku_time_idx').on(t.skuId, t.postedAt),
    index('stock_ledger_place_time_idx').on(t.skuId, t.locationId, t.batchId, t.postedAt),
    index('stock_ledger_doc_idx').on(t.docType, t.docId),
    index('stock_ledger_date_idx').on(t.businessDate),
  ],
);

export const stockBalances = pgTable(
  'stock_balances',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    skuId: uuid()
      .notNull()
      .references(() => skus.id),
    locationId: uuid()
      .notNull()
      .references(() => locations.id),
    batchId: uuid().references(() => batches.id),
    qty: qty().notNull().default('0'),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    unique('stock_balances_place_uq').on(t.skuId, t.locationId, t.batchId).nullsNotDistinct(),
    index('stock_balances_location_idx').on(t.locationId),
  ],
);

/** Moving-average valuation per SKU; locked FOR UPDATE while posting. */
export const skuValuations = pgTable('sku_valuations', {
  skuId: uuid()
    .primaryKey()
    .references(() => skus.id),
  qty: qty().notNull().default('0'),
  value: money().notNull().default(0),
  lastAvgCost: unitCost(),
  lastPurchaseCost: unitCost(),
  highestPurchaseCost: unitCost(),
  highestPurchaseAt: timestamptz(),
  updatedAt: timestamptz().notNull().defaultNow(),
});

const stockDocColumns = () => ({
  docNo: text().notNull().unique(),
  status: stockDocStatus().notNull().default('DRAFT'),
  businessDate: date().notNull(),
  postedAt: timestamptz(),
  postedBy: uuid().references(() => users.id),
  journalId: uuid().references(() => journals.id),
  ...auditColumns(),
});

export const stockTransfers = pgTable('stock_transfers', {
  id: uuid().primaryKey(),
  fromLocationId: uuid()
    .notNull()
    .references(() => locations.id),
  toLocationId: uuid()
    .notNull()
    .references(() => locations.id),
  note: text(),
  ...stockDocColumns(),
});

export const stockTransferLines = pgTable('stock_transfer_lines', {
  id: uuid().primaryKey().defaultRandom(),
  transferId: uuid()
    .notNull()
    .references(() => stockTransfers.id),
  skuId: uuid()
    .notNull()
    .references(() => skus.id),
  batchId: uuid().references(() => batches.id),
  qty: qty().notNull(),
});

export const stockAdjustments = pgTable('stock_adjustments', {
  id: uuid().primaryKey(),
  reason: adjustmentReason().notNull(),
  opnameId: uuid(),
  note: text(),
  submittedAt: timestamptz(),
  submittedBy: uuid().references(() => users.id),
  approvedAt: timestamptz(),
  approvedBy: uuid().references(() => users.id),
  rejectedReason: text(),
  ...stockDocColumns(),
});

export const stockAdjustmentLines = pgTable('stock_adjustment_lines', {
  id: uuid().primaryKey().defaultRandom(),
  adjustmentId: uuid()
    .notNull()
    .references(() => stockAdjustments.id, { onDelete: 'cascade' }),
  skuId: uuid()
    .notNull()
    .references(() => skus.id),
  locationId: uuid()
    .notNull()
    .references(() => locations.id),
  batchId: uuid().references(() => batches.id),
  batchNo: text(),
  expiryDate: date(),
  qty: qty().notNull(),
  unitCost: unitCost(),
  value: money(),
});


export const opnameStatus = pgEnum('opname_status', [
  'DRAFT',
  'COUNTING',
  'PENDING_APPROVAL',
  'POSTED',
  'CANCELLED',
]);
export const uncountedPolicy = pgEnum('uncounted_policy', ['IGNORE', 'ZERO']);

/** Stock opname (SO). Counting does not close the store: see docs/alur/06 §2. */
export const stockOpnames = pgTable('stock_opnames', {
  id: uuid().primaryKey(),
  docNo: text().notNull().unique(),
  status: opnameStatus().notNull().default('DRAFT'),
  scopeLocationIds: uuid().array().notNull().default([]),
  scopeCategoryIds: uuid().array().notNull().default([]),
  uncountedPolicy: uncountedPolicy(),
  note: text(),
  businessDate: date().notNull(),
  startedAt: timestamptz(),
  submittedAt: timestamptz(),
  submittedBy: uuid().references(() => users.id),
  approvedAt: timestamptz(),
  approvedBy: uuid().references(() => users.id),
  adjustmentId: uuid().references(() => stockAdjustments.id),
  ...auditColumns(),
});

export const stockOpnameLines = pgTable(
  'stock_opname_lines',
  {
    id: uuid().primaryKey().defaultRandom(),
    opnameId: uuid()
      .notNull()
      .references(() => stockOpnames.id),
    skuId: uuid()
      .notNull()
      .references(() => skus.id),
    locationId: uuid()
      .notNull()
      .references(() => locations.id),
    batchId: uuid().references(() => batches.id),
    countedQty: qty().notNull(),
    countedAt: timestamptz().notNull(),
    countedBy: uuid()
      .notNull()
      .references(() => users.id),
    /** Ledger quantity at counted_at, filled when the count is submitted. */
    systemQty: qty(),
    diffQty: qty(),
  },
  (t) => [
    unique('stock_opname_lines_place_uq')
      .on(t.opnameId, t.skuId, t.locationId, t.batchId)
      .nullsNotDistinct(),
  ],
);
