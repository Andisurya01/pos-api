/** WIB (UTC+7, no DST): business dates, periods and document months follow it. */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** "YYYY-MM-DD" of the instant in WIB. */
export function businessDate(at: Date = new Date()): string {
  return new Date(at.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM" period id for a business date. */
export const periodOf = (date: string) => date.slice(0, 7);

/** First and last day of the period containing the date. */
export function periodRange(date: string) {
  const [y, m] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { id: `${y}-${mm}`, startsOn: `${y}-${mm}-01`, endsOn: `${y}-${mm}-${last}` };
}

/** "YYMM" used in document numbers, e.g. PJ/2610/00123. */
export const docMonth = (date: string) => `${date.slice(2, 4)}${date.slice(5, 7)}`;

export const isIsoDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
