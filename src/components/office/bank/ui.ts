/** Shared classes and formatting for the Banking panel's pieces. */

import { formatRupees } from '../../../accounting/money';

export const card = 'bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl shadow-xs';
export const field =
  'w-full bg-[var(--mv-surface)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold text-xs ' +
  'text-[var(--mv-ink)] outline-none focus:border-[var(--mv-accent)]';
export const label = 'text-[10px] text-[var(--mv-muted)] font-bold block mb-1 uppercase tracking-wider';
export const primaryButton =
  'px-4 py-2 rounded-xl text-xs font-bold bg-[var(--mv-accent)] text-white border border-[var(--mv-accent)] ' +
  'hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed';
export const secondaryButton =
  'px-4 py-2 rounded-xl text-xs font-bold bg-[var(--mv-surface)] text-[var(--mv-ink)] border ' +
  'border-[var(--mv-border)] hover:border-[var(--mv-accent)] disabled:opacity-50 disabled:cursor-not-allowed';
export const dialogPanel =
  'bg-[var(--mv-surface)] w-full max-w-md max-h-[90vh] overflow-y-auto rounded-3xl shadow-2xl border ' +
  'border-[var(--mv-border)] p-5 space-y-4 text-xs text-left outline-none';
export const errorBox = 'p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-medium';

/** Paise as rupees with Indian grouping, always to the paisa. */
export function rupees(paise: number): string {
  return formatRupees(paise, { paise: true });
}

/** Today in the browser's own calendar, as an ISO date. */
export function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * A rupee amount as typed, to paise, or null when it is not one. Accepts a
 * sign and Indian grouping commas, and at most two decimals: anything finer
 * was never an amount of money.
 */
export function parseRupees(text: string): number | null {
  const cleaned = text.trim().replace(/[₹,\s]/g, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (m === null) return null;
  const paise = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(paise)) return null;
  return m[1] === '-' ? -paise : paise;
}
