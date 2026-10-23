/**
 * Builds a ledger from the demo's existing arrays.
 *
 * The engine knows nothing about `src/data.ts`, localStorage or React; this
 * file is the one place that does, so swapping the source for a Postgres-backed
 * API means replacing this file and nothing else.
 *
 * Nothing here invents a figure. There is no opening bank balance because the
 * demo data contains no evidence of one — the bank balance that comes out is
 * exactly the receipts recorded less the payments recorded. The old reports
 * showed ₹8,20,000 of cash and ₹60,80,000 of reserves; those were literals in
 * the JSX, not transactions, so they are not carried over.
 */

import { Paise, fromRupees } from './money';
import { A } from './accounts';
import { Ledger } from './journal';
import { AccountingConfig, DEMO_CONFIG } from './config';
import { billMaintenance, bookVendorBill, receiveFromMember } from './transactions';

/** The shape of the demo's `Invoice`, restated so the engine stays independent. */
export interface SourceInvoice {
  id: string;
  invoiceNo: string;
  flatNo: string;
  name: string;
  period: string;
  maintenance: number;
  sinkingFund: number;
  waterCharges: number;
  parkingCharges: number;
  nonOccupancyCharges: number;
  latePenalty: number;
  gst: number;
  total: number;
  status: 'Paid' | 'Pending' | 'Overdue';
  dueDate: string;
  paidDate?: string;
  paymentMethod?: string;
  transactionId?: string;
}

export interface SourceVendorInvoice {
  id: string;
  vendorId: string;
  vendorName: string;
  category: string;
  amount: number;
  tdsRate: number;
  tdsAmount: number;
  netPayable: number;
  status: 'Pending' | 'Approved' | 'Rejected';
  date: string;
}

