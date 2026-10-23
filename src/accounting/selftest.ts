/**
 * The accounting engine's test suite.
 *
 * Deliberately dependency-free: it compiles with the TypeScript already in
 * devDependencies and runs on plain node, so `npm run test:accounting` works
 * without a test runner and runs identically in CI.
 *
 * Run it with: npm run test:accounting
 */

import { allocate, formatRupees, fromRupees, percentOf, toRupees } from './money';
import { A, CHART, NORMAL_BALANCE } from './accounts';
import { Ledger, credit, debit, validateEntry } from './journal';
import { DEMO_CONFIG, AccountingConfig, assertConfigReviewed, financialYearOf } from './config';
import { DEMO_BUDGET, budgetVsActual } from './budget';
import {
  assembleBalanceSheet, balanceSheet, cashFlowCloses, debitsEqualCredits,
  incomeAndExpenditure, netBalances, receiptsAndPayments, reconcile, trialBalance,
} from './reports';
import {
  applyAdvance, billMaintenance, bookVendorBill, memberPosition, payVendorBill,
  placeFixedDeposit, postOpeningBalances, receiveFromMember, remitTds,
  transferToSinkingFundBank, vendorPosition,
} from './transactions';

// --- Tiny harness ---------------------------------------------------------

let passed = 0;
const failures: string[] = [];
let currentSuite = '';

