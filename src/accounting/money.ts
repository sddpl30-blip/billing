/**
 * Money is integer paise throughout the engine.
 *
 * The demo stored rupees as plain JavaScript numbers, which cannot represent
 * most two-decimal amounts exactly: 0.1 + 0.2 is 0.30000000000000004, and a
 * trial balance compared with === will eventually fail on nothing but float
 * drift. Integers remove the question. Rupees appear only at the edges, in
 * `fromRupees` on the way in and `formatRupees` on the way out.
 */

/** An amount in paise. Always an integer; may be negative. */
export type Paise = number;

export class MoneyError extends Error {}

/** Rupees to paise. Rejects anything that is not a finite 2-decimal amount. */
export function fromRupees(rupees: number): Paise {
  if (!Number.isFinite(rupees)) {
    throw new MoneyError(`Not a finite amount: ${rupees}`);
  }
  const paise = Math.round(rupees * 100);
  // 0.005 of a rupee is half a paisa; anything finer was never representable.
  if (Math.abs(rupees * 100 - paise) > 1e-6) {
    throw new MoneyError(`${rupees} is finer than one paisa`);
  }
  return paise;
}

/** Paise to rupees, for display and for handing values to the existing UI. */
export function toRupees(paise: Paise): number {
  assertInteger(paise);
  return paise / 100;
}

export function assertInteger(paise: Paise): void {
  if (!Number.isInteger(paise)) {
    throw new MoneyError(`Amount must be whole paise, got ${paise}`);
  }
}

/** Throws unless the amount is a positive whole number of paise. */
export function assertPositive(paise: Paise, what = 'amount'): void {
  assertInteger(paise);
  if (paise <= 0) {
    throw new MoneyError(`${what} must be positive, got ${paise} paise`);
  }
}

export function sum(amounts: readonly Paise[]): Paise {
  let total = 0;
  for (const a of amounts) {
    assertInteger(a);
    total += a;
  }
  return total;
}

/**
 * A percentage of an amount, rounded half-up to the paisa.
 *
 * `rate` is a percentage (18 for 18%, 2 for 2% TDS) and may carry decimals.
 * Half-up matches how an Indian tax invoice is normally rounded; the engine
 * never relies on the rounded figure balancing by itself — the caller plugs
 * the remainder into a real account rather than a difference line.
 */
export function percentOf(base: Paise, rate: number): Paise {
  assertInteger(base);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new MoneyError(`Rate must be a non-negative percentage, got ${rate}`);
  }
  // Scale by 10000 so a rate like 2.5 stays exact in integer arithmetic.
  const scaled = Math.round(base * Math.round(rate * 10000));
  return Math.round(scaled / 1000000);
}

/**
 * Splits `total` into `weights.length` parts proportional to `weights`,
 * guaranteeing the parts add back to `total` exactly.
 *
 * Needed wherever one amount is apportioned across several accounts — GST
 * across CGST and SGST, a receipt across the heads it settles. Rounding each
 * part independently loses or gains paise; this gives the remainder to the
 * largest parts, so nothing is invented to make the figures tie.
 */
export function allocate(total: Paise, weights: readonly number[]): Paise[] {
  assertInteger(total);
  if (weights.length === 0) {
    throw new MoneyError('Cannot allocate across zero weights');
  }
  if (weights.some(w => !Number.isFinite(w) || w < 0)) {
    throw new MoneyError('Weights must be non-negative finite numbers');
  }
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  if (weightTotal === 0) {
    throw new MoneyError('Weights must not all be zero');
  }

  const parts = weights.map(w => Math.floor((total * w) / weightTotal));
  let remainder = total - parts.reduce((a, b) => a + b, 0);

  // Hand out the leftover paise largest-share-first, deterministically.
  const order = weights
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (b.w - a.w) || (a.i - b.i));
  const step = remainder >= 0 ? 1 : -1;
  let k = 0;
  while (remainder !== 0) {
    parts[order[k % order.length].i] += step;
    remainder -= step;
    k++;
  }
  return parts;
}

const INDIAN_GROUPS = /\B(?=(\d{2})+(?!\d))/g;

/** Indian digit grouping with paise: 1234567.5 -> "₹12,34,567.50". */
export function formatRupees(paise: Paise, opts: { paise?: boolean } = {}): string {
  assertInteger(paise);
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;

  const digits = whole.toString();
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest === ''
    ? lastThree
    : rest.replace(INDIAN_GROUPS, ',') + ',' + lastThree;

  const showPaise = opts.paise ?? fraction !== 0;
  const tail = showPaise ? '.' + fraction.toString().padStart(2, '0') : '';
  return (negative ? '-₹' : '₹') + grouped + tail;
}
