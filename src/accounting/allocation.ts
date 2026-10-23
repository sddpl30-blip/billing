/**
 * Allocating receipts to invoices, and deriving an invoice's status from them.
 *
 * The demo marked an invoice `Paid` the moment any amount was tendered, so a
 * ₹2,000 payment closed a ₹10,620 bill and the ledger and the invoice list
 * disagreed by ₹8,620 with nothing recording why. Here an invoice's status is
 * not stored at all: it is read back from what the ledger says is still
 * outstanding against that invoice.
 */

import { Paise, assertPositive, sum } from './money';
import { A } from './accounts';
import { Ledger } from './journal';
import { requireIsoDate } from './clock';

export class AllocationError extends Error {}

/** What a receipt is applied to. */
export interface Allocation {
  readonly docRef: string;
  readonly amount: Paise;
}

export interface AllocationPlan {
  readonly allocations: readonly Allocation[];
  /** Anything beyond the outstanding dues, to be held as an advance. */
  readonly advance: Paise;
  readonly totalAllocated: Paise;
}

export interface OutstandingInvoice {
  readonly docRef: string;
  /** What the invoice was raised for. */
  readonly gross: Paise;
  /** What is still owed on it. */
  readonly outstanding: Paise;
  /** The date it was raised, which sets the allocation order. */
  readonly raisedOn: string;
  readonly dueOn?: string;
}

/**
 * What each of a flat's invoices still owes, oldest first.
 *
 * Read from the receivable control account by document, so it cannot drift
 * from the books the way a stored status does.
 */
export function outstandingInvoices(
  ledger: Ledger,
  flatNo: string,
  opts: { asAt?: string } = {},
): readonly OutstandingInvoice[] {
  const balances = ledger.docLedger(A.MAINTENANCE_RECEIVABLE, {
    party: flatNo,
    to: opts.asAt,
  });

  // The gross and the raising date come from the entry that raised the invoice.
  const raised = new Map<string, { gross: Paise; raisedOn: string }>();
  for (const entry of ledger.all()) {
    if (entry.source.kind !== 'maintenance-billing') continue;
    if (opts.asAt !== undefined && entry.date > opts.asAt) continue;
    for (const p of entry.postings) {
      if (p.accountCode !== A.MAINTENANCE_RECEIVABLE || !p.docRef) continue;
      if (p.party !== flatNo) continue;
      const existing = raised.get(p.docRef);
      raised.set(p.docRef, {
        gross: (existing?.gross ?? 0) + p.debit - p.credit,
        raisedOn: existing?.raisedOn ?? entry.date,
      });
    }
  }

  const rows: OutstandingInvoice[] = [];
  for (const [docRef, outstanding] of balances) {
    const origin = raised.get(docRef);
    rows.push({
      docRef,
      gross: origin?.gross ?? outstanding,
      outstanding,
      raisedOn: origin?.raisedOn ?? '',
    });
  }

  // Oldest first, then by document reference so the order is deterministic
  // when two invoices share a date.
  return rows.sort((a, b) =>
    (a.raisedOn < b.raisedOn ? -1 : a.raisedOn > b.raisedOn ? 1 : a.docRef.localeCompare(b.docRef)));
}

/**
 * Plans how a receipt is applied: oldest invoice first, remainder to advance.
 *
 * Oldest-first is the convention an association's members expect and the one
 * that keeps ageing honest; a specific invoice can be targeted with
 * `against`, which is what a member paying one bill out of order needs.
 */
export function planAllocation(
  ledger: Ledger,
  input: { flatNo: string; amount: Paise; asAt?: string; against?: string },
): AllocationPlan {
  assertPositive(input.amount, 'receipt amount');

  const open = outstandingInvoices(ledger, input.flatNo, { asAt: input.asAt })
    .filter(i => i.outstanding > 0);

  if (input.against !== undefined) {
    const target = open.find(i => i.docRef === input.against);
    if (!target) {
      throw new AllocationError(
        `Flat ${input.flatNo} has nothing outstanding against ${input.against}, ` +
        `so a receipt cannot be allocated to it.`,
      );
    }
    const applied = Math.min(target.outstanding, input.amount);
    return {
      allocations: [{ docRef: target.docRef, amount: applied }],
      advance: input.amount - applied,
      totalAllocated: applied,
    };
  }

  const allocations: Allocation[] = [];
  let left = input.amount;
  for (const invoice of open) {
    if (left === 0) break;
    const applied = Math.min(invoice.outstanding, left);
    if (applied > 0) {
      allocations.push({ docRef: invoice.docRef, amount: applied });
      left -= applied;
    }
  }

  const totalAllocated = sum(allocations.map(a => a.amount));
  if (totalAllocated + left !== input.amount) {
    // Defensive: the plan must account for every paisa of the receipt.
    throw new AllocationError(
      `Allocation lost money: ${totalAllocated} allocated plus ${left} unallocated ` +
      `is not the ${input.amount} received.`,
    );
  }

  return { allocations, advance: left, totalAllocated };
}

