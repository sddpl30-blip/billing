/**
 * Rates and policy choices, in one place, each with the date it takes effect.
 *
 * None of these are facts this code can establish. Every one is a demo value
 * until the association's CA confirms it, and the two treatment flags change
 * the surplus and the balance sheet, so they are choices rather than
 * defaults — `assertConfigReviewed` refuses to let an unreviewed config be
 * used for anything that would be shown as final.
 */

export interface TaxRate {
  /** Percentage. 18 means 18%. */
  readonly rate: number;
  readonly effectiveFrom: string;
  readonly basis: string;
}

export interface AccountingConfig {
  /**
   * Whether GST is charged on maintenance at all. Turns on the association's
   * turnover and the per-member threshold, neither of which is in this code.
   */
  readonly gstOnMaintenance: boolean;
  /** Split equally into CGST and SGST for an intra-state supply. */
  readonly gst: TaxRate;
  /** Per-member monthly maintenance above which GST is charged, in rupees. */
  readonly gstMemberThresholdRupees: number;

  readonly tds: {
    readonly contractor194C: TaxRate;
    readonly professional194J: TaxRate;
    readonly rent194I: TaxRate;
  };

  /**
   * Treatment of sinking fund contributions.
   *
   * `true`  — credit income, then appropriate the surplus to the fund. The
   *           contribution appears in Income & Expenditure.
   * `false` — credit the fund directly. The contribution never touches I&E.
   *
   * Both are used in practice and they give different surpluses. There is no
   * safe default, which is why this has no default.
   */
  readonly sinkingFundThroughIncome: boolean;

  readonly financialYear: {
    /** 1 = January. Indian financial years start in April. */
    readonly startMonth: number;
  };

  readonly billing: {
    /** Days after issue that a bill falls due. */
    readonly dueAfterDays: number;
    /** Prefix for the tax-invoice series. */
    readonly taxInvoicePrefix: string;
    /**
     * Whether an unpaid proforma becomes a tax invoice when it falls due.
     *
     * Under GST the time of supply for a continuous service is the earlier of
     * payment and the due date, which is the basis for converting on the due
     * date. Whether that is the right treatment for this association's
     * maintenance is a CA question, which is why it is a flag.
     */
    readonly convertOnDueDate: boolean;
  };

  /** The maintenance rate schedule, kept with the rest of the policy. */
  readonly maintenance: {
    readonly ratePerSqFt: number;
    readonly areaBasis: 'carpet' | 'built-up' | 'super-built-up';
    readonly effectiveFrom: string;
    readonly basis: string;
  };

  /** Set once a CA has signed off on everything above. */
  readonly reviewedBy?: string;
  readonly reviewedOn?: string;
}

/**
 * Demo values. Every figure here is unverified and the two treatment flags are
 * guesses standing in for a decision nobody has made yet.
 */
export const DEMO_CONFIG: AccountingConfig = {
  gstOnMaintenance: true,
  gst: {
    rate: 18,
    effectiveFrom: '2017-07-01',
    basis: 'DEMO VALUE — to be verified by a CA. Rate as commonly applied to RWA maintenance; applicability itself depends on turnover and the per-member threshold.',
  },
  gstMemberThresholdRupees: 7500,
  tds: {
    contractor194C: {
      rate: 2,
      effectiveFrom: '2024-04-01',
      basis: 'DEMO VALUE — to be verified by a CA. 194C company payee; 1% applies to an individual or HUF payee, which this engine does not yet distinguish.',
    },
    professional194J: {
      rate: 10,
      effectiveFrom: '2024-04-01',
      basis: 'DEMO VALUE — to be verified by a CA.',
    },
    rent194I: {
      rate: 10,
      effectiveFrom: '2024-04-01',
      basis: 'DEMO VALUE — to be verified by a CA. 194I rate differs for plant and machinery versus land and building.',
    },
  },
  sinkingFundThroughIncome: false,
  financialYear: { startMonth: 4 },
  billing: {
    dueAfterDays: 10,
    taxInvoicePrefix: 'TI',
    convertOnDueDate: true,
  },
  maintenance: {
    ratePerSqFt: 4.5,
    areaBasis: 'super-built-up',
    effectiveFrom: '2026-04-01',
    basis:
      'Rate of ₹4.50/sq ft is as stated in the project brief. THE AREA BASIS IS NOT STATED ' +
      'there — carpet, built-up and super built-up give materially different bills, so the ' +
      'value here is a placeholder pending the requirements document. The due day and the ' +
      'convert-on-due-date treatment are also unconfirmed.',
  },
};

export class ConfigNotReviewedError extends Error {}

/**
 * Throws unless a CA has signed the config off. Call this on any path that
 * produces a statement presented as final, so an unreviewed rate cannot reach
 * a document somebody files.
 */
export function assertConfigReviewed(config: AccountingConfig): void {
  if (!config.reviewedBy || !config.reviewedOn) {
    throw new ConfigNotReviewedError(
      'This accounting config has not been reviewed. The GST and TDS rates and ' +
      'the sinking-fund treatment are demo values; set reviewedBy and reviewedOn ' +
      'once a CA has confirmed them.',
    );
  }
}

/** Human-readable list of what still needs confirming. */
export function outstandingConfirmations(config: AccountingConfig): string[] {
  const out = [
    `GST on maintenance: ${config.gstOnMaintenance ? 'charged' : 'not charged'} at ${config.gst.rate}% — ${config.gst.basis}`,
    `Per-member GST threshold: ₹${config.gstMemberThresholdRupees}`,
    `TDS 194C: ${config.tds.contractor194C.rate}% — ${config.tds.contractor194C.basis}`,
    `TDS 194J: ${config.tds.professional194J.rate}% — ${config.tds.professional194J.basis}`,
    `TDS 194I: ${config.tds.rent194I.rate}% — ${config.tds.rent194I.basis}`,
    config.sinkingFundThroughIncome
      ? 'Sinking fund contributions are routed through income and then appropriated.'
      : 'Sinking fund contributions are credited to the fund directly and never appear in Income & Expenditure.',
    `Maintenance rate: ₹${config.maintenance.ratePerSqFt}/sq ft on ${config.maintenance.areaBasis} area — ${config.maintenance.basis}`,
    `Bills fall due ${config.billing.dueAfterDays} days after issue.`,
    config.billing.convertOnDueDate
      ? 'An unpaid proforma becomes a tax invoice on its due date.'
      : 'A proforma becomes a tax invoice only on payment.',
  ];
  if (!config.reviewedBy) out.push('NOT YET REVIEWED by a CA.');
  return out;
}

/** The financial year containing an ISO date, e.g. 2026-07-15 -> FY26-27. */
export function financialYearOf(isoDate: string, config: AccountingConfig): {
  label: string; from: string; to: string;
} {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const startMonth: number = config.financialYear.startMonth;
  const startYear = month >= startMonth ? year : year - 1;
  const endYear = startMonth === 1 ? startYear : startYear + 1;
  const mm = startMonth.toString().padStart(2, '0');
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const em = endMonth.toString().padStart(2, '0');
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return {
    label: `FY${startYear.toString().slice(2)}-${endYear.toString().slice(2)}`,
    from: `${startYear}-${mm}-01`,
    to: `${endYear}-${em}-${lastDay.toString().padStart(2, '0')}`,
  };
}
