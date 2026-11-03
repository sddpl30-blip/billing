/**
 * How a bill's period reads on screen and on paper.
 *
 * An opening due brought forward (numbered OB/<batch>/<serial>) is stored
 * with the period of the opening date, so a cut-over on 1 Oct 2026 shows as
 * "Oct 2026", which reads like October's maintenance. It is what the flat
 * owed before the portal started, and carries no GST. It is shown as
 * "Arrears upto <label date>" instead (the committee's wording); the stored period, its number
 * and its amount are unchanged, so nothing that matches on them moves.
 */

import { periodLabel } from './clock';

/**
 * The date an opening due reads "upto". It is a label only (Office > Settings
 * "Arrears label date"): the opening batch's own date, its postings, amounts
 * and due dates are never read from it. Until the server reports the setting,
 * this default applies.
 */
export const ARREARS_LABEL_DEFAULT = '2026-09-30';
export const ARREARS_LABEL_KEY = 'billing.arrearsLabelDate';

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

let registeredLabelDate = ARREARS_LABEL_DEFAULT;
/** Set by the server store on each refresh, so every screen reads the one setting. */
export function registerArrearsLabelDate(date: unknown): void {
  registeredLabelDate = isIsoDate(date) ? date : ARREARS_LABEL_DEFAULT;
}

/** "Arrears upto 30 Sep 2026". */
export const arrearsLabel = (iso: string): string =>
  `Arrears upto ${iso.slice(8, 10)} ${periodLabel(iso)}`;

export const isOpeningDocument = (documentNo: string | null | undefined): boolean =>
  typeof documentNo === 'string' && documentNo.startsWith('OB/');

/**
 * The period as it should read. An opening due reads from the label date
 * (the one given, else the setting the server last reported); anything else
 * reads as its period.
 */
export function billPeriodLabel(
  period: string, documentNo: string | null | undefined, labelDate?: string,
): string {
  if (!isOpeningDocument(documentNo)) return period;
  return arrearsLabel(isIsoDate(labelDate) ? labelDate : registeredLabelDate);
}

/** A bill's title: "Oct 2026 Maintenance", or "Arrears upto Sep 2026". */
export function billTitle(period: string, documentNo: string | null | undefined): string {
  return isOpeningDocument(documentNo) ? billPeriodLabel(period, documentNo) : `${period} Maintenance`;
}

/** The one line an opening due shows instead of a breakdown: "Previous outstanding upto Sep 2026". */
export function openingLineLabel(period: string, documentNo: string | null | undefined): string {
  return billPeriodLabel(period, documentNo).replace(/^Arrears/, 'Previous outstanding');
}
