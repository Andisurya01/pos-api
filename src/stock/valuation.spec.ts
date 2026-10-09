import { fromMilli, issue, receive, roundDiv, toMilli, valueAt } from './valuation.js';

const state = (qty: string, value: number, lastAvgCost: string | null = null) => ({
  qty: toMilli(qty),
  value,
  lastAvgCost,
});

describe('milli quantities', () => {
  it('round-trips the numeric(18,3) text form', () => {
    for (const q of ['0.000', '1.500', '40.000', '0.250', '-2.000']) {
      expect(fromMilli(toMilli(q))).toBe(q);
    }
    expect(toMilli('3')).toBe(3000n);
  });

  it('rounds half away from zero', () => {
    expect(roundDiv(10000n, 3n)).toBe(3333n);
    expect(roundDiv(5n, 2n)).toBe(3n);
    expect(roundDiv(-5n, 2n)).toBe(-3n);
  });
});

describe('moving average', () => {
  it('follows the docs example: 3 pcs worth Rp10.000, sell 1 then 2', () => {
    const first = issue(state('3', 10000), toMilli('1'));
    expect(first.cost).toBe(3333);
    expect(first.next).toMatchObject({ qty: toMilli('2'), value: 6667 });
    const second = issue(first.next, toMilli('2'));
    expect(second.cost).toBe(6667); // the rest, no rounding residue
    expect(second.next).toMatchObject({ qty: 0n, value: 0 });
  });

  it('re-averages on every receipt (beli 10 @10.000 lalu 10 @12.000)', () => {
    const a = receive(state('0', 0), toMilli('10'), 100000);
    expect(a.next.lastAvgCost).toBe('10000.0000');
    const b = receive(a.next, toMilli('10'), 120000);
    expect(b.next).toMatchObject({ qty: toMilli('20'), value: 220000, lastAvgCost: '11000.0000' });
    expect(b.correction).toBe(0);
    // Selling everything empties the account exactly — the HPP-tertinggi problem cannot happen.
    expect(issue(b.next, toMilli('20')).cost).toBe(220000);
  });

  it('keeps the last average when stock reaches zero', () => {
    const empty = issue(state('2', 2400, '1200.0000'), toMilli('2')).next;
    expect(empty).toEqual({ qty: 0n, value: 0, lastAvgCost: '1200.0000' });
  });

  it('handles weighed goods in grams', () => {
    const beras = receive(state('0', 0), toMilli('25'), 362500); // 25 kg @ 14.500
    const sold = issue(beras.next, toMilli('1.255'));
    expect(sold.cost).toBe(18198); // 1.255 × 14.500 = 18.197,5 -> 18.198
  });

  describe('negative stock (PIN-approved sale)', () => {
    it('costs units beyond stock at the last average, then corrects on the next receipt', () => {
      // 1 pcs left worth 1.000, sell 3: 1.000 + 2 × 1.000.
      const sale = issue(state('1', 1000, '1000.0000'), toMilli('3'));
      expect(sale.cost).toBe(3000);
      expect(sale.next).toMatchObject({ qty: toMilli('-2'), value: -2000 });

      // Receive 10 @ 1.200: the 2 missing units should have cost 2.400, not 2.000.
      const receipt = receive(sale.next, toMilli('10'), 12000);
      expect(receipt.correction).toBe(400);
      expect(receipt.next).toMatchObject({ qty: toMilli('8'), value: 9600, lastAvgCost: '1200.0000' });
    });

    it('corrects only the covered part when a receipt does not fill the gap', () => {
      const negative = state('-5', -5000, '1000.0000');
      const receipt = receive(negative, toMilli('2'), 3000); // 2 @ 1.500
      expect(receipt.correction).toBe(1000); // 2 × (1.500 − 1.000)
      expect(receipt.next).toMatchObject({ qty: toMilli('-3'), value: -3000, lastAvgCost: '1000.0000' });
    });
  });

  it('values opening stock at the given unit cost', () => {
    expect(valueAt(toMilli('40'), '2900.0000')).toBe(116000);
    expect(valueAt(toMilli('0.333'), '1000.5000')).toBe(333);
  });
});