/** The status an invoice actually has, given what the ledger says it owes. */
export type DerivedStatus = 'Pending' | 'Partly paid' | 'Paid' | 'Overdue' | 'Cancelled';

export interface InvoiceStatusInput {
  readonly docRef: string;
  readonly gross: Paise;
  readonly outstanding: Paise;
  readonly dueOn?: string;
  readonly cancelled?: boolean;
}

/**
 * Derives an invoice's status. Never stored, always computed.
 *
 * `Partly paid` is a state the demo had no way to express, which is why a part
 * payment had to be rounded up to `Paid`.
 */
export function deriveStatus(input: InvoiceStatusInput, asAt: string): DerivedStatus {
  requireIsoDate(asAt, 'as-at date');
  if (input.cancelled) return 'Cancelled';
  if (input.outstanding <= 0) return 'Paid';

  const overdue = input.dueOn !== undefined && input.dueOn < asAt;
  if (input.outstanding < input.gross) {
    // Part paid and past due is still worth chasing, but saying "Overdue"
    // hides that money came in. The ageing report uses `dueOn` directly.
    return 'Partly paid';
  }
  return overdue ? 'Overdue' : 'Pending';
}

export interface MemberLedgerPosition {
  readonly flatNo: string;
  readonly invoices: readonly OutstandingInvoice[];
  /** Total still owed across every invoice. */
  readonly totalDues: Paise;
  /** Credit held on account. */
  readonly advance: Paise;
  /** Dues net of the advance held. */
  readonly net: Paise;
}

/**
 * A flat's full position: every open invoice, plus the advance held.
 *
 * The advance comes off the member advance liability rather than being
 * inferred from a negative receivable, which is the arrangement that keeps the
 * receivable from ever going credit-side.
 */
export function memberLedgerPosition(
  ledger: Ledger,
  flatNo: string,
  opts: { asAt?: string } = {},
): MemberLedgerPosition {
  const invoices = outstandingInvoices(ledger, flatNo, { asAt: opts.asAt });
  const totalDues = ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: flatNo, to: opts.asAt });
  const advance = ledger.balanceOf(A.MEMBER_ADVANCE, { party: flatNo, to: opts.asAt });
  return { flatNo, invoices, totalDues, advance, net: totalDues - advance };
}

/** Receivable ageing for a flat, in the buckets a committee asks for. */
export interface AgeingBucket {
  readonly label: string;
  readonly fromDays: number;
  readonly toDays: number | null;
  readonly amount: Paise;
}

export function ageing(
  ledger: Ledger,
  asAt: string,
  dueDateOf: (docRef: string) => string | undefined,
): readonly AgeingBucket[] {
  requireIsoDate(asAt, 'as-at date');
  const buckets: Array<{ label: string; fromDays: number; toDays: number | null; amount: Paise }> = [
    { label: 'Not yet due', fromDays: -Infinity as unknown as number, toDays: 0, amount: 0 },
    { label: '1–30 days', fromDays: 1, toDays: 30, amount: 0 },
    { label: '31–60 days', fromDays: 31, toDays: 60, amount: 0 },
    { label: '61–90 days', fromDays: 61, toDays: 90, amount: 0 },
    { label: 'Over 90 days', fromDays: 91, toDays: null, amount: 0 },
  ];

  const balances = ledger.docLedger(A.MAINTENANCE_RECEIVABLE, { to: asAt });
  for (const [docRef, outstanding] of balances) {
    if (outstanding <= 0) continue;
    const due = dueDateOf(docRef);
    const overdueBy = due === undefined
      ? 0
      : Math.round((Date.parse(asAt + 'T00:00:00Z') - Date.parse(due + 'T00:00:00Z')) / 86400000);

    const bucket = overdueBy <= 0 ? buckets[0]
      : overdueBy <= 30 ? buckets[1]
      : overdueBy <= 60 ? buckets[2]
      : overdueBy <= 90 ? buckets[3]
      : buckets[4];
    bucket.amount += outstanding;
  }

  return buckets.map(b => ({
    label: b.label,
    fromDays: Number.isFinite(b.fromDays) ? b.fromDays : 0,
    toDays: b.toDays,
    amount: b.amount,
  }));
}
