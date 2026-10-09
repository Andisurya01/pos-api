export type PriceLevel = 'RETAIL' | 'WHOLESALE' | 'MEMBER';

export interface PriceRow {
  level: PriceLevel;
  minQty: string;
  price: number;
}

export interface ResolvedPrice {
  level: PriceLevel;
  minQty: string;
  price: number;
}

/**
 * Harga tingkat (docs/alur/03): the lowest price among the levels that apply —
 * retail always, member when a member is selected, wholesale tiers once the
 * line quantity (in that unit) reaches the tier minimum. Ties prefer retail,
 * then member, then wholesale, so receipts show the plainest level.
 */
export function resolveUnitPrice(
  prices: readonly PriceRow[],
  context: { qty: string | number; isMember: boolean },
): ResolvedPrice | null {
  const qty = Number(context.qty);
  const order: Record<PriceLevel, number> = { RETAIL: 0, MEMBER: 1, WHOLESALE: 2 };
  const applicable = prices.filter((p) => {
    if (p.level === 'RETAIL') return true;
    if (p.level === 'MEMBER') return context.isMember;
    return qty >= Number(p.minQty);
  });
  if (!applicable.some((p) => p.level === 'RETAIL')) return null;
  const best = [...applicable].sort(
    (a, b) => a.price - b.price || order[a.level] - order[b.level],
  )[0];
  return { level: best.level, minQty: best.minQty, price: best.price };
}
