/**
 * Society settings, and the approval flags on the ones that are tax or
 * accounting treatments.
 *
 * Read from `society_settings` rather than hard-coded, because every one of
 * these was a literal in the demo: the GST rate, the invoice prefix, the due
 * date, the sinking-fund share. A value a committee can change is a setting.
 *
 * Nothing here invents a default for a treatment. `gstTreatment` returns
 * `approved: false` until a row records who signed it off, and the billing
 * path refuses to issue a GST-charging invoice on an unapproved treatment —
 * which is enforced in `convertToTaxInvoice`, not here.
 */

import type { Queryable } from './pg';
import { badRequest, conflict } from './http';
import type { GstTreatment } from './posting';
import type { AreaBasis, MaintenanceRate } from '../../src/accounting/rates';

export interface SettingRow {
  readonly key: string;
  readonly value: unknown;
  readonly approvedBy: string | null;
  readonly approvedOn: string | null;
  readonly note: string | null;
  readonly updatedAt: string;
}

export async function readSettings(tx: Queryable, societyId: string): Promise<SettingRow[]> {
  const result = await tx.query<{
    key: string; value: string; approved_by: string | null; approved_on: string | null;
    note: string | null; updated_at: string;
  }>(
    `SELECT key, value::text, approved_by, approved_on::text, note, updated_at::text
       FROM society_settings WHERE society_id = $1 ORDER BY key`,
    [societyId],
  );
  return result.rows.map(r => ({
    key: r.key,
    value: JSON.parse(r.value),
    approvedBy: r.approved_by,
    approvedOn: r.approved_on,
    note: r.note,
    updatedAt: r.updated_at,
  }));
}

