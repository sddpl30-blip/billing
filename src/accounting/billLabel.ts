/**
 * How a bill's period reads on screen and on paper.
 *
 * An opening due brought forward (numbered OB/<batch>/<serial>) is stored
 * with the period of the opening date, so a cut-over on 1 Oct 2026 shows as
 * "Oct 2026", which reads like October's maintenance. It is what the flat
 * owed before the portal started, and carries no GST. It is shown as
 * "Arrears upto Sep 2026" instead (the committee's wording); the stored period, its number
 * and its amount are unchanged, so nothing that matches on them moves.
 */

import { addMonths, periodLabel, periodToIso } from './clock';

/**
 * Opening dates by document number, as the server last reported them. Set by
 * the server store on each refresh, so every screen labels an opening due
 * from its real opening date without each caller having to pass it.
 */
let knownOpeningDates: Readonly<Record<string, string>> = {};
export function registerOpeningDates(dates: Readonly<Record<string, string>>): void {
  knownOpeningDates = dates;
}

export const isOpeningDocument = (documentNo: string | null | undefined): boolean =>
  typeof documentNo === 'string' && documentNo.startsWith('OB/');

/**
 * The period as it should read. `openingAsAt`, when known, is the opening
 * date itself: dues "up to" the month before it if it is the 1st, or up to
 * that date otherwise. Without it (or one registered from the server), the
 * opening date is taken to be the 1st of the stored month.
 */
export function billPeriodLabel(
  period: string, documentNo: string | null | undefined, openingAsAt?: string,
): string {
  if (!isOpeningDocument(documentNo)) return period;
  openingAsAt ??= knownOpeningDates[documentNo as string];
  if (openingAsAt !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(openingAsAt)) {
    return openingAsAt.endsWith('-01')
      ? `Arrears upto ${periodLabel(addMonths(openingAsAt, -1))}`
      : `Arrears upto ${openingAsAt.slice(8, 10)} ${periodLabel(openingAsAt)}`;
  }
  const iso = periodToIso(period);
  return iso === null ? 'Arrears' : `Arrears upto ${periodLabel(addMonths(iso, -1))}`;
}

/** A bill's title: "Oct 2026 Maintenance", or "Arrears upto Sep 2026". */
export function billTitle(period: string, documentNo: string | null | undefined): string {
  return isOpeningDocument(documentNo) ? billPeriodLabel(period, documentNo) : `${period} Maintenance`;
}

/** The one line an opening due shows instead of a breakdown: "Previous outstanding upto Sep 2026". */
export function openingLineLabel(period: string, documentNo: string | null | undefined): string {
  return billPeriodLabel(period, documentNo).replace(/^Arrears/, 'Previous outstanding');
}
