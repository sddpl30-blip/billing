#!/usr/bin/env node
/**
 * Constraint tests for migration 003: the rest of the domain.
 *
 * Same discipline as schema.test.mjs — every case runs in a transaction that
 * is rolled back, and `SET CONSTRAINTS ALL IMMEDIATE` forces the deferred
 * triggers so nothing has to be committed to be checked.
 *
 *   PGHOST=... PGDATABASE=... node server/schema-domain.test.mjs
 */

import { spawnSync } from 'node:child_process';

function psql(text) {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  const r = spawnSync('psql', [
      // A URL where one is configured, so these checks run against a hosted
    // database — over TLS, with the sslmode the URL asks for — as well as
    // against a local socket.
    ...(url === undefined || url === '' ? [] : [url]),
    '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
    '--set', 'ON_ERROR_STOP=1', '--command', text,
  ], { encoding: 'utf8', shell: false });
  if (r.error) throw new Error(`psql: ${r.error.message}`);
  return { ok: r.status === 0, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
}

let passed = 0;
const failures = [];
let suiteName = '';
const suite = (n) => { suiteName = n; console.log(`\n${n}`); };
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) {
    failures.push(`${suiteName} / ${name}\n       ${err.message}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}
function expectRejected(label, body, matching) {
  const r = psql(`BEGIN;\n${body}\nSET CONSTRAINTS ALL IMMEDIATE;\nROLLBACK;`);
  if (r.ok) throw new Error(`${label}: the database accepted it`);
  if (!matching.test(r.out)) throw new Error(`${label}: rejected, but with "${r.out.split('\n')[0]}"`);
}
function expectAccepted(label, body) {
  const r = psql(`BEGIN;\n${body}\nSET CONSTRAINTS ALL IMMEDIATE;\nROLLBACK;`);
  if (!r.ok) throw new Error(`${label}: ${r.out.split('\n').slice(0, 3).join(' | ')}`);
}

// --- fixture --------------------------------------------------------------

const S = '11111111-1111-1111-1111-111111111111';
const FLAT = '22222222-2222-2222-2222-222222222222';
const U1 = '33333333-3333-3333-3333-333333333331';
const U2 = '33333333-3333-3333-3333-333333333332';
const VENDOR = '44444444-4444-4444-4444-444444444444';
const BANK = '55555555-5555-5555-5555-555555555555';
const DOC = '66666666-6666-6666-6666-666666666666';
const PAY = '77777777-7777-7777-7777-777777777777';

const BASE = `
INSERT INTO societies (id, name, mode) VALUES ('${S}', 'Test', 'demo');
INSERT INTO accounts (society_id, code, name, class, grp, is_cash, control) VALUES
  ('${S}', '1000', 'Bank', 'asset', 'Cash and bank', true, NULL),
  ('${S}', '1100', 'Receivable', 'asset', 'Receivables', false, 'resident'),
  ('${S}', '2000', 'Vendor payable', 'liability', 'Payables', false, 'vendor'),
  ('${S}', '3000', 'Sinking fund', 'fund', 'Funds', false, NULL),
  ('${S}', '4000', 'Maintenance', 'income', 'Maintenance', false, NULL),
  ('${S}', '5000', 'Water', 'expenditure', 'Utilities', false, NULL);
INSERT INTO flats (id, society_id, flat_no, billing_area_sqft, area_basis)
  VALUES ('${FLAT}', '${S}', 'A-101', 1750, 'super-built-up');
INSERT INTO users (id, society_id, email) VALUES
  ('${U1}', '${S}', 'maker@example.test'),
  ('${U2}', '${S}', 'checker@example.test');
INSERT INTO vendors (id, society_id, name, category, tds_section, payee_kind)
  VALUES ('${VENDOR}', '${S}', 'Force Aqua', 'Water tankers', '194C', 'company');
INSERT INTO bank_accounts (id, society_id, label, bank_name, account_last4, ifsc, ledger_account, purpose)
  VALUES ('${BANK}', '${S}', 'Operating', 'SBI', '4321', 'SBIN0001234', '1000', 'operating');
`;

const DOCUMENT = `
INSERT INTO billing_documents
  (id, society_id, proforma_no, flat_id, period, estimated_tax, gross, issued_on, due_on, state, approved_by)
VALUES ('${DOC}', '${S}', 'PI-1', '${FLAT}', 'Jul 2026', 141750, 929250,
        '2026-07-01', '2026-07-11', 'approved', '${U2}');
`;

const payment = (amount, allocations) => `
INSERT INTO payments
  (id, society_id, receipt_no, flat_id, received_on, amount, method, idempotency_key)
VALUES ('${PAY}', '${S}', 'RCT-1', '${FLAT}', '2026-07-05', ${amount}, 'UPI', 'receipt:RCT-1');
${allocations}
`;

// --- receipt allocations --------------------------------------------------

suite('A receipt must be fully allocated');

check('allocations that add up to the payment are accepted', () => {
  expectAccepted('full allocation', BASE + DOCUMENT + payment(929250, `
INSERT INTO receipt_allocations (payment_id, document_id, amount, head) VALUES
  ('${PAY}', '${DOC}', 929250, 'maintenance');
`));
});

check('a part payment plus an advance slice is accepted', () => {
  expectAccepted('part plus advance', BASE + DOCUMENT + payment(1000000, `
INSERT INTO receipt_allocations (payment_id, document_id, amount, head) VALUES
  ('${PAY}', '${DOC}', 929250, 'maintenance'),
  ('${PAY}', NULL, 70750, NULL);
`));
});

check('allocations that fall short of the payment are rejected', () => {
  expectRejected('under-allocated', BASE + DOCUMENT + payment(929250, `
INSERT INTO receipt_allocations (payment_id, document_id, amount, head) VALUES
  ('${PAY}', '${DOC}', 500000, 'maintenance');
`), /allocations total .*\(out by/);
});

check('allocations that exceed the payment are rejected', () => {
  expectRejected('over-allocated', BASE + DOCUMENT + payment(500000, `
INSERT INTO receipt_allocations (payment_id, document_id, amount, head) VALUES
  ('${PAY}', '${DOC}', 929250, 'maintenance');
`), /allocations total .*\(out by/);
});

check('a payment with no allocations at all is rejected', () => {
  expectRejected('unallocated', BASE + DOCUMENT + payment(929250, ''),
    /allocations total 0|out by/);
});

check('a receipt number cannot repeat within a society', () => {
  expectRejected('duplicate receipt no', BASE + DOCUMENT + payment(929250, `
INSERT INTO receipt_allocations (payment_id, document_id, amount) VALUES ('${PAY}', '${DOC}', 929250);
INSERT INTO payments (society_id, receipt_no, flat_id, received_on, amount, method, idempotency_key)
VALUES ('${S}', 'RCT-1', '${FLAT}', '2026-07-06', 100, 'UPI', 'receipt:RCT-2');
`), /payments_society_id_receipt_no_key|duplicate key value/);
});

check('a payment idempotency key cannot repeat within a society', () => {
  expectRejected('duplicate idempotency key', BASE + DOCUMENT + payment(929250, `
INSERT INTO receipt_allocations (payment_id, document_id, amount) VALUES ('${PAY}', '${DOC}', 929250);
INSERT INTO payments (society_id, receipt_no, flat_id, received_on, amount, method, idempotency_key)
VALUES ('${S}', 'RCT-2', '${FLAT}', '2026-07-06', 100, 'UPI', 'receipt:RCT-1');
`), /payments_society_id_idempotency_key_key|duplicate key value/);
});

check('a payment cannot be deleted', () => {
  const r = psql(`BEGIN;
${BASE}${DOCUMENT}${payment(929250, `INSERT INTO receipt_allocations (payment_id, document_id, amount) VALUES ('${PAY}', '${DOC}', 929250);`)}
SET CONSTRAINTS ALL IMMEDIATE;
DELETE FROM payments WHERE id = '${PAY}';
SELECT count(*) FROM payments WHERE id = '${PAY}';
ROLLBACK;`);
  if (!r.ok) throw new Error(r.out);
  const lines = r.out.split('\n').filter(l => l.trim() !== '');
  if (lines[lines.length - 1] !== '1') throw new Error(`count after delete: ${lines[lines.length - 1]}`);
});

// --- maker-checker --------------------------------------------------------

suite('Maker-checker is enforced by the database');

check('the requester cannot be the approver', () => {
  expectRejected('self-approval', BASE + `
INSERT INTO approvals (society_id, subject_table, subject_id, requested_by, decided_by, decided_at, decision)
VALUES ('${S}', 'billing_documents', 'PI-1', '${U1}', '${U1}', now(), 'approved');
`, /approvals_check|violates check constraint/);
});

check('a different approver is accepted', () => {
  expectAccepted('two people', BASE + `
INSERT INTO approvals (society_id, subject_table, subject_id, requested_by, decided_by, decided_at, decision)
VALUES ('${S}', 'billing_documents', 'PI-1', '${U1}', '${U2}', now(), 'approved');
`);
});

check('a rejection must give a reason', () => {
  expectRejected('rejection with no reason', BASE + `
INSERT INTO approvals (society_id, subject_table, subject_id, requested_by, decided_by, decided_at, decision)
VALUES ('${S}', 'billing_documents', 'PI-1', '${U1}', '${U2}', now(), 'rejected');
`, /violates check constraint/);
});

check('a decision without a timestamp is rejected', () => {
  expectRejected('decided but undated', BASE + `
INSERT INTO approvals (society_id, subject_table, subject_id, requested_by, decided_by, decision)
VALUES ('${S}', 'billing_documents', 'PI-1', '${U1}', '${U2}', 'approved');
`, /violates check constraint/);
});

// --- period locks ---------------------------------------------------------

suite('A closed period cannot be posted into');

const entryIn = (date, id = '88888888-8888-8888-8888-888888888888', key = 'k1') => `
INSERT INTO journal_entries
  (id, society_id, entry_ref, entry_date, narration, source_kind, idempotency_key,
   posted_by_label, total_debit, total_credit)
VALUES ('${id}', '${S}', 'JE-${key}', '${date}', 'test', 'manual', '${key}', 'test', 100000, 100000);
INSERT INTO journal_postings (entry_id, society_id, account_code, debit, credit, party) VALUES
  ('${id}', '${S}', '1100', 100000, 0, 'A-101'),
  ('${id}', '${S}', '4000', 0, 100000, NULL);
`;

const closedPeriod = `
INSERT INTO financial_periods
  (society_id, period, starts_on, ends_on, state, closed_by, closed_at,
   trial_balance_debit, trial_balance_credit)
VALUES ('${S}', '2026-06', '2026-06-01', '2026-06-30', 'closed', '${U2}', now(), 500000, 500000);
`;

check('posting into a closed period is refused', () => {
  expectRejected('post into June', BASE + closedPeriod + entryIn('2026-06-15'),
    /cannot post into 2026-06 because that period is closed/);
});

check('posting into an open period is fine', () => {
  expectAccepted('post into July', BASE + closedPeriod + entryIn('2026-07-15'));
});

check('posting into a period with no row at all is fine', () => {
  expectAccepted('no period row', BASE + entryIn('2026-09-15'));
});

check('a closed period must record a trial balance that ties', () => {
  expectRejected('closed without a tying trial balance', BASE + `
INSERT INTO financial_periods
  (society_id, period, starts_on, ends_on, state, closed_by, closed_at,
   trial_balance_debit, trial_balance_credit)
VALUES ('${S}', '2026-06', '2026-06-01', '2026-06-30', 'closed', '${U2}', now(), 500000, 400000);
`, /violates check constraint/);
});

check('a closed period must name who closed it', () => {
  expectRejected('closed by nobody', BASE + `
INSERT INTO financial_periods (society_id, period, starts_on, ends_on, state)
VALUES ('${S}', '2026-06', '2026-06-01', '2026-06-30', 'closed');
`, /violates check constraint/);
});

check('a reopened period must record a reason', () => {
  expectRejected('reopened silently', BASE + `
INSERT INTO financial_periods (society_id, period, starts_on, ends_on, state, reopened_by)
VALUES ('${S}', '2026-06', '2026-06-01', '2026-06-30', 'reopened', '${U2}');
`, /violates check constraint/);
});

// --- vendor bills ---------------------------------------------------------

suite('Vendor bill arithmetic and lifecycle');

const bill = (state, extra = '') => `
INSERT INTO vendor_bills
  (society_id, vendor_id, bill_no, bill_date, expense_account, gross, tds_section,
   tds_rate_bps, tds_amount, net_payable, state ${extra ? ', ' + extra.split('=')[0] : ''})
VALUES ('${S}', '${VENDOR}', 'FA-118', '2026-07-10', '5000', 5400000, '194C',
        200, 108000, 5292000, '${state}' ${extra ? ', ' + extra.split('=')[1] : ''});
`;

check('net payable must equal gross less TDS', () => {
  expectRejected('wrong net', BASE + `
INSERT INTO vendor_bills
  (society_id, vendor_id, bill_no, bill_date, expense_account, gross, tds_section,
   tds_rate_bps, tds_amount, net_payable, state)
VALUES ('${S}', '${VENDOR}', 'FA-1', '2026-07-10', '5000', 5400000, '194C',
        200, 108000, 5000000, 'awaiting-approval');
`, /violates check constraint/);
});

check('TDS cannot exceed the gross', () => {
  expectRejected('absurd TDS', BASE + `
INSERT INTO vendor_bills
  (society_id, vendor_id, bill_no, bill_date, expense_account, gross, tds_section,
   tds_rate_bps, tds_amount, net_payable, state)
VALUES ('${S}', '${VENDOR}', 'FA-1', '2026-07-10', '5000', 100000, '194C',
        20000, 200000, -100000, 'awaiting-approval');
`, /violates check constraint/);
});

check('an approved bill must name its approver', () => {
  expectRejected('approved by nobody', BASE + bill('approved'), /violates check constraint/);
});

check('a booked bill must have an approver and a posted entry', () => {
  expectRejected('booked without a posting', BASE + bill('approved', `approved_by='${U2}'`).replace("'approved'", "'booked'"),
    /violates check constraint/);
});

check('a rejected bill must record why', () => {
  expectRejected('rejected silently', BASE + bill('rejected'), /violates check constraint/);
});

check('an awaiting-approval bill needs neither', () => {
  expectAccepted('fresh bill', BASE + bill('awaiting-approval'));
});

check('a vendor PAN must be the right shape', () => {
  expectRejected('bad PAN', BASE + `
INSERT INTO vendors (society_id, name, category, pan) VALUES ('${S}', 'X', 'Y', 'NOTAPAN');
`, /violates check constraint/);
});

check('a well-formed PAN is accepted', () => {
  expectAccepted('good PAN', BASE + `
INSERT INTO vendors (society_id, name, category, pan) VALUES ('${S}', 'X', 'Y', 'ABCDE1234F');
`);
});

// --- banking --------------------------------------------------------------

suite('Banking: dedupe, matching and reconciliation');

const txn = (key, extra = '') => `
INSERT INTO bank_transactions
  (society_id, bank_account_id, value_date, narration, amount, dedupe_key ${extra ? ', ' + extra.split('=')[0] : ''})
VALUES ('${S}', '${BANK}', '2026-07-05', 'UPI/A-101/JUL', 929250, '${key}'
        ${extra ? ', ' + extra.split('=')[1] : ''});
`;

check('the same bank transaction cannot be imported twice', () => {
  expectRejected('duplicate dedupe key', BASE + txn('abc123') + txn('abc123'),
    /bank_transactions_society_id_bank_account_id_dedupe_key_key|duplicate key value/);
});

check('the same dedupe key on a different account is fine', () => {
  const bank2 = '55555555-5555-5555-5555-555555555556';
  expectAccepted('other account', BASE + `
INSERT INTO bank_accounts (id, society_id, label, bank_name, account_last4, ifsc, ledger_account, purpose)
VALUES ('${bank2}', '${S}', 'Sinking', 'SBI', '9876', 'SBIN0001234', '1000', 'sinking');
` + txn('abc123') + `
INSERT INTO bank_transactions (society_id, bank_account_id, value_date, narration, amount, dedupe_key)
VALUES ('${S}', '${bank2}', '2026-07-05', 'x', 100, 'abc123');
`);
});

check('a zero-amount bank line is rejected', () => {
  expectRejected('zero amount', BASE + `
INSERT INTO bank_transactions (society_id, bank_account_id, value_date, narration, amount, dedupe_key)
VALUES ('${S}', '${BANK}', '2026-07-05', 'x', 0, 'z');
`, /violates check constraint/);
});

check('a suspense line must say why', () => {
  expectRejected('suspense with no reason', BASE + txn('s1', "state='suspense'"),
    /violates check constraint/);
});

check('a matched line must point at exactly one side', () => {
  expectRejected('matched to nothing', BASE + txn('m1', "state='matched'"),
    /violates check constraint/);
});

check('an IFSC must be the right shape', () => {
  expectRejected('bad IFSC', BASE + `
INSERT INTO bank_accounts (society_id, label, bank_name, account_last4, ifsc, ledger_account, purpose)
VALUES ('${S}', 'X', 'SBI', '1234', 'NOTANIFSC', '1000', 'other');
`, /violates check constraint/);
});

check('a reconciliation difference must be derived, not asserted', () => {
  expectRejected('bogus difference', BASE + `
INSERT INTO bank_reconciliations
  (society_id, bank_account_id, as_at, statement_balance, ledger_balance, difference)
VALUES ('${S}', '${BANK}', '2026-07-31', 1000000, 900000, 0);
`, /violates check constraint/);
});

check('a reconciliation cannot be signed off while it does not agree', () => {
  expectRejected('signed off out of balance', BASE + `
INSERT INTO bank_reconciliations
  (society_id, bank_account_id, as_at, statement_balance, ledger_balance, difference,
   reconciled_by, reconciled_at)
VALUES ('${S}', '${BANK}', '2026-07-31', 1000000, 900000, 100000, '${U2}', now());
`, /violates check constraint/);
});

check('a reconciliation that agrees can be signed off', () => {
  expectAccepted('clean reconciliation', BASE + `
INSERT INTO bank_reconciliations
  (society_id, bank_account_id, as_at, statement_balance, ledger_balance, difference,
   reconciled_by, reconciled_at)
VALUES ('${S}', '${BANK}', '2026-07-31', 1000000, 1000000, 0, '${U2}', now());
`);
});

check('the same statement file cannot be imported twice', () => {
  const imp = `
INSERT INTO statement_imports
  (society_id, bank_account_id, format, filename, content_sha256)
VALUES ('${S}', '${BANK}', 'csv', 'july.csv', 'deadbeef');
`;
  expectRejected('same file twice', BASE + imp + imp,
    /statement_imports_society_id_bank_account_id_content_sha256_key|duplicate key value/);
});

suite('No credential has a column');

check('bank_accounts has no password, secret or full account number column', () => {
  const r = psql(`SELECT string_agg(column_name, ',') FROM information_schema.columns
                  WHERE table_name = 'bank_accounts';`);
  if (!r.ok) throw new Error(r.out);
  const forbidden = ['password', 'secret', 'token', 'pin', 'account_number', 'customer_id', 'api_key'];
  const found = forbidden.filter(f => r.out.includes(f));
  if (found.length > 0) throw new Error(`found ${found.join(', ')} in bank_accounts`);
});

check('vendors has no banking credential column', () => {
  const r = psql(`SELECT string_agg(column_name, ',') FROM information_schema.columns
                  WHERE table_name = 'vendors';`);
  if (!r.ok) throw new Error(r.out);
  for (const f of ['password', 'secret', 'account_number', 'api_key']) {
    if (r.out.includes(f)) throw new Error(`found ${f} in vendors`);
  }
});

check('no table anywhere has a plaintext password or pin column', () => {
  const r = psql(`SELECT coalesce(string_agg(table_name || '.' || column_name, ', '), 'none')
                  FROM information_schema.columns
                  WHERE table_schema = 'public'
                    AND (column_name LIKE '%password%' OR column_name LIKE '%pin%'
                         OR column_name LIKE '%secret%')
                    AND column_name NOT LIKE '%_hash';`);
  if (!r.ok) throw new Error(r.out);
  if (r.out !== 'none') throw new Error(`unhashed credential columns: ${r.out}`);
});

// --- notifications --------------------------------------------------------

suite('A delivery cannot be claimed without evidence');

check('marking a notification sent without a provider id is rejected', () => {
  expectRejected('sent with no evidence', BASE + `
INSERT INTO notifications (society_id, channel, template, to_address, payload, state, sent_at)
VALUES ('${S}', 'email', 'invoice', 'a@example.test', '{}', 'sent', now());
`, /violates check constraint/);
});

check('marking it sent with a provider and message id is accepted', () => {
  expectAccepted('sent with evidence', BASE + `
INSERT INTO notifications
  (society_id, channel, template, to_address, payload, state, provider, provider_message_id, sent_at)
VALUES ('${S}', 'email', 'invoice', 'a@example.test', '{}', 'sent', 'local-dev', 'msg-1', now());
`);
});

check('a failed notification must record the error', () => {
  expectRejected('failed silently', BASE + `
INSERT INTO notifications (society_id, channel, template, to_address, payload, state)
VALUES ('${S}', 'email', 'invoice', 'a@example.test', '{}', 'failed');
`, /violates check constraint/);
});

check('a queued notification needs neither', () => {
  expectAccepted('queued', BASE + `
INSERT INTO notifications (society_id, channel, template, to_address, payload)
VALUES ('${S}', 'email', 'invoice', 'a@example.test', '{}');
`);
});

// --- scheduled jobs -------------------------------------------------------

suite('A scheduled job runs once per key');

check('the same kind and run key cannot exist twice', () => {
  const job = `
INSERT INTO scheduled_jobs (kind, run_key, scheduled_for)
VALUES ('monthly-billing', '2026-07', '2026-07-01T00:30:00Z');
`;
  expectRejected('duplicate run key', BASE + job + job,
    /scheduled_jobs_kind_run_key_key|duplicate key value/);
});

check('a different run key is a different run', () => {
  expectAccepted('two months', BASE + `
INSERT INTO scheduled_jobs (kind, run_key, scheduled_for) VALUES
  ('monthly-billing', '2026-07', '2026-07-01T00:30:00Z'),
  ('monthly-billing', '2026-08', '2026-08-01T00:30:00Z');
`);
});

check('a failed job must record the error', () => {
  expectRejected('failed silently', BASE + `
INSERT INTO scheduled_jobs (kind, run_key, scheduled_for, state)
VALUES ('monthly-billing', '2026-07', now(), 'failed');
`, /violates check constraint/);
});

check('a running job must name its worker', () => {
  expectRejected('running unowned', BASE + `
INSERT INTO scheduled_jobs (kind, run_key, scheduled_for, state)
VALUES ('monthly-billing', '2026-07', now(), 'running');
`, /violates check constraint/);
});

// --- receipt heads and GST ------------------------------------------------

suite('Receipt heads and the GST register');

check('a head must credit something', () => {
  expectRejected('head crediting nothing', BASE + `
INSERT INTO receipt_heads (society_id, key, label, taxable) VALUES
  ('${S}', 'maintenance', 'Maintenance', true);
`, /violates check constraint/);
});

check('a head that credits the fund directly must name the fund', () => {
  expectRejected('fund-direct with no fund', BASE + `
INSERT INTO receipt_heads (society_id, key, label, income_account, taxable, credits_fund_directly)
VALUES ('${S}', 'sinking', 'Sinking', '4000', false, true);
`, /violates check constraint/);
});

check('all six heads can be configured', () => {
  expectAccepted('six heads', BASE + `
INSERT INTO receipt_heads (society_id, key, label, income_account, fund_account, taxable, credits_fund_directly) VALUES
  ('${S}', 'maintenance',   'Maintenance charges',   '4000', NULL,   true,  false),
  ('${S}', 'sinking',       'Sinking fund',          NULL,   '3000', false, true),
  ('${S}', 'festival',      'Festival and event',    '4000', NULL,   false, false),
  ('${S}', 'rental',        'Common space rental',   '4000', NULL,   true,  false),
  ('${S}', 'reimbursement', 'Reimbursable expenses', '4000', NULL,   true,  false),
  ('${S}', 'other',         'Other receipts',        '4000', NULL,   false, false);
`);
});

check('a GST row cannot carry both IGST and CGST/SGST', () => {
  expectRejected('both tax kinds', BASE + DOCUMENT + `
INSERT INTO gst_register
  (society_id, document_id, tax_period, invoice_no, invoice_date, counterparty,
   supply_type, taxable_value, cgst, sgst, igst, rate_bps)
VALUES ('${S}', '${DOC}', '2026-07', 'TI/1', '2026-07-11', 'A-101',
        'B2C', 787500, 70875, 70875, 141750, 1800);
`, /violates check constraint/);
});

check('an intra-state GST row with CGST and SGST is accepted', () => {
  expectAccepted('CGST + SGST', BASE + DOCUMENT + `
INSERT INTO gst_register
  (society_id, document_id, tax_period, invoice_no, invoice_date, counterparty,
   supply_type, taxable_value, cgst, sgst, rate_bps)
VALUES ('${S}', '${DOC}', '2026-07', 'TI/1', '2026-07-11', 'A-101',
        'B2C', 787500, 70875, 70875, 1800);
`);
});

check('a GST row must belong to an invoice or an adjustment, not both', () => {
  expectRejected('neither', BASE + `
INSERT INTO gst_register
  (society_id, tax_period, invoice_no, invoice_date, counterparty, supply_type,
   taxable_value, cgst, sgst, rate_bps)
VALUES ('${S}', '2026-07', 'TI/1', '2026-07-11', 'A-101', 'B2C', 787500, 70875, 70875, 1800);
`, /violates check constraint/);
});

check('a TDS quarter must be well formed', () => {
  expectRejected('bad quarter', BASE + `
INSERT INTO tds_register
  (society_id, vendor_id, section, quarter, deducted_on, gross, rate_bps, tds_amount)
VALUES ('${S}', '${VENDOR}', '194C', 'Q5-2026', '2026-07-10', 5400000, 200, 108000);
`, /violates check constraint/);
});

check('a well-formed TDS quarter is accepted', () => {
  expectAccepted('Q2-FY26-27', BASE + `
INSERT INTO tds_register
  (society_id, vendor_id, section, quarter, deducted_on, gross, rate_bps, tds_amount)
VALUES ('${S}', '${VENDOR}', '194C', 'Q2-FY26-27', '2026-07-10', 5400000, 200, 108000);
`);
});

check('a TDS challan number and date go together', () => {
  expectRejected('challan half recorded', BASE + `
INSERT INTO tds_register
  (society_id, vendor_id, section, quarter, deducted_on, gross, rate_bps, tds_amount, challan_no)
VALUES ('${S}', '${VENDOR}', '194C', 'Q2-FY26-27', '2026-07-10', 5400000, 200, 108000, 'CH-1');
`, /violates check constraint/);
});

// --- helpdesk -------------------------------------------------------------

suite('Helpdesk lifecycle');

const CATEGORY = `
INSERT INTO ticket_categories (society_id, key, label, sla_hours, escalate_to_role)
VALUES ('${S}', 'plumbing', 'Plumbing', 72, 'manager');
`;

check('a resolved ticket must record when and how', () => {
  expectRejected('resolved with nothing', BASE + CATEGORY + `
INSERT INTO tickets (society_id, ticket_no, flat_id, category, description, state, due_at)
VALUES ('${S}', 'TK-1', '${FLAT}', 'plumbing', 'Tap leaking', 'resolved', now());
`, /violates check constraint/);
});

check('a resolved ticket with a note and a timestamp is accepted', () => {
  expectAccepted('properly resolved', BASE + CATEGORY + `
INSERT INTO tickets
  (society_id, ticket_no, flat_id, category, description, state, due_at,
   resolved_at, resolution_note)
VALUES ('${S}', 'TK-1', '${FLAT}', 'plumbing', 'Tap leaking', 'resolved', now(),
        now(), 'Washer replaced');
`);
});

check('a ticket cannot be assigned to a person and a vendor at once', () => {
  expectRejected('double assignment', BASE + CATEGORY + `
INSERT INTO tickets
  (society_id, ticket_no, flat_id, category, description, state, due_at,
   assigned_to_user, assigned_to_vendor)
VALUES ('${S}', 'TK-1', '${FLAT}', 'plumbing', 'x', 'assigned', now(), '${U1}', '${VENDOR}');
`, /violates check constraint/);
});

check('a satisfaction rating outside 1 to 5 is rejected', () => {
  expectRejected('rating of 9', BASE + CATEGORY + `
INSERT INTO tickets (society_id, ticket_no, flat_id, category, description, due_at, satisfaction)
VALUES ('${S}', 'TK-1', '${FLAT}', 'plumbing', 'x', now(), 9);
`, /violates check constraint/);
});

check('an empty description is rejected', () => {
  expectRejected('blank description', BASE + CATEGORY + `
INSERT INTO tickets (society_id, ticket_no, flat_id, category, description, due_at)
VALUES ('${S}', 'TK-1', '${FLAT}', 'plumbing', '   ', now());
`, /violates check constraint/);
});

check('a ticket event cannot be deleted', () => {
  const r = psql(`BEGIN;
${BASE}${CATEGORY}
INSERT INTO tickets (id, society_id, ticket_no, flat_id, category, description, due_at)
VALUES ('99999999-9999-9999-9999-999999999999', '${S}', 'TK-1', '${FLAT}', 'plumbing', 'x', now());
INSERT INTO ticket_events (ticket_id, actor_label, to_state)
VALUES ('99999999-9999-9999-9999-999999999999', 'test', 'open');
DELETE FROM ticket_events;
-- Counted for this ticket rather than for the whole table: the table is
-- shared with whatever else the database holds, and a count of every row
-- makes this check pass or fail on data it does not own.
SELECT count(*) FROM ticket_events
 WHERE ticket_id = '99999999-9999-9999-9999-999999999999';
ROLLBACK;`);
  if (!r.ok) throw new Error(r.out);
  const lines = r.out.split('\n').filter(l => l.trim() !== '');
  if (lines[lines.length - 1] !== '1') throw new Error(`events after delete: ${lines[lines.length - 1]}`);
});

// --- attachments and FDs --------------------------------------------------

suite('Attachments and deposits');

check('an attachment must hang off exactly one thing', () => {
  expectRejected('attached to nothing', BASE + `
INSERT INTO attachments (society_id, filename, content_type, byte_size, sha256, storage_key)
VALUES ('${S}', 'a.pdf', 'application/pdf', 100, 'abc', 'key1');
`, /violates check constraint/);
});

check('an attachment on two things at once is rejected', () => {
  expectRejected('attached twice', BASE + CATEGORY + DOCUMENT + `
INSERT INTO tickets (id, society_id, ticket_no, flat_id, category, description, due_at)
VALUES ('99999999-9999-9999-9999-999999999999', '${S}', 'TK-1', '${FLAT}', 'plumbing', 'x', now());
INSERT INTO attachments
  (society_id, ticket_id, document_id, filename, content_type, byte_size, sha256, storage_key)
VALUES ('${S}', '99999999-9999-9999-9999-999999999999', '${DOC}', 'a.pdf',
        'application/pdf', 100, 'abc', 'key1');
`, /violates check constraint/);
});

check('a deposit maturing before it was placed is rejected', () => {
  expectRejected('backwards FD', BASE + `
INSERT INTO fixed_deposits
  (society_id, fd_ref, bank_name, principal, rate_bps, placed_on, matures_on, fund)
VALUES ('${S}', 'FD-1', 'SBI', 5000000, 725, '2027-01-01', '2026-01-01', 'sinking');
`, /violates check constraint/);
});

check('a deposit stores only the last four digits, and validates them', () => {
  expectRejected('full account number in last4', BASE + `
INSERT INTO fixed_deposits
  (society_id, fd_ref, bank_name, account_last4, principal, rate_bps, placed_on, matures_on, fund)
VALUES ('${S}', 'FD-1', 'SBI', '123456789012', 5000000, 725, '2026-01-01', '2027-01-01', 'sinking');
`, /violates check constraint/);
});

// --- report ---------------------------------------------------------------

console.log('\n' + '='.repeat(66));
if (failures.length === 0) {
  console.log(`ALL ${passed} DOMAIN SCHEMA CHECKS PASSED (PostgreSQL, real constraints)`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(66));
