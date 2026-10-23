/**
 * Effective-dated maintenance rates and the area-based charge.
 *
 * The demo's billing wizard took a flat amount typed into a box and applied it
 * to every flat, so a 1,750 sq ft flat and a 2,400 sq ft flat were billed the
 * same. Here the charge is the flat's billing area times the rate in force on
 * the billing date, and a rate is never silently extended backwards: a billing
 * date before the earliest rate is an error, not a fallback.
 */

import { Paise, assertPositive, fromRupees, percentOf } from './money';
import { DateError, isValidIsoDate, requireIsoDate } from './clock';

/**
 * Which measured area a rate applies to.
 *
 * There is no default. The same rupee rate over carpet area and over
 * super-built-up area produces materially different bills, and which one an
 * association resolved on is a fact about that association, not something this
 * code can pick. A flat with no basis recorded cannot be billed.
 */
export type AreaBasis = 'carpet' | 'built-up' | 'super-built-up';

export const AREA_BASIS_LABEL: Record<AreaBasis, string> = {
  carpet: 'Carpet area',
  'built-up': 'Built-up area',
  'super-built-up': 'Super built-up area',
};

export interface MaintenanceRate {
  /** Rupees per square foot per month. */
  readonly ratePerSqFt: number;
  /** The area measure this rate is expressed against. */
  readonly basis: AreaBasis;
  readonly effectiveFrom: string;
  /** What authorised it — an AGM resolution, a committee minute. */
  readonly authority: string;
  /** Set once a CA or the committee has confirmed the figure. */
  readonly approvedBy?: string;
  readonly approvedOn?: string;
}

export class RateError extends Error {}

/**
 * The rate schedule, newest last. Each entry stands until the next one starts.
 */
export interface RateSchedule {
  readonly rates: readonly MaintenanceRate[];
}

/**
 * ₹4.50 per square foot, as stated in the brief for this association.
 *
 * `basis` is the open question. The brief gives the rate but not the area
 * measure it applies to, and the requirements PDF that would settle it has not
 * reached this session, so `super-built-up` here is a placeholder and
 * `approvedBy` is deliberately unset — `requireApprovedRate` refuses to bill
 * from an unapproved rate, so this cannot quietly become the basis of a real
 * invoice.
 */
export const MANI_VISTA_RATES: RateSchedule = {
  rates: [
    {
      ratePerSqFt: 4.5,
      basis: 'super-built-up',
      effectiveFrom: '2026-04-01',
      authority:
        'Rate stated in the project brief. AREA BASIS UNCONFIRMED — the brief gives ₹4.50/sq ft ' +
        'but not whether it applies to carpet, built-up or super built-up area. The three give ' +
        'materially different bills. To be confirmed against the requirements document.',
    },
  ],
};

/** The rate in force on a date, or null when the schedule starts later. */
export function rateOn(schedule: RateSchedule, isoDate: string): MaintenanceRate | null {
  requireIsoDate(isoDate, 'billing date');
  let found: MaintenanceRate | null = null;
  for (const rate of schedule.rates) {
    if (!isValidIsoDate(rate.effectiveFrom)) {
      throw new DateError(`Rate has an invalid effectiveFrom: "${rate.effectiveFrom}"`);
    }
    if (rate.effectiveFrom <= isoDate) {
      if (found === null || rate.effectiveFrom > found.effectiveFrom) found = rate;
    }
  }
  return found;
}

/**
 * The rate in force, or an error. Refuses an unapproved rate.
 *
 * Billing a member from a rate nobody has signed off is the kind of mistake
 * that has to be unwound invoice by invoice, so it is blocked here rather than
 * warned about.
 */
export function requireApprovedRate(schedule: RateSchedule, isoDate: string): MaintenanceRate {
  const rate = rateOn(schedule, isoDate);
  if (rate === null) {
    const earliest = [...schedule.rates].map(r => r.effectiveFrom).sort()[0] ?? 'none';
    throw new RateError(
      `No maintenance rate is in force on ${isoDate}; the earliest rate starts ${earliest}. ` +
      `A rate is not extended backwards.`,
    );
  }
  if (!rate.approvedBy || !rate.approvedOn) {
    throw new RateError(
      `The rate of ₹${rate.ratePerSqFt}/sq ft effective ${rate.effectiveFrom} has not been ` +
      `approved. ${rate.authority} Set approvedBy and approvedOn once it is confirmed.`,
    );
  }
  return rate;
}

export interface FlatForBilling {
  readonly flatNo: string;
  /** Measured area in square feet. */
  readonly billingAreaSqFt: number;
  /** Which measure `billingAreaSqFt` is. Must match the rate's basis. */
  readonly areaBasis: AreaBasis;
}

export interface AreaChargeResult {
  readonly flatNo: string;
  readonly areaSqFt: number;
  readonly basis: AreaBasis;
  readonly ratePerSqFt: number;
  /** Area times rate, rounded to the paisa. */
  readonly amount: Paise;
  readonly effectiveFrom: string;
}

/**
 * The monthly maintenance charge for a flat: area times the rate in force.
 *
 * Refuses when the flat's area basis is not the one the rate is expressed
 * against, rather than applying a super-built-up rate to a carpet-area figure
 * and producing a bill that looks plausible and is wrong by a third.
 */
export function areaCharge(
  flat: FlatForBilling,
  rate: MaintenanceRate,
  opts: { allowUnapproved?: boolean } = {},
): AreaChargeResult {
  if (!Number.isFinite(flat.billingAreaSqFt) || flat.billingAreaSqFt <= 0) {
    throw new RateError(
      `Flat ${flat.flatNo} has no usable billing area (${flat.billingAreaSqFt}); ` +
      `an area-based charge cannot be computed.`,
    );
  }
  if (flat.areaBasis !== rate.basis) {
    throw new RateError(
      `Flat ${flat.flatNo} records ${AREA_BASIS_LABEL[flat.areaBasis].toLowerCase()} but the ` +
      `rate effective ${rate.effectiveFrom} is per ${AREA_BASIS_LABEL[rate.basis].toLowerCase()}. ` +
      `Applying one to the other would misstate the bill.`,
    );
  }
  if (!opts.allowUnapproved && (!rate.approvedBy || !rate.approvedOn)) {
    throw new RateError(
      `Refusing to compute a charge from an unapproved rate (effective ${rate.effectiveFrom}).`,
    );
  }

  // Rupees per sq ft can carry paise, so the multiply happens in paise.
  const amount = Math.round(fromRupees(rate.ratePerSqFt) * flat.billingAreaSqFt);
  assertPositive(amount, `maintenance charge for ${flat.flatNo}`);

  return {
    flatNo: flat.flatNo,
    areaSqFt: flat.billingAreaSqFt,
    basis: flat.areaBasis,
    ratePerSqFt: rate.ratePerSqFt,
    amount,
    effectiveFrom: rate.effectiveFrom,
  };
}

/**
 * GST on a taxable value at a configured rate, as CGST and SGST.
 *
 * Kept here rather than inline so the only place a tax rate is applied is one
 * function, and `allocate` guarantees the two halves add back to the total.
 */
export function gstOn(taxableValue: Paise, ratePercent: number): Paise {
  if (taxableValue === 0) return 0;
  return percentOf(taxableValue, ratePercent);
}
