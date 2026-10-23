/**
 * Financial years and TDS quarters, the way the server names them.
 *
 * An Indian society's year runs April to March, so "this year" in a report
 * means the year that began on the most recent 1 April — in India's date, not
 * the browser's, which is why callers pass `isoDateInIndia()` as today.
 */

/** The calendar year the financial year containing `iso` began in. */
export function fyStartOf(iso: string): number {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return month >= 4 ? year : year - 1;
}

export function fyLabel(start: number): string {
  return `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The year's first and last day, the last capped at today for the current year. */
export function fyBounds(start: number, today: string): { from: string; to: string } {
  const end = `${start + 1}-03-31`;
  return { from: `${start}-04-01`, to: end < today ? end : today };
}

/** The current year and the five before it. */
export function fyOptions(today: string, count = 6): number[] {
  const current = fyStartOf(today);
  return Array.from({ length: count }, (_, i) => current - i);
}

/** Quarter 1 is April to June, as the TDS returns count them. */
export function quarterOf(iso: string): 1 | 2 | 3 | 4 {
  const month = Number(iso.slice(5, 7));
  return month >= 4 && month <= 6 ? 1 : month >= 7 && month <= 9 ? 2 : month >= 10 ? 3 : 4;
}

/** The code the TDS register files a quarter under: Q2-FY26-27. */
export function quarterCode(quarter: number, fyStart: number): string {
  const a = String(fyStart % 100).padStart(2, '0');
  const b = String((fyStart + 1) % 100).padStart(2, '0');
  return `Q${quarter}-FY${a}-${b}`;
}

export const QUARTER_MONTHS: Record<number, string> = {
  1: 'Apr–Jun', 2: 'Jul–Sep', 3: 'Oct–Dec', 4: 'Jan–Mar',
};

export const isIsoDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);
