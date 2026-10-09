// Cart arithmetic for the cashier (docs/alur/03 "Urutan hitung", docs/alur/04 §2–3).
// Pure functions: the server recomputes every sale with these at posting time, the screen
// only previews. All money is integer rupiah; allocations hand the rounding remainder to
// the last line so totals always match exactly.
import { type PriceRow, resolveUnitPrice } from '../catalog/pricing.js';
import { amountOf } from '../purchasing/purchase-orders.service.js';
import { roundDiv } from '../stock/valuation.js';

export interface CartLine {
  lineId: string;
  skuId: string;
  categoryId: string;
  brandId: string | null;
  qty: string; // in the line's unit
  isTaxable: boolean;
  prices: PriceRow[]; // prices of the line's unit, in effect now
  /** Price changed at the register ([PIN]); replaces the tier price. */
  overrideUnitPrice?: number | null;
}

export interface Promo {
  id: string;
  name: string;
  type: 'ITEM_DISCOUNT' | 'TOTAL_DISCOUNT';
  discountKind: 'PERCENT' | 'AMOUNT';
  discountValue: string; // numeric(18,4)
  maxDiscount: number | null;
  minPurchase: number | null;
  memberOnly: boolean;
  startsAt: Date;
  endsAt: Date;
  daysOfWeek: number[] | null; // 1 = Monday … 7 = Sunday (WIB)
  timeStart: string | null; // "HH:mm[:ss]" WIB
  timeEnd: string | null;
  isActive: boolean;
  targets: { targetType: 'SKU' | 'CATEGORY' | 'BRAND'; targetId: string }[];
}

export interface CartInput {
  lines: CartLine[];
  promos: Promo[];
  isMember: boolean;
  at: Date;
  manualDiscount: number; // rupiah on the whole sale, [PIN]
  tax: { enabled: boolean; rate: string }; // e.g. "11" or "11.0000"
}

export interface CalculatedLine {
  lineId: string;
  unitPrice: number;
  priceLevel: PriceRow['level'];
  gross: number;
  itemPromoId: string | null;
  promoDiscount: number;
  manualDiscount: number;
  net: number; // incl. tax
  tax: number;
  /** Net without tax (DPP); revenue in the journal. */
  netBase: number;
  /** Discount without tax; Potongan penjualan in the journal. */
  discountBase: number;
  /** netBase + discountBase; Penjualan bruto in the journal. */
  grossBase: number;
}

export interface CalculatedCart {
  lines: CalculatedLine[];
  discountMode: 'NONE' | 'ITEM' | 'TOTAL';
  totalPromoId: string | null;
  gross: number;
  promoDiscount: number;
  manualDiscount: number;
  net: number;
  taxBase: number;
  tax: number;
  /** For the journal: Penjualan (bruto DPP) − Potongan penjualan (DPP) + PPN = net. */
  salesGrossBase: number;
  salesDiscountBase: number;
}

export class CartError extends Error {}

const WIB_MS = 7 * 3_600_000;

/** Whether the promo is valid at that moment (period, weekday and hours in WIB, member). */
export function promoApplies(promo: Promo, at: Date, isMember: boolean) {
  if (!promo.isActive || at < promo.startsAt || at >= promo.endsAt) return false;
  if (promo.memberOnly && !isMember) return false;
  const wib = new Date(at.getTime() + WIB_MS);
  const weekday = wib.getUTCDay() === 0 ? 7 : wib.getUTCDay();
  if (promo.daysOfWeek?.length && !promo.daysOfWeek.includes(weekday)) return false;
  if (promo.timeStart && promo.timeEnd) {
    const hhmm = wib.toISOString().slice(11, 16);
    if (hhmm < promo.timeStart.slice(0, 5) || hhmm >= promo.timeEnd.slice(0, 5)) return false;
  }
  return true;
}

/** Percent as basis points (11.5 % → 1150) so no float touches money. */
function basisPoints(value: string) {
  const [int, frac = ''] = value.split('.');
  return BigInt(int) * 100n + BigInt((frac + '00').slice(0, 2));
}

function percentOf(amount: number, value: string) {
  return Number(roundDiv(BigInt(amount) * basisPoints(value), 10_000n));
}

