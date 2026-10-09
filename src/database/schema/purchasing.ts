// ERD 05 — Pembelian (docs/erd/05-pembelian.md).
import {
  boolean,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { money, qty, skus, skuUnits, suppliers } from './catalog.js';
import { timestamptz } from './columns.js';
import { accounts, journals } from './finance.js';
import { batches, locations } from './stock.js';
import { auditColumns, users } from './system.js';

export const poStatus = pgEnum('po_status', [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
]);
export const billStatus = pgEnum('bill_status', ['POSTED', 'PARTIALLY_PAID', 'PAID']);
export const returnOffset = pgEnum('return_offset', ['GRNI', 'PAYABLE']);

const postedDoc = () => ({
  docNo: text().notNull().unique(),
  businessDate: date().notNull(),
  postedAt: timestamptz().notNull().defaultNow(),
  postedBy: uuid().references(() => users.id),
  journalId: uuid().references(() => journals.id),
  ...auditColumns(),
});

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid().primaryKey(),
    docNo: text().notNull().unique(),
    status: poStatus().notNull().default('DRAFT'),
    supplierId: uuid()
      .notNull()
      .references(() => suppliers.id),
    orderDate: date().notNull(),
    expectedDate: date(),
    note: text(),
    subtotal: money().notNull().default(0),
    submittedAt: timestamptz(),
    submittedBy: uuid().references(() => users.id),
    approvedAt: timestamptz(),
    approvedBy: uuid().references(() => users.id),
    rejectedReason: text(),
    closedReason: text(),
    ...auditColumns(),
  },
  (t) => [index('purchase_orders_supplier_idx').on(t.supplierId, t.status)],
);

export const purchaseOrderLines = pgTable('purchase_order_lines', {
  id: uuid().primaryKey().defaultRandom(),
  poId: uuid()
    .notNull()
    .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  skuId: uuid()
    .notNull()
    .references(() => skus.id),
  skuUnitId: uuid()
    .notNull()
    .references(() => skuUnits.id),
  qty: qty().notNull(),
  baseQty: qty().notNull(),
  unitPrice: money().notNull(),
  lineAmount: money().notNull(),
  receivedBaseQty: qty().notNull().default('0'),
});

export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: uuid().primaryKey(),
    supplierId: uuid()
      .notNull()
      .references(() => suppliers.id),
    poId: uuid().references(() => purchaseOrders.id),
    isDirect: boolean().notNull().default(false),
    supplierDeliveryNo: text(),
    totalValue: money().notNull(),
    ...postedDoc(),
  },
  (t) => [index('goods_receipts_supplier_idx').on(t.supplierId)],
);

export const goodsReceiptLines = pgTable('goods_receipt_lines', {
  id: uuid().primaryKey().defaultRandom(),
  receiptId: uuid()
    .notNull()
    .references(() => goodsReceipts.id),
  poLineId: uuid().references(() => purchaseOrderLines.id),
  skuId: uuid()
    .notNull()
    .references(() => skus.id),
  skuUnitId: uuid()
    .notNull()
    .references(() => skuUnits.id),
  qty: qty().notNull(),
  baseQty: qty().notNull(),
  unitPrice: money().notNull(),
  lineValue: money().notNull(),
  locationId: uuid()
    .notNull()
    .references(() => locations.id),
  batchId: uuid().references(() => batches.id),
  billedBaseQty: qty().notNull().default('0'),
  returnedBaseQty: qty().notNull().default('0'),
});

export const supplierBills = pgTable(
  'supplier_bills',
  {
    id: uuid().primaryKey(),
    supplierId: uuid()
      .notNull()
      .references(() => suppliers.id),
    isOpening: boolean().notNull().default(false),
    supplierInvoiceNo: text().notNull(),
    taxInvoiceNo: text(),
    billDate: date().notNull(),
    dueDate: date().notNull(),
    status: billStatus().notNull().default('POSTED'),
    subtotal: money().notNull(),
    shippingCost: money().notNull().default(0),
    taxAmount: money().notNull().default(0),
    total: money().notNull(),
    paidAmount: money().notNull().default(0),
    varianceApprovedBy: uuid().references(() => users.id),
    ...postedDoc(),
  },
  (t) => [index('supplier_bills_supplier_idx').on(t.supplierId, t.status)],
);

export const supplierBillLines = pgTable('supplier_bill_lines', {
  id: uuid().primaryKey().defaultRandom(),
  billId: uuid()
    .notNull()
    .references(() => supplierBills.id),
  receiptLineId: uuid()
    .notNull()
    .references(() => goodsReceiptLines.id),
  qty: qty().notNull(),
  baseQty: qty().notNull(),
  unitPrice: money().notNull(),
  lineAmount: money().notNull(),
  receiptValue: money().notNull(),
  priceVariance: money().notNull(),
  allocatedShipping: money().notNull().default(0),
});

export const purchaseReturns = pgTable('purchase_returns', {
  id: uuid().primaryKey(),
  supplierId: uuid()
    .notNull()
    .references(() => suppliers.id),
  fromLocationId: uuid()
    .notNull()
    .references(() => locations.id),
  reduces: returnOffset().notNull(),
  debitNoteAmount: money().notNull(),
  taxAmount: money().notNull().default(0),
  appliedAmount: money().notNull().default(0),
  note: text(),
  ...postedDoc(),
});

export const purchaseReturnLines = pgTable('purchase_return_lines', {
  id: uuid().primaryKey().defaultRandom(),
  returnId: uuid()
    .notNull()
    .references(() => purchaseReturns.id),
  receiptLineId: uuid().references(() => goodsReceiptLines.id),
  skuId: uuid()
    .notNull()
    .references(() => skus.id),
  batchId: uuid().references(() => batches.id),
  baseQty: qty().notNull(),
  lineAmount: money().notNull(),
  costAmount: money().notNull(),
  variance: money().notNull(),
});

export const supplierPayments = pgTable('supplier_payments', {
  id: uuid().primaryKey(),
  supplierId: uuid()
    .notNull()
    .references(() => suppliers.id),
  paymentDate: date().notNull(),
  sourceAccountId: uuid()
    .notNull()
    .references(() => accounts.id),
  amount: money().notNull(),
  bankFee: money().notNull().default(0),
  referenceNo: text(),
  ...postedDoc(),
});

export const supplierPaymentAllocations = pgTable('supplier_payment_allocations', {
  id: uuid().primaryKey().defaultRandom(),
  paymentId: uuid()
    .notNull()
    .references(() => supplierPayments.id),
  billId: uuid()
    .notNull()
    .references(() => supplierBills.id),
  amount: money().notNull(),
  /** Set when this allocation uses a debit note instead of money. */
  purchaseReturnId: uuid().references(() => purchaseReturns.id),
});
