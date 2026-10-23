/**
 * Dates, validated in one place.
 *
 * The demo wrote '20 Jun 2026' and '2026-06-20 07:48' as literals into every
 * posting and audit row, so every transaction claimed the same instant however
 * long the app had been open. Nothing here invents a date: a caller either
 * supplies one or asks the clock, and anything that is not a real calendar day
 * is rejected rather than coerced.
 */

export class DateError extends Error {}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when the string is YYYY-MM-DD and names a day that exists. */
export function isValidIsoDate(value: string): boolean {
  const m = ISO.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  // Round-tripping catches 31 February and the like, which Date silently rolls.
  const asDate = new Date(Date.UTC(year, month - 1, day));
  return asDate.getUTCFullYear() === year
    && asDate.getUTCMonth() === month - 1
    && asDate.getUTCDate() === day;
}

/** Returns the date, or throws naming the field. */
export function requireIsoDate(value: string, field = 'date'): string {
  if (!isValidIsoDate(value)) {
    throw new DateError(`${field} must be a real date as YYYY-MM-DD, got "${value}"`);
  }
  return value;
}

/**
 * A clock, so a caller never reaches for `new Date()` directly.
 *
 * Production passes `systemClock`. Tests pass `fixedClock` so a run is
 * reproducible — a suite that depends on the real date passes today and fails
 * next month.
 */
export interface Clock {
  readonly today: () => string;
  /** Human-readable instant for an audit row. */
  readonly now: () => string;
}

export const systemClock: Clock = {
  today: () => new Date().toISOString().slice(0, 10),
  now: () => new Date().toISOString(),
};

export function fixedClock(date: string, instant?: string): Clock {
  requireIsoDate(date, 'fixed clock date');
  return { today: () => date, now: () => instant ?? `${date}T00:00:00.000Z` };
}

export function addDays(iso: string, days: number): string {
  requireIsoDate(iso);
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(iso: string, months: number): string {
  requireIsoDate(iso);
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)));
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  requireIsoDate(from, 'from');
  requireIsoDate(to, 'to');
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

export function endOfMonth(iso: string): string {
  requireIsoDate(iso);
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${iso.slice(0, 7)}-${last.toString().padStart(2, '0')}`;
}

export function startOfMonth(iso: string): string {
  requireIsoDate(iso);
  return `${iso.slice(0, 7)}-01`;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "2026-07-01" -> "Jul 2026", the period label the screens use. */
export function periodLabel(iso: string): string {
  requireIsoDate(iso);
  return `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

/** "Jul 2026" -> "2026-07-01". Null when the label names no month. */
export function periodToIso(label: string): string | null {
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(label.trim());
  if (!m) return null;
  const index = MONTH_NAMES.findIndex(n => n.toLowerCase() === m[1].toLowerCase());
  if (index < 0) return null;
  return `${m[2]}-${(index + 1).toString().padStart(2, '0')}-01`;
}

/** "10 Jun 2026" -> "2026-06-10". Null when it is not a day, month and year. */
export function dayMonthYearToIso(value: string): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const index = MONTH_NAMES.findIndex(n => n.toLowerCase() === m[2].toLowerCase());
  if (index < 0) return null;
  const iso = `${m[3]}-${(index + 1).toString().padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

/** "2026-06-10" -> "10 Jun 2026", for display next to the existing screens. */
export function isoToDayMonthYear(iso: string): string {
  requireIsoDate(iso);
  return `${iso.slice(8, 10)} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}
