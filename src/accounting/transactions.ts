/**
 * Business transactions: the only sanctioned way to write to the ledger.
 *
 * Each function builds a complete, balanced entry and hands it to
 * `ledger.post`, which validates it again. Callers never assemble postings by
 * hand, so the mistakes the demo made — a vendor bill that books no expense, a
 * part payment that closes the invoice — cannot be expressed here.
 *
 * Every function takes an explicit idempotency key derived from the business
 * event, so re-running a monthly job is safe: the second attempt is rejected.
 */

import { Paise, allocate, assertPositive, formatRupees, percentOf, sum } from './money';
import { planAllocation } from './allocation';
import { requireIsoDate } from './clock';
import { A, ReceiptHead, receiptHead } from './accounts';
import { Ledger, JournalEntry, Posting, PostingError, credit, debit } from './journal';
import { AccountingConfig } from './config';

export interface Actor {
  /** Who is posting. Recorded on the entry; never defaulted. */
  readonly postedBy: string;
}

// --- Maintenance billing --------------------------------------------------

export interface BillLine {
  readonly head: ReceiptHead;
  /** Amount before tax, in paise. */
  readonly amount: Paise;
  /** Whether this line is taxable. Set from the config, not guessed per line. */
  readonly taxable: boolean;
}

export interface MaintenanceBill {
  readonly flatNo: string;
  readonly period: string;
  readonly date: string;
  readonly lines: readonly BillLine[];
  readonly invoiceNo: string;
  /**
   * Tax as stated on an already-issued invoice, used only when importing
   * history. Recomputing tax on a document the association has already sent
   * would silently change what a member was billed, so the stated figure is
   * posted instead. Leave unset for new billing, where the engine computes it.
   */
  readonly statedTax?: Paise;
}

export interface BillResult {
  readonly entry: JournalEntry;
  readonly taxableValue: Paise;
  readonly cgst: Paise;
  readonly sgst: Paise;
  readonly gross: Paise;
}

/**
 * Raises a maintenance bill: debit the member's receivable with the gross,
 * credit each head's income and the two GST accounts.
 *
 * GST is computed once over the taxable lines and split by `allocate`, so CGST
 * plus SGST always equals the total tax exactly rather than drifting by a
 * paisa when the tax is odd.
 */
export function billMaintenance(
  ledger: Ledger,
  bill: MaintenanceBill,
  config: AccountingConfig,
  actor: Actor,
): BillResult {
  if (bill.lines.length === 0) {
    throw new PostingError(`Bill ${bill.invoiceNo} has no lines`);
  }
  for (const line of bill.lines) {
    assertPositive(line.amount, `line for ${line.head}`);
  }

  const taxableValue = config.gstOnMaintenance
    ? sum(bill.lines.filter(l => l.taxable).map(l => l.amount))
    : 0;
  const tax = bill.statedTax !== undefined
    ? bill.statedTax
    : taxableValue === 0 ? 0 : percentOf(taxableValue, config.gst.rate);
  const [cgst, sgst] = tax === 0 ? [0, 0] : allocate(tax, [1, 1]);
  const gross = sum(bill.lines.map(l => l.amount)) + tax;

  requireIsoDate(bill.date, `billing date for ${bill.invoiceNo}`);

  const postings: Posting[] = [
    // docRef is what makes the invoice's own balance readable later, and
    // therefore what lets its status be derived rather than stored.
    debit(A.MAINTENANCE_RECEIVABLE, gross, bill.flatNo, `${bill.invoiceNo} ${bill.period}`, bill.invoiceNo),
  ];

  for (const line of bill.lines) {
    const head = receiptHead(line.head);
    // Where the association does not route a fund contribution through income,
    // the credit goes straight to the fund. Which of the two applies is a
    // config decision, documented in config.ts, not a choice made here.
    const target = !config.sinkingFundThroughIncome && head.fund
      ? head.fund
      : head.income;
    postings.push(credit(target, line.amount, undefined, head.label));
  }
  if (cgst > 0) postings.push(credit(A.CGST_OUTPUT, cgst));
  if (sgst > 0) postings.push(credit(A.SGST_OUTPUT, sgst));

  const entry = ledger.post({
    date: bill.date,
    narration: `Maintenance bill ${bill.invoiceNo} — flat ${bill.flatNo}, ${bill.period}`,
    source: { kind: 'maintenance-billing', ref: bill.invoiceNo },
    postings,
    idempotencyKey: `bill:${bill.flatNo}:${bill.period}`,
    postedBy: actor.postedBy,
  });

  return { entry, taxableValue, cgst, sgst, gross };
}

