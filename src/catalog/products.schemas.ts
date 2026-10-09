import { z } from 'zod';
import {
  moneySchema,
  positiveQuantitySchema,
  quantitySchema,
} from '../common/quantity.js';

const barcodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z-]{3,64}$/, 'Barcode hanya huruf, angka, atau tanda hubung');

export const priceInputSchema = z.object({
  level: z.enum(['RETAIL', 'WHOLESALE', 'MEMBER']),
  minQty: positiveQuantitySchema.optional(),
  price: moneySchema,
});

export const unitInputSchema = z.object({
  unitId: z.uuid(),
  factor: positiveQuantitySchema,
  isBase: z.boolean().default(false),
  isDefaultSale: z.boolean().default(false),
  isDefaultPurchase: z.boolean().default(false),
  barcodes: z.array(barcodeSchema).default([]),
  prices: z.array(priceInputSchema).default([]),
});

export const componentInputSchema = z.object({
  componentSkuId: z.uuid(),
  qty: positiveQuantitySchema,
});

const skuFlags = {
  variantName: z.string().trim().max(100).nullish(),
  variantAttrs: z.record(z.string(), z.string()).nullish(),
  isTaxable: z.boolean().default(true),
  trackBatch: z.boolean().default(false),
  isSellable: z.boolean().default(true),
  isPurchasable: z.boolean().default(true),
  minStock: quantitySchema.default('0'),
  reorderPoint: quantitySchema.default('0'),
  primarySupplierId: z.uuid().nullish(),
  availableFrom: z.iso.date().nullish(),
  availableUntil: z.iso.date().nullish(),
};

export const skuInputSchema = z.object({
  skuCode: z.string().trim().min(1, 'Kode SKU wajib diisi').max(50),
  kind: z.enum(['STANDARD', 'BUNDLE']).default('STANDARD'),
  isWeighed: z.boolean().default(false),
  ...skuFlags,
  units: z.array(unitInputSchema).min(1, 'Minimal satu satuan'),
  components: z.array(componentInputSchema).default([]),
});

export const productInputSchema = z.object({
  name: z.string().trim().min(1, 'Nama produk wajib diisi').max(150),
  categoryId: z.uuid(),
  brandId: z.uuid().nullish(),
  description: z.string().trim().max(1000).nullish(),
});

export const createProductSchema = productInputSchema.extend({
  skus: z.array(skuInputSchema).min(1, 'Minimal satu SKU'),
});

export const updateProductSchema = productInputSchema.extend({
  isActive: z.boolean().default(true),
});

export const updateSkuSchema = z.object({ ...skuFlags, isActive: z.boolean().default(true) });

export const barcodesSchema = z.object({ barcodes: z.array(barcodeSchema) });

export const setPriceSchema = priceInputSchema.extend({
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
});

export const removeTierSchema = z.object({
  level: z.enum(['WHOLESALE', 'MEMBER']),
  minQty: positiveQuantitySchema.optional(),
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
});

export const componentsSchema = z.object({
  components: z.array(componentInputSchema).min(1, 'Bundel minimal punya satu komponen'),
});

export const skuListQuerySchema = z.object({
  q: z.string().trim().optional(),
  categoryId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type SkuInput = z.infer<typeof skuInputSchema>;
export type UnitInput = z.infer<typeof unitInputSchema>;
export type PriceInput = z.infer<typeof priceInputSchema>;
export type ComponentInput = z.infer<typeof componentInputSchema>;
export type UpdateSkuInput = z.infer<typeof updateSkuSchema>;
export type SkuListQuery = z.infer<typeof skuListQuerySchema>;