/** Splits `total` over `weights` proportionally; the last non-zero weight takes the remainder. */
export function allocate(total: number, weights: number[]) {
  const sum = weights.reduce((s, w) => s + w, 0);
  const shares = weights.map(() => 0);
  if (total === 0 || sum === 0) return shares;
  const last = weights.map((w) => w > 0).lastIndexOf(true);
  let left = total;
  weights.forEach((w, i) => {
    if (i === last) return;
    shares[i] = Number(roundDiv(BigInt(total) * BigInt(w), BigInt(sum)));
    left -= shares[i];
  });
  shares[last] = left;
  return shares;
}

function itemDiscount(promo: Promo, line: CartLine, gross: number) {
  const raw = promo.discountKind === 'PERCENT' ? percentOf(gross, promo.discountValue) : amountOf(line.qty, Number(promo.discountValue));
  const capped = promo.maxDiscount != null ? Math.min(raw, promo.maxDiscount) : raw;
  return Math.min(capped, gross);
}

function targets(promo: Promo, line: CartLine) {
  return promo.targets.some(
    (t) =>
      (t.targetType === 'SKU' && t.targetId === line.skuId) ||
      (t.targetType === 'CATEGORY' && t.targetId === line.categoryId) ||
      (t.targetType === 'BRAND' && t.targetId === line.brandId),
  );
}

export function calculateCart(input: CartInput): CalculatedCart {
  if (input.lines.length === 0) throw new CartError('Keranjang kosong');

  // 1. Harga tingkat (or the PIN-approved override).
  const priced = input.lines.map((line) => {
    if (line.overrideUnitPrice != null) {
      return { line, unitPrice: line.overrideUnitPrice, level: 'RETAIL' as const };
    }
    const resolved = resolveUnitPrice(line.prices, { qty: line.qty, isMember: input.isMember });
    if (!resolved) throw new CartError(`Barang ${line.skuId} belum punya harga eceran`);
    return { line, unitPrice: resolved.price, level: resolved.level };
  });
  const grosses = priced.map((p) => amountOf(p.line.qty, p.unitPrice));
  const gross = grosses.reduce((s, g) => s + g, 0);

  // 2. Item promos (best per line) versus the best total promo — never both (owner decision).
  const active = input.promos.filter((p) => promoApplies(p, input.at, input.isMember));
  const itemBest = priced.map((p, i) => {
    let best = { id: null as string | null, amount: 0 };
    for (const promo of active.filter((x) => x.type === 'ITEM_DISCOUNT' && targets(x, p.line))) {
      const amount = itemDiscount(promo, p.line, grosses[i]);
      if (amount > best.amount) best = { id: promo.id, amount };
    }
    return best;
  });
  const itemTotal = itemBest.reduce((s, b) => s + b.amount, 0);
  let totalBest = { id: null as string | null, amount: 0 };
  for (const promo of active.filter((x) => x.type === 'TOTAL_DISCOUNT')) {
    if (promo.minPurchase != null && gross < promo.minPurchase) continue;
    const raw = promo.discountKind === 'PERCENT' ? percentOf(gross, promo.discountValue) : Number(promo.discountValue);
    const amount = Math.min(promo.maxDiscount != null ? Math.min(raw, promo.maxDiscount) : raw, gross);
    if (amount > totalBest.amount) totalBest = { id: promo.id, amount };
  }
  const discountMode = itemTotal === 0 && totalBest.amount === 0 ? 'NONE' : itemTotal >= totalBest.amount ? 'ITEM' : 'TOTAL';
  const promoShares =
    discountMode === 'ITEM' ? itemBest.map((b) => b.amount) : discountMode === 'TOTAL' ? allocate(totalBest.amount, grosses) : grosses.map(() => 0);

  // 3. Manual discount (supervisor) on what is left.
  const afterPromo = grosses.map((g, i) => g - promoShares[i]);
  const subtotal = afterPromo.reduce((s, a) => s + a, 0);
  if (input.manualDiscount < 0 || input.manualDiscount > subtotal) throw new CartError('Diskon manual melebihi total belanja');
  const manualShares = allocate(input.manualDiscount, afterPromo);
  const nets = afterPromo.map((a, i) => a - manualShares[i]);

  // 4. PPN per transaction from the taxable lines (prices include tax).
  const rateBp = input.tax.enabled ? basisPoints(input.tax.rate) : 0n;
  const baseOf = (amount: number) => (rateBp === 0n ? amount : Number(roundDiv(BigInt(amount) * 10_000n, 10_000n + rateBp)));
  const taxableNet = nets.reduce((s, n, i) => s + (priced[i].line.isTaxable ? n : 0), 0);
  const tax = taxableNet - baseOf(taxableNet);
  const taxShares = allocate(tax, nets.map((n, i) => (priced[i].line.isTaxable ? n : 0)));

  const lines = priced.map((p, i) => {
    const netBase = nets[i] - taxShares[i];
    const discount = promoShares[i] + manualShares[i];
    const discountBase = p.line.isTaxable ? baseOf(discount) : discount;
    return {
      lineId: p.line.lineId,
      unitPrice: p.unitPrice,
      priceLevel: p.level,
      gross: grosses[i],
      itemPromoId: discountMode === 'ITEM' ? itemBest[i].id : null,
      promoDiscount: promoShares[i],
      manualDiscount: manualShares[i],
      net: nets[i],
      tax: taxShares[i],
      netBase,
      discountBase,
      grossBase: netBase + discountBase,
    };
  });
  // Penjualan (bruto DPP) − Potongan (DPP) + PPN = net, exactly; no discount → Potongan 0.
  const salesDiscountBase = lines.reduce((s, l) => s + l.discountBase, 0);
  const salesGrossBase = lines.reduce((s, l) => s + l.grossBase, 0);
  const net = nets.reduce((s, n) => s + n, 0);
  return {
    lines,
    discountMode,
    totalPromoId: discountMode === 'TOTAL' ? totalBest.id : null,
    gross,
    promoDiscount: promoShares.reduce((s, x) => s + x, 0),
    manualDiscount: input.manualDiscount,
    net,
    taxBase: net - tax,
    tax,
    salesGrossBase,
    salesDiscountBase,
  };
}