// --- Member receipts ------------------------------------------------------

export interface ReceiptInput {
  readonly flatNo: string;
  readonly date: string;
  readonly amount: Paise;
  readonly receiptNo: string;
  readonly method: string;
  readonly bankAccount?: string;
  /**
   * Settle one named invoice rather than the oldest open ones. What a member
   * paying a specific bill out of order needs.
   */
  readonly against?: string;
}

export interface ReceiptResult {
  readonly entry: JournalEntry;
  /** Applied against outstanding receivable. */
  readonly appliedToDues: Paise;
  /** Anything beyond the outstanding dues, held as an advance. */
  readonly heldAsAdvance: Paise;
  /** Receivable still outstanding for this flat after the receipt. */
  readonly outstandingAfter: Paise;
  /** Which invoices the receipt was applied to, and for how much. */
  readonly allocations: ReadonlyArray<{ docRef: string; amount: Paise }>;
}

/**
 * Records a receipt from a member, part payment included.
 *
 * The amount is applied against the flat's outstanding receivable; whatever
 * exceeds it is credited to member advances rather than leaving the receivable
 * with a credit balance. Nothing about this marks an invoice settled — the
 * receivable balance is the single source of truth for what is still owed,
 * which is the defect this replaces.
 */
export function receiveFromMember(
  ledger: Ledger,
  input: ReceiptInput,
  actor: Actor,
): ReceiptResult {
  assertPositive(input.amount, 'receipt amount');
  requireIsoDate(input.date, `receipt date for ${input.receiptNo}`);
  const bank = input.bankAccount ?? A.BANK_OPERATING;

  const outstanding = ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, {
    party: input.flatNo,
    to: input.date,
  });

  // Allocated invoice by invoice, oldest first, rather than netted against the
  // flat's total. Without the per-invoice split no invoice could say how much
  // of it was settled, which is what forced the demo to call any payment
  // "Paid".
  const plan = planAllocation(ledger, {
    flatNo: input.flatNo,
    amount: input.amount,
    asAt: input.date,
    against: input.against,
  });

  const appliedToDues = plan.totalAllocated;
  const heldAsAdvance = plan.advance;

  const postings: Posting[] = [debit(bank, input.amount, undefined, input.method, input.receiptNo)];
  for (const allocation of plan.allocations) {
    postings.push(credit(
      A.MAINTENANCE_RECEIVABLE, allocation.amount, input.flatNo,
      `${input.receiptNo} against ${allocation.docRef}`, allocation.docRef,
    ));
  }
  if (heldAsAdvance > 0) {
    postings.push(credit(
      A.MEMBER_ADVANCE, heldAsAdvance, input.flatNo,
      `Advance on ${input.receiptNo}`, input.receiptNo,
    ));
  }

  const settled = plan.allocations.map(a => a.docRef).join(', ');
  const entry = ledger.post({
    date: input.date,
    narration:
      `Receipt ${input.receiptNo} — flat ${input.flatNo} via ${input.method}` +
      (settled !== '' ? ` against ${settled}` : '') +
      (heldAsAdvance > 0 ? ` (${formatRupees(heldAsAdvance)} held as advance)` : ''),
    source: { kind: 'member-receipt', ref: input.receiptNo },
    postings,
    idempotencyKey: `receipt:${input.receiptNo}`,
    postedBy: actor.postedBy,
  });

  return {
    entry,
    appliedToDues,
    heldAsAdvance,
    outstandingAfter: outstanding - appliedToDues,
    allocations: plan.allocations.map(a => ({ docRef: a.docRef, amount: a.amount })),
  };
}

/**
 * Applies a member's existing advance against their outstanding dues. Used
 * when a bill is raised for a flat that paid ahead.
 */
