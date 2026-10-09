import {
  allocate,
  type CartInput,
  type CartLine,
  calculateCart,
  type Promo,
  promoApplies,
  roundCash,
  settle,
} from './cart-calculator.js';

const retail = (price: number) => [{ level: 'RETAIL' as const, minQty: '1.000', price }];

const indomie: CartLine = {
  lineId: 'l1', skuId: 'mie', categoryId: 'cat-mi', brandId: 'indofood', qty: '10', isTaxable: true,
  prices: [...retail(3500), { level: 'MEMBER', minQty: '1.000', price: 3400 }],
};
const gula: CartLine = { lineId: 'l2', skuId: 'gula', categoryId: 'cat-sembako', brandId: null, qty: '1', isTaxable: false, prices: retail(12350) };

const base = (patch: Partial<CartInput> = {}): CartInput => ({
  lines: [indomie, gula],
  promos: [],
  isMember: false,
  at: new Date('2026-10-09T05:00:00Z'), // Friday 12:00 WIB
  manualDiscount: 0,
  tax: { enabled: true, rate: '11' },
  ...patch,
});

const promo = (patch: Partial<Promo>): Promo => ({
  id: 'p', name: 'Promo', type: 'ITEM_DISCOUNT', discountKind: 'PERCENT', discountValue: '10', maxDiscount: null,
  minPurchase: null, memberOnly: false, startsAt: new Date('2026-10-01T00:00:00Z'), endsAt: new Date('2026-11-01T00:00:00Z'),
  daysOfWeek: null, timeStart: null, timeEnd: null, isActive: true, targets: [], ...patch,
});

describe('calculateCart', () => {
  it('reproduces the docs example: PPN only on taxable lines, per transaction', () => {
    const cart = calculateCart(base());
    expect(cart).toMatchObject({ gross: 47350, net: 47350, tax: 3468, taxBase: 43882, discountMode: 'NONE', salesDiscountBase: 0 });
    expect(cart.lines.map((l) => [l.net, l.tax, l.netBase])).toEqual([
      [35000, 3468, 31532],
      [12350, 0, 12350],
    ]);
    // Journal identity: Penjualan − Potongan + PPN = what the customer pays.
    expect(cart.salesGrossBase - cart.salesDiscountBase + cart.tax).toBe(cart.net);
  });

  it('uses the member price when a member is selected', () => {
    expect(calculateCart(base({ isMember: true })).lines[0]).toMatchObject({ unitPrice: 3400, priceLevel: 'MEMBER', gross: 34000 });
  });

  it('applies the best item discount per line', () => {
    const cart = calculateCart(base({
      promos: [
        promo({ id: 'cat10', targets: [{ targetType: 'CATEGORY', targetId: 'cat-mi' }] }),
        promo({ id: 'sku500', discountKind: 'AMOUNT', discountValue: '500', targets: [{ targetType: 'SKU', targetId: 'mie' }] }),
      ],
    }));
    expect(cart.discountMode).toBe('ITEM');
    expect(cart.lines[0]).toMatchObject({ itemPromoId: 'sku500', promoDiscount: 5000, net: 30000 });
    expect(cart.salesGrossBase - cart.salesDiscountBase + cart.tax).toBe(cart.net);
  });

  it('never stacks item and total discounts: the bigger one wins', () => {
    const item = promo({ id: 'item', targets: [{ targetType: 'BRAND', targetId: 'indofood' }] }); // 3.500
    const total = promo({ id: 'total', type: 'TOTAL_DISCOUNT', discountKind: 'AMOUNT', discountValue: '5000', minPurchase: 40000 });
    const cart = calculateCart(base({ promos: [item, total] }));
    expect(cart).toMatchObject({ discountMode: 'TOTAL', totalPromoId: 'total', promoDiscount: 5000, net: 42350 });
    // The total discount is spread over the lines (used by returns and reports).
    expect(cart.lines.map((l) => l.promoDiscount)).toEqual([3696, 1304]);
    expect(cart.lines.every((l) => l.itemPromoId === null)).toBe(true);

    const small = calculateCart(base({ promos: [item, { ...total, discountValue: '1000' }] }));
    expect(small).toMatchObject({ discountMode: 'ITEM', promoDiscount: 3500 });
  });

  it('respects minimum purchase, caps and percentages over 100 rupiah rounding', () => {
    const total = promo({ type: 'TOTAL_DISCOUNT', discountValue: '10', maxDiscount: 2000, minPurchase: 50000 });
    expect(calculateCart(base({ promos: [total] })).discountMode).toBe('NONE'); // 47.350 < 50.000
    expect(calculateCart(base({ promos: [{ ...total, minPurchase: 40000 }] })).promoDiscount).toBe(2000);
  });

  it('spreads a supervisor discount after promos and rejects one larger than the bill', () => {
    const cart = calculateCart(base({ manualDiscount: 1000 }));
    expect(cart.lines.map((l) => l.manualDiscount)).toEqual([739, 261]);
    expect(cart.net).toBe(46350);
    expect(() => calculateCart(base({ manualDiscount: 50000 }))).toThrow('melebihi');
  });

  it('honours a price override approved at the register', () => {
    const cart = calculateCart(base({ lines: [{ ...indomie, overrideUnitPrice: 3000 }] }));
    expect(cart.lines[0]).toMatchObject({ unitPrice: 3000, gross: 30000 });
  });

  it('handles weighed goods and PPN switched off', () => {
    const beras: CartLine = { lineId: 'b', skuId: 'beras', categoryId: 'c', brandId: null, qty: '1.255', isTaxable: true, prices: retail(14500) };
    const cart = calculateCart(base({ lines: [beras], tax: { enabled: false, rate: '11' } }));
    expect(cart).toMatchObject({ gross: 18198, tax: 0, net: 18198 });
  });
});

