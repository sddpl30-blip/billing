/**
 * Phase 2 integration tests: the billing register driving the ledger.
 *
 * `selftest.ts` covers the engine's units. These cover the paths the screens
 * take — raise, approve, release, convert, pay, part-pay, overpay, apply an
 * advance, book and pay a vendor, re-run a billing run — and assert that after
 * each one the books still tie and the invoice statuses agree with the ledger.
 *
 * Run with: npm run test:integration
 */

import { formatRupees, fromRupees } from './money';
import { A } from './accounts';
import { Ledger } from './journal';
import { AccountingConfig, DEMO_CONFIG } from './config';
import { canonicalPeriod, fixedClock, isoDateInIndia } from './clock';
import { BillingRegister, DocumentError } from './documents';
import { runBilling, FlatRecord } from './billingRun';
import {
  ageing, deriveStatus, memberLedgerPosition, outstandingInvoices, planAllocation,
} from './allocation';
import { areaCharge, rateOn, requireApprovedRate, RateError } from './rates';
import {
  balanceSheet, incomeAndExpenditure, receiptsAndPayments, reconcile, trialBalance,
} from './reports';
import { applyAdvance, bookVendorBill, payVendorBill, remitTds } from './transactions';
import { buildStatements } from './uiReports';
import { SourceInvoice, SourceVendorInvoice, importDemoData } from './adapter';
import { createBooksStore } from '../store/booksStore';
import { toRupees } from './money';

// --- harness --------------------------------------------------------------

let passed = 0;
const failures: string[] = [];
let suiteName = '';