function suite(name: string): void {
  currentSuite = name;
  console.log(`\n${name}`);
}

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${currentSuite} / ${name}\n       ${message.replace(/\n/g, '\n       ')}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${message.replace(/\n/g, '\n       ')}`);
  }
}

function eq<T>(got: T, want: T, what = 'value'): void {
  if (got !== want) {
    throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

function truthy(cond: boolean, what: string): void {
  if (!cond) throw new Error(`expected ${what}`);
}

function throws(fn: () => unknown, matching: RegExp | string, what: string): void {
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ok = typeof matching === 'string' ? message.includes(matching) : matching.test(message);
    if (!ok) throw new Error(`${what}: threw, but message was "${message}"`);
    return;
  }
  throw new Error(`${what}: expected a throw, but nothing was thrown`);
}

const ACTOR = { postedBy: 'selftest' };
const R = fromRupees;

// --- Money ----------------------------------------------------------------

suite('Money is exact integer paise');

check('rupees convert to paise and back', () => {
  eq(R(3300), 330000);
  eq(R(0.01), 1);
  eq(toRupees(330050), 3300.5);
});

check('an amount finer than a paisa is rejected', () => {
  throws(() => R(1.005), /finer than one paisa/, 'sub-paisa amount');
  throws(() => R(Number.NaN), /Not a finite amount/, 'NaN');
});

check('Indian digit grouping', () => {
  eq(formatRupees(R(100000)), '₹1,00,000');
  eq(formatRupees(R(1250000)), '₹12,50,000');
  eq(formatRupees(R(999)), '₹999');
  eq(formatRupees(R(3300.5)), '₹3,300.50');
  eq(formatRupees(-R(1200)), '-₹1,200');
  eq(formatRupees(R(1000), { paise: true }), '₹1,000.00');
});

check('percentages round half-up to the paisa', () => {
  eq(percentOf(R(10000), 18), R(1800));
  eq(percentOf(R(100), 2.5), R(2.5));
  eq(percentOf(R(5000), 0), 0);

  // Cases that distinguish rounding from truncation. 2% of 123456 paise is
  // 2469.12, which rounds down; 18% of 10005 paise is 1800.9, which rounds up.
  // A floor() implementation gives 2469 and 1800, so it fails the second.
  eq(percentOf(R(1234.56), 2), 2469, '2469.12 rounds down');
  eq(percentOf(R(100.05), 18), 1801, '1800.9 rounds up, not down to 1800');
  eq(percentOf(R(50.05), 1), 50, '50.05 paise rounds down to 50');
  // 1% of 10050 paise is 100.50 exactly — the half-up boundary.
  eq(percentOf(R(100.50), 1), 101, '100.50 paise rounds up to 101');
  eq(percentOf(R(100.49), 1), 100, '100.49 paise rounds down to 100');
  // Exactly half must go up, which is what "half-up" means.
  eq(percentOf(5, 10), 1, '0.5 paisa rounds up to 1');
});

check('allocation never loses or invents a paisa', () => {
  // An odd tax split two ways must still add back exactly.
  const [a, b] = allocate(1801, [1, 1]);
  eq(a + b, 1801, 'split total');
  eq(a, 901);
  eq(b, 900);

  const parts = allocate(100000, [3, 5, 7]);
  eq(parts.reduce((x, y) => x + y, 0), 100000, 'three-way total');

  // Exhaustive: every total from 0..500 across several weight sets ties back.
  for (const weights of [[1, 1], [1, 2], [1, 1, 1], [3, 5, 7], [0, 1], [9, 1]]) {
    for (let total = 0; total <= 500; total++) {
      const got = allocate(total, weights);
      if (got.reduce((x, y) => x + y, 0) !== total) {
        throw new Error(`allocate(${total}, [${weights}]) summed to ${got.reduce((x, y) => x + y, 0)}`);
      }
    }
  }
});

check('allocation rejects impossible weights', () => {
  throws(() => allocate(100, []), /zero weights/, 'empty weights');
  throws(() => allocate(100, [0, 0]), /must not all be zero/, 'all-zero weights');
});

// --- Chart of accounts ----------------------------------------------------

suite('Chart of accounts');

check('account codes are unique', () => {
  const codes = CHART.map(a => a.code);
  eq(new Set(codes).size, codes.length, 'distinct codes');
});

check('every account has a class with a known normal balance', () => {
  for (const a of CHART) {
    truthy(NORMAL_BALANCE[a.cls] !== undefined, `normal balance for ${a.code}`);
  }
});

check('the six receipt heads each have an income account', () => {
  const heads = [
    A.INC_MAINTENANCE, A.INC_SINKING_CONTRIBUTION, A.INC_FESTIVAL,
    A.INC_SPACE_RENTAL, A.INC_REIMBURSEMENT, A.INC_OTHER_RECEIPTS,
  ];
  eq(new Set(heads).size, 6, 'six distinct heads');
  for (const code of heads) {
    truthy(CHART.some(a => a.code === code), `account ${code} exists`);
  }
});

// --- Posting validation ---------------------------------------------------

suite('Posting rejects invalid and incomplete entries');

const base = {
  date: '2026-07-01',
  narration: 'test',
  source: { kind: 'manual' as const },
  idempotencyKey: 'k',
  postedBy: 'selftest',
};

check('an unbalanced entry is rejected', () => {
  const problems = validateEntry({
    ...base,
    postings: [debit(A.BANK_OPERATING, 1000), credit(A.INC_OTHER_RECEIPTS, 900)],
  });
  truthy(problems.some(p => /does not balance/.test(p)), 'balance complaint');
  throws(
    () => new Ledger().post({
      ...base,
      postings: [debit(A.BANK_OPERATING, 1000), credit(A.INC_OTHER_RECEIPTS, 900)],
    }),
    /does not balance/, 'unbalanced post',
  );
});

check('a single-leg entry is rejected', () => {
  throws(
    () => new Ledger().post({ ...base, postings: [debit(A.BANK_OPERATING, 1000)] }),
    /at least two legs/, 'one leg',
  );
});

check('an unknown account is rejected', () => {
  throws(
    () => new Ledger().post({
      ...base,
      postings: [debit('9999', 1000), credit(A.BANK_OPERATING, 1000)],
    }),
    /no such account/, 'bad code',
  );
});

check('a negative leg is rejected rather than treated as the other side', () => {
  throws(
    () => new Ledger().post({
      ...base,
      postings: [debit(A.BANK_OPERATING, -1000), credit(A.INC_OTHER_RECEIPTS, -1000)],
    }),
    /must not be negative/, 'negative amounts',
  );
});

check('a leg that is both a debit and a credit is rejected', () => {
  throws(
    () => new Ledger().post({
      ...base,
      postings: [
        { accountCode: A.BANK_OPERATING, debit: 500, credit: 500 },
        credit(A.INC_OTHER_RECEIPTS, 0),
      ],
    }),
    /either a debit or a credit/, 'both sides',
  );
});

check('a zero entry is rejected', () => {
  throws(
    () => new Ledger().post({
      ...base,
      postings: [debit(A.BANK_OPERATING, 0), credit(A.INC_OTHER_RECEIPTS, 0)],
    }),
    /non-zero/, 'zero movement',
  );
});

check('a control account requires a party', () => {
  throws(
    () => new Ledger().post({
      ...base,
      postings: [debit(A.MAINTENANCE_RECEIVABLE, 1000), credit(A.INC_MAINTENANCE, 1000)],
    }),
    /must name a party/, 'missing party',
  );
});

check('a malformed date is rejected', () => {
  throws(
    () => new Ledger().post({
      ...base,
      date: '01-07-2026',
      postings: [debit(A.BANK_OPERATING, 1000), credit(A.INC_OTHER_RECEIPTS, 1000)],
    }),
    /YYYY-MM-DD/, 'bad date',
  );
});

check('fractional paise are rejected', () => {
  throws(
    () => new Ledger().post({
      ...base,
      postings: [debit(A.BANK_OPERATING, 100.5), credit(A.INC_OTHER_RECEIPTS, 100.5)],
    }),
    /whole paise/, 'fractional amount',
  );
});

check('a rejected entry leaves the ledger untouched', () => {
  const ledger = new Ledger();
  try {
    ledger.post({ ...base, postings: [debit(A.BANK_OPERATING, 1000)] });
  } catch { /* expected */ }
  eq(ledger.all().length, 0, 'entries after rejection');
});

// --- Duplicates -----------------------------------------------------------

suite('Duplicate transactions are prevented');

check('the same idempotency key cannot be posted twice', () => {
  const ledger = new Ledger();
  const entry = {
    ...base,
    idempotencyKey: 'receipt:RCT-1',
    postings: [debit(A.BANK_OPERATING, 1000), credit(A.INC_OTHER_RECEIPTS, 1000)],
  };
  ledger.post(entry);
  throws(() => ledger.post(entry), /Duplicate transaction/, 'second post');
  eq(ledger.all().length, 1, 'entry count');
});

check('re-running a billing run bills nobody twice', () => {
  const ledger = new Ledger();
  const bill = {
    flatNo: 'B-204', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'GM-2026-07-B204',
    lines: [{ head: 'maintenance' as const, amount: R(2500), taxable: true }],
  };
  billMaintenance(ledger, bill, DEMO_CONFIG, ACTOR);
  throws(() => billMaintenance(ledger, bill, DEMO_CONFIG, ACTOR), /Duplicate transaction/, 're-run');
  eq(ledger.all().length, 1, 'one bill only');
});

// --- Billing and GST ------------------------------------------------------

suite('Maintenance billing and GST');

check('GST is 18% of the taxable lines, split equally into CGST and SGST', () => {
  const ledger = new Ledger();
  const result = billMaintenance(ledger, {
    flatNo: 'A-101', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-1',
    lines: [
      { head: 'maintenance', amount: R(5000), taxable: true },
      { head: 'sinking', amount: R(1000), taxable: false },
    ],
  }, DEMO_CONFIG, ACTOR);

  eq(result.taxableValue, R(5000), 'taxable value');
  eq(result.cgst + result.sgst, R(900), 'total GST');
  eq(result.cgst, R(450), 'CGST');
  eq(result.sgst, R(450), 'SGST');
  eq(result.gross, R(6900), 'gross');
  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'A-101' }), R(6900), 'receivable');
});

check('an odd GST amount still splits without losing a paisa', () => {
  const ledger = new Ledger();
  // 18% of ₹100.05 = ₹18.009 -> 1801 paise, which is odd.
  const result = billMaintenance(ledger, {
    flatNo: 'A-102', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-2',
    lines: [{ head: 'maintenance', amount: R(100.05), taxable: true }],
  }, DEMO_CONFIG, ACTOR);
  eq(result.cgst + result.sgst, percentOf(R(100.05), 18), 'CGST + SGST equals the tax');
  truthy(Math.abs(result.cgst - result.sgst) <= 1, 'split is even to within a paisa');
});

check('GST liabilities reconcile with the tax invoices raised', () => {
  const ledger = new Ledger();
  let expected = 0;
  for (const [i, amount] of [2500, 3300, 7125.5, 999.99].entries()) {
    const r = billMaintenance(ledger, {
      flatNo: `F-${i}`, period: 'Jul 2026', date: '2026-07-01', invoiceNo: `INV-G${i}`,
      lines: [{ head: 'maintenance', amount: R(amount), taxable: true }],
    }, DEMO_CONFIG, ACTOR);
    expected += r.cgst + r.sgst;
  }
  const onLedger =
    ledger.balanceOf(A.CGST_OUTPUT) + ledger.balanceOf(A.SGST_OUTPUT);
  eq(onLedger, expected, 'GST on the ledger vs GST on the invoices');
});

check('no GST is charged when the config says it does not apply', () => {
  const noGst: AccountingConfig = { ...DEMO_CONFIG, gstOnMaintenance: false };
  const ledger = new Ledger();
  const r = billMaintenance(ledger, {
    flatNo: 'A-103', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-3',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
  }, noGst, ACTOR);
  eq(r.cgst, 0, 'CGST');
  eq(r.sgst, 0, 'SGST');
  eq(r.gross, R(5000), 'gross');
  eq(ledger.balanceOf(A.CGST_OUTPUT), 0, 'CGST account');
});

check('sinking contributions follow the configured treatment, not a default', () => {
  const direct = new Ledger();
  billMaintenance(direct, {
    flatNo: 'A-104', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-4',
    lines: [{ head: 'sinking', amount: R(1000), taxable: false }],
  }, { ...DEMO_CONFIG, sinkingFundThroughIncome: false }, ACTOR);
  eq(direct.balanceOf(A.SINKING_FUND), R(1000), 'fund credited directly');
  eq(direct.balanceOf(A.INC_SINKING_CONTRIBUTION), 0, 'income untouched');

  const viaIncome = new Ledger();
  billMaintenance(viaIncome, {
    flatNo: 'A-104', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-4',
    lines: [{ head: 'sinking', amount: R(1000), taxable: false }],
  }, { ...DEMO_CONFIG, sinkingFundThroughIncome: true }, ACTOR);
  eq(viaIncome.balanceOf(A.INC_SINKING_CONTRIBUTION), R(1000), 'income credited');
  eq(viaIncome.balanceOf(A.SINKING_FUND), 0, 'fund untouched');
});

check('an imported invoice keeps the tax it was issued with', () => {
  const ledger = new Ledger();
  // The demo's seed carries a ₹684 GST figure on a ₹3,800 taxable base, which
  // is 18% of something else entirely. Recomputing it would change what the
  // member was billed, so the stated figure must be posted as-is.
  const result = billMaintenance(ledger, {
    flatNo: 'A-101', period: 'May 2026', date: '2026-05-01', invoiceNo: 'GM-2026-05-A101',
    lines: [
      { head: 'maintenance', amount: R(2500), taxable: true },
      { head: 'sinking', amount: R(500), taxable: false },
      { head: 'maintenance', amount: R(300), taxable: true },
      { head: 'maintenance', amount: R(300), taxable: true },
      { head: 'other', amount: R(200), taxable: false },
    ],
    statedTax: R(684),
  }, DEMO_CONFIG, ACTOR);

  eq(result.cgst + result.sgst, R(684), 'the stated tax is what got posted');
  // 18% of the 3,100 taxable base would be 558, which is not what was issued.
  truthy(result.cgst + result.sgst !== percentOf(R(3100), 18), 'and it was not recomputed');
  eq(result.gross, R(4484), 'gross matches the issued invoice total');
  eq(ledger.balanceOf(A.CGST_OUTPUT) + ledger.balanceOf(A.SGST_OUTPUT), R(684), 'GST liability');
});

check('new billing computes its own tax rather than taking one', () => {
  const ledger = new Ledger();
  const result = billMaintenance(ledger, {
    flatNo: 'A-102', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-NEW',
    lines: [{ head: 'maintenance', amount: R(3100), taxable: true }],
  }, DEMO_CONFIG, ACTOR);
  eq(result.cgst + result.sgst, percentOf(R(3100), 18), 'computed at the configured rate');
  eq(result.gross, R(3100) + percentOf(R(3100), 18), 'gross');
});

// --- Partial payments and advances ---------------------------------------

suite('Partial payments preserve the outstanding balance');

check('a part payment leaves the remainder outstanding', () => {
  const ledger = new Ledger();
  // The exact case from the audit: ₹2,000 against a ₹10,620 bill.
  billMaintenance(ledger, {
    flatNo: 'B-204', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-P1',
    lines: [{ head: 'maintenance', amount: R(9000), taxable: true }],
  }, DEMO_CONFIG, ACTOR);
  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'B-204' }), R(10620), 'billed gross');

  const r = receiveFromMember(ledger, {
    flatNo: 'B-204', date: '2026-07-05', amount: R(2000),
    receiptNo: 'RCT-1', method: 'UPI',
  }, ACTOR);

  eq(r.appliedToDues, R(2000), 'applied');
  eq(r.heldAsAdvance, 0, 'advance');
  eq(r.outstandingAfter, R(8620), 'outstanding after');
  eq(memberPosition(ledger, 'B-204').dues, R(8620), 'position');
});

check('several part payments settle the bill exactly', () => {
  const ledger = new Ledger();
  billMaintenance(ledger, {
    flatNo: 'C-302', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-P2',
    lines: [{ head: 'maintenance', amount: R(3000), taxable: false }],
  }, DEMO_CONFIG, ACTOR);
  for (const [i, amount] of [1000, 1500, 500].entries()) {
    receiveFromMember(ledger, {
      flatNo: 'C-302', date: '2026-07-10', amount: R(amount),
      receiptNo: `RCT-P2-${i}`, method: 'NEFT',
    }, ACTOR);
  }
  eq(memberPosition(ledger, 'C-302').dues, 0, 'fully settled');
});

check('an overpayment becomes an advance, not a negative receivable', () => {
  const ledger = new Ledger();
  billMaintenance(ledger, {
    flatNo: 'D-404', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-P3',
    lines: [{ head: 'maintenance', amount: R(3000), taxable: false }],
  }, DEMO_CONFIG, ACTOR);

  const r = receiveFromMember(ledger, {
    flatNo: 'D-404', date: '2026-07-05', amount: R(5000),
    receiptNo: 'RCT-3', method: 'UPI',
  }, ACTOR);

  eq(r.appliedToDues, R(3000), 'applied to dues');
  eq(r.heldAsAdvance, R(2000), 'held as advance');
  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'D-404' }), 0, 'receivable is zero, not negative');
  eq(ledger.balanceOf(A.MEMBER_ADVANCE, { party: 'D-404' }), R(2000), 'advance liability');
});

check('a receipt with no dues outstanding is held entirely as an advance', () => {
  const ledger = new Ledger();
  const r = receiveFromMember(ledger, {
    flatNo: 'E-501', date: '2026-07-05', amount: R(4000),
    receiptNo: 'RCT-4', method: 'UPI',
  }, ACTOR);
  eq(r.heldAsAdvance, R(4000), 'all advance');
  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'E-501' }), 0, 'receivable untouched');
});

check('an advance applies against the next bill', () => {
  const ledger = new Ledger();
  receiveFromMember(ledger, {
    flatNo: 'E-502', date: '2026-07-05', amount: R(4000), receiptNo: 'RCT-5', method: 'UPI',
  }, ACTOR);
  billMaintenance(ledger, {
    flatNo: 'E-502', period: 'Aug 2026', date: '2026-08-01', invoiceNo: 'INV-P5',
    lines: [{ head: 'maintenance', amount: R(3000), taxable: false }],
  }, DEMO_CONFIG, ACTOR);

  const { applied } = applyAdvance(ledger, {
    flatNo: 'E-502', date: '2026-08-02', ref: 'ADJ-1',
  }, ACTOR);

  eq(applied, R(3000), 'applied');
  eq(memberPosition(ledger, 'E-502').dues, 0, 'dues cleared');
  eq(ledger.balanceOf(A.MEMBER_ADVANCE, { party: 'E-502' }), R(1000), 'advance remaining');
});

check('a zero-value receipt is rejected', () => {
  const ledger = new Ledger();
  throws(
    () => receiveFromMember(ledger, {
      flatNo: 'B-204', date: '2026-07-05', amount: 0, receiptNo: 'RCT-0', method: 'UPI',
    }, ACTOR),
    /must be positive/, 'zero receipt',
  );
});

// --- Vendor bills ---------------------------------------------------------

suite('Vendor bills book expense, payable and TDS');

check('booking a bill debits the expense and credits payable net of TDS', () => {
  const ledger = new Ledger();
  const r = bookVendorBill(ledger, {
    vendorId: 'V-1', vendorName: 'Force Aqua Tankers', billNo: 'FA-118',
    date: '2026-07-10', expenseAccount: A.EXP_WATER,
    gross: R(54000), tdsSection: '194C',
  }, DEMO_CONFIG, ACTOR);

  eq(r.tdsAmount, R(1080), 'TDS at 2%');
  eq(r.netPayable, R(52920), 'net payable');
  eq(ledger.balanceOf(A.EXP_WATER), R(54000), 'expense is the gross, not the net');
  eq(ledger.balanceOf(A.VENDOR_PAYABLE, { party: 'V-1' }), R(52920), 'payable');
  eq(ledger.balanceOf(A.TDS_PAYABLE_194C), R(1080), 'TDS liability');
});

check('booking a bill does not touch the bank', () => {
  const ledger = new Ledger();
  bookVendorBill(ledger, {
    vendorId: 'V-2', vendorName: 'Lift Co', billNo: 'LC-1',
    date: '2026-07-10', expenseAccount: A.EXP_LIFT, gross: R(15400), tdsSection: 'none',
  }, DEMO_CONFIG, ACTOR);
  eq(ledger.balanceOf(A.BANK_OPERATING), 0, 'bank untouched by a booking');
});

check('a subsequent payment clears the payable', () => {
  const ledger = new Ledger();
  postOpeningBalances(ledger, {
    date: '2026-06-30',
    debits: [{ account: A.BANK_OPERATING, amount: R(500000) }],
    credits: [{ account: A.GENERAL_RESERVE, amount: R(500000) }],
  }, ACTOR);
  const booked = bookVendorBill(ledger, {
    vendorId: 'V-3', vendorName: 'Secure Guards', billNo: 'SG-7',
    date: '2026-07-10', expenseAccount: A.EXP_SECURITY, gross: R(152600), tdsSection: '194C',
  }, DEMO_CONFIG, ACTOR);

  const paid = payVendorBill(ledger, {
    vendorId: 'V-3', vendorName: 'Secure Guards', date: '2026-07-15',
    amount: booked.netPayable, paymentRef: 'PAY-7',
  }, ACTOR);

  eq(paid.payableAfter, 0, 'payable cleared');
  eq(vendorPosition(ledger, 'V-3'), 0, 'vendor position');
  eq(ledger.balanceOf(A.BANK_OPERATING), R(500000) - booked.netPayable, 'bank reduced');
  // The TDS stays a liability until it is remitted.
  eq(ledger.balanceOf(A.TDS_PAYABLE_194C), booked.tdsAmount, 'TDS still payable');
});

check('a part payment to a vendor leaves the balance outstanding', () => {
  const ledger = new Ledger();
  const booked = bookVendorBill(ledger, {
    vendorId: 'V-4', vendorName: 'Paint Co', billNo: 'PC-1',
    date: '2026-07-10', expenseAccount: A.EXP_REPAIRS, gross: R(40000), tdsSection: 'none',
  }, DEMO_CONFIG, ACTOR);
  const paid = payVendorBill(ledger, {
    vendorId: 'V-4', vendorName: 'Paint Co', date: '2026-07-20',
    amount: R(15000), paymentRef: 'PAY-PC-1',
  }, ACTOR);
  eq(paid.payableAfter, R(25000), 'remaining payable');
  eq(booked.netPayable, R(40000), 'no TDS when the section is none');
});

check('paying more than the payable is rejected', () => {
  const ledger = new Ledger();
  bookVendorBill(ledger, {
    vendorId: 'V-5', vendorName: 'Glass Co', billNo: 'GC-1',
    date: '2026-07-10', expenseAccount: A.EXP_REPAIRS, gross: R(1000), tdsSection: 'none',
  }, DEMO_CONFIG, ACTOR);
  throws(
    () => payVendorBill(ledger, {
      vendorId: 'V-5', vendorName: 'Glass Co', date: '2026-07-20',
      amount: R(5000), paymentRef: 'PAY-GC-1',
    }, ACTOR),
    /exceeds the outstanding payable/, 'overpayment',
  );
});

check('remitting TDS clears the liability and cannot over-remit', () => {
  const ledger = new Ledger();
  postOpeningBalances(ledger, {
    date: '2026-06-30',
    debits: [{ account: A.BANK_OPERATING, amount: R(100000) }],
    credits: [{ account: A.GENERAL_RESERVE, amount: R(100000) }],
  }, ACTOR);
  bookVendorBill(ledger, {
    vendorId: 'V-6', vendorName: 'Tank Co', billNo: 'TC-1',
    date: '2026-07-10', expenseAccount: A.EXP_WATER, gross: R(50000), tdsSection: '194C',
  }, DEMO_CONFIG, ACTOR);
  eq(ledger.balanceOf(A.TDS_PAYABLE_194C), R(1000), 'liability before');

  throws(
    () => remitTds(ledger, {
      section: '194C', date: '2026-08-07', amount: R(2000), challanNo: 'CH-X',
    }, ACTOR),
    /exceeds the 194C liability/, 'over-remittance',
  );

  const r = remitTds(ledger, {
    section: '194C', date: '2026-08-07', amount: R(1000), challanNo: 'CH-1',
  }, ACTOR);
  eq(r.liabilityAfter, 0, 'liability cleared');
});

check('TDS larger than the bill is rejected', () => {
  const absurd: AccountingConfig = {
    ...DEMO_CONFIG,
    tds: { ...DEMO_CONFIG.tds, contractor194C: { rate: 150, effectiveFrom: '2024-04-01', basis: 'test' } },
  };
  throws(
    () => bookVendorBill(new Ledger(), {
      vendorId: 'V-7', vendorName: 'X', billNo: 'X-1', date: '2026-07-10',
      expenseAccount: A.EXP_REPAIRS, gross: R(1000), tdsSection: '194C',
    }, absurd, ACTOR),
    /exceeds the bill gross/, 'absurd TDS rate',
  );
});

// --- Reversals ------------------------------------------------------------

suite('Reversals keep the ledger whole');

check('a reversal mirrors the original and nets both to zero', () => {
  const ledger = new Ledger();
  const { entry } = billMaintenance(ledger, {
    flatNo: 'B-204', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-R1',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: true }],
  }, DEMO_CONFIG, ACTOR);

  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'B-204' }), R(5900), 'before reversal');

  const reversal = ledger.reverse(entry.id, {
    date: '2026-07-02', postedBy: 'selftest', reason: 'wrong period',
  });

  eq(ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, { party: 'B-204' }), 0, 'after reversal');
  eq(ledger.balanceOf(A.CGST_OUTPUT), 0, 'GST reversed too');
  eq(reversal.reversalOf, entry.id, 'back-reference');
  eq(ledger.get(entry.id)?.reversedBy, reversal.id, 'forward reference');
});

check('the original entry is never removed', () => {
  const ledger = new Ledger();
  const { entry } = billMaintenance(ledger, {
    flatNo: 'B-205', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-R2',
    lines: [{ head: 'maintenance', amount: R(1000), taxable: false }],
  }, DEMO_CONFIG, ACTOR);
  ledger.reverse(entry.id, { date: '2026-07-02', postedBy: 'selftest', reason: 'test' });
  eq(ledger.all().length, 2, 'both entries retained');
  truthy(ledger.get(entry.id) !== undefined, 'original still present');
});

check('an entry cannot be reversed twice', () => {
  const ledger = new Ledger();
  const { entry } = billMaintenance(ledger, {
    flatNo: 'B-206', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-R3',
    lines: [{ head: 'maintenance', amount: R(1000), taxable: false }],
  }, DEMO_CONFIG, ACTOR);
  ledger.reverse(entry.id, { date: '2026-07-02', postedBy: 'selftest', reason: 'first' });
  throws(
    () => ledger.reverse(entry.id, { date: '2026-07-03', postedBy: 'selftest', reason: 'second' }),
    /already reversed/, 'double reversal',
  );
});

check('a reversal cannot itself be reversed', () => {
  const ledger = new Ledger();
  const { entry } = billMaintenance(ledger, {
    flatNo: 'B-207', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-R4',
    lines: [{ head: 'maintenance', amount: R(1000), taxable: false }],
  }, DEMO_CONFIG, ACTOR);
  const rev = ledger.reverse(entry.id, { date: '2026-07-02', postedBy: 'selftest', reason: 'x' });
  throws(
    () => ledger.reverse(rev.id, { date: '2026-07-03', postedBy: 'selftest', reason: 'y' }),
    /is itself a reversal/, 'reversing a reversal',
  );
});

check('a reversal keeps the trial balance balanced', () => {
  const ledger = new Ledger();
  const { entry } = billMaintenance(ledger, {
    flatNo: 'B-208', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-R5',
    lines: [{ head: 'maintenance', amount: R(7777.77), taxable: true }],
  }, DEMO_CONFIG, ACTOR);
  ledger.reverse(entry.id, { date: '2026-07-02', postedBy: 'selftest', reason: 'x' });
  const tb = trialBalance(ledger, '2026-07-31');
  truthy(tb.balanced, `trial balance after reversal (out by ${tb.totalDebit - tb.totalCredit})`);
});

// --- A full period --------------------------------------------------------

/**
 * Builds one month of real activity, which the statement tests then read.
 * Every figure below is posted through the transaction builders; nothing is
 * asserted into the ledger by hand.
 */
function buildPeriod(): Ledger {
  const ledger = new Ledger();

  postOpeningBalances(ledger, {
    date: '2026-06-30',
    debits: [
      { account: A.BANK_OPERATING, amount: R(820000) },
      { account: A.MAINTENANCE_RECEIVABLE, amount: R(41238), party: 'OPENING' },
    ],
    credits: [
      { account: A.SINKING_FUND, amount: R(126000) },
      { account: A.GENERAL_RESERVE, amount: R(735238) },
    ],
  }, ACTOR);

  // Bill four flats.
  const flats = [
    { flat: 'B-204', maint: 2500, sinking: 500 },
    { flat: 'A-101', maint: 2500, sinking: 500 },
    { flat: 'C-302', maint: 3000, sinking: 600 },
    { flat: 'D-404', maint: 2800, sinking: 560 },
  ];
  for (const f of flats) {
    billMaintenance(ledger, {
      flatNo: f.flat, period: 'Jul 2026', date: '2026-07-01',
      invoiceNo: `GM-2026-07-${f.flat.replace('-', '')}`,
      lines: [
        { head: 'maintenance', amount: R(f.maint), taxable: true },
        { head: 'sinking', amount: R(f.sinking), taxable: false },
      ],
    }, DEMO_CONFIG, ACTOR);
  }

  // A receipt on the first day of the period, which is what makes the
  // opening-cash boundary testable.
  receiveFromMember(ledger, {
    flatNo: 'D-404', date: '2026-07-01', amount: R(1500),
    receiptNo: 'RCT-100', method: 'UPI',
  }, ACTOR);

  // Collect: one in full, one part, one overpaying.
  receiveFromMember(ledger, {
    flatNo: 'B-204', date: '2026-07-06', amount: R(3450),
    receiptNo: 'RCT-101', method: 'UPI',
  }, ACTOR);
  receiveFromMember(ledger, {
    flatNo: 'A-101', date: '2026-07-08', amount: R(2000),
    receiptNo: 'RCT-102', method: 'NEFT',
  }, ACTOR);
  receiveFromMember(ledger, {
    flatNo: 'C-302', date: '2026-07-09', amount: R(6000),
    receiptNo: 'RCT-103', method: 'UPI',
  }, ACTOR);

  // Vendor bills, then pay one.
  const water = bookVendorBill(ledger, {
    vendorId: 'V-WATER', vendorName: 'Force Aqua Tankers', billNo: 'FA-118',
    date: '2026-07-10', expenseAccount: A.EXP_WATER, gross: R(49000), tdsSection: '194C',
  }, DEMO_CONFIG, ACTOR);
  bookVendorBill(ledger, {
    vendorId: 'V-GUARD', vendorName: 'Secure Guards', billNo: 'SG-07',
    date: '2026-07-12', expenseAccount: A.EXP_SECURITY, gross: R(152600), tdsSection: '194C',
  }, DEMO_CONFIG, ACTOR);
  payVendorBill(ledger, {
    vendorId: 'V-WATER', vendorName: 'Force Aqua Tankers', date: '2026-07-18',
    amount: water.netPayable, paymentRef: 'PAY-FA-118',
  }, ACTOR);

  // Funds and a deposit.
  transferToSinkingFundBank(ledger, { date: '2026-07-20', amount: R(60000), ref: 'SF-JUL' }, ACTOR);
  placeFixedDeposit(ledger, { date: '2026-07-21', amount: R(50000), fdRef: 'FD-2026-01' }, ACTOR);

  return ledger;
}

suite('Statements derive from the ledger');

const period = buildPeriod();
const FROM = '2026-07-01';
const TO = '2026-07-31';

check('trial balance debits equal credits', () => {
  const tb = trialBalance(period, TO);
  truthy(tb.rows.length > 0, 'the trial balance has rows');
  // Assert the arithmetic, not the flag the code sets: a `balanced` field
  // hardcoded true would otherwise satisfy this test.
  eq(tb.totalDebit, tb.totalCredit, 'gross debits vs gross credits');
  const rowDebits = tb.rows.reduce((a, r) => a + r.debit, 0);
  const rowCredits = tb.rows.reduce((a, r) => a + r.credit, 0);
  eq(rowDebits, tb.totalDebit, 'rows sum to the debit total');
  eq(rowCredits, tb.totalCredit, 'rows sum to the credit total');
  eq(tb.balanced, tb.totalDebit === tb.totalCredit, 'the flag agrees with the arithmetic');
});

check('the balanced test actually distinguishes balanced from not', () => {
  // On engine-produced data debits always equal credits, so `balanced: true`
  // hardcoded would satisfy every other test here. Call the predicate with
  // figures that do not tie.
  truthy(debitsEqualCredits({ totalDebit: 1000, totalCredit: 1000 }), 'equal totals');
  truthy(!debitsEqualCredits({ totalDebit: 1000, totalCredit: 999 }), 'one paisa short');
  truthy(!debitsEqualCredits({ totalDebit: 0, totalCredit: 1 }), 'nothing against something');
  const tb = trialBalance(period, TO);
  eq(tb.balanced, debitsEqualCredits(tb), 'the report uses this predicate');
});

check('the netted trial balance also ties', () => {
  const tb = trialBalance(period, TO);
  eq(tb.totalNetDebit, tb.totalNetCredit, 'net debits vs net credits');
  for (const r of tb.rows) {
    truthy(r.netDebit === 0 || r.netCredit === 0, `${r.account.code} nets to one side only`);
    eq(r.netDebit - r.netCredit, r.debit - r.credit, `${r.account.code} net equals gross movement`);
  }
});

check('an opening balance is not reported as a receipt of the period', () => {
  // With the period widened to contain the opening entry, its cash must show
  // as opening cash rather than as a receipt against the general reserve.
  const wide = receiptsAndPayments(period, '2026-06-01', TO);
  eq(wide.openingCash, R(820000), 'opening cash still the opening bank balance');
  const labels = wide.receipts.map(r => r.label);
  truthy(!labels.includes('General reserve (accumulated surplus)'),
    'opening capital must not appear as a receipt');
  eq(wide.openingCash + wide.totalReceipts - wide.totalPayments, wide.closingCash, 'still closes');
});

check('no account sits on the wrong side', () => {
  const tb = trialBalance(period, TO);
  if (tb.contraNormal.length > 0) {
    throw new Error(
      'contra-normal balances: ' +
      tb.contraNormal.map(a => `${a.code} ${a.name}`).join(', '),
    );
  }
});

check('balance sheet assets equal liabilities plus funds plus surplus', () => {
  const bs = balanceSheet(period, TO);
  truthy(bs.balanced, `out by ${bs.difference} paise`);
  eq(bs.totalAssets, bs.totalLiabilitiesAndFunds, 'the identity');
});

check('the balance sheet reports an imbalance instead of hiding it', () => {
  // Every entry the engine posts balances, so a real ledger always ties. That
  // means a `balanced` flag hardcoded to true, or a difference plugged to
  // zero, would pass every other test here. Feed the arithmetic a set of
  // balances that does not tie and check it says so.
  const skewed = new Map(netBalances(period, TO));
  skewed.set(A.BANK_OPERATING, (skewed.get(A.BANK_OPERATING) ?? 0) + R(100000));

  const bs = assembleBalanceSheet(skewed, TO);
  truthy(!bs.balanced, 'an imbalance must be reported, not absorbed');
  eq(bs.difference, R(100000), 'the reported difference is the real gap');
  eq(bs.totalAssets - bs.totalLiabilitiesAndFunds, bs.difference, 'difference is derived from the totals');

  // And the other direction: understating assets is caught too.
  const short = new Map(netBalances(period, TO));
  short.set(A.SINKING_FUND, (short.get(A.SINKING_FUND) ?? 0) + R(5000));
  const bs2 = assembleBalanceSheet(short, TO);
  truthy(!bs2.balanced, 'an imbalance the other way must also be reported');
  eq(bs2.difference, -R(5000), 'signed difference');
});

check('reconciliation fails when a statement does not tie', () => {
  // The same seam, one level up: a reconciliation that cannot fail is not a
  // reconciliation. Drop a fund balance and the identity check must break.
  const skewed = new Map(netBalances(period, TO));
  skewed.delete(A.SINKING_FUND);
  const bs = assembleBalanceSheet(skewed, TO);
  truthy(!bs.balanced, 'dropping a whole class of balance must show up');
  truthy(bs.difference !== 0, 'and the difference must be non-zero');
});

check('the balance sheet counts every class of account', () => {
  // A class silently omitted from the statement would still "balance" if the
  // difference were plugged, so check each class reaches a line.
  const bs = balanceSheet(period, TO);
  truthy(bs.assets.length > 0, 'assets are presented');
  truthy(bs.liabilities.length > 0, 'liabilities are presented');
  truthy(bs.funds.length > 0, 'funds are presented');
  const assetFromLines = bs.assets.reduce((a, l) => a + l.total, 0);
  eq(assetFromLines, bs.totalAssets, 'asset lines sum to the asset total');
  const liabFromLines = bs.liabilities.reduce((a, l) => a + l.total, 0);
  const fundFromLines = bs.funds.reduce((a, l) => a + l.total, 0);
  eq(liabFromLines + fundFromLines + bs.surplusForPeriod, bs.totalLiabilitiesAndFunds,
     'liability + fund lines plus surplus sum to the credit-side total');
});

check('expenditure actually reaches Income & Expenditure', () => {
  const ie = incomeAndExpenditure(period, FROM, TO);
  // The defect this replaces: expenditure was always zero.
  truthy(ie.totalExpenditure > 0, 'non-zero expenditure');
  eq(ie.totalExpenditure, R(49000) + R(152600), 'both vendor bills, at gross');
  eq(ie.surplus, ie.totalIncome - ie.totalExpenditure, 'surplus is income less expenditure');
});

check('Income & Expenditure is internally consistent', () => {
  const ie = incomeAndExpenditure(period, FROM, TO);
  const incomeFromLines = ie.income.reduce((a, l) => a + l.total, 0);
  const expFromLines = ie.expenditure.reduce((a, l) => a + l.total, 0);
  eq(incomeFromLines, ie.totalIncome, 'income lines sum to the total');
  eq(expFromLines, ie.totalExpenditure, 'expenditure lines sum to the total');
  eq(ie.totalIncome - ie.totalExpenditure, ie.surplus, 'no figure dropped between the lines and the surplus');
});

check('Receipts & Payments closes to the real cash balance', () => {
  const rp = receiptsAndPayments(period, FROM, TO);
  // Recomputed here rather than trusting rp.reconciles, so a hardcoded flag
  // fails this test.
  eq(rp.openingCash + rp.totalReceipts - rp.totalPayments, rp.closingCash,
     'opening + receipts - payments vs closing cash');
  eq(rp.openingCash, R(820000), 'opening cash from the opening entry');
  eq(rp.reconciles, cashFlowCloses(rp), 'the report uses the shared predicate');
  // The line totals must also sum to the stated totals.
  eq(rp.receipts.reduce((a, r) => a + r.amount, 0), rp.totalReceipts, 'receipt lines');
  eq(rp.payments.reduce((a, p) => a + p.amount, 0), rp.totalPayments, 'payment lines');
});

check('the cash-flow test actually distinguishes closing from not', () => {
  truthy(cashFlowCloses({ openingCash: 1000, totalReceipts: 500, totalPayments: 200, closingCash: 1300 }), 'ties');
  truthy(!cashFlowCloses({ openingCash: 1000, totalReceipts: 500, totalPayments: 200, closingCash: 1299 }), 'a paisa out');
  truthy(!cashFlowCloses({ openingCash: 0, totalReceipts: 0, totalPayments: 0, closingCash: 1 }), 'cash from nowhere');
});

check('opening cash excludes movements inside the period', () => {
  // `buildPeriod` posts a receipt dated on the first day of the period. If
  // opening cash were read at `from` rather than the day before, that receipt
  // would be counted twice — once in the opening figure and once as a receipt.
  const rp = receiptsAndPayments(period, FROM, TO);
  const firstDayReceipt = R(1500);
  eq(rp.openingCash, R(820000), 'opening excludes the first-day receipt');
  truthy(rp.totalReceipts >= firstDayReceipt, 'and the first-day receipt is counted as a receipt');
  eq(rp.openingCash + rp.totalReceipts - rp.totalPayments, rp.closingCash, 'still closes');
});

check('a transfer between two bank accounts is not a receipt or a payment', () => {
  const rp = receiptsAndPayments(period, FROM, TO);
  const labels = [...rp.receipts, ...rp.payments].map(r => r.label);
  truthy(!labels.includes('Bank — sinking fund account'),
    'an internal transfer should not appear as a receipt or payment');
});

check('all three statements reconcile with each other and the ledger', () => {
  const result = reconcile(period, '2026-06-01', TO);
  const failed = result.checks.filter(c => !c.passed);
  if (failed.length > 0) {
    throw new Error(failed.map(c => `${c.name}: ${c.detail}`).join('; '));
  }
  truthy(result.allPassed, 'every reconciliation check');
});

check('the general ledger running balance ends at the account balance', () => {
  for (const code of [A.BANK_OPERATING, A.MAINTENANCE_RECEIVABLE, A.EXP_WATER, A.SINKING_FUND]) {
    const rows = period.generalLedger(code, { to: TO });
    const last = rows.length === 0 ? 0 : rows[rows.length - 1].runningBalance;
    eq(last, period.balanceOf(code, { to: TO }), `running balance for ${code}`);
  }
});

check('the receivable subledger sums to the control account', () => {
  const sub = period.subledger(A.MAINTENANCE_RECEIVABLE, { to: TO });
  const total = [...sub.values()].reduce((a, b) => a + b, 0);
  eq(total, period.balanceOf(A.MAINTENANCE_RECEIVABLE, { to: TO }), 'subledger vs control');
});

check('the vendor subledger sums to the control account', () => {
  const sub = period.subledger(A.VENDOR_PAYABLE, { to: TO });
  const total = [...sub.values()].reduce((a, b) => a + b, 0);
  eq(total, period.balanceOf(A.VENDOR_PAYABLE, { to: TO }), 'subledger vs control');
});

check('a non-control account has no subledger', () => {
  throws(
    () => period.subledger(A.BANK_OPERATING),
    /not a control account/, 'subledger on a plain account',
  );
});

check('the identity survives a reversal mid-period', () => {
  const ledger = buildPeriod();
  const target = ledger.all().find(e => e.source.kind === 'vendor-bill');
  if (!target) throw new Error('no vendor bill to reverse');
  ledger.reverse(target.id, { date: '2026-07-25', postedBy: 'selftest', reason: 'duplicate bill' });

  const tb = trialBalance(ledger, TO);
  const bs = balanceSheet(ledger, TO);
  truthy(tb.balanced, `trial balance out by ${tb.totalDebit - tb.totalCredit}`);
  truthy(bs.balanced, `balance sheet out by ${bs.difference}`);
  const result = reconcile(ledger, '2026-06-01', TO);
  truthy(result.allPassed, result.checks.filter(c => !c.passed).map(c => c.name).join(', '));
});

// --- Budget ---------------------------------------------------------------

suite('Budget against actuals');

check('actuals come from the ledger, not from a literal', () => {
  const rows = budgetVsActual(period, DEMO_BUDGET, FROM, TO);
  const water = rows.find(r => r.head === 'Water supply');
  if (!water) throw new Error('no water row');
  // buildPeriod books a water bill of 49,000 at gross.
  eq(water.actual, R(49000), 'water actual read from the ledger');
  const security = rows.find(r => r.head === 'Security services');
  eq(security?.actual, R(152600), 'security actual read from the ledger');
});

check('variance always agrees with its own budget and actual', () => {
  for (const r of budgetVsActual(period, DEMO_BUDGET, FROM, TO)) {
    eq(r.variance, r.actual - r.budgeted, `${r.head} variance`);
    if (r.budgeted === 0) {
      eq(r.variancePercent, null, `${r.head} percent undefined`);
    } else {
      const expected = ((r.actual - r.budgeted) / r.budgeted) * 100;
      if (Math.abs((r.variancePercent ?? 0) - expected) > 1e-9) {
        throw new Error(`${r.head}: percent ${r.variancePercent} vs ${expected}`);
      }
    }
  }
});

check('the exact arithmetic the old screen got wrong', () => {
  // The demo printed -16.03% for 21,000 realised against 25,000 budgeted.
  const ledger = new Ledger();
  bookVendorBill(ledger, {
    vendorId: 'V-PARK', vendorName: 'Parking Co', billNo: 'PK-1',
    date: '2026-07-05', expenseAccount: A.EXP_REPAIRS, gross: R(21000), tdsSection: 'none',
  }, DEMO_CONFIG, ACTOR);
  const rows = budgetVsActual(ledger, [
    { head: 'Covered parking', accounts: [A.EXP_REPAIRS], budgeted: R(25000) },
  ], '2026-07-01', '2026-07-31');
  eq(rows[0].actual, R(21000), 'actual');
  eq(rows[0].variancePercent, -16, 'minus sixteen per cent exactly, not -16.03');
});

check('income over budget is favourable, spending over budget is not', () => {
  const ledger = new Ledger();
  billMaintenance(ledger, {
    flatNo: 'Z-1', period: 'Jul 2026', date: '2026-07-01', invoiceNo: 'INV-B1',
    lines: [{ head: 'maintenance', amount: R(12000), taxable: false }],
  }, DEMO_CONFIG, ACTOR);
  bookVendorBill(ledger, {
    vendorId: 'V-Z', vendorName: 'Z', billNo: 'Z-1', date: '2026-07-02',
    expenseAccount: A.EXP_WATER, gross: R(12000), tdsSection: 'none',
  }, DEMO_CONFIG, ACTOR);

  const rows = budgetVsActual(ledger, [
    { head: 'Maintenance charges', accounts: [A.INC_MAINTENANCE], budgeted: R(10000) },
    { head: 'Water supply', accounts: [A.EXP_WATER], budgeted: R(10000) },
  ], '2026-07-01', '2026-07-31');

  const income = rows[0];
  const spend = rows[1];
  eq(income.variance, R(2000), 'income over by 2,000');
  eq(spend.variance, R(2000), 'spending over by 2,000');
  truthy(income.favourable, 'collecting more than budgeted is good news');
  truthy(!spend.favourable, 'spending more than budgeted is not');
  eq(income.kind, 'income');
  eq(spend.kind, 'expenditure');
});

// --- Config -------------------------------------------------------------

suite('Config is explicit about what is unverified');

check('an unreviewed config cannot be used for a final statement', () => {
  throws(() => assertConfigReviewed(DEMO_CONFIG), /has not been reviewed/, 'demo config');
  const reviewed: AccountingConfig = {
    ...DEMO_CONFIG, reviewedBy: 'A CA', reviewedOn: '2026-10-21',
  };
  assertConfigReviewed(reviewed); // must not throw
});

check('financial year bounds', () => {
  eq(financialYearOf('2026-07-15', DEMO_CONFIG).label, 'FY26-27');
  eq(financialYearOf('2026-03-31', DEMO_CONFIG).label, 'FY25-26');
  eq(financialYearOf('2026-04-01', DEMO_CONFIG).from, '2026-04-01');
  eq(financialYearOf('2026-04-01', DEMO_CONFIG).to, '2027-03-31');
});

// --- Report -------------------------------------------------------------

console.log('\n' + '='.repeat(66));
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log('  - ' + f);
}
console.log('='.repeat(66));

// Non-zero exit so CI and `npm run` fail on a regression.
if (failures.length > 0) {
  if (typeof process !== 'undefined') process.exitCode = 1;
}