describe('promoApplies (WIB)', () => {
  const at = (iso: string) => new Date(iso);
  it('checks weekday and hours in WIB, member-only and period', () => {
    const happyHour = promo({ daysOfWeek: [5], timeStart: '10:00', timeEnd: '13:00' }); // Friday 10–13 WIB
    expect(promoApplies(happyHour, at('2026-10-09T05:00:00Z'), false)).toBe(true); // Fri 12:00 WIB
    expect(promoApplies(happyHour, at('2026-10-09T06:00:00Z'), false)).toBe(false); // Fri 13:00 WIB
    expect(promoApplies(happyHour, at('2026-10-08T05:00:00Z'), false)).toBe(false); // Thursday
    expect(promoApplies(promo({ memberOnly: true }), at('2026-10-09T05:00:00Z'), false)).toBe(false);
    expect(promoApplies(promo({}), at('2026-11-01T00:00:00Z'), false)).toBe(false);
  });
});

describe('payments', () => {
  it('rounds the cash part to the nearest Rp100', () => {
    expect([47350, 47349, 47301, 100].map(roundCash)).toEqual([47400, 47300, 47300, 100]);
  });

  it('settles the docs example in cash with rounding and change', () => {
    expect(settle(47350, [{ methodId: 'tunai', kind: 'CASH', amount: 50000 }])).toEqual({
      payments: [{ methodId: 'tunai', kind: 'CASH', amount: 47400, tendered: 50000, change: 2600 }],
      rounding: 50,
      amountDue: 47400,
      change: 2600,
    });
  });

  it('takes non-cash exactly and rounds only the cash remainder', () => {
    expect(settle(47320, [{ methodId: 'qris', kind: 'QRIS', amount: 40000 }, { methodId: 'tunai', kind: 'CASH', amount: 10000 }])).toMatchObject({ rounding: -20, amountDue: 47300 }); // 7.320 → 7.300
    const s = settle(47350, [
      { methodId: 'qris', kind: 'QRIS', amount: 40000 },
      { methodId: 'tunai', kind: 'CASH', amount: 10000 },
    ]);
    expect(s).toMatchObject({ rounding: 50, amountDue: 47400, change: 2600 }); // cash part 7.350 → 7.400
    expect(settle(47350, [{ methodId: 'qris', kind: 'QRIS', amount: 47350 }])).toMatchObject({ rounding: 0, change: 0 });
  });

  it('rejects overpaying with non-cash, too little cash, and cash on a settled bill', () => {
    expect(() => settle(1000, [{ methodId: 'q', kind: 'QRIS', amount: 2000 }])).toThrow('melebihi');
    expect(() => settle(47350, [{ methodId: 't', kind: 'CASH', amount: 47000 }])).toThrow('kurang');
    expect(() => settle(1000, [{ methodId: 'q', kind: 'QRIS', amount: 1000 }, { methodId: 't', kind: 'CASH', amount: 500 }])).toThrow('lunas');
  });
});

describe('allocate', () => {
  it('gives the remainder to the last weighted line and skips zero weights', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([33, 33, 34]);
    expect(allocate(100, [1, 0])).toEqual([100, 0]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
  });
});