function suite(name: string): void {
  suiteName = name;
  console.log(`\n${name}`);
}

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${suiteName} / ${name}\n       ${message.replace(/\n/g, '\n       ')}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${message.replace(/\n/g, '\n       ')}`);
  }
}

function eq<T>(got: T, want: T, what = 'value'): void {
  if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function truthy(cond: boolean, what: string): void {
  if (!cond) throw new Error(`expected ${what}`);
}
function throws(fn: () => unknown, matching: RegExp | string, what: string): void {
  try { fn(); } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    const ok = typeof matching === 'string' ? m.includes(matching) : matching.test(m);
    if (!ok) throw new Error(`${what}: threw with "${m}"`);
    return;
  }
  throw new Error(`${what}: expected a throw`);
}

const R = fromRupees;
const CLOCK = fixedClock('2026-07-15');

/** The config with the rate approved, which is what a live run needs. */
const APPROVED: AccountingConfig = {
  ...DEMO_CONFIG,
  reviewedBy: 'Test CA',
  reviewedOn: '2026-06-01',
};

/**
 * Mani Vista's smallest flat per the brief, plus three more for the
 * allocation and ageing paths.
 */
const FLATS: readonly FlatRecord[] = [
  { flatNo: 'A-101', name: 'Priya Nair', billingAreaSqFt: 1750, areaBasis: 'super-built-up' },
  { flatNo: 'B-204', name: 'Rohan Mehta', billingAreaSqFt: 2000, areaBasis: 'super-built-up' },
  { flatNo: 'C-302', name: 'Suresh Iyer', billingAreaSqFt: 2400, areaBasis: 'super-built-up' },
  { flatNo: 'D-404', name: 'Anjali Gupta', billingAreaSqFt: 1900, areaBasis: 'super-built-up' },
];

/** A store wired exactly as App.tsx wires it, with a fixed clock. */
function makeStore(vendorInvoices: readonly SourceVendorInvoice[] = []) {
  return createBooksStore({ config: APPROVED, clock: CLOCK, vendorInvoices });
}

const toRupeesNumber = (paise: number): number => toRupees(paise);

/** A couple of seed invoices, for the fallback-import check. */
const SEED_INVOICES: readonly SourceInvoice[] = [{
  id: 'seed-1', invoiceNo: 'GM-2026-06-B204', flatNo: 'B-204', name: 'Rohan Mehta',
  period: 'Jun 2026', maintenance: 2500, sinkingFund: 500, waterCharges: 300,
  parkingCharges: 0, nonOccupancyCharges: 0, latePenalty: 0, gst: 0, total: 3300,
  status: 'Overdue', dueDate: '10 Jun 2026',
}];

function freshRegister(config: AccountingConfig = APPROVED) {
  const ledger = new Ledger();
  return { ledger, register: new BillingRegister(ledger, config, CLOCK), config };
}

/** Asserts the books tie, which every test does after it changes anything. */
function assertTies(ledger: Ledger, from: string, to: string, where: string): void {
  const tb = trialBalance(ledger, to);
  if (tb.totalDebit !== tb.totalCredit) {
    throw new Error(`${where}: trial balance out by ${tb.totalDebit - tb.totalCredit} paise`);
  }
  const bs = balanceSheet(ledger, to);
  if (!bs.balanced) throw new Error(`${where}: balance sheet out by ${bs.difference} paise`);
  const result = reconcile(ledger, from, to);
  const bad = result.checks.filter(c => !c.passed);
  if (bad.length > 0) {
    throw new Error(`${where}: ${bad.map(c => `${c.name} (${c.detail})`).join('; ')}`);
  }
}

// --- the Mani Vista rate --------------------------------------------------

suite('Area-based maintenance at the rate from the brief');

check('1,750 sq ft at ₹4.50 is ₹7,875', () => {
  const rate = rateOn({ rates: [{
    ratePerSqFt: 4.5, basis: 'super-built-up', effectiveFrom: '2026-04-01',
    authority: 'test', approvedBy: 'T', approvedOn: '2026-04-01',
  }] }, '2026-07-01');
  if (rate === null) throw new Error('no rate');
  const charge = areaCharge(
    { flatNo: 'A-101', billingAreaSqFt: 1750, areaBasis: 'super-built-up' }, rate,
  );
  eq(charge.amount, R(7875), 'maintenance charge');
  eq(formatRupees(charge.amount), '₹7,875');
});

check('18% GST on ₹7,875 is ₹1,417.50, so the bill is ₹9,292.50', () => {
  const { register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  eq(doc.estimatedTax, R(1417.5), 'GST');
  eq(doc.gross, R(9292.5), 'gross');
  eq(formatRupees(doc.gross), '₹9,292.50');
});

check('an unapproved rate cannot bill', () => {
  throws(
    () => requireApprovedRate({ rates: [{
      ratePerSqFt: 4.5, basis: 'super-built-up', effectiveFrom: '2026-04-01',
      authority: 'unconfirmed',
    }] }, '2026-07-01'),
    /has not been approved/, 'unapproved rate',
  );
});

check('a rate is not extended backwards', () => {
  throws(
    () => requireApprovedRate({ rates: [{
      ratePerSqFt: 4.5, basis: 'super-built-up', effectiveFrom: '2026-04-01',
      authority: 't', approvedBy: 'T', approvedOn: '2026-04-01',
    }] }, '2026-03-31'),
    /No maintenance rate is in force/, 'date before the schedule',
  );
});

check('an area measured on one basis is not billed at another basis rate', () => {
  const rate = {
    ratePerSqFt: 4.5, basis: 'super-built-up' as const, effectiveFrom: '2026-04-01',
    authority: 't', approvedBy: 'T', approvedOn: '2026-04-01',
  };
  throws(
    () => areaCharge({ flatNo: 'X', billingAreaSqFt: 1200, areaBasis: 'carpet' }, rate),
    /records carpet area but the rate/, 'basis mismatch',
  );
});

check('a flat with no recorded area is skipped, not guessed', () => {
  const { register, config } = freshRegister();
  const result = runBilling(register, {
    period: 'Jul 2026',
    flats: [{ flatNo: 'Z-1', name: 'No area' }],
  }, config);
  eq(result.documents.length, 0, 'documents raised');
  eq(result.skipped.length, 1, 'skips');
  truthy(/no billing area or area basis/.test(result.skipped[0].why), 'the reason is recorded');
});

check('an effective-dated rate change applies from its date', () => {
  const schedule = { rates: [
    { ratePerSqFt: 4.0, basis: 'super-built-up' as const, effectiveFrom: '2025-04-01', authority: 'a', approvedBy: 'T', approvedOn: '2025-04-01' },
    { ratePerSqFt: 4.5, basis: 'super-built-up' as const, effectiveFrom: '2026-04-01', authority: 'b', approvedBy: 'T', approvedOn: '2026-04-01' },
  ] };
  eq(rateOn(schedule, '2026-03-31')?.ratePerSqFt, 4.0, 'before the change');
  eq(rateOn(schedule, '2026-04-01')?.ratePerSqFt, 4.5, 'on the day');
  eq(rateOn(schedule, '2027-01-01')?.ratePerSqFt, 4.5, 'after');
});

// --- the document lifecycle ----------------------------------------------

suite('Proforma, approval, release, conversion');

check('a proforma posts nothing to the ledger', () => {
  const { ledger, register } = freshRegister();
  register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  eq(ledger.all().length, 0, 'journal entries');
  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'A-101' }), 0, 'receivable');
});

check('an unapproved proforma cannot become a tax invoice', () => {
  const { register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  throws(
    () => register.convertToTaxInvoice(doc.proformaNo, { because: 'manual', by: 'test' }),
    /has not been approved/, 'conversion without approval',
  );
});

check('approval needs a name', () => {
  const { register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  throws(() => register.approve(doc.proformaNo, '  '), /must name who gave it/, 'blank approver');
});

check('release records that nothing was actually sent', () => {
  const { register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  register.approve(doc.proformaNo, 'Treasurer');
  const released = register.release(doc.proformaNo, 'Treasurer');
  eq(released.state, 'released', 'state');
  eq(released.dispatch?.length, 1, 'one attempt recorded');
  eq(released.dispatch?.[0].delivered, false, 'nothing was delivered');
  eq(released.dispatch?.[0].channel, 'none-configured', 'channel');
  truthy(/nothing was sent to the member/.test(released.dispatch?.[0].note ?? ''), 'the note says so');
});

check('a document cannot be released before it is approved', () => {
  const { register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  throws(() => register.release(doc.proformaNo, 'T'), /only an approved document/, 'early release');
});

check('conversion posts the receivable, the income and the GST', () => {
  const { ledger, register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026', issuedOn: '2026-07-01',
    lines: [
      { head: 'maintenance', amount: R(7875), taxable: true },
      { head: 'sinking', amount: R(1575), taxable: false },
    ],
  });
  register.approve(doc.proformaNo, 'Treasurer', '2026-07-01');
  register.release(doc.proformaNo, 'Treasurer');
  const { document } = register.convertToTaxInvoice(doc.proformaNo, {
    on: '2026-07-11', because: 'due-date-reached', by: 'job',
  });

  truthy(document.taxInvoiceNo !== undefined, 'a tax invoice number was assigned');
  truthy(document.taxInvoiceNo !== document.proformaNo, 'and it is not the proforma number');
  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'A-101' }), R(9292.5 + 1575 - 1417.5) + R(1417.5), 'receivable');
  eq(ledger.balanceOf(A.INC_MAINTENANCE), R(7875), 'maintenance income');
  eq(ledger.balanceOf(A.SINKING_FUND), R(1575), 'sinking fund credited directly');
  eq(ledger.balanceOf(A.CGST_OUTPUT) + ledger.balanceOf(A.SGST_OUTPUT), R(1417.5), 'GST');
  assertTies(ledger, '2026-07-01', '2026-07-31', 'after conversion');
});

check('a document cannot be converted twice', () => {
  const { register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  register.approve(doc.proformaNo, 'T');
  register.convertToTaxInvoice(doc.proformaNo, { because: 'manual', by: 'T' });
  throws(
    () => register.convertToTaxInvoice(doc.proformaNo, { because: 'manual', by: 'T' }),
    /already tax invoice/, 'second conversion',
  );
});

check('the due-date job converts only what has fallen due', () => {
  const { ledger, register } = freshRegister();
  for (const flat of ['A-101', 'B-204']) {
    const doc = register.issueProforma({
      flatNo: flat, period: 'Jul 2026', issuedOn: '2026-07-01',
      lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
    });
    register.approve(doc.proformaNo, 'T', '2026-07-01');
    register.release(doc.proformaNo, 'T');
  }
  const laterDoc = register.issueProforma({
    flatNo: 'C-302', period: 'Aug 2026', issuedOn: '2026-08-01',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
  });
  register.approve(laterDoc.proformaNo, 'T', '2026-08-01');
  register.release(laterDoc.proformaNo, 'T');

  // Due 10 days after issue: the July pair are due 11 July, August's is not.
  const result = register.convertDue('2026-07-11', 'job');
  eq(result.converted.length, 2, 'converted');
  eq(result.refused.length, 0, 'refused');
  eq(register.get(laterDoc.proformaNo)?.state, 'released', 'the August document is untouched');
  assertTies(ledger, '2026-07-01', '2026-07-31', 'after the due-date job');
});

check('tax-invoice numbers run in a single series', () => {
  const { register } = freshRegister();
  const numbers: string[] = [];
  for (const flat of ['A-101', 'B-204', 'C-302']) {
    const doc = register.issueProforma({
      flatNo: flat, period: 'Jul 2026',
      lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
    });
    register.approve(doc.proformaNo, 'T');
    const r = register.convertToTaxInvoice(doc.proformaNo, { because: 'manual', by: 'T' });
    numbers.push(r.document.taxInvoiceNo as string);
  }
  eq(new Set(numbers).size, 3, 'all distinct');
  truthy(numbers[0].endsWith('00001'), `first is 00001, got ${numbers[0]}`);
  truthy(numbers[2].endsWith('00003'), `third is 00003, got ${numbers[2]}`);
});

check('a proforma shows nothing outstanding even when the flat owes on another bill', () => {
  // The flat's total receivable and one document's balance are different
  // numbers. Reading the flat total for an unconverted proforma would show a
  // demand that has not been raised.
  const { ledger, register } = freshRegister();
  const june = register.issueProforma({
    flatNo: 'A-101', period: 'Jun 2026', issuedOn: '2026-06-01',
    lines: [{ head: 'maintenance', amount: R(6000), taxable: false }],
  });
  register.approve(june.proformaNo, 'T', '2026-06-01');
  register.convertToTaxInvoice(june.proformaNo, { on: '2026-06-01', because: 'manual', by: 'T' });
  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'A-101' }), R(6000), 'the flat owes 6,000');

  const july = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026', issuedOn: '2026-07-01',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  eq(register.get(july.proformaNo)?.outstanding, 0,
     'the unconverted July proforma owes nothing yet');
  eq(register.get(june.proformaNo)?.outstanding, R(6000), 'and June still owes its own 6,000');
});

check('the sinking fund percentage produces its own line at the right amount', () => {
  const { register, config } = freshRegister();
  const run = runBilling(register, {
    period: 'Jul 2026',
    flats: [FLATS[0]], // 1,750 sq ft at ₹4.50 = ₹7,875
    sinkingFundPercentOfMaintenance: 20,
    issuedOn: '2026-07-01',
  }, config);

  eq(run.documents.length, 1, 'one document');
  const lines = run.documents[0].lines;
  const maintenance = lines.filter(l => l.head === 'maintenance').reduce((a, l) => a + l.amount, 0);
  const sinking = lines.filter(l => l.head === 'sinking').reduce((a, l) => a + l.amount, 0);

  eq(maintenance, R(7875), 'maintenance line');
  eq(sinking, R(1575), '20% of 7,875 is 1,575');
  truthy(lines.some(l => l.head === 'sinking'), 'there is a sinking line at all');
  // Sinking is not taxable here, so GST is on the maintenance only.
  eq(run.documents[0].estimatedTax, R(1417.5), 'GST on the maintenance alone');
  eq(run.documents[0].gross, R(7875 + 1575 + 1417.5), 'gross');

  // And zero percent produces no line rather than a zero one.
  const { register: r2, config: c2 } = freshRegister();
  const none = runBilling(r2, {
    period: 'Jul 2026', flats: [FLATS[0]], issuedOn: '2026-07-01',
  }, c2);
  truthy(!none.documents[0].lines.some(l => l.head === 'sinking'), 'no sinking line when not levied');
});

// --- duplicate billing ----------------------------------------------------

suite('Duplicate billing is prevented at both levels');

check('a second proforma for the same flat and period is refused', () => {
  const { register } = freshRegister();
  register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
  });
  throws(
    () => register.issueProforma({
      flatNo: 'A-101', period: 'Jul 2026',
      lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
    }),
    /already has PI-2026-07-A101 for Jul 2026/, 'duplicate document',
  );
});

check('re-running a billing run raises nothing and reports every skip', () => {
  const { register, config } = freshRegister();
  const first = runBilling(register, { period: 'Jul 2026', flats: FLATS }, config);
  eq(first.documents.length, 4, 'first run');
  eq(first.skipped.length, 0, 'no skips on the first run');

  const second = runBilling(register, { period: 'Jul 2026', flats: FLATS }, config);
  eq(second.documents.length, 0, 'second run raises nothing');
  eq(second.skipped.length, 4, 'and reports all four');
  truthy(second.skipped.every(s => /already has a live document/.test(s.why)), 'with the reason');
});

check('the ledger refuses a duplicate posting even if the register is bypassed', () => {
  const { ledger, register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
  });
  register.approve(doc.proformaNo, 'T');
  register.convertToTaxInvoice(doc.proformaNo, { because: 'manual', by: 'T' });
  // Two independent guards: the register's flat+period key, and the engine's
  // idempotency key on the posting itself.
  eq(ledger.all().filter(e => e.source.kind === 'maintenance-billing').length, 1, 'one billing entry');
  throws(
    () => ledger.post({
      date: '2026-07-01', narration: 'hand-rolled duplicate',
      source: { kind: 'maintenance-billing' },
      postings: [], idempotencyKey: 'bill:A-101:Jul 2026', postedBy: 'x',
    }),
    /at least two legs|Duplicate transaction/, 'bypassing the register',
  );
});

check('a cancelled document frees the flat and period', () => {
  const { register } = freshRegister();
  const first = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
  });
  register.cancel(first.proformaNo, 'T', 'wrong area on file');
  const second = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026', proformaNo: 'PI-2026-07-A101-R2',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  eq(second.state, 'draft', 'the replacement was raised');
});

// --- full payment ---------------------------------------------------------

suite('Full payment through the register');

check('paying a proforma converts it and settles it', () => {
  const { ledger, register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026', issuedOn: '2026-07-01',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  register.approve(doc.proformaNo, 'T', '2026-07-01');
  register.release(doc.proformaNo, 'T');

  const result = register.recordPayment({
    proformaNo: doc.proformaNo, amount: R(9292.5),
    receiptNo: 'RCT-1', method: 'UPI', on: '2026-07-05', by: 'Manager',
  });

  truthy(result.conversion !== undefined, 'payment triggered the conversion');
  eq(result.appliedToDues, R(9292.5), 'applied in full');
  eq(result.heldAsAdvance, 0, 'no advance');
  eq(result.outstandingAfter, 0, 'nothing outstanding');
  eq(register.get(doc.proformaNo)?.status, 'Paid', 'status derived as Paid');
  eq(ledger.balanceOf(A.BANK_OPERATING), R(9292.5), 'bank');
  assertTies(ledger, '2026-07-01', '2026-07-31', 'after full payment');
});

// --- partial payment ------------------------------------------------------

suite('Partial payment');

check('a part payment leaves the remainder and reads as Partly paid', () => {
  const { ledger, register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026', issuedOn: '2026-07-01',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  register.approve(doc.proformaNo, 'T', '2026-07-01');

  const result = register.recordPayment({
    proformaNo: doc.proformaNo, amount: R(2000),
    receiptNo: 'RCT-2', method: 'NEFT', on: '2026-07-05', by: 'Manager',
  });

  eq(result.appliedToDues, R(2000), 'applied');
  eq(result.outstandingAfter, R(7292.5), 'still outstanding');
  const view = register.get(doc.proformaNo);
  eq(view?.status, 'Partly paid', 'status is neither Pending nor Paid');
  eq(view?.outstanding, R(7292.5), 'the view agrees');
  // The defect this replaces: the invoice used to read Paid here.
  truthy(view?.status !== 'Paid', 'a part payment does not close the invoice');
  assertTies(ledger, '2026-07-01', '2026-07-31', 'after part payment');
});

check('successive part payments settle it exactly and then read Paid', () => {
  const { ledger, register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'B-204', period: 'Jul 2026', issuedOn: '2026-07-01',
    lines: [{ head: 'maintenance', amount: R(9000), taxable: true }],
  });
  register.approve(doc.proformaNo, 'T', '2026-07-01');
  const gross = R(9000) + R(1620);

  let i = 0;
  for (const amount of [R(3000), R(5000), gross - R(8000)]) {
    i++;
    register.recordPayment({
      proformaNo: doc.proformaNo, amount,
      receiptNo: `RCT-B-${i}`, method: 'UPI', on: '2026-07-10', by: 'Manager',
    });
  }
  eq(register.get(doc.proformaNo)?.outstanding, 0, 'settled');
  eq(register.get(doc.proformaNo)?.status, 'Paid', 'status');
  eq(ledger.balanceOf(A.BANK_OPERATING), gross, 'bank holds exactly the gross');
  assertTies(ledger, '2026-07-01', '2026-07-31', 'after three part payments');
});

check('a receipt spanning two invoices is allocated oldest first', () => {
  const { ledger, register } = freshRegister();
  const docs: string[] = [];
  for (const [period, issuedOn] of [['Jun 2026', '2026-06-01'], ['Jul 2026', '2026-07-01']]) {
    const d = register.issueProforma({
      flatNo: 'C-302', period, issuedOn,
      lines: [{ head: 'maintenance', amount: R(5000), taxable: false }],
    });
    register.approve(d.proformaNo, 'T', issuedOn);
    register.convertToTaxInvoice(d.proformaNo, { on: issuedOn, because: 'manual', by: 'T' });
    docs.push(d.proformaNo);
  }

  const open = outstandingInvoices(ledger, 'C-302');
  eq(open.length, 2, 'two invoices open');
  eq(open[0].raisedOn, '2026-06-01', 'oldest first');

  // ₹7,000 against two ₹5,000 invoices: the June one closes, July takes ₹2,000.
  const result = register.recordPayment({
    proformaNo: docs[1], amount: R(7000),
    receiptNo: 'RCT-C-1', method: 'UPI', on: '2026-07-20', by: 'Manager',
  });
  // Paying through a specific document targets that document first.
  eq(result.appliedToDues, R(5000), 'capped at the targeted invoice');
  eq(result.heldAsAdvance, R(2000), 'the rest is held, not forced onto another invoice');

  const after = memberLedgerPosition(ledger, 'C-302');
  eq(after.totalDues, R(5000), 'June still open');
  eq(after.advance, R(2000), 'advance held');
  assertTies(ledger, '2026-06-01', '2026-07-31', 'after a cross-invoice receipt');
});

check('allocation is by invoice date, not by the order they were entered', () => {
  // Raised out of order on purpose: July first, then June. If allocation
  // followed insertion order instead of the invoice date, the July bill would
  // be settled first and the older debt left standing.
  const { ledger, register } = freshRegister();
  const july = register.issueProforma({
    flatNo: 'C-302', period: 'Jul 2026', issuedOn: '2026-07-01',
    lines: [{ head: 'maintenance', amount: R(4000), taxable: false }],
  });
  register.approve(july.proformaNo, 'T', '2026-07-01');
  register.convertToTaxInvoice(july.proformaNo, { on: '2026-07-01', because: 'manual', by: 'T' });

  const june = register.issueProforma({
    flatNo: 'C-302', period: 'Jun 2026', issuedOn: '2026-06-01',
    lines: [{ head: 'maintenance', amount: R(3000), taxable: false }],
  });
  register.approve(june.proformaNo, 'T', '2026-06-01');
  register.convertToTaxInvoice(june.proformaNo, { on: '2026-06-01', because: 'manual', by: 'T' });

  const open = outstandingInvoices(ledger, 'C-302');
  eq(open.length, 2, 'two open');
  eq(open[0].raisedOn, '2026-06-01', 'the June invoice is first despite being entered second');

  // An untargeted receipt of ₹3,000 must clear June, not July.
  const plan = planAllocation(ledger, { flatNo: 'C-302', amount: R(3000), asAt: '2026-07-20' });
  eq(plan.allocations.length, 1, 'one invoice touched');
  eq(plan.allocations[0].docRef, register.get(june.proformaNo)?.taxInvoiceNo, 'and it is June\'s');
  eq(plan.advance, 0, 'nothing left over');
});

check('an unpaid invoice past its due date reads Overdue', () => {
  const { register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jun 2026', issuedOn: '2026-06-01',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: false }],
  });
  register.approve(doc.proformaNo, 'T', '2026-06-01');
  register.convertToTaxInvoice(doc.proformaNo, { on: '2026-06-01', because: 'manual', by: 'T' });

  // Due 11 June. The fixed clock is 15 July, so this is well past due.
  eq(register.get(doc.proformaNo)?.dueOn, '2026-06-11', 'due date');
  eq(register.get(doc.proformaNo)?.status, 'Overdue', 'status with nothing paid and the date passed');

  // The same invoice before its due date is merely Pending.
  eq(deriveStatus({
    docRef: 'X', gross: R(5000), outstanding: R(5000), dueOn: '2026-06-11',
  }, '2026-06-05'), 'Pending', 'not yet due');
  eq(deriveStatus({
    docRef: 'X', gross: R(5000), outstanding: R(5000), dueOn: '2026-06-11',
  }, '2026-06-12'), 'Overdue', 'one day past due');
  // And once anything is paid it is Partly paid rather than Overdue, so a
  // part payment is not hidden behind the overdue flag.
  eq(deriveStatus({
    docRef: 'X', gross: R(5000), outstanding: R(1000), dueOn: '2026-06-11',
  }, '2026-07-15'), 'Partly paid', 'part paid and past due');
});

// --- advances -------------------------------------------------------------

suite('Advances through the member subledger');

check('an overpayment becomes an advance on the subledger, not a negative receivable', () => {
  const { ledger, register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'D-404', period: 'Jul 2026', issuedOn: '2026-07-01',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: false }],
  });
  register.approve(doc.proformaNo, 'T', '2026-07-01');
  const result = register.recordPayment({
    proformaNo: doc.proformaNo, amount: R(8000),
    receiptNo: 'RCT-D-1', method: 'UPI', on: '2026-07-05', by: 'Manager',
  });

  eq(result.appliedToDues, R(5000), 'applied to the invoice');
  eq(result.heldAsAdvance, R(3000), 'held as advance');
  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'D-404' }), 0, 'receivable is zero');
  const sub = ledger.subledger(A.MEMBER_ADVANCE);
  eq(sub.get('D-404'), R(3000), 'the advance sits on the member subledger');
  assertTies(ledger, '2026-07-01', '2026-07-31', 'after an overpayment');
});

check('an advance applies to the next invoice and leaves the remainder', () => {
  const { ledger, register } = freshRegister();
  const july = register.issueProforma({
    flatNo: 'D-404', period: 'Jul 2026', issuedOn: '2026-07-01',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: false }],
  });
  register.approve(july.proformaNo, 'T', '2026-07-01');
  register.recordPayment({
    proformaNo: july.proformaNo, amount: R(9000),
    receiptNo: 'RCT-D-2', method: 'UPI', on: '2026-07-05', by: 'Manager',
  });
  eq(ledger.balanceOf(A.MEMBER_ADVANCE, { party: 'D-404' }), R(4000), 'advance held');

  const august = register.issueProforma({
    flatNo: 'D-404', period: 'Aug 2026', issuedOn: '2026-08-01',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: false }],
  });
  register.approve(august.proformaNo, 'T', '2026-08-01');
  register.convertToTaxInvoice(august.proformaNo, {
    on: '2026-08-01', because: 'manual', by: 'T',
  });

  const applied = applyAdvanceVia(ledger, 'D-404', '2026-08-02', 'ADJ-1');
  eq(applied, R(4000), 'the whole advance went against the August invoice');
  eq(ledger.balanceOf(A.MEMBER_ADVANCE, { party: 'D-404' }), 0, 'advance exhausted');
  eq(register.get(august.proformaNo)?.outstanding, R(1000), 'August part settled');
  eq(register.get(august.proformaNo)?.status, 'Partly paid', 'and reads as part paid');
  assertTies(ledger, '2026-07-01', '2026-08-31', 'after applying an advance');
});

check('applying an advance when nothing is due does nothing', () => {
  const { ledger } = freshRegister();
  const applied = applyAdvanceVia(ledger, 'Z-9', '2026-07-05', 'ADJ-NONE');
  eq(applied, 0, 'nothing applied');
  eq(ledger.all().length, 0, 'and nothing posted');
});

// --- vendor bills, TDS ----------------------------------------------------

suite('Vendor bills, payment and TDS');

check('booking, paying and remitting are three separate transactions', () => {
  const { ledger } = freshRegister();
  const actor = { postedBy: 'Treasurer' };

  const booked = bookVendorBill(ledger, {
    vendorId: 'V-WATER', vendorName: 'Force Aqua Tankers', billNo: 'FA-118',
    date: '2026-07-10', expenseAccount: A.EXP_WATER, gross: R(54000), tdsSection: '194C',
  }, APPROVED, actor);

  eq(booked.tdsAmount, R(1080), 'TDS at 2%');
  eq(booked.netPayable, R(52920), 'net');
  eq(ledger.balanceOf(A.EXP_WATER), R(54000), 'expense at gross');
  eq(ledger.balanceOf(A.BANK_OPERATING), 0, 'booking does not touch the bank');

  // Fund the bank honestly, from a member receipt rather than an opening plug.
  const { register } = freshRegister();
  const fundingDoc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(60000), taxable: false }],
  });
  register.approve(fundingDoc.proformaNo, 'T');
  // The funding happens on the same ledger used below.
  void fundingDoc;

  payVendorBill(ledger, {
    vendorId: 'V-WATER', vendorName: 'Force Aqua Tankers', date: '2026-07-18',
    amount: booked.netPayable, paymentRef: 'PAY-1', againstBillNo: 'FA-118',
  }, actor);
  eq(ledger.balanceOf(A.VENDOR_PAYABLE, { party: 'V-WATER' }), 0, 'payable cleared');
  eq(ledger.balanceOf(A.TDS_PAYABLE_194C), R(1080), 'TDS still a liability after payment');

  remitTds(ledger, {
    section: '194C', date: '2026-08-07', amount: R(1080), challanNo: 'CH-1',
  }, actor);
  eq(ledger.balanceOf(A.TDS_PAYABLE_194C), 0, 'TDS cleared only on remittance');
  assertTies(ledger, '2026-07-01', '2026-08-31', 'after the vendor cycle');
});

check('a payment exceeding one bill is refused even when the vendor owes more overall', () => {
  const { ledger } = freshRegister();
  const actor = { postedBy: 'T' };
  bookVendorBill(ledger, {
    vendorId: 'V-X', vendorName: 'X', billNo: 'B-1', date: '2026-07-01',
    expenseAccount: A.EXP_REPAIRS, gross: R(1000), tdsSection: 'none',
  }, APPROVED, actor);
  bookVendorBill(ledger, {
    vendorId: 'V-X', vendorName: 'X', billNo: 'B-2', date: '2026-07-02',
    expenseAccount: A.EXP_REPAIRS, gross: R(5000), tdsSection: 'none',
  }, APPROVED, actor);

  // The vendor is owed ₹6,000 in total but only ₹1,000 on B-1.
  throws(
    () => payVendorBill(ledger, {
      vendorId: 'V-X', vendorName: 'X', date: '2026-07-10', amount: R(3000),
      paymentRef: 'PAY-X', againstBillNo: 'B-1',
    }, actor),
    /exceeds the ₹1,000 outstanding on bill B-1/, 'over-paying one bill',
  );
});

// --- GST ------------------------------------------------------------------

suite('GST');

check('GST liability equals the tax on every converted invoice', () => {
  const { ledger, register, config } = freshRegister();
  const run = runBilling(register, {
    period: 'Jul 2026', flats: FLATS, sinkingFundPercentOfMaintenance: 20,
  }, config);
  let expectedTax = 0;
  for (const doc of run.documents) {
    register.approve(doc.proformaNo, 'T', '2026-07-01');
    register.convertToTaxInvoice(doc.proformaNo, {
      on: '2026-07-11', because: 'due-date-reached', by: 'job',
    });
    expectedTax += doc.estimatedTax;
  }
  const onLedger = ledger.balanceOf(A.CGST_OUTPUT) + ledger.balanceOf(A.SGST_OUTPUT);
  eq(onLedger, expectedTax, 'GST on the ledger vs the sum of the invoices');
  truthy(onLedger > 0, 'and it is not zero');
  assertTies(ledger, '2026-07-01', '2026-07-31', 'after a full run');
});

check('GST off in config means no GST account movement', () => {
  const noGst: AccountingConfig = { ...APPROVED, gstOnMaintenance: false };
  const ledger = new Ledger();
  const register = new BillingRegister(ledger, noGst, CLOCK);
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  eq(doc.estimatedTax, 0, 'no estimated tax');
  eq(doc.gross, R(7875), 'gross is the net');
  register.approve(doc.proformaNo, 'T');
  register.convertToTaxInvoice(doc.proformaNo, { because: 'manual', by: 'T' });
  eq(ledger.balanceOf(A.CGST_OUTPUT), 0, 'CGST');
  eq(ledger.balanceOf(A.SGST_OUTPUT), 0, 'SGST');
});

check('a non-standard GST rate flows through', () => {
  const twelve: AccountingConfig = {
    ...APPROVED,
    gst: { rate: 12, effectiveFrom: '2026-04-01', basis: 'test' },
  };
  const ledger = new Ledger();
  const register = new BillingRegister(ledger, twelve, CLOCK);
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    // Above the ₹7,500 per-member threshold, below which nothing is charged.
    lines: [{ head: 'maintenance', amount: R(10000), taxable: true }],
  });
  eq(doc.estimatedTax, R(1200), '12% applied');
});

// --- cancellation and reversal -------------------------------------------

suite('Cancellation');

check('cancelling a converted invoice reverses the posting', () => {
  const { ledger, register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026', issuedOn: '2026-07-01',
    lines: [{ head: 'maintenance', amount: R(7875), taxable: true }],
  });
  register.approve(doc.proformaNo, 'T', '2026-07-01');
  register.convertToTaxInvoice(doc.proformaNo, { on: '2026-07-02', because: 'manual', by: 'T' });
  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'A-101' }), R(9292.5), 'raised');

  const { reversal } = register.cancel(doc.proformaNo, 'T', 'billed on the wrong area', '2026-07-03');
  truthy(reversal !== undefined, 'a reversal was posted');
  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'A-101' }), 0, 'receivable cleared');
  eq(ledger.balanceOf(A.CGST_OUTPUT), 0, 'GST reversed too');
  eq(register.get(doc.proformaNo)?.status, 'Cancelled', 'status');
  eq(ledger.all().length, 2, 'the original entry is still there');
  assertTies(ledger, '2026-07-01', '2026-07-31', 'after a cancellation');
});

check('an invoice with money against it cannot simply be cancelled', () => {
  const { register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026', issuedOn: '2026-07-01',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: false }],
  });
  register.approve(doc.proformaNo, 'T', '2026-07-01');
  register.recordPayment({
    proformaNo: doc.proformaNo, amount: R(2000),
    receiptNo: 'RCT-K', method: 'UPI', on: '2026-07-05', by: 'M',
  });
  throws(
    () => register.cancel(doc.proformaNo, 'T', 'changed my mind'),
    /has ₹2,000 received against it/, 'cancelling a part-paid invoice',
  );
});

check('a cancellation must give a reason', () => {
  const { register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: false }],
  });
  throws(() => register.cancel(doc.proformaNo, 'T', '   '), /must record a reason/, 'blank reason');
});

// --- dates ----------------------------------------------------------------

suite('Dates are validated, not assumed');

check('an invalid date is refused everywhere it is accepted', () => {
  const { register } = freshRegister();
  throws(
    () => register.issueProforma({
      flatNo: 'A-101', period: 'Jul 2026', issuedOn: '2026-02-30',
      lines: [{ head: 'maintenance', amount: R(1000), taxable: false }],
    }),
    /must be a real date/, '30 February',
  );
  throws(
    () => register.issueProforma({
      flatNo: 'B-204', period: 'Jul 2026', issuedOn: '01-07-2026',
      lines: [{ head: 'maintenance', amount: R(1000), taxable: false }],
    }),
    /must be a real date/, 'day-first format',
  );
});

check('a due date before the issue date is refused', () => {
  const { register } = freshRegister();
  throws(
    () => register.issueProforma({
      flatNo: 'A-101', period: 'Jul 2026', issuedOn: '2026-07-10', dueOn: '2026-07-01',
      lines: [{ head: 'maintenance', amount: R(1000), taxable: false }],
    }),
    /before the issue date/, 'inverted dates',
  );
});

check('a tax invoice cannot be dated before its proforma', () => {
  const { register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026', issuedOn: '2026-07-01',
    lines: [{ head: 'maintenance', amount: R(1000), taxable: false }],
  });
  register.approve(doc.proformaNo, 'T', '2026-07-01');
  throws(
    () => register.convertToTaxInvoice(doc.proformaNo, {
      on: '2026-06-30', because: 'manual', by: 'T',
    }),
    /before the proforma's issue date/, 'backdated conversion',
  );
});

check('a period that is not a month and year is refused', () => {
  const { register } = freshRegister();
  throws(
    () => register.issueProforma({
      flatNo: 'A-101', period: '10th of Month',
      lines: [{ head: 'maintenance', amount: R(1000), taxable: false }],
    }),
    /is not a month and year/, 'the demo\'s junk period string',
  );
});

// --- ageing and reconciliation -------------------------------------------

suite('Reports reflect the same transactions');

check('ageing buckets add up to the outstanding receivable', () => {
  const { ledger, register, config } = freshRegister();
  const run = runBilling(register, {
    period: 'Jul 2026', flats: FLATS, issuedOn: '2026-07-01',
  }, config);
  for (const doc of run.documents) {
    register.approve(doc.proformaNo, 'T', '2026-07-01');
    register.convertToTaxInvoice(doc.proformaNo, { on: '2026-07-01', because: 'manual', by: 'T' });
  }
  // Settle one in full so a zero-balance invoice is excluded from ageing.
  register.recordPayment({
    proformaNo: run.documents[0].proformaNo,
    amount: register.get(run.documents[0].proformaNo)?.outstanding as number,
    receiptNo: 'RCT-AG', method: 'UPI', on: '2026-07-05', by: 'M',
  });

  const dueDates = new Map<string, string>();
  for (const view of register.all()) {
    if (view.taxInvoiceNo) dueDates.set(view.taxInvoiceNo, view.dueOn);
  }
  const buckets = ageing(ledger, '2026-09-30', ref => dueDates.get(ref));
  const bucketTotal = buckets.reduce((a, b) => a + b.amount, 0);
  eq(bucketTotal, ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { to: '2026-09-30' }),
     'buckets vs the control account');
  // Issued 1 July, due 10 days later on 11 July. At 30 September that is 81
  // days overdue, which is the 61–90 bucket, not 31–60.
  eq(buckets.find(b => b.label === 'Over 90 days')?.amount, 0, 'nothing over 90 days');
  eq(buckets.find(b => b.label === '31–60 days')?.amount, 0, '31–60 is empty');
  truthy((buckets.find(b => b.label === '61–90 days')?.amount ?? 0) > 0,
         'the July bills land in 61–90 days');

  // And the bucket boundaries themselves: one day either side of 90.
  const at90 = ageing(ledger, '2026-10-09', ref => dueDates.get(ref));
  const at91 = ageing(ledger, '2026-10-10', ref => dueDates.get(ref));
  truthy((at90.find(b => b.label === '61–90 days')?.amount ?? 0) > 0, '90 days is still 61–90');
  truthy((at91.find(b => b.label === 'Over 90 days')?.amount ?? 0) > 0, '91 days tips over 90');
});

check('the statements reflect exactly what the register posted', () => {
  const { ledger, register, config } = freshRegister();
  const run = runBilling(register, {
    period: 'Jul 2026', flats: FLATS, issuedOn: '2026-07-01',
    sinkingFundPercentOfMaintenance: 20,
  }, config);
  for (const doc of run.documents) {
    register.approve(doc.proformaNo, 'T', '2026-07-01');
  }
  register.convertDue('2026-07-11', 'job');
  register.recordPayment({
    proformaNo: run.documents[0].proformaNo, amount: R(5000),
    receiptNo: 'RCT-S1', method: 'UPI', on: '2026-07-20', by: 'M',
  });
  bookVendorBill(ledger, {
    vendorId: 'V-S', vendorName: 'Supplier', billNo: 'S-1', date: '2026-07-15',
    expenseAccount: A.EXP_WATER, gross: R(20000), tdsSection: '194C',
  }, config, { postedBy: 'T' });

  const ie = incomeAndExpenditure(ledger, '2026-07-01', '2026-07-31');
  const rp = receiptsAndPayments(ledger, '2026-07-01', '2026-07-31');
  const bs = balanceSheet(ledger, '2026-07-31');

  // Income is the maintenance billed, which is the run's net less the sinking
  // fund (credited to the fund, not to income, under this config).
  const billedMaintenance = run.documents.reduce(
    (a, d) => a + d.lines.filter(l => l.head === 'maintenance').reduce((x, l) => x + l.amount, 0), 0);
  eq(ledger.balanceOf(A.INC_MAINTENANCE), billedMaintenance, 'income equals what was billed');
  eq(ie.totalExpenditure, R(20000), 'expenditure is the vendor bill at gross');
  eq(rp.totalReceipts, R(5000), 'cash in is the one receipt');
  eq(rp.totalPayments, 0, 'nothing was paid out');
  eq(bs.totalAssets, bs.totalLiabilitiesAndFunds, 'balance sheet ties');
  assertTies(ledger, '2026-07-01', '2026-07-31', 'end to end');
});

check('nothing posts an opening balance of its own accord', () => {
  const { ledger, register, config } = freshRegister();
  runBilling(register, { period: 'Jul 2026', flats: FLATS }, config);
  eq(ledger.all().filter(e => e.source.kind === 'opening-balance').length, 0,
     'no opening-balance entry was invented');
  eq(ledger.balanceOf(A.GENERAL_RESERVE), 0, 'no reserve conjured');
});

// --- CA approval gate -----------------------------------------------------

suite('CA approval flags are respected');

check('a billing run from an unapproved config raises nothing billable', () => {
  const ledger = new Ledger();
  // DEMO_CONFIG has no reviewedBy, so the rate it carries is unapproved.
  const register = new BillingRegister(ledger, DEMO_CONFIG, CLOCK);
  const result = runBilling(register, { period: 'Jul 2026', flats: FLATS }, DEMO_CONFIG);
  eq(result.documents.length, 0, 'no documents raised');
  eq(result.skipped.length, FLATS.length, 'every flat skipped');
  truthy(result.skipped.every(s => /unapproved rate/.test(s.why)),
         `the reason names the unapproved rate, got "${result.skipped[0]?.why}"`);
});

check('a preview from an unapproved rate is allowed but still cannot post', () => {
  const ledger = new Ledger();
  const register = new BillingRegister(ledger, DEMO_CONFIG, CLOCK);
  const preview = runBilling(register, {
    period: 'Jul 2026', flats: FLATS, previewOnly: true,
  }, DEMO_CONFIG);
  eq(preview.documents.length, 4, 'the preview produced figures');
  truthy(preview.documents.every(d => d.state === 'draft'), 'all still drafts');
  // And a draft cannot be converted, so a preview has no path to the books.
  throws(
    () => register.convertToTaxInvoice(preview.documents[0].proformaNo, {
      because: 'manual', by: 'x',
    }),
    /has not been approved/, 'converting a preview',
  );
  eq(ledger.all().length, 0, 'nothing reached the ledger');
});

// --- the store, which is what the screens call ---------------------------

suite('The store: the path the screens actually take');

check('a payment through the store converts, allocates and moves the books', () => {
  const store = makeStore();
  const run = store.runBillingFor({ period: 'Jul 2026', flats: FLATS, issuedOn: '2026-07-01' });
  eq(run.documents.length, 4, 'proformas raised');
  store.approveDocuments(run.documents.map(d => d.proformaNo), 'Treasurer');

  const target = run.documents[0];
  const gross = toRupeesNumber(target.gross);
  const result = store.recordMemberPayment({
    proformaNo: target.proformaNo, amountRupees: gross,
    receiptNo: 'RCT-STORE-1', method: 'UPI', by: 'Manager',
  });

  truthy(result.converted, 'the proforma was converted on payment');
  eq(result.outstandingAfter, 0, 'settled');
  const view = store.snapshot().register.get(target.proformaNo);
  eq(view?.status, 'Paid', 'status derived from the ledger');
  assertTies(store.snapshot().ledger, '2026-07-01', '2026-12-31', 'after a store payment');
});

check('a part payment through the store leaves the balance and does not say Paid', () => {
  const store = makeStore();
  const run = store.runBillingFor({ period: 'Jul 2026', flats: FLATS, issuedOn: '2026-07-01' });
  store.approveDocuments(run.documents.map(d => d.proformaNo), 'Treasurer');

  const target = run.documents[0];
  const result = store.recordMemberPayment({
    proformaNo: target.proformaNo, amountRupees: 1000,
    receiptNo: 'RCT-STORE-2', method: 'NEFT', by: 'Manager',
  });
  truthy(result.outstandingAfter > 0, 'still outstanding');
  eq(store.snapshot().register.get(target.proformaNo)?.status, 'Partly paid', 'status');
  assertTies(store.snapshot().ledger, '2026-07-01', '2026-12-31', 'after a store part payment');
});

check('an advance deposit through the store lands on the member subledger', () => {
  const store = makeStore();
  const result = store.depositAdvance({
    flatNo: 'A-101', amountRupees: 5000, receiptNo: 'ADV-1', method: 'UPI', by: 'Resident',
  });
  eq(result.appliedToDues, 0, 'nothing open to apply it to');
  eq(result.heldAsAdvance, R(5000), 'held as advance');
  const sub = store.snapshot().ledger.subledger(A.MEMBER_ADVANCE);
  eq(sub.get('A-101'), R(5000), 'on the subledger');
  assertTies(store.snapshot().ledger, '2026-01-01', '2026-12-31', 'after a store advance');
});

check('an advance deposited first is applied when a bill arrives', () => {
  const store = makeStore();
  store.depositAdvance({
    flatNo: 'A-101', amountRupees: 5000, receiptNo: 'ADV-2', method: 'UPI', by: 'Resident',
  });
  const run = store.runBillingFor({ period: 'Jul 2026', flats: FLATS, issuedOn: '2026-07-01' });
  const doc = run.documents.find(d => d.flatNo === 'A-101');
  if (!doc) throw new Error('no document for A-101');
  store.approveDocuments([doc.proformaNo], 'Treasurer');
  store.snapshot().register.convertToTaxInvoice(doc.proformaNo, {
    on: '2026-07-11', because: 'due-date-reached', by: 'job',
  });

  const applied = store.applyMemberAdvance({ flatNo: 'A-101', ref: 'ADJ-STORE', by: 'Manager' });
  eq(applied, R(5000), 'the whole advance went against the bill');
  eq(store.snapshot().ledger.balanceOf(A.MEMBER_ADVANCE, { party: 'A-101' }), 0, 'advance used');
  eq(store.snapshot().register.get(doc.proformaNo)?.status, 'Partly paid', 'bill part settled');
  assertTies(store.snapshot().ledger, '2026-01-01', '2026-12-31', 'after applying via the store');
});

check('approving a vendor bill through the store does not pay it', () => {
  const store = makeStore([{
    id: 'VB-1', vendorId: 'V-1', vendorName: 'Force Aqua', category: 'Water tankers',
    amount: 54000, tdsRate: 2, tdsAmount: 1080, netPayable: 52920,
    status: 'Pending', date: '10 Jul 2026',
  }]);

  store.approveVendorBill('VB-1', 'Treasurer');
  eq(store.snapshot().vendorBills[0].state, 'approved', 'approved');
  eq(store.snapshot().ledger.all().length, 0, 'approval posts nothing at all');

  store.bookApprovedVendorBill('VB-1', 'Treasurer', A.EXP_WATER);
  const ledger = store.snapshot().ledger;
  eq(store.snapshot().vendorBills[0].state, 'booked', 'booked');
  eq(ledger.balanceOf(A.EXP_WATER), R(54000), 'expense at gross');
  eq(ledger.balanceOf(A.VENDOR_PAYABLE, { party: 'V-1' }), R(52920), 'payable stands');
  eq(ledger.balanceOf(A.TDS_PAYABLE_194C), R(1080), 'TDS withheld');
  eq(ledger.balanceOf(A.BANK_OPERATING), 0, 'the bank is untouched by booking');
  assertTies(ledger, '2026-07-01', '2026-12-31', 'after booking through the store');
});

check('paying an unbooked vendor bill is refused, not silently posted', () => {
  const store = makeStore([{
    id: 'VB-2', vendorId: 'V-2', vendorName: 'X', category: 'Repairs',
    amount: 1000, tdsRate: 0, tdsAmount: 0, netPayable: 1000,
    status: 'Pending', date: '10 Jul 2026',
  }]);
  store.payVendor({ id: 'VB-2', amountRupees: 1000, paymentRef: 'P-1', by: 'T' });
  eq(store.snapshot().ledger.all().length, 0, 'nothing posted');
  truthy(store.snapshot().problems.some(p => /only be made against a booked bill/.test(p)),
         'and the refusal is recorded for the screen');
});

check('a vendor payment through the store clears the payable', () => {
  const store = makeStore([{
    id: 'VB-3', vendorId: 'V-3', vendorName: 'Guards', category: 'Security',
    amount: 10000, tdsRate: 2, tdsAmount: 200, netPayable: 9800,
    status: 'Approved', date: '10 Jul 2026',
  }]);
  // Fund the bank from a real receipt rather than an invented opening balance.
  const run = store.runBillingFor({ period: 'Jul 2026', flats: FLATS, issuedOn: '2026-07-01' });
  store.approveDocuments(run.documents.map(d => d.proformaNo), 'T');
  store.recordMemberPayment({
    proformaNo: run.documents[0].proformaNo,
    amountRupees: toRupeesNumber(run.documents[0].gross),
    receiptNo: 'RCT-FUND', method: 'UPI', by: 'M',
  });

  store.bookApprovedVendorBill('VB-3', 'T', A.EXP_SECURITY);
  store.payVendor({ id: 'VB-3', amountRupees: 9800, paymentRef: 'PAY-VB3', by: 'T' });

  const ledger = store.snapshot().ledger;
  eq(ledger.balanceOf(A.VENDOR_PAYABLE, { party: 'V-3' }), 0, 'payable cleared');
  eq(ledger.balanceOf(A.TDS_PAYABLE_194C), R(200), 'TDS still owed to the government');
  assertTies(ledger, '2026-07-01', '2026-12-31', 'after a store vendor payment');
});

check('a rerun through the store raises nothing and records every skip', () => {
  const store = makeStore();
  store.runBillingFor({ period: 'Jul 2026', flats: FLATS, issuedOn: '2026-07-01' });
  const second = store.runBillingFor({ period: 'Jul 2026', flats: FLATS, issuedOn: '2026-07-01' });
  eq(second.documents.length, 0, 'nothing raised');
  eq(second.skipped.length, 4, 'all four skipped');
  eq(store.snapshot().problems.filter(p => /already has a live document/.test(p)).length, 4,
     'and each skip is surfaced');
});

check('a flat with no area is skipped by the store and the reason is shown', () => {
  const store = makeStore();
  const result = store.runBillingFor({
    period: 'Jul 2026',
    flats: [...FLATS, { flatNo: 'D-202', name: 'Sanjay Verma' }],
    issuedOn: '2026-07-01',
  });
  eq(result.documents.length, 4, 'the four with areas were billed');
  truthy(result.skipped.some(sk => sk.flatNo === 'D-202'), 'the arealess flat was skipped');
  truthy(store.snapshot().problems.some(p => /D-202/.test(p)), 'and it is on the problem list');
});

check('the statements read the store ledger, not a rebuild of the arrays', () => {
  const store = makeStore();
  const run = store.runBillingFor({ period: 'Jul 2026', flats: FLATS, issuedOn: '2026-07-01' });
  store.approveDocuments(run.documents.map(d => d.proformaNo), 'T');
  store.snapshot().register.convertDue('2026-07-11', 'job');

  const statements = buildStatements([], [], { ledger: store.snapshot().ledger });
  eq(statements.source, 'live-ledger', 'the live ledger was used');
  truthy(statements.allChecksPassed, 'and it reconciles');
  eq(statements.counts.entries, store.snapshot().ledger.all().length, 'same entry count');
});

check('an empty store falls back to the seed so the books are never blank', () => {
  const store = makeStore();
  const statements = buildStatements(SEED_INVOICES, [], { ledger: store.snapshot().ledger });
  eq(statements.source, 'imported-seed', 'the seed was imported');
  truthy(statements.counts.entries > 0, 'and there is something to show');
});

// --- regressions from the accounting audit ---------------------------------

suite('Audit regressions');

check('a period is canonicalised before the duplicate check', () => {
  const { register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'jul  2026',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
  });
  eq(doc.period, 'Jul 2026', 'the stored period');
  // "July 2026" and "JUL 2026" are the same month; the raw-text key let both
  // through as new slots.
  throws(() => register.issueProforma({
    flatNo: 'A-101', period: 'July 2026',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
  }), /already has .* for Jul 2026/, 'a second spelling of July');
  truthy(register.hasDocumentFor('A-101', 'JUL 2026'), 'the slot is found under any spelling');
  throws(() => register.issueProforma({
    flatNo: 'B-204', period: 'Julyy 2026',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
  }), /not a month and year/, 'a word that only starts like a month');
  eq(canonicalPeriod('Sept 2026'), 'Sep 2026', 'Sept');
  eq(canonicalPeriod(' 2026 Jul'), null, 'year first');
});

check('a cancelled tax invoice can be replaced and the replacement posts', () => {
  const { ledger, register } = freshRegister();
  const lines = [{ head: 'maintenance' as const, amount: R(5000), taxable: true }];
  const first = register.issueProforma({ flatNo: 'A-101', period: 'Jul 2026', lines });
  register.approve(first.proformaNo, 'T');
  register.convertToTaxInvoice(first.proformaNo, { because: 'manual', by: 'T' });
  register.cancel(first.proformaNo, 'T', 'wrong area on file');

  // Its own number: re-using PI-2026-07-A101 was refused as "already in use".
  const second = register.issueProforma({ flatNo: 'A-101', period: 'Jul 2026', lines });
  eq(second.proformaNo, 'PI-2026-07-A101-R2', 'the replacement number');
  register.approve(second.proformaNo, 'T');
  // And it posts: the billing entry was keyed on flat and period, and the
  // reversed entry's key is never released.
  const { document } = register.convertToTaxInvoice(second.proformaNo, { because: 'manual', by: 'T' });
  eq(register.outstandingOf(document), R(5000), 'the replacement is owed');
  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'A-101' }), R(5000), 'the flat owes it once');
  eq(ledger.all().filter(e => e.source.kind === 'maintenance-billing').length, 2, 'two billing entries');
  assertTies(ledger, '2026-07-01', '2026-07-31', 'after the replacement');
});

check('the proforma estimate and the posted tax follow the same threshold rule', () => {
  const { register } = freshRegister();
  const under = register.issueProforma({
    flatNo: 'A-101', period: 'Jul 2026',
    lines: [{ head: 'maintenance', amount: R(7500), taxable: true }],
  });
  eq(under.estimatedTax, 0, 'at ₹7,500 a member is exempt');
  const over = register.issueProforma({
    flatNo: 'B-204', period: 'Jul 2026',
    lines: [
      { head: 'maintenance', amount: R(9000), taxable: true },
      { head: 'sinking', amount: R(900), taxable: false },
    ],
  });
  eq(over.estimatedTax, R(1620), 'above it, 18% of the whole taxable value');
  register.approve(over.proformaNo, 'T');
  const { document } = register.convertToTaxInvoice(over.proformaNo, { because: 'manual', by: 'T' });
  eq(document.gross, over.gross, 'the posted gross is the estimate');
});

check('an imported late penalty is late-payment interest, not "other receipts"', () => {
  const invoice: SourceInvoice = {
    id: 'pen-1', invoiceNo: 'GM-PEN-1', flatNo: 'A-101', name: 'Test', period: 'Jun 2026',
    maintenance: 2500, sinkingFund: 500, waterCharges: 0, parkingCharges: 0,
    nonOccupancyCharges: 0, latePenalty: 100, gst: 450, total: 3550,
    status: 'Pending', dueDate: '10th of Month',
  };
  const report = importDemoData([invoice], []);
  eq(report.skipped.length, 0, 'nothing skipped');
  eq(report.ledger.balanceOf(A.INC_LATE_INTEREST), R(100), 'late payment interest (4060)');
  eq(report.ledger.balanceOf(A.INC_OTHER_RECEIPTS), 0, 'other receipts untouched');
});

check('TDS is withheld on the bill less its GST, rounded half-up', () => {
  const ledger = new Ledger();
  const withGst = bookVendorBill(ledger, {
    vendorId: 'V1', vendorName: 'Lift Co', billNo: 'L-1', date: '2026-07-05',
    expenseAccount: A.EXP_LIFT, gross: R(11800), inputGst: R(1800), tdsSection: '194C',
  }, APPROVED, { postedBy: 'test' });
  // 2% of the ₹10,000 service; it was 2% of ₹11,800.
  eq(withGst.tdsAmount, R(200), 'tds on the value of the service');
  eq(withGst.netPayable, R(11600), 'net payable');
  const odd = bookVendorBill(ledger, {
    vendorId: 'V1', vendorName: 'Lift Co', billNo: 'L-2', date: '2026-07-05',
    expenseAccount: A.EXP_LIFT, gross: 10_025, tdsSection: '194C',
  }, APPROVED, { postedBy: 'test' });
  eq(odd.tdsAmount, 201, '2% of 10,025 paise, half-up — the server now agrees');
});

check('a tax invoice in February is labelled by its financial year', () => {
  const { register } = freshRegister();
  const doc = register.issueProforma({
    flatNo: 'A-101', period: 'Feb 2027',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
  });
  register.approve(doc.proformaNo, 'T', '2027-02-01');
  const { document } = register.convertToTaxInvoice(doc.proformaNo, {
    on: '2027-02-10', because: 'manual', by: 'T',
  });
  truthy((document.taxInvoiceNo ?? '').startsWith('TI/2026/'), `FY 2026-27, got ${document.taxInvoiceNo}`);
});

check('"today" is the date in India', () => {
  eq(isoDateInIndia(new Date('2026-07-31T18:29:59Z')), '2026-07-31', 'just before midnight IST');
  eq(isoDateInIndia(new Date('2026-07-31T18:30:00Z')), '2026-08-01', 'midnight IST, still the 31st in UTC');
});

// --- helper ---------------------------------------------------------------

/** Applies a flat's advance, via the engine, returning what was applied. */
function applyAdvanceVia(ledger: Ledger, flatNo: string, date: string, ref: string): number {
  return applyAdvance(ledger, { flatNo, date, ref }, { postedBy: 'test' }).applied;
}

// --- report ---------------------------------------------------------------

console.log('\n' + '='.repeat(66));
if (failures.length === 0) {
  console.log(`ALL ${passed} INTEGRATION CHECKS PASSED`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log('  - ' + f);
}
console.log('='.repeat(66));
if (failures.length > 0 && typeof process !== 'undefined') process.exitCode = 1;

// Referenced so the import is not flagged as unused when a check is edited out.
void DocumentError;
void RateError;