export function applyAdvance(
  ledger: Ledger,
  input: { flatNo: string; date: string; upTo?: Paise; ref: string; against?: string },
  actor: Actor,
): {
  entry: JournalEntry | null;
  applied: Paise;
  allocations: ReadonlyArray<{ docRef: string; amount: Paise }>;
} {
  requireIsoDate(input.date, `advance application date for ${input.ref}`);
  const advance = ledger.balanceOf(A.MEMBER_ADVANCE, { party: input.flatNo, to: input.date });
  if (advance <= 0) return { entry: null, applied: 0, allocations: [] };

  const cap = input.upTo === undefined ? advance : Math.min(advance, input.upTo);
  if (cap <= 0) return { entry: null, applied: 0, allocations: [] };

  // Allocated invoice by invoice, exactly as a cash receipt is, so applying an
  // advance leaves the same trail and the same derived statuses.
  const plan = planAllocation(ledger, {
    flatNo: input.flatNo,
    amount: cap,
    asAt: input.date,
    against: input.against,
  });
  if (plan.totalAllocated === 0) return { entry: null, applied: 0, allocations: [] };

  const postings: Posting[] = [
    debit(A.MEMBER_ADVANCE, plan.totalAllocated, input.flatNo, input.ref, input.ref),
  ];
  for (const allocation of plan.allocations) {
    postings.push(credit(
      A.MAINTENANCE_RECEIVABLE, allocation.amount, input.flatNo,
      `${input.ref} against ${allocation.docRef}`, allocation.docRef,
    ));
  }

  const entry = ledger.post({
    date: input.date,
    narration:
      `Advance applied — flat ${input.flatNo} against ` +
      `${plan.allocations.map(a => a.docRef).join(', ')} (${input.ref})`,
    source: { kind: 'advance-adjustment', ref: input.ref },
    postings,
    idempotencyKey: `advance-apply:${input.ref}`,
    postedBy: actor.postedBy,
  });
  return {
    entry,
    applied: plan.totalAllocated,
    allocations: plan.allocations.map(a => ({ docRef: a.docRef, amount: a.amount })),
  };
}

// --- Vendor bills ---------------------------------------------------------

export type TdsSection = '194C' | '194J' | '194I' | 'none';

const TDS_ACCOUNT: Record<Exclude<TdsSection, 'none'>, string> = {
  '194C': A.TDS_PAYABLE_194C,
  '194J': A.TDS_PAYABLE_194J,
  '194I': A.TDS_PAYABLE_194I,
};

export interface VendorBillInput {
  readonly vendorId: string;
  readonly vendorName: string;
  readonly billNo: string;
  readonly date: string;
  /** Expenditure account the cost belongs to. */
  readonly expenseAccount: string;
  /** Gross amount before TDS, in paise. */
  readonly gross: Paise;
  readonly tdsSection: TdsSection;
  /** Input GST, where the association can claim it. */
  readonly inputGst?: Paise;
}

export interface VendorBillResult {
  readonly entry: JournalEntry;
  readonly tdsAmount: Paise;
  readonly netPayable: Paise;
}

/**
 * Books a vendor bill: debit the expense, credit the payable net of tax and
 * credit the TDS withheld.
 *
 * Booking and paying are separate transactions. The demo collapsed them, which
 * is why approving a bill appeared to pay it; here `bookVendorBill` leaves a
 * payable standing and only `payVendorBill` touches the bank.
 */
export function bookVendorBill(
  ledger: Ledger,
  input: VendorBillInput,
  config: AccountingConfig,
  actor: Actor,
): VendorBillResult {
  assertPositive(input.gross, 'vendor bill gross');

  const rate = input.tdsSection === 'none'
    ? 0
    : input.tdsSection === '194C' ? config.tds.contractor194C.rate
    : input.tdsSection === '194J' ? config.tds.professional194J.rate
    : config.tds.rent194I.rate;

  const tdsAmount = rate === 0 ? 0 : percentOf(input.gross, rate);
  if (tdsAmount > input.gross) {
    throw new PostingError(
      `TDS ${tdsAmount} exceeds the bill gross ${input.gross} for ${input.billNo}`,
    );
  }
  const inputGst = input.inputGst ?? 0;
  const netPayable = input.gross - tdsAmount;

  requireIsoDate(input.date, `vendor bill date for ${input.billNo}`);

  const postings: Posting[] = [
    debit(input.expenseAccount, input.gross - inputGst, undefined, input.billNo, input.billNo),
  ];
  if (inputGst > 0) {
    postings.push(debit(A.GST_INPUT_CREDIT, inputGst, undefined, input.billNo, input.billNo));
  }
  postings.push(credit(A.VENDOR_PAYABLE, netPayable, input.vendorId, input.billNo, input.billNo));
  if (tdsAmount > 0) {
    postings.push(credit(
      TDS_ACCOUNT[input.tdsSection as Exclude<TdsSection, 'none'>], tdsAmount, undefined,
      `${input.tdsSection} on ${input.billNo}`, input.billNo,
    ));
  }

  const entry = ledger.post({
    date: input.date,
    narration: `Vendor bill ${input.billNo} — ${input.vendorName}`,
    source: { kind: 'vendor-bill', ref: input.billNo },
    postings,
    idempotencyKey: `vendor-bill:${input.vendorId}:${input.billNo}`,
    postedBy: actor.postedBy,
  });

  return { entry, tdsAmount, netPayable };
}

