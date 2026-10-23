/**
 * One list of bills for every screen.
 *
 * The resident and manager screens read the `invoices` array, while the books
 * read the ledger — so a bill raised through the register was invisible on the
 * invoice screens, and a bill from the seed had no register document. This
 * merges the two into one list where the register is authoritative for
 * anything it holds, and says where each row came from.
 *
 * It does not write. Nothing here changes a status; a register row's status is
 * whatever the ledger says, and a legacy row's is whatever the array says,
 * labelled as such.
 */

import {
  type DerivedStatus, type RegisterView, formatRupees, isoToDayMonthYear, toRupees,
} from '../accounting';
import type { SourceInvoice } from '../accounting';

export interface UnifiedInvoice {
  /** Stable key for React. */
  readonly key: string;
  /** What the member sees: the tax invoice number once issued, else the proforma. */
  readonly reference: string;
  readonly flatNo: string;
  readonly name: string;
  readonly period: string;
  readonly grossRupees: number;
  readonly grossFormatted: string;
  readonly outstandingRupees: number;
  readonly outstandingFormatted: string;
  readonly status: DerivedStatus;
  readonly dueOnDisplay: string;
  readonly dueOnIso?: string;
  /**
   * Where this row comes from.
   *
   * `register` rows have a ledger behind them and a status derived from it.
   * `legacy-seed` rows are from the original demo array: they carry no
   * postings, so their status is the stored one and no receipt can be applied
   * to them until a document is opened.
   */
  readonly source: 'register' | 'legacy-seed';
  /** The register document, when there is one, for the workflow actions. */
  readonly proformaNo?: string;
  readonly taxInvoiceNo?: string;
  /** True when the row can take a payment right now. */
  readonly payable: boolean;
  /** Why not, when it cannot. */
  readonly notPayableBecause?: string;
}

const STATUS_FROM_LEGACY: Record<SourceInvoice['status'], DerivedStatus> = {
  Paid: 'Paid',
  Pending: 'Pending',
  Overdue: 'Overdue',
};

/**
 * Whether a receipt can be applied to this document right now.
 *
 * Before conversion the answer is yes: paying a proforma is what converts it.
 * After conversion it depends on whether anything is still owed. Cancelled is
 * always no.
 */
function payableState(doc: RegisterView): { payable: boolean; because?: string } {
  if (doc.state === 'cancelled') {
    return { payable: false, because: 'This document was cancelled.' };
  }
  if (doc.state !== 'tax-invoice') {
    // A draft can take a payment, but paying it converts it, which needs
    // approval — the register enforces that and says so.
    return doc.state === 'draft'
      ? { payable: false, because: 'Awaiting treasurer approval before it can be paid or issued.' }
      : { payable: true };
  }
  return doc.outstanding > 0
    ? { payable: true }
    : { payable: false, because: 'Settled in full.' };
}

function fromRegister(doc: RegisterView, nameOf: (flatNo: string) => string): UnifiedInvoice {
  const { payable, because } = payableState(doc);
  return {
    key: `reg:${doc.proformaNo}`,
    reference: doc.taxInvoiceNo ?? doc.proformaNo,
    flatNo: doc.flatNo,
    name: nameOf(doc.flatNo),
    period: doc.period,
    grossRupees: toRupees(doc.gross),
    grossFormatted: formatRupees(doc.gross),
    outstandingRupees: toRupees(doc.outstanding),
    outstandingFormatted: formatRupees(doc.outstanding),
    status: doc.status,
    dueOnDisplay: isoToDayMonthYear(doc.dueOn),
    dueOnIso: doc.dueOn,
    source: 'register',
    proformaNo: doc.proformaNo,
    ...(doc.taxInvoiceNo !== undefined ? { taxInvoiceNo: doc.taxInvoiceNo } : {}),
    payable,
    ...(because !== undefined ? { notPayableBecause: because } : {}),
  };
}

function fromLegacy(inv: SourceInvoice): UnifiedInvoice {
  const outstanding = inv.status === 'Paid' ? 0 : inv.total;
  return {
    key: `seed:${inv.id}`,
    reference: inv.invoiceNo,
    flatNo: inv.flatNo,
    name: inv.name,
    period: inv.period,
    grossRupees: inv.total,
    grossFormatted: formatRupees(Math.round(inv.total * 100)),
    outstandingRupees: outstanding,
    outstandingFormatted: formatRupees(Math.round(outstanding * 100)),
    status: STATUS_FROM_LEGACY[inv.status],
    dueOnDisplay: inv.dueDate,
    source: 'legacy-seed',
    payable: outstanding > 0,
    ...(outstanding === 0 ? { notPayableBecause: 'Recorded as paid in the sample data.' } : {}),
  };
}

/**
 * Merges register documents with the legacy array.
 *
 * A legacy row is dropped when the register holds a document for the same flat
 * and period: the register has the postings, so showing both would double the
 * bill on screen and let a member pay the same month twice.
 */
export function unifiedInvoices(input: {
  registerDocuments: readonly RegisterView[];
  legacyInvoices: readonly SourceInvoice[];
  nameOf?: (flatNo: string) => string;
}): readonly UnifiedInvoice[] {
  const nameOf = input.nameOf ?? ((flat: string) => flat);
  const covered = new Set(
    input.registerDocuments
      .filter(d => d.state !== 'cancelled')
      .map(d => `${d.flatNo}::${d.period}`),
  );

  const rows: UnifiedInvoice[] = input.registerDocuments.map(d => fromRegister(d, nameOf));
  for (const inv of input.legacyInvoices) {
    if (covered.has(`${inv.flatNo}::${inv.period}`)) continue;
    rows.push(fromLegacy(inv));
  }

  // Newest period first where a date is known, then by reference, so the order
  // is stable across renders.
  return rows.sort((a, b) => {
    const aKey = a.dueOnIso ?? '';
    const bKey = b.dueOnIso ?? '';
    if (aKey !== bKey) return aKey < bKey ? 1 : -1;
    return a.reference.localeCompare(b.reference);
  });
}

/** Just one flat's bills, for the resident screens. */
export function invoicesForFlat(
  all: readonly UnifiedInvoice[],
  flatNo: string,
): readonly UnifiedInvoice[] {
  return all.filter(i => i.flatNo === flatNo);
}

export interface InvoiceTotals {
  readonly billedRupees: number;
  readonly collectedRupees: number;
  readonly outstandingRupees: number;
  readonly overdueCount: number;
  /** Rows with no postings behind them, so a committee knows the figure is partial. */
  readonly legacyRows: number;
}

export function invoiceTotals(rows: readonly UnifiedInvoice[]): InvoiceTotals {
  let billed = 0;
  let outstanding = 0;
  let overdueCount = 0;
  let legacyRows = 0;
  for (const r of rows) {
    billed += r.grossRupees;
    outstanding += r.outstandingRupees;
    if (r.status === 'Overdue') overdueCount++;
    if (r.source === 'legacy-seed') legacyRows++;
  }
  return {
    billedRupees: billed,
    collectedRupees: billed - outstanding,
    outstandingRupees: outstanding,
    overdueCount,
    legacyRows,
  };
}