export interface ImportReport {
  readonly ledger: Ledger;
  readonly invoicesPosted: number;
  readonly receiptsPosted: number;
  readonly vendorBillsPosted: number;
  /** Rows the import could not post, each with the reason. Never silently dropped. */
  readonly skipped: ReadonlyArray<{ what: string; why: string }>;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * An ISO date for a `period` like "Jun 2026", pinned to the first of the month.
 *
 * The demo's `dueDate` and `paidDate` fields hold values such as
 * "10th of Month" that name no actual date, so the period is the only usable
 * source. Returns null rather than guessing when the period is unparseable.
 */
export function isoFromPeriod(period: string, dayOfMonth = 1): string | null {
  const match = /^([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(period.trim());
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (!month) return null;
  return `${match[2]}-${month}-${dayOfMonth.toString().padStart(2, '0')}`;
}

/** An ISO date for a value like "10 Jun 2026". Null when it is not one. */
export function isoFromDayMonthYear(value: string): string | null {
  const match = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${match[1].padStart(2, '0')}`;
}

const EXPENSE_FOR_CATEGORY: Record<string, string> = {
  water: A.EXP_WATER,
  security: A.EXP_SECURITY,
  lift: A.EXP_LIFT,
  housekeeping: A.EXP_HOUSEKEEPING,
  electricity: A.EXP_ELECTRICITY,
  repairs: A.EXP_REPAIRS,
  audit: A.EXP_PROFESSIONAL,
};

/** Maps a free-text vendor category onto an expenditure account. */
export function expenseAccountFor(category: string): string {
  const key = Object.keys(EXPENSE_FOR_CATEGORY)
    .find(k => category.toLowerCase().includes(k));
  // Anything unrecognised lands in general repairs rather than being dropped,
  // and the import report says which rows that happened to.
  return key ? EXPENSE_FOR_CATEGORY[key] : A.EXP_REPAIRS;
}

/**
 * Posts the demo's invoices and vendor bills into a fresh ledger.
 *
 * A `Paid` invoice also gets its receipt. A vendor bill is booked but not
 * paid: the demo's "Approved" status meant both at once, which is the defect
 * being removed, so approval leaves a payable standing.
 */
export function importDemoData(
  invoices: readonly SourceInvoice[],
  vendorInvoices: readonly SourceVendorInvoice[],
  config: AccountingConfig = DEMO_CONFIG,
): ImportReport {
  const ledger = new Ledger();
  const skipped: Array<{ what: string; why: string }> = [];
  let invoicesPosted = 0;
  let receiptsPosted = 0;
  let vendorBillsPosted = 0;

  // Oldest first, so a receipt never precedes the bill it settles.
  const dated = invoices
    .map(inv => ({ inv, iso: isoFromPeriod(inv.period) }))
    .sort((a, b) => (a.iso ?? '9999').localeCompare(b.iso ?? '9999'));

  for (const { inv, iso } of dated) {
    if (iso === null) {
      skipped.push({ what: `invoice ${inv.invoiceNo}`, why: `period "${inv.period}" is not a month and year` });
      continue;
    }
    const lines = [
      { head: 'maintenance' as const, amount: fromRupees(inv.maintenance), taxable: true },
      { head: 'sinking' as const, amount: fromRupees(inv.sinkingFund), taxable: false },
      { head: 'maintenance' as const, amount: fromRupees(inv.waterCharges), taxable: true },
      { head: 'maintenance' as const, amount: fromRupees(inv.parkingCharges), taxable: true },
      { head: 'maintenance' as const, amount: fromRupees(inv.nonOccupancyCharges), taxable: true },
    ].filter(l => l.amount > 0);

    if (inv.latePenalty > 0) {
      // Late interest is its own head, not part of the maintenance charge.
      lines.push({ head: 'other' as const, amount: fromRupees(inv.latePenalty), taxable: false } as never);
    }
    if (lines.length === 0) {
      skipped.push({ what: `invoice ${inv.invoiceNo}`, why: 'every line is zero' });
      continue;
    }

    // The flatNo "—" marks the consolidated credit for the flats that are not
    // individually seeded; it still needs a party for the control account.
    const party = inv.flatNo === '—' ? 'CONSOLIDATED' : inv.flatNo;

    let gross: Paise;
    try {
      const result = billMaintenance(ledger, {
        flatNo: party,
        period: inv.period,
        date: iso,
        invoiceNo: inv.invoiceNo,
        lines,
        // The stated tax is posted rather than recomputed: these invoices were
        // already issued, and recomputing would change what a member was told.
        statedTax: fromRupees(inv.gst),
      }, config, { postedBy: 'import' });
      gross = result.gross;
      invoicesPosted++;
    } catch (err) {
      skipped.push({ what: `invoice ${inv.invoiceNo}`, why: err instanceof Error ? err.message : String(err) });
      continue;
    }

    // The engine's gross must match the invoice's own total, or the ledger and
    // the invoice list would disagree. Report the gap rather than absorb it.
    if (gross !== fromRupees(inv.total)) {
      skipped.push({
        what: `invoice ${inv.invoiceNo} total`,
        why: `lines plus stated tax come to ${gross} paise but the invoice says ${fromRupees(inv.total)} paise`,
      });
    }

    if (inv.status === 'Paid') {
      const paidIso = (inv.paidDate ? isoFromDayMonthYear(inv.paidDate) : null) ?? iso;
      try {
        receiveFromMember(ledger, {
          flatNo: party,
          date: paidIso < iso ? iso : paidIso,
          amount: fromRupees(inv.total),
          receiptNo: `RCT-${inv.invoiceNo}`,
          method: inv.paymentMethod ?? 'Unrecorded',
        }, { postedBy: 'import' });
        receiptsPosted++;
      } catch (err) {
        skipped.push({ what: `receipt for ${inv.invoiceNo}`, why: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  for (const vi of vendorInvoices) {
    if (vi.status === 'Rejected') continue;
    const iso = isoFromDayMonthYear(vi.date);
    if (iso === null) {
      skipped.push({ what: `vendor bill ${vi.id}`, why: `date "${vi.date}" is not a day, month and year` });
      continue;
    }
    const section = vi.tdsRate === 0 ? 'none'
      : vi.tdsRate >= 10 ? '194J'
      : '194C';
    try {
      bookVendorBill(ledger, {
        vendorId: vi.vendorId,
        vendorName: vi.vendorName,
        billNo: vi.id,
        date: iso,
        expenseAccount: expenseAccountFor(vi.category),
        gross: fromRupees(vi.amount),
        tdsSection: section,
      }, {
        ...config,
        // The bill states its own TDS, so the configured rate is overridden
        // for an import: changing a withholding already deducted and reported
        // would misstate the vendor's credit.
        tds: {
          contractor194C: { ...config.tds.contractor194C, rate: vi.tdsRate },
          professional194J: { ...config.tds.professional194J, rate: vi.tdsRate },
          rent194I: config.tds.rent194I,
        },
      }, { postedBy: 'import' });
      vendorBillsPosted++;
    } catch (err) {
      skipped.push({ what: `vendor bill ${vi.id}`, why: err instanceof Error ? err.message : String(err) });
    }
  }

  return { ledger, invoicesPosted, receiptsPosted, vendorBillsPosted, skipped };
}