/** Pays a vendor, clearing the payable. Part payment is allowed. */
export function payVendorBill(
  ledger: Ledger,
  input: {
    vendorId: string; vendorName: string; date: string; amount: Paise;
    paymentRef: string; bankAccount?: string;
    /** The bill being settled, so the payable can be read per bill. */
    againstBillNo?: string;
  },
  actor: Actor,
): { entry: JournalEntry; payableAfter: Paise } {
  assertPositive(input.amount, 'vendor payment');
  requireIsoDate(input.date, `payment date for ${input.paymentRef}`);
  const bank = input.bankAccount ?? A.BANK_OPERATING;

  const payable = ledger.balanceOf(A.VENDOR_PAYABLE, { party: input.vendorId, to: input.date });
  if (input.amount > payable) {
    throw new PostingError(
      `Payment of ${formatRupees(input.amount)} to ${input.vendorName} exceeds the ` +
      `outstanding payable of ${formatRupees(payable)}. Book the bill first.`,
    );
  }
  if (input.againstBillNo !== undefined) {
    const billOutstanding = ledger.balanceOf(A.VENDOR_PAYABLE, {
      party: input.vendorId, to: input.date, docRef: input.againstBillNo,
    });
    if (input.amount > billOutstanding) {
      throw new PostingError(
        `Payment of ${formatRupees(input.amount)} exceeds the ${formatRupees(billOutstanding)} ` +
        `outstanding on bill ${input.againstBillNo}.`,
      );
    }
  }

  const entry = ledger.post({
    date: input.date,
    narration:
      `Payment ${input.paymentRef} to ${input.vendorName}` +
      (input.againstBillNo !== undefined ? ` against ${input.againstBillNo}` : ''),
    source: { kind: 'vendor-payment', ref: input.paymentRef },
    postings: [
      debit(A.VENDOR_PAYABLE, input.amount, input.vendorId, input.paymentRef, input.againstBillNo),
      credit(bank, input.amount, undefined, input.paymentRef, input.againstBillNo),
    ],
    idempotencyKey: `vendor-payment:${input.paymentRef}`,
    postedBy: actor.postedBy,
  });

  return { entry, payableAfter: payable - input.amount };
}

/** Remits withheld TDS to the government, clearing the liability. */
export function remitTds(
  ledger: Ledger,
  input: {
    section: Exclude<TdsSection, 'none'>; date: string; amount: Paise;
    challanNo: string; bankAccount?: string;
  },
  actor: Actor,
): { entry: JournalEntry; liabilityAfter: Paise } {
  assertPositive(input.amount, 'TDS remittance');
  const code = TDS_ACCOUNT[input.section];
  const liability = ledger.balanceOf(code, { to: input.date });
  if (input.amount > liability) {
    throw new PostingError(
      `Remitting ${input.amount} paise exceeds the ${input.section} liability of ${liability} paise`,
    );
  }

  const entry = ledger.post({
    date: input.date,
    narration: `TDS ${input.section} remitted — challan ${input.challanNo}`,
    source: { kind: 'tds-remittance', ref: input.challanNo },
    postings: [
      debit(code, input.amount, undefined, input.challanNo),
      credit(input.bankAccount ?? A.BANK_OPERATING, input.amount, undefined, input.challanNo),
    ],
    idempotencyKey: `tds-remittance:${input.section}:${input.challanNo}`,
    postedBy: actor.postedBy,
  });
  return { entry, liabilityAfter: liability - input.amount };
}

/** Remits collected GST, clearing CGST and SGST together. */
export function remitGst(
  ledger: Ledger,
  input: { date: string; cgst: Paise; sgst: Paise; challanNo: string; bankAccount?: string },
  actor: Actor,
): JournalEntry {
  if (input.cgst === 0 && input.sgst === 0) {
    throw new PostingError('A GST remittance must move something');
  }
  const postings: Posting[] = [];
  if (input.cgst > 0) postings.push(debit(A.CGST_OUTPUT, input.cgst, undefined, input.challanNo));
  if (input.sgst > 0) postings.push(debit(A.SGST_OUTPUT, input.sgst, undefined, input.challanNo));
  postings.push(credit(input.bankAccount ?? A.BANK_OPERATING, input.cgst + input.sgst, undefined, input.challanNo));

  return ledger.post({
    date: input.date,
    narration: `GST remitted — challan ${input.challanNo}`,
    source: { kind: 'gst-remittance', ref: input.challanNo },
    postings,
    idempotencyKey: `gst-remittance:${input.challanNo}`,
    postedBy: actor.postedBy,
  });
}

