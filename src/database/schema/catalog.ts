// ERD 02 — Produk, Harga, Promo, Member, Supplier (docs/erd/02-produk.md).
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './columns.js';
import { auditColumns, users } from './system.js';

/** Rupiah. Read as a JS number: exact up to Rp9 quadrillion, and JSON-serializable. */
export const money = () => bigint({ mode: 'number' });
/** Quantity in base units; 3 decimals for weighed goods. Read as a string (no float). */
export const qty = () => numeric({ precision: 18, scale: 3 });

export const skuKind = pgEnum('sku_kind', ['STANDARD', 'BUNDLE']);
export const priceLevel = pgEnum('price_level', ['RETAIL', 'WHOLESALE', 'MEMBER']);
export const promoType = pgEnum('promo_type', ['ITEM_DISCOUNT', 'TOTAL_DISCOUNT']);
export const discountKind = pgEnum('discount_kind', ['PERCENT', 'AMOUNT']);
export const promoTarget = pgEnum('promo_target', ['SKU', 'CATEGORY', 'BRAND']);

export const categories = pgTable(
  'categories',
  {
    id: uuid().primaryKey().defaultRandom(),
    parentId: uuid().references((): AnyPgColumn => categories.id),
    name: text().notNull(),
    isActive: boolean().notNull().default(true),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('categories_parent_name_uq')
      .on(sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(${t.name})`),
  ],
);

export const brands = pgTable(
  'brands',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('brands_name_uq').on(sql`lower(${t.name})`)],
);

export const units = pgTable(
  'units',
  {
    id: uuid().primaryKey().defaultRandom(),
    code: text().notNull(),
    name: text().notNull(),
    allowsDecimal: boolean().notNull().default(false),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('units_code_uq').on(sql`lower(${t.code})`)],
);

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid().primaryKey().defaultRandom(),
    code: text().notNull().unique(),
    name: text().notNull(),
    address: text(),
    phone: text(),
    contactName: text(),
    isPkp: boolean().notNull().default(false),
    npwp: text(),
    paymentTermDays: smallint().notNull().default(0),
    leadTimeDays: smallint().notNull().default(3),
    isActive: boolean().notNull().default(true),
    ...auditColumns(),
  },
  (t) => [
    check('suppliers_terms_check', sql`${t.paymentTermDays} >= 0 and ${t.leadTimeDays} >= 0`),
  ],
);

export const products = pgTable(
  'products',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    categoryId: uuid()
      .notNull()
      .references(() => categories.id),
    brandId: uuid().references(() => brands.id),
    description: text(),
    isActive: boolean().notNull().default(true),
    ...auditColumns(),
  },
  (t) => [
    index('products_category_idx').on(t.categoryId),
    index('products_name_idx').on(sql`lower(${t.name})`),
  ],
);

export const skus = pgTable(
  'skus',
  {
    id: uuid().primaryKey().defaultRandom(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    skuCode: text().notNull(),
    variantName: text(),
    variantAttrs: jsonb(),
    kind: skuKind().notNull().default('STANDARD'),
    baseUnitId: uuid()
      .notNull()
      .references(() => units.id),
    isWeighed: boolean().notNull().default(false),
    isTaxable: boolean().notNull().default(true),
    trackBatch: boolean().notNull().default(false),
    isSellable: boolean().notNull().default(true),
    isPurchasable: boolean().notNull().default(true),
    minStock: qty().notNull().default('0'),
    reorderPoint: qty().notNull().default('0'),
    primarySupplierId: uuid().references(() => suppliers.id),
    availableFrom: date(),
    availableUntil: date(),
    isActive: boolean().notNull().default(true),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('skus_code_uq').on(sql`lower(${t.skuCode})`),
    index('skus_product_idx').on(t.productId),
    check(
      'skus_bundle_check',
      sql`${t.kind} <> 'BUNDLE' or (not ${t.isPurchasable} and not ${t.trackBatch} and not ${t.isWeighed})`,
    ),
  ],
);

export const skuUnits = pgTable(
  'sku_units',
  {
    id: uuid().primaryKey().defaultRandom(),
    skuId: uuid()
      .notNull()
      .references(() => skus.id),
    unitId: uuid()
      .notNull()
      .references(() => units.id),
    factor: qty().notNull(),
    isBase: boolean().notNull().default(false),
    isDefaultSale: boolean().notNull().default(false),
    isDefaultPurchase: boolean().notNull().default(false),
  },
  (t) => [
    uniqueIndex('sku_units_sku_unit_uq').on(t.skuId, t.unitId),
    uniqueIndex('sku_units_one_base_uq').on(t.skuId).where(sql`${t.isBase}`),
    check('sku_units_factor_check', sql`${t.factor} > 0 and (not ${t.isBase} or ${t.factor} = 1)`),
  ],
);

export const barcodes = pgTable(
  'barcodes',
  {
    barcode: text().primaryKey(),
    skuUnitId: uuid()
      .notNull()
      .references(() => skuUnits.id),
  },
  (t) => [index('barcodes_sku_unit_idx').on(t.skuUnitId)],
);

/** Price history; the current price is the latest row per (unit, level, min_qty) already in effect. */
export const skuPrices = pgTable(
  'sku_prices',
  {
    id: uuid().primaryKey().defaultRandom(),
    skuUnitId: uuid()
      .notNull()
      .references(() => skuUnits.id),
    level: priceLevel().notNull(),
    minQty: qty().notNull().default('1'),
    price: money().notNull(),
    effectiveFrom: timestamptz().notNull().defaultNow(),
    isDeleted: boolean().notNull().default(false),
    createdAt: timestamptz().notNull().defaultNow(),
    createdBy: uuid().references(() => users.id),
  },
  (t) => [
    index('sku_prices_lookup_idx').on(t.skuUnitId, t.level, t.minQty, t.effectiveFrom.desc()),
    check('sku_prices_values_check', sql`${t.price} >= 0 and ${t.minQty} > 0`),
  ],
);

export const bundleComponents = pgTable(
  'bundle_components',
  {
    bundleSkuId: uuid()
      .notNull()
      .references(() => skus.id),
    componentSkuId: uuid()
      .notNull()
      .references(() => skus.id),
    qty: qty().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bundleSkuId, t.componentSkuId] }),
    check('bundle_components_check', sql`${t.qty} > 0 and ${t.bundleSkuId} <> ${t.componentSkuId}`),
  ],
);

export const promotions = pgTable(
  'promotions',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    type: promoType().notNull(),
    discountKind: discountKind().notNull(),
    discountValue: numeric({ precision: 18, scale: 4 }).notNull(),
    maxDiscount: money(),
    minPurchase: money(),
    memberOnly: boolean().notNull().default(false),
    startsAt: timestamptz().notNull(),
    endsAt: timestamptz().notNull(),
    daysOfWeek: smallint().array(),
    timeStart: time(),
    timeEnd: time(),
    isActive: boolean().notNull().default(true),
    ...auditColumns(),
  },
  (t) => [
    index('promotions_period_idx').on(t.startsAt, t.endsAt),
    check('promotions_period_check', sql`${t.endsAt} > ${t.startsAt}`),
    check(
      'promotions_value_check',
      sql`${t.discountValue} > 0 and (${t.discountKind} <> 'PERCENT' or ${t.discountValue} <= 100)`,
    ),
  ],
);

export const promotionTargets = pgTable(
  'promotion_targets',
  {
    promotionId: uuid()
      .notNull()
      .references(() => promotions.id, { onDelete: 'cascade' }),
    targetType: promoTarget().notNull(),
    targetId: uuid().notNull(),
  },
  (t) => [primaryKey({ columns: [t.promotionId, t.targetType, t.targetId] })],
);

export const members = pgTable('members', {
  id: uuid().primaryKey().defaultRandom(),
  phone: text().notNull().unique(),
  name: text().notNull(),
  cardNo: text().unique(),
  joinedAt: date().notNull().default(sql`current_date`),
  isActive: boolean().notNull().default(true),
  ...auditColumns(),
});

/** Last purchase price per supplier, to prefill POs. FK to goods_receipts arrives with ERD 05. */
export const skuSupplierPrices = pgTable(
  'sku_supplier_prices',
  {
    skuUnitId: uuid()
      .notNull()
      .references(() => skuUnits.id),
    supplierId: uuid()
      .notNull()
      .references(() => suppliers.id),
    lastPrice: money().notNull(),
    lastReceiptId: uuid(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.skuUnitId, t.supplierId] })],
);
