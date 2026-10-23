/**
 * Prints one month of postings and the three statements, so the engine's
 * output can be read rather than inferred from test names.
 *
 * Run with: npm run demo:accounting
 */

import { formatRupees, fromRupees } from './money';
import { A, account } from './accounts';
import { Ledger } from './journal';
import { DEMO_CONFIG, outstandingConfirmations } from './config';
import {
  balanceSheet, incomeAndExpenditure, receiptsAndPayments, reconcile, trialBalance,
} from './reports';
import {
  billMaintenance, bookVendorBill, memberPosition, payVendorBill,
  postOpeningBalances, receiveFromMember, transferToSinkingFundBank,
} from './transactions';

const R = fromRupees;
const ACTOR = { postedBy: 'demo' };
const pad = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
const money = (p: number) => formatRupees(p).padStart(14);
const rule = (n = 78) => console.log('─'.repeat(n));

const ledger = new Ledger();

postOpeningBalances(ledger, {
  date: '2026-06-30',
  debits: [
    { account: A.BANK_OPERATING, amount: R(820000) },
    { account: A.MAINTENANCE_RECEIVABLE, amount: R(41238), party: 'OPENING-ARREARS' },
  ],
  credits: [
    { account: A.SINKING_FUND, amount: R(126000) },
    { account: A.GENERAL_RESERVE, amount: R(735238) },
  ],
}, ACTOR);

for (const f of [
  { flat: 'B-204', maint: 2500, sinking: 500 },
  { flat: 'A-101', maint: 2500, sinking: 500 },
  { flat: 'C-302', maint: 3000, sinking: 600 },
]) {
  billMaintenance(ledger, {
    flatNo: f.flat, period: 'Jul 2026', date: '2026-07-01',
    invoiceNo: `GM-2026-07-${f.flat.replace('-', '')}`,
    lines: [
      { head: 'maintenance', amount: R(f.maint), taxable: true },
      { head: 'sinking', amount: R(f.sinking), taxable: false },
    ],
  }, DEMO_CONFIG, ACTOR);
}

receiveFromMember(ledger, { flatNo: 'B-204', date: '2026-07-06', amount: R(3450), receiptNo: 'RCT-101', method: 'UPI' }, ACTOR);
receiveFromMember(ledger, { flatNo: 'A-101', date: '2026-07-08', amount: R(2000), receiptNo: 'RCT-102', method: 'NEFT' }, ACTOR);
receiveFromMember(ledger, { flatNo: 'C-302', date: '2026-07-09', amount: R(6000), receiptNo: 'RCT-103', method: 'UPI' }, ACTOR);

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
transferToSinkingFundBank(ledger, { date: '2026-07-20', amount: R(60000), ref: 'SF-JUL' }, ACTOR);

// --- Journal --------------------------------------------------------------

console.log('\nJOURNAL');
rule();
for (const e of ledger.all()) {
  console.log(`${e.id}  ${e.date}  ${e.narration}`);
  for (const p of e.postings) {
    const side = p.debit > 0 ? 'Dr' : 'Cr';
    const amt = p.debit > 0 ? p.debit : p.credit;
    const party = p.party ? ` [${p.party}]` : '';
    console.log(`          ${side} ${pad(p.accountCode + ' ' + account(p.accountCode).name + party, 48)}${money(amt)}`);
  }
}

// --- Trial balance --------------------------------------------------------

const TO = '2026-07-31';
const FROM = '2026-07-01';
const tb = trialBalance(ledger, TO);

console.log('\nTRIAL BALANCE as at ' + TO);
rule();
console.log(pad('', 44) + '         Debit        Credit');
for (const r of tb.rows) {
  console.log(pad(r.account.code + '  ' + r.account.name, 44) + money(r.debit) + money(r.credit));
}
rule();
console.log(pad('TOTAL', 44) + money(tb.totalDebit) + money(tb.totalCredit));
console.log(`balanced: ${tb.balanced}` + (tb.contraNormal.length > 0
  ? `; on the wrong side: ${tb.contraNormal.map(a => a.code).join(', ')}` : '; none on the wrong side'));

// --- Income & Expenditure -------------------------------------------------