// --- Funds ----------------------------------------------------------------

/**
 * Moves cash from the operating account into the sinking fund bank account.
 *
 * This is a transfer between two assets. It does not create the fund — the
 * fund liability arises when a contribution is billed — which is the
 * confusion in the demo's seed row `j-5`.
 */
export function transferToSinkingFundBank(
  ledger: Ledger,
  input: { date: string; amount: Paise; ref: string },
  actor: Actor,
): JournalEntry {
  assertPositive(input.amount, 'fund transfer');
  return ledger.post({
    date: input.date,
    narration: `Transfer to sinking fund bank account (${input.ref})`,
    source: { kind: 'fund-transfer', ref: input.ref },
    postings: [
      debit(A.BANK_SINKING, input.amount, undefined, input.ref),
      credit(A.BANK_OPERATING, input.amount, undefined, input.ref),
    ],
    idempotencyKey: `fund-transfer:${input.ref}`,
    postedBy: actor.postedBy,
  });
}

/** Places sinking fund cash into a fixed deposit. */
export function placeFixedDeposit(
  ledger: Ledger,
  input: { date: string; amount: Paise; fdRef: string },
  actor: Actor,
): JournalEntry {
  assertPositive(input.amount, 'fixed deposit');
  return ledger.post({
    date: input.date,
    narration: `Fixed deposit placed — ${input.fdRef}`,
    source: { kind: 'fund-transfer', ref: input.fdRef },
    postings: [
      debit(A.FD_SINKING, input.amount, undefined, input.fdRef),
      credit(A.BANK_SINKING, input.amount, undefined, input.fdRef),
    ],
    idempotencyKey: `fd-place:${input.fdRef}`,
    postedBy: actor.postedBy,
  });
}

/**
 * Accrues interest on a deposit. Credited to other receipts as income, which
 * is the ordinary treatment; whether fund interest should instead be credited
 * directly to the fund is one of the questions in config.ts.
 */
export function accrueFdInterest(
  ledger: Ledger,
  input: { date: string; amount: Paise; fdRef: string },
  actor: Actor,
): JournalEntry {
  assertPositive(input.amount, 'interest accrual');
  return ledger.post({
    date: input.date,
    narration: `Interest accrued on ${input.fdRef}`,
    source: { kind: 'fd-interest', ref: input.fdRef },
    postings: [
      debit(A.ACCRUED_FD_INTEREST, input.amount, undefined, input.fdRef),
      credit(A.INC_OTHER_RECEIPTS, input.amount, undefined, `Interest on ${input.fdRef}`),
    ],
    idempotencyKey: `fd-interest:${input.fdRef}:${input.date}`,
    postedBy: actor.postedBy,
  });
}

// --- Opening balances -----------------------------------------------------

/**
 * Posts an opening trial balance as one entry. The caller supplies both sides;
 * the engine will not invent a balancing figure, so an opening position that
 * does not balance is rejected rather than plugged to a reserve.
 */
export function postOpeningBalances(
  ledger: Ledger,
  input: {
    date: string;
    debits: ReadonlyArray<{ account: string; amount: Paise; party?: string }>;
    credits: ReadonlyArray<{ account: string; amount: Paise; party?: string }>;
  },
  actor: Actor,
): JournalEntry {
  const postings: Posting[] = [
    ...input.debits.map(d => debit(d.account, d.amount, d.party, 'Opening balance')),
    ...input.credits.map(c => credit(c.account, c.amount, c.party, 'Opening balance')),
  ];
  return ledger.post({
    date: input.date,
    narration: `Opening balances as at ${input.date}`,
    source: { kind: 'opening-balance' },
    postings,
    idempotencyKey: `opening:${input.date}`,
    postedBy: actor.postedBy,
  });
}

// --- Member position ------------------------------------------------------

export interface MemberPosition {
  readonly flatNo: string;
  /** Positive means the member owes the association. */
  readonly dues: Paise;
  /** Positive means the association holds the member's money. */
  readonly advance: Paise;
  /** Dues net of any advance held. */
  readonly net: Paise;
}

export function memberPosition(ledger: Ledger, flatNo: string, asAt?: string): MemberPosition {
  const dues = ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: flatNo, to: asAt });
  const advance = ledger.balanceOf(A.MEMBER_ADVANCE, { party: flatNo, to: asAt });
  return { flatNo, dues, advance, net: dues - advance };
}

export function vendorPosition(ledger: Ledger, vendorId: string, asAt?: string): Paise {
  return ledger.balanceOf(A.VENDOR_PAYABLE, { party: vendorId, to: asAt });
}
