import { normalizeQuantity, positiveQuantitySchema } from '../common/quantity.js';
import { type PriceRow, resolveUnitPrice } from './pricing.js';

const prices: PriceRow[] = [
  { level: 'RETAIL', minQty: '1.000', price: 3500 },
  { level: 'MEMBER', minQty: '1.000', price: 3400 },
  { level: 'WHOLESALE', minQty: '12.000', price: 3300 },
  { level: 'WHOLESALE', minQty: '40.000', price: 3100 },
];

describe('resolveUnitPrice', () => {
  it('uses retail for a normal customer buying a few', () => {
    expect(resolveUnitPrice(prices, { qty: '3', isMember: false })).toMatchObject({
      level: 'RETAIL',
      price: 3500,
    });
  });

  it('uses the member price when a member is selected', () => {
    expect(resolveUnitPrice(prices, { qty: '3', isMember: true })?.price).toBe(3400);
  });

  it('applies the highest wholesale tier reached', () => {
    expect(resolveUnitPrice(prices, { qty: '12', isMember: false })?.price).toBe(3300);
    expect(resolveUnitPrice(prices, { qty: '39.999', isMember: true })?.price).toBe(3300);
    expect(resolveUnitPrice(prices, { qty: '40', isMember: false })).toMatchObject({
      level: 'WHOLESALE',
      minQty: '40.000',
      price: 3100,
    });
  });

  it('never picks a level that is more expensive than retail', () => {
    const odd: PriceRow[] = [
      { level: 'RETAIL', minQty: '1.000', price: 3000 },
      { level: 'MEMBER', minQty: '1.000', price: 3200 },
    ];
    expect(resolveUnitPrice(odd, { qty: 1, isMember: true })?.level).toBe('RETAIL');
  });

  it('returns null when the unit has no retail price', () => {
    expect(resolveUnitPrice([prices[1]], { qty: 1, isMember: true })).toBeNull();
  });
});

describe('quantities', () => {
  it('normalizes to the 3-decimal text Postgres returns', () => {
    expect(normalizeQuantity('40')).toBe('40.000');
    expect(normalizeQuantity('0.25')).toBe('0.250');
    expect(normalizeQuantity('007.1')).toBe('7.100');
  });

  it('accepts grams but rejects finer fractions, zero and negatives', () => {
    expect(positiveQuantitySchema.safeParse(1.255).success).toBe(true);
    expect(positiveQuantitySchema.safeParse('1.2555').success).toBe(false);
    expect(positiveQuantitySchema.safeParse(0).success).toBe(false);
    expect(positiveQuantitySchema.safeParse(-1).success).toBe(false);
  });
});