const ie = incomeAndExpenditure(ledger, FROM, TO);
console.log(`\nINCOME & EXPENDITURE  ${FROM} to ${TO}   (accrual)`);
rule();
console.log('INCOME');
for (const l of ie.income) {
  console.log('  ' + pad(l.group, 50) + money(l.total));
}
console.log('  ' + pad('Total income', 50) + money(ie.totalIncome));
console.log('EXPENDITURE');
for (const l of ie.expenditure) {
  console.log('  ' + pad(l.group, 50) + money(l.total));
}
console.log('  ' + pad('Total expenditure', 50) + money(ie.totalExpenditure));
rule();
console.log('  ' + pad(ie.surplus >= 0 ? 'SURPLUS' : 'DEFICIT', 50) + money(ie.surplus));
console.log(`  check: ${formatRupees(ie.totalIncome)} - ${formatRupees(ie.totalExpenditure)} = ${formatRupees(ie.totalIncome - ie.totalExpenditure)}`);

// --- Receipts & Payments --------------------------------------------------

const rp = receiptsAndPayments(ledger, FROM, TO);
console.log(`\nRECEIPTS & PAYMENTS  ${FROM} to ${TO}   (cash)`);
rule();
console.log('  ' + pad('Opening cash and bank', 50) + money(rp.openingCash));
console.log('RECEIPTS');
for (const r of rp.receipts) console.log('  ' + pad(r.label, 50) + money(r.amount));
console.log('  ' + pad('Total receipts', 50) + money(rp.totalReceipts));
console.log('PAYMENTS');
for (const p of rp.payments) console.log('  ' + pad(p.label, 50) + money(p.amount));
console.log('  ' + pad('Total payments', 50) + money(rp.totalPayments));
rule();
console.log('  ' + pad('Closing cash and bank', 50) + money(rp.closingCash));
console.log(`  check: ${formatRupees(rp.openingCash)} + ${formatRupees(rp.totalReceipts)} - ${formatRupees(rp.totalPayments)} = ${formatRupees(rp.openingCash + rp.totalReceipts - rp.totalPayments)}  (reconciles: ${rp.reconciles})`);

// --- Balance sheet --------------------------------------------------------

const bs = balanceSheet(ledger, TO);
console.log(`\nBALANCE SHEET as at ${TO}`);
rule();
console.log('ASSETS');
for (const l of bs.assets) {
  console.log('  ' + pad(l.group, 50) + money(l.total));
  for (const a of l.accounts) console.log('      ' + pad(a.account.name, 46) + money(a.amount));
}
console.log('  ' + pad('TOTAL ASSETS', 50) + money(bs.totalAssets));
console.log('LIABILITIES');
for (const l of bs.liabilities) {
  console.log('  ' + pad(l.group, 50) + money(l.total));
  for (const a of l.accounts) console.log('      ' + pad(a.account.name, 46) + money(a.amount));
}
console.log('  ' + pad('Total liabilities', 50) + money(bs.totalLiabilities));
console.log('FUNDS');
for (const l of bs.funds) {
  for (const a of l.accounts) console.log('      ' + pad(a.account.name, 46) + money(a.amount));
}
console.log('  ' + pad('Total funds', 50) + money(bs.totalFunds));
console.log('  ' + pad('Surplus for the period', 50) + money(bs.surplusForPeriod));
rule();
console.log('  ' + pad('TOTAL LIABILITIES, FUNDS AND SURPLUS', 50) + money(bs.totalLiabilitiesAndFunds));
console.log(`  balanced: ${bs.balanced}   difference: ${formatRupees(bs.difference, { paise: true })}`);

// --- Member positions -----------------------------------------------------

console.log('\nMEMBER POSITIONS');
rule();
console.log(pad('Flat', 12) + '          Dues       Advance           Net');
for (const flat of ['B-204', 'A-101', 'C-302', 'OPENING-ARREARS']) {
  const pos = memberPosition(ledger, flat, TO);
  console.log(pad(flat, 12) + money(pos.dues) + money(pos.advance) + money(pos.net));
}

// --- Reconciliation -------------------------------------------------------

const rec = reconcile(ledger, '2026-06-01', TO);
console.log('\nRECONCILIATION');
rule();
for (const c of rec.checks) {
  console.log(`  ${c.passed ? 'ok  ' : 'FAIL'}  ${pad(c.name, 46)} ${c.detail}`);
}
console.log(`\n  all checks passed: ${rec.allPassed}`);

console.log('\nSTILL TO BE CONFIRMED BY A CA');
rule();
for (const line of outstandingConfirmations(DEMO_CONFIG)) console.log('  - ' + line);
console.log();
