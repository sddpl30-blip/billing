/**
 * The monthly billing run.
 *
 * Builds one proforma per flat from that flat's billing area and the
 * maintenance rate in force, plus whatever fixed heads apply. Skips a flat
 * that already has a live document for the period rather than raising a
 * second, and reports every skip rather than swallowing it.
 */

import { Paise, fromRupees } from './money';
import { AccountingConfig } from './config';
import { periodLabel, periodToIso, requireIsoDate } from './clock';
import { AreaBasis, MaintenanceRate, RateError, areaCharge, rateOn } from './rates';
import { BillLine } from './transactions';
import { BillingDocument, BillingRegister } from './documents';
import { ReceiptHead } from './accounts';

export interface FlatRecord {
  readonly flatNo: string;
  readonly name: string;
  /** Measured area in square feet. Zero or missing blocks area-based billing. */
  readonly billingAreaSqFt?: number;
  /** Which measure the area is. No default — see rates.ts. */
  readonly areaBasis?: AreaBasis;
  /** Per-flat fixed additions, e.g. a second parking bay. */
  readonly fixedCharges?: ReadonlyArray<{ head: ReceiptHead; amountRupees: number; taxable: boolean }>;
  /** True where the owner does not occupy, which some associations surcharge. */
  readonly nonOccupied?: boolean;
}

export interface BillingRunInput {
  readonly period: string;
  readonly flats: readonly FlatRecord[];
  /** Heads applied to every flat, as rupee amounts. */
  readonly commonCharges?: ReadonlyArray<{ head: ReceiptHead; amountRupees: number; taxable: boolean }>;
  /** Sinking fund as a percentage of the maintenance charge, where that is how it is levied. */
  readonly sinkingFundPercentOfMaintenance?: number;
  readonly issuedOn?: string;
  /** Allows a run from an unapproved rate, for a preview only. */
  readonly previewOnly?: boolean;
}

export interface BillingRunResult {
  readonly period: string
  readonly issuedOn: string;
  readonly documents: readonly BillingDocument[];
  /** Flats not billed, each with the reason. */
  readonly skipped: ReadonlyArray<{ flatNo: string; why: string }>;
  readonly rate: MaintenanceRate | null;
  readonly totalNet: Paise;
  readonly totalTax: Paise;
  readonly totalGross: Paise;
}

/**
 * Builds the proformas for a period. Raises nothing in the ledger — the
 * register posts on conversion.
 *
 * `previewOnly` lets a treasurer see what a run would produce from a rate that
 * has not been approved yet; the documents it builds are still drafts and
 * still cannot be converted without approval, so there is no path from a
 * preview to a posted invoice.
 */
export function runBilling(
  register: BillingRegister,
  input: BillingRunInput,
  config: AccountingConfig,
): BillingRunResult {
  const periodStart = periodToIso(input.period);
  if (periodStart === null) {
    throw new RateError(`"${input.period}" is not a month and year.`);
  }
  const issuedOn = requireIsoDate(input.issuedOn ?? periodStart, 'issue date');

  const rate = rateOn(
    { rates: [{
      ratePerSqFt: config.maintenance.ratePerSqFt,
      basis: config.maintenance.areaBasis,
      effectiveFrom: config.maintenance.effectiveFrom,
      authority: config.maintenance.basis,
      ...(config.reviewedBy !== undefined ? { approvedBy: config.reviewedBy } : {}),
      ...(config.reviewedOn !== undefined ? { approvedOn: config.reviewedOn } : {}),
    }] },
    issuedOn,
  );

  const documents: BillingDocument[] = [];
  const skipped: Array<{ flatNo: string; why: string }> = [];
  let totalNet = 0;
  let totalTax = 0;

  for (const flat of input.flats) {
    if (register.hasDocumentFor(flat.flatNo, input.period)) {
      skipped.push({
        flatNo: flat.flatNo,
        why: `already has a live document for ${input.period}`,
      });
      continue;
    }
    if (rate === null) {
      skipped.push({
        flatNo: flat.flatNo,
        why: `no maintenance rate is in force on ${issuedOn}`,
      });
      continue;
    }
    if (flat.billingAreaSqFt === undefined || flat.areaBasis === undefined) {
      skipped.push({
        flatNo: flat.flatNo,
        why:
          'no billing area or area basis recorded. An area-based charge cannot be computed, ' +
          'and guessing either would misstate the bill.',
      });
      continue;
    }

    let maintenance;
    try {
      maintenance = areaCharge(
        { flatNo: flat.flatNo, billingAreaSqFt: flat.billingAreaSqFt, areaBasis: flat.areaBasis },
        rate,
        { allowUnapproved: input.previewOnly === true },
      );
    } catch (err) {
      skipped.push({ flatNo: flat.flatNo, why: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const lines: BillLine[] = [
      { head: 'maintenance', amount: maintenance.amount, taxable: true },
    ];

    if (input.sinkingFundPercentOfMaintenance !== undefined && input.sinkingFundPercentOfMaintenance > 0) {
      const sinking = Math.round(
        (maintenance.amount * Math.round(input.sinkingFundPercentOfMaintenance * 10000)) / 1000000,
      );
      if (sinking > 0) {
        // Not taxable — a corpus collection — unless the society has decided
        // otherwise; then it is taxed with maintenance and counts towards the
        // per-member threshold, because the line says it is taxable.
        lines.push({ head: 'sinking', amount: sinking, taxable: config.gstSinkingFundTaxable === true });
      }
    }

    for (const charge of [...(input.commonCharges ?? []), ...(flat.fixedCharges ?? [])]) {
      const amount = fromRupees(charge.amountRupees);
      if (amount > 0) {
        lines.push({ head: charge.head, amount, taxable: charge.taxable });
      }
    }

    try {
      const doc = register.issueProforma({
        flatNo: flat.flatNo,
        period: input.period,
        lines,
        issuedOn,
      });
      documents.push(doc);
      totalNet += doc.gross - doc.estimatedTax;
      totalTax += doc.estimatedTax;
    } catch (err) {
      skipped.push({ flatNo: flat.flatNo, why: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    period: input.period,
    issuedOn,
    documents,
    skipped,
    rate,
    totalNet,
    totalTax,
    totalGross: totalNet + totalTax,
  };
}

/** The period label for a date, so callers do not format it themselves. */
export function periodFor(isoDate: string): string {
  return periodLabel(isoDate);
}