async function readOne(
  tx: Queryable,
  societyId: string,
  key: string,
): Promise<{ value: unknown; approved: boolean } | null> {
  const result = await tx.query<{ value: string; approved_by: string | null }>(
    'SELECT value::text, approved_by FROM society_settings WHERE society_id = $1 AND key = $2',
    [societyId, key],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { value: JSON.parse(row.value), approved: row.approved_by !== null };
}

export async function writeSetting(
  tx: Queryable,
  input: {
    societyId: string; key: string; value: unknown;
    /** Only set when the person writing it is recording a sign-off. */
    approvedBy?: string | null;
    approvedOn?: string | null;
    note?: string | null;
    /** Who proposed the value. Whoever approves it must be someone else. */
    requestedBy?: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO society_settings (society_id, key, value, approved_by, approved_on, note, requested_by, updated_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7, now())
     ON CONFLICT (society_id, key) DO UPDATE
        SET value = EXCLUDED.value,
            requested_by = EXCLUDED.requested_by,
            -- A changed value drops the old sign-off rather than inheriting it:
            -- approving 5% does not approve 18%.
            approved_by = EXCLUDED.approved_by,
            approved_on = EXCLUDED.approved_on,
            note = EXCLUDED.note,
            updated_at = now()`,
    [
      input.societyId,
      input.key,
      JSON.stringify(input.value),
      input.approvedBy ?? null,
      input.approvedOn ?? null,
      input.note ?? null,
      input.requestedBy ?? null,
    ],
  );
}

export const SETTING_KEYS = {
  GST: 'gst.treatment',
  INVOICE_PREFIX: 'billing.invoicePrefix',
  DUE_DAYS: 'billing.dueDays',
  SINKING_PERCENT: 'billing.sinkingFundPercent',
  BILLING_DAY: 'billing.dayOfMonth',
  FUNDS_THROUGH_INCOME: 'accounting.sinkingFundThroughIncome',
} as const;

/**
 * The per-member GST exemption when the setting does not name one: ₹7,500 a
 * month, the figure the engine's config carries. Statutory rather than a
 * choice, which is why it has a default where the treatment itself does not.
 */
export const DEFAULT_GST_MEMBER_THRESHOLD_RUPEES = 7500;

/**
 * The GST treatment.
 *
 * A society with no row at all is treated as not charging GST, which is the
 * safe direction: failing to charge is a shortfall the committee can see,
 * while charging on an unapproved treatment puts a wrong tax figure on a legal
 * document. A row that charges GST but has no sign-off comes back
 * `approved: false`, and posting refuses it.
 */
export async function gstTreatment(tx: Queryable, societyId: string): Promise<GstTreatment> {
  const row = await readOne(tx, societyId, SETTING_KEYS.GST);
  const defaultThreshold = DEFAULT_GST_MEMBER_THRESHOLD_RUPEES * 100;
  if (row === null) {
    return {
      chargeGst: false, ratePercent: 0, approved: false, memberThresholdPaise: defaultThreshold,
      sinkingFundTaxable: false, roundToRupee: false,
    };
  }
  const value = row.value as {
    chargeGst?: unknown; ratePercent?: unknown; memberThresholdRupees?: unknown;
    sinkingFundTaxable?: unknown; roundToRupee?: unknown;
  };
  const chargeGst = value.chargeGst === true;
  const ratePercent = typeof value.ratePercent === 'number' ? value.ratePercent : 0;
  if (chargeGst && !(ratePercent > 0 && ratePercent <= 100)) {
    throw badRequest(
      `The stored GST treatment charges tax at ${String(value.ratePercent)}%, which is not a ` +
      `usable rate. Correct the ${SETTING_KEYS.GST} setting.`,
    );
  }
  // The per-member threshold is part of the treatment, so it is signed off
  // with the rate: changing it drops the approval like any other change to
  // the value. Absent, the statutory figure applies — never "no threshold",
  // which would charge members the law exempts.
  const threshold = value.memberThresholdRupees;
  if (threshold !== undefined &&
      !(typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 && threshold <= 10_000_000)) {
    throw badRequest(
      `The stored GST treatment gives a per-member threshold of ${String(threshold)}, which is ` +
      `not an amount in rupees. Correct the ${SETTING_KEYS.GST} setting.`,
    );
  }
  const memberThresholdPaise = typeof threshold === 'number'
    ? Math.round(threshold * 100)
    : defaultThreshold;
  // Two choices the society makes, both off when absent so a society that has
  // not opted in bills exactly as before. Part of the treatment's value, so
  // changing either drops the sign-off like any other change to it. Anything
  // but a boolean is refused rather than read as one: "false" as a string is
  // truthy, and a tax figure should not turn on that.
  const flag = (name: 'sinkingFundTaxable' | 'roundToRupee'): boolean => {
    const raw = value[name];
    if (raw === undefined) return false;
    if (typeof raw !== 'boolean') {
      throw badRequest(
        `The stored GST treatment gives ${name} as ${JSON.stringify(raw)}, which is not true ` +
        `or false. Correct the ${SETTING_KEYS.GST} setting.`,
      );
    }
    return raw;
  };
  return {
    chargeGst, ratePercent, approved: row.approved, memberThresholdPaise,
    sinkingFundTaxable: flag('sinkingFundTaxable'),
    roundToRupee: flag('roundToRupee'),
  };
}

/**
 * Whether fund contributions — the sinking fund and festival collections —
 * are credited to income and appropriated later, rather than to the fund
 * directly. The server's name for the engine's `sinkingFundThroughIncome`.
 *
 * False when there is no row: crediting the fund directly is what the server
 * has always done with the sinking fund, and it keeps a contribution out of
 * the surplus a committee might read as spendable. A row saying true changes
 * the surplus and the balance sheet, so it is honoured only once signed off;
 * until then posting is refused rather than either treatment being guessed.
 */
export async function fundTreatment(tx: Queryable, societyId: string): Promise<boolean> {
  const row = await readOne(tx, societyId, SETTING_KEYS.FUNDS_THROUGH_INCOME);
  if (row === null || row.value !== true) return false;
  if (!row.approved) {
    throw conflict(
      `The ${SETTING_KEYS.FUNDS_THROUGH_INCOME} setting routes fund contributions through ` +
      `income but has not been signed off, so nothing that credits a fund can be posted. ` +
      `Record the sign-off, or set it back to false.`,
    );
  }
  return true;
}

export async function invoicePrefix(tx: Queryable, societyId: string): Promise<string> {
  const row = await readOne(tx, societyId, SETTING_KEYS.INVOICE_PREFIX);
  const value = row?.value;
  if (typeof value === 'string' && /^[A-Z0-9-]{2,12}$/.test(value)) return value;
  // 'INV' rather than something society-specific: a prefix appears on a tax
  // invoice, and guessing an abbreviation of the association's name would put
  // an invented identifier on a legal document.
  return 'INV';
}

export async function dueDays(tx: Queryable, societyId: string): Promise<number> {
  const row = await readOne(tx, societyId, SETTING_KEYS.DUE_DAYS);
  const value = row?.value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 90
    ? value
    : 15;
}

export async function sinkingFundPercent(tx: Queryable, societyId: string): Promise<number> {
  const row = await readOne(tx, societyId, SETTING_KEYS.SINKING_PERCENT);
  const value = row?.value;
  return typeof value === 'number' && value >= 0 && value <= 100 ? value : 0;
}

/** The payment terms a production society must have entered and approved before it bills. */
export const BILLING_TERMS = [
  { key: SETTING_KEYS.DUE_DAYS, label: 'Days to pay (billing.dueDays)' },
  { key: SETTING_KEYS.SINKING_PERCENT, label: 'Sinking fund share (billing.sinkingFundPercent)' },
] as const;

/**
 * Which payment terms are still pending verification: never entered, or
 * entered and not yet approved by someone other than the person who entered
 * them. Empty means billing may use them.
 *
 * Only a production society is held to this. A demo society keeps the
 * defaults it was seeded with, so the demo and the test suites bill as before.
 */
export async function pendingBillingTerms(tx: Queryable, societyId: string): Promise<string[]> {
  const mode = await tx.query<{ mode: string }>('SELECT mode FROM societies WHERE id = $1', [societyId]);
  if (mode.rows[0]?.mode !== 'production') return [];
  const pending: string[] = [];
  for (const term of BILLING_TERMS) {
    const row = await readOne(tx, societyId, term.key);
    if (row === null || row.value === null) pending.push(`${term.label}: not entered`);
    else if (!row.approved) pending.push(`${term.label}: entered, awaiting approval`);
  }
  return pending;
}

export interface RateInForce extends MaintenanceRate {
  readonly id: string;
}

/**
 * The maintenance rate in force on a date, with its approval.
 *
 * Effective-dated: the row with the latest `effective_from` at or before the
 * date. An unapproved rate is still returned, with its approval fields absent,
 * so a caller can say "the rate in force has not been signed off" rather than
 * "there is no rate" — two different problems with two different fixes.
 */
export async function rateOnDate(
  tx: Queryable,
  input: { societyId: string; on: string },
): Promise<RateInForce | null> {
  const result = await tx.query<{
    id: string; rate_paise_per_sqft: string; area_basis: string;
    effective_from: string; authority: string; approved_by: string | null;
    approved_on: string | null;
  }>(
    `SELECT id, rate_paise_per_sqft::text, area_basis, effective_from::text,
            authority, approved_by, approved_on::text
       FROM maintenance_rates
      WHERE society_id = $1 AND effective_from <= $2
      ORDER BY effective_from DESC
      LIMIT 1`,
    [input.societyId, input.on],
  );
  const row = result.rows[0];
  if (row === undefined) return null;

  // Stored in paise per square foot, because a rate is money and money is an
  // integer here. The engine's MaintenanceRate takes rupees per square foot,
  // so the division happens once, at this boundary.
  const rate: RateInForce = {
    id: row.id,
    ratePerSqFt: Number(row.rate_paise_per_sqft) / 100,
    basis: row.area_basis as AreaBasis,
    effectiveFrom: row.effective_from,
    authority: row.authority,
    ...(row.approved_by !== null && row.approved_on !== null
      ? { approvedBy: row.approved_by, approvedOn: row.approved_on }
      : {}),
  };
  return rate;
}