export interface PaymentInput {
  methodId: string;
  kind: 'CASH' | 'QRIS' | 'CARD' | 'TRANSFER';
  amount: number; // non-cash: amount charged; cash: amount tendered
}

export interface Settlement {
  payments: { methodId: string; kind: PaymentInput['kind']; amount: number; tendered: number | null; change: number | null }[];
  rounding: number;
  amountDue: number;
  change: number;
}

/** Nearest Rp100, half up (docs/alur/04 §3): 47.350 → 47.400, 47.349 → 47.300. */
export const roundCash = (amount: number) => Math.floor((amount + 50) / 100) * 100;

/**
 * Non-cash pays exactly and may not exceed what is left; the cash part is rounded to
 * Rp100 and the rounding is journaled. Only cash gives change.
 */
export function settle(net: number, payments: PaymentInput[]): Settlement {
  const nonCash = payments.filter((p) => p.kind !== 'CASH');
  const cash = payments.filter((p) => p.kind === 'CASH');
  if (cash.length > 1) throw new CartError('Pembayaran tunai cukup satu baris');
  const nonCashTotal = nonCash.reduce((s, p) => s + p.amount, 0);
  if (nonCash.some((p) => p.amount <= 0)) throw new CartError('Jumlah pembayaran harus lebih dari 0');
  if (nonCashTotal > net) throw new CartError('Pembayaran non-tunai melebihi total belanja');
  const cashPart = net - nonCashTotal;
  const cashDue = roundCash(cashPart);
  const rounding = cashPart === 0 ? 0 : cashDue - cashPart;
  const tendered = cash[0]?.amount ?? 0;
  if (cashPart > 0 && tendered < cashDue) throw new CartError('Uang tunai kurang');
  if (cashPart === 0 && tendered > 0) throw new CartError('Total sudah lunas tanpa tunai');
  const change = cashPart > 0 ? tendered - cashDue : 0;
  return {
    payments: [
      ...nonCash.map((p) => ({ methodId: p.methodId, kind: p.kind, amount: p.amount, tendered: null, change: null })),
      ...(cashPart > 0 ? [{ methodId: cash[0].methodId, kind: 'CASH' as const, amount: cashDue, tendered, change }] : []),
    ],
    rounding,
    amountDue: net + rounding,
    change,
  };
}
