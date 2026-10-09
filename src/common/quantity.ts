import { z } from 'zod';

/**
 * Quantities travel as strings with up to 3 decimals (grams for weighed goods),
 * matching Postgres numeric(18,3). Numbers are accepted and converted.
 */
export const quantitySchema = z
  .union([z.number(), z.string().trim()])
  .transform((v) => (typeof v === 'number' ? String(v) : v))
  .refine((v) => /^\d{1,15}(\.\d{1,3})?$/.test(v), 'Jumlah maksimal 3 angka desimal')
  .transform((v) => normalizeQuantity(v));

export const positiveQuantitySchema = quantitySchema.refine(
  (v) => Number(v) > 0,
  'Jumlah harus lebih dari 0',
);

/** "40" -> "40.000", "1.5" -> "1.500" — the same text Postgres returns. */
export function normalizeQuantity(value: string) {
  const [int, frac = ''] = value.split('.');
  return `${BigInt(int).toString()}.${frac.padEnd(3, '0')}`;
}

export const isWholeQuantity = (value: string) => /\.0{3}$/.test(normalizeQuantity(value));

/** Rupiah amount: whole, non-negative, within JS safe integers. */
export const moneySchema = z
  .number()
  .int('Nilai rupiah harus bilangan bulat')
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
