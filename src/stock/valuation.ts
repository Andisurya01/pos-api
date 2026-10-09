// Moving-average valuation (docs/alur/06-gudang.md, "HPP rata-rata bergerak").
// Quantities are handled as integer milli-units (bigint) and money as integer rupiah,
// so no float ever touches a stock value.

const MILLI = 1000n;
const AVG_SCALE = 10_000n; // last_avg_cost has 4 decimals

/** "1.500" -> 1500n, "-2" -> -2000n. */
export function toMilli(quantity: string): bigint {
  const negative = quantity.startsWith('-');
  const [int, frac = ''] = quantity.replace('-', '').split('.');
  const milli = BigInt(int || '0') * MILLI + BigInt((frac + '000').slice(0, 3));
  return negative ? -milli : milli;
}

/** 1500n -> "1.500" (the text Postgres numeric(18,3) returns). */
export function fromMilli(milli: bigint): string {
  const negative = milli < 0n;
  const abs = negative ? -milli : milli;
  const text = `${abs / MILLI}.${(abs % MILLI).toString().padStart(3, '0')}`;
  return negative ? `-${text}` : text;
}

/** Integer division rounded half away from zero. */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (2n * d);
  return negative ? -q : q;
}

/** "1234.5678" -> 12345678n (4-decimal fixed point). */
function toAvg(avg: string): bigint {
  const [int, frac = ''] = avg.split('.');
  return BigInt(int) * AVG_SCALE + BigInt((frac + '0000').slice(0, 4));
}

function fromAvg(scaled: bigint): string {
  return `${scaled / AVG_SCALE}.${(scaled % AVG_SCALE).toString().padStart(4, '0')}`;
}

export interface ValuationState {
  qty: bigint; // milli-units, may be negative after a PIN-approved sale
  value: number; // rupiah
  lastAvgCost: string | null; // per base unit, 4 decimals
}

/** value/qty with 4 decimals, or the previous average when there is no positive stock. */
export function averageOf(qty: bigint, value: number, previous: string | null) {
  if (qty <= 0n) return previous;
  return fromAvg(roundDiv(BigInt(value) * MILLI * AVG_SCALE, qty));
}

/** Cost of `out` units at the last known average (used beyond the stock on hand). */
function costAtLastAverage(out: bigint, lastAvgCost: string | null): bigint {
  if (!lastAvgCost) return 0n;
  return roundDiv(toAvg(lastAvgCost) * out, MILLI * AVG_SCALE);
}

/**
 * Goods out. Cost is taken from the remaining *value*, not from a rounded average,
 * so the last unit out takes exactly what is left and the ledger value never drifts
 * from the Persediaan account.
 */
export function issue(state: ValuationState, out: bigint) {
  if (out <= 0n) throw new Error('issue quantity must be positive');
  let cost: bigint;
  if (state.qty > 0n && out <= state.qty) {
    cost = out === state.qty ? BigInt(state.value) : roundDiv(BigInt(state.value) * out, state.qty);
  } else if (state.qty > 0n) {
    // Takes all remaining value, the excess goes negative at the last average.
    cost = BigInt(state.value) + costAtLastAverage(out - state.qty, state.lastAvgCost);
  } else {
    cost = costAtLastAverage(out, state.lastAvgCost);
  }
  const qty = state.qty - out;
  const value = state.value - Number(cost);
  return {
    cost: Number(cost),
    next: { qty, value, lastAvgCost: averageOf(qty, value, state.lastAvgCost) },
  };
}

/**
 * Goods in. When stock was negative, the units that close the gap are re-valued at the
 * incoming cost; `correction` (> 0: cost of goods sold was too low) must be journaled
 * Dr HPP / Cr Persediaan by the caller.
 */
export function receive(state: ValuationState, inQty: bigint, inValue: number) {
  if (inQty <= 0n) throw new Error('receive quantity must be positive');
  if (inValue < 0) throw new Error('receive value cannot be negative');
  let correction = 0n;
  if (state.qty < 0n) {
    const covered = inQty < -state.qty ? inQty : -state.qty;
    const atIncomingCost = roundDiv(BigInt(inValue) * covered, inQty);
    const charged = roundDiv(-BigInt(state.value) * covered, -state.qty);
    correction = atIncomingCost - charged;
  }
  const qty = state.qty + inQty;
  const value = state.value + inValue - Number(correction);
  return {
    correction: Number(correction),
    next: { qty, value, lastAvgCost: averageOf(qty, value, state.lastAvgCost) },
  };
}

/** Value of `qty` units at a 4-decimal unit cost (opening stock, stock found). */
export function valueAt(qty: bigint, unitCost: string) {
  return Number(roundDiv(toAvg(unitCost) * qty, MILLI * AVG_SCALE));
}
