#!/usr/bin/env node
/**
 * Database constraint tests, run against a real PostgreSQL server.
 *
 * The engine enforces these invariants in TypeScript. These tests prove the
 * database enforces them too, so a second writer — a script, a console, a
 * future service — cannot corrupt the books by going around the application.
 *
 * Every test runs in its own transaction and rolls back, so the suite leaves
 * the database as it found it.
 *
 *   PGHOST=... PGPORT=... PGUSER=... PGDATABASE=... node server/schema.test.mjs
 */

import { spawnSync } from 'node:child_process';

function psql(text) {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  const result = spawnSync('psql', [
      // A URL where one is configured, so these checks run against a hosted
    // database — over TLS, with the sslmode the URL asks for — as well as
    // against a local socket.
    ...(url === undefined || url === '' ? [] : [url]),
    '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
    '--set', 'ON_ERROR_STOP=1', '--command', text,
  ], { encoding: 'utf8', shell: false });
  if (result.error) throw new Error(`psql: ${result.error.message}`);
  return {
    ok: result.status === 0,
    out: ((result.stdout ?? '') + (result.stderr ?? '')).trim(),
  };
}

let passed = 0;
const failures = [];
let suiteName = '';
function suite(n) { suiteName = n; console.log(`\n${n}`); }
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) {
    failures.push(`${suiteName} / ${name}\n       ${err.message}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

/**
 * Runs SQL and expects the database to refuse it.
 *
 * Never commits. An earlier version ended with COMMIT, so any case the
 * database *accepted* — which is exactly what happens when the constraint
 * under test is missing — left its fixture behind and every later test then
 * failed on a duplicate primary key instead of on its own subject.
 *
 * `SET CONSTRAINTS ALL IMMEDIATE` is what makes the deferred balance triggers
 * fire here: they are INITIALLY DEFERRED and would otherwise only run at
 * COMMIT, which this deliberately never reaches.
 */
function expectRejected(label, body, matching) {
  const r = psql(`BEGIN;\n${body}\nSET CONSTRAINTS ALL IMMEDIATE;\nROLLBACK;`);
  if (r.ok) throw new Error(`${label}: the database accepted it`);
  if (!matching.test(r.out)) {
    throw new Error(`${label}: rejected, but with "${r.out.split('\n')[0]}"`);
  }
}

/**
 * Runs SQL inside a transaction that is rolled back, expecting success.
 *
 * Also forces deferred constraints, so "accepted" means accepted by every
 * check and not merely by the ones that run per statement.
 */
function expectAccepted(label, body) {
  const r = psql(`BEGIN;\n${body}\nSET CONSTRAINTS ALL IMMEDIATE;\nROLLBACK;`);
  if (!r.ok) throw new Error(`${label}: ${r.out.split('\n').slice(0, 3).join(' | ')}`);
}

// --- fixture --------------------------------------------------------------

const SOCIETY = '11111111-1111-1111-1111-111111111111';
const FLAT = '22222222-2222-2222-2222-222222222222';
const FLAT2 = '22222222-2222-2222-2222-222222222223';

const FIXTURE = `
INSERT INTO societies (id, name, mode) VALUES
  ('${SOCIETY}', 'Test Society', 'demo');
INSERT INTO accounts (society_id, code, name, class, grp, is_cash, control) VALUES
  ('${SOCIETY}', '1000', 'Bank', 'asset', 'Cash and bank', true, NULL),
  ('${SOCIETY}', '1100', 'Maintenance receivable', 'asset', 'Receivables', false, 'resident'),
  ('${SOCIETY}', '4000', 'Maintenance charges', 'income', 'Maintenance', false, NULL);
INSERT INTO flats (id, society_id, flat_no, billing_area_sqft, area_basis) VALUES
  ('${FLAT}', '${SOCIETY}', 'A-101', 1750, 'super-built-up'),
  ('${FLAT2}', '${SOCIETY}', 'B-204', 2000, 'super-built-up');
`;

const ENTRY = '33333333-3333-3333-3333-333333333333';

const balancedEntry = (key = 'bill:A-101:Jul 2026', id = ENTRY) => `
INSERT INTO journal_entries
  (id, society_id, entry_ref, entry_date, narration, source_kind, idempotency_key,
   posted_by_label, total_debit, total_credit)
VALUES
  ('${id}', '${SOCIETY}', 'JE${id.slice(0, 6)}', '2026-07-01', 'Maintenance bill',
   'maintenance-billing', '${key}', 'test', 500000, 500000);
INSERT INTO journal_postings (entry_id, society_id, account_code, debit, credit, party, doc_ref) VALUES
  ('${id}', '${SOCIETY}', '1100', 500000, 0, 'A-101', 'TI/2026/00001'),
  ('${id}', '${SOCIETY}', '4000', 0, 500000, NULL, 'TI/2026/00001');
`;

suite('The schema is reachable and complete');

check('the migrations are applied', () => {
  const r = psql("SELECT count(*) FROM schema_migrations;");
  if (!r.ok) throw new Error(r.out);
  if (Number(r.out) < 2) throw new Error(`only ${r.out} migrations applied`);
});

check('a balanced entry with two legs is accepted', () => {
  expectAccepted('balanced entry', FIXTURE + balancedEntry());
});

suite('An entry that does not balance cannot be committed');

check('legs that disagree with each other are rejected at commit', () => {
  expectRejected('unbalanced legs', FIXTURE + `
INSERT INTO journal_entries
  (id, society_id, entry_ref, entry_date, narration, source_kind, idempotency_key,
   posted_by_label, total_debit, total_credit)
VALUES ('${ENTRY}', '${SOCIETY}', 'JE1', '2026-07-01', 'x', 'manual', 'k', 't', 500000, 500000);
INSERT INTO journal_postings (entry_id, society_id, account_code, debit, credit, party) VALUES
  ('${ENTRY}', '${SOCIETY}', '1100', 500000, 0, 'A-101'),
  ('${ENTRY}', '${SOCIETY}', '4000', 0, 400000, NULL);
`, /does not balance|out by/);
});

check('legs that disagree with the stated totals are rejected', () => {
  expectRejected('legs vs header', FIXTURE + `
INSERT INTO journal_entries
  (id, society_id, entry_ref, entry_date, narration, source_kind, idempotency_key,
   posted_by_label, total_debit, total_credit)
VALUES ('${ENTRY}', '${SOCIETY}', 'JE1', '2026-07-01', 'x', 'manual', 'k', 't', 900000, 900000);
INSERT INTO journal_postings (entry_id, society_id, account_code, debit, credit, party) VALUES
  ('${ENTRY}', '${SOCIETY}', '1100', 500000, 0, 'A-101'),
  ('${ENTRY}', '${SOCIETY}', '4000', 0, 500000, NULL);
`, /states .* but its legs total/);
});

check('a header whose own two sides differ is rejected', () => {
  expectRejected('header not equal', FIXTURE + `
INSERT INTO journal_entries
  (id, society_id, entry_ref, entry_date, narration, source_kind, idempotency_key,
   posted_by_label, total_debit, total_credit)
VALUES ('${ENTRY}', '${SOCIETY}', 'JE1', '2026-07-01', 'x', 'manual', 'k', 't', 500000, 400000);
`, /journal_entry_balances/);
});

check('a single-leg entry is rejected', () => {
  expectRejected('one leg', FIXTURE + `
INSERT INTO journal_entries
  (id, society_id, entry_ref, entry_date, narration, source_kind, idempotency_key,
   posted_by_label, total_debit, total_credit)
VALUES ('${ENTRY}', '${SOCIETY}', 'JE1', '2026-07-01', 'x', 'manual', 'k', 't', 500000, 500000);
INSERT INTO journal_postings (entry_id, society_id, account_code, debit, credit, party) VALUES
  ('${ENTRY}', '${SOCIETY}', '1100', 500000, 0, 'A-101');
`, /needs at least two|leg\(s\)/);
});

check('an entry with no legs at all is rejected', () => {
  expectRejected('no legs', FIXTURE + `
INSERT INTO journal_entries
  (id, society_id, entry_ref, entry_date, narration, source_kind, idempotency_key,
   posted_by_label, total_debit, total_credit)
VALUES ('${ENTRY}', '${SOCIETY}', 'JE1', '2026-07-01', 'x', 'manual', 'k', 't', 500000, 500000);
`, /at least two are required|leg\(s\)/);
});

check('a leg carrying both a debit and a credit is rejected', () => {
  expectRejected('both sides', FIXTURE + `
INSERT INTO journal_entries
  (id, society_id, entry_ref, entry_date, narration, source_kind, idempotency_key,
   posted_by_label, total_debit, total_credit)
VALUES ('${ENTRY}', '${SOCIETY}', 'JE1', '2026-07-01', 'x', 'manual', 'k', 't', 500000, 500000);
INSERT INTO journal_postings (entry_id, society_id, account_code, debit, credit, party) VALUES
  ('${ENTRY}', '${SOCIETY}', '1100', 500000, 500000, 'A-101'),
  ('${ENTRY}', '${SOCIETY}', '4000', 0, 500000, NULL);
`, /posting_one_side/);
});

check('a negative amount is rejected', () => {
  expectRejected('negative leg', FIXTURE + `
INSERT INTO journal_entries
  (id, society_id, entry_ref, entry_date, narration, source_kind, idempotency_key,
   posted_by_label, total_debit, total_credit)
VALUES ('${ENTRY}', '${SOCIETY}', 'JE1', '2026-07-01', 'x', 'manual', 'k', 't', 500000, 500000);
INSERT INTO journal_postings (entry_id, society_id, account_code, debit, credit, party) VALUES
  ('${ENTRY}', '${SOCIETY}', '1100', -500000, 0, 'A-101'),
  ('${ENTRY}', '${SOCIETY}', '4000', 0, -500000, NULL);
`, /journal_postings_debit_check|journal_postings_credit_check|posting_one_side/);
});

suite('Control accounts require a party');

check('a receivable leg with no party is rejected', () => {
  expectRejected('no party', FIXTURE + `
INSERT INTO journal_entries
  (id, society_id, entry_ref, entry_date, narration, source_kind, idempotency_key,
   posted_by_label, total_debit, total_credit)
VALUES ('${ENTRY}', '${SOCIETY}', 'JE1', '2026-07-01', 'x', 'manual', 'k', 't', 500000, 500000);
INSERT INTO journal_postings (entry_id, society_id, account_code, debit, credit) VALUES
  ('${ENTRY}', '${SOCIETY}', '1100', 500000, 0),
  ('${ENTRY}', '${SOCIETY}', '4000', 0, 500000);
`, /control account, so the posting must name a party/);
});

check('a non-control leg needs no party', () => {
  expectAccepted('bank leg without a party', FIXTURE + balancedEntry());
});

suite('Idempotency is enforced by the database');

check('the same key twice in one society is rejected', () => {
  expectRejected('duplicate key', FIXTURE
    + balancedEntry('receipt:RCT-1', '33333333-3333-3333-3333-333333333333')
    + balancedEntry('receipt:RCT-1', '44444444-4444-4444-4444-444444444444'),
    /journal_entries_society_id_idempotency_key_key|duplicate key value/);
});

check('the same key in a different society is allowed', () => {
  // Idempotency is scoped to the tenant: two societies independently
  // numbering their receipts RCT-1 must not collide with each other.
  const other = '55555555-5555-5555-5555-555555555555';
  const otherEntry = '88888888-8888-8888-8888-888888888888';
  expectAccepted('same key, different tenant', FIXTURE + `
INSERT INTO societies (id, name, mode) VALUES ('${other}', 'Other', 'demo');
INSERT INTO accounts (society_id, code, name, class, grp, control) VALUES
  ('${other}', '1100', 'Maintenance receivable', 'asset', 'Receivables', 'resident'),
  ('${other}', '4000', 'Maintenance charges', 'income', 'Maintenance', NULL);
` + balancedEntry('receipt:RCT-1') + `
INSERT INTO journal_entries
  (id, society_id, entry_ref, entry_date, narration, source_kind, idempotency_key,
   posted_by_label, total_debit, total_credit)
VALUES ('${otherEntry}', '${other}', 'JE-OTHER-1', '2026-07-01', 'Same key, other society',
        'manual', 'receipt:RCT-1', 'test', 100000, 100000);
INSERT INTO journal_postings (entry_id, society_id, account_code, debit, credit, party) VALUES
  ('${otherEntry}', '${other}', '1100', 100000, 0, 'Z-1'),
  ('${otherEntry}', '${other}', '4000', 0, 100000, NULL);
`);
});

suite('An entry can never be deleted');

check('a delete on journal_entries does nothing', () => {
  const r = psql(`BEGIN;
${FIXTURE}
${balancedEntry()}
SET CONSTRAINTS ALL IMMEDIATE;
DELETE FROM journal_entries WHERE id = '${ENTRY}';
SELECT count(*) FROM journal_entries WHERE id = '${ENTRY}';
ROLLBACK;`);
  if (!r.ok) throw new Error(r.out);
  const lines = r.out.split('\n').filter(l => l.trim() !== '');
  if (lines[lines.length - 1] !== '1') {
    throw new Error(`entry count after delete was "${lines[lines.length - 1]}", want 1`);
  }
});

check('a delete on audit_log does nothing', () => {
  const r = psql(`BEGIN;
${FIXTURE}
INSERT INTO audit_log (society_id, actor_label, action) VALUES ('${SOCIETY}', 'test', 'did a thing');
DELETE FROM audit_log WHERE society_id = '${SOCIETY}';
SELECT count(*) FROM audit_log WHERE society_id = '${SOCIETY}';
ROLLBACK;`);
  if (!r.ok) throw new Error(r.out);
  const lines = r.out.split('\n').filter(l => l.trim() !== '');
  if (lines[lines.length - 1] !== '1') {
    throw new Error(`audit rows after delete: "${lines[lines.length - 1]}", want 1`);
  }
});

check('an update on audit_log does nothing', () => {
  const r = psql(`BEGIN;
${FIXTURE}
INSERT INTO audit_log (society_id, actor_label, action) VALUES ('${SOCIETY}', 'test', 'original');
UPDATE audit_log SET action = 'tampered' WHERE society_id = '${SOCIETY}';
SELECT action FROM audit_log WHERE society_id = '${SOCIETY}';
ROLLBACK;`);
  if (!r.ok) throw new Error(r.out);
  const lines = r.out.split('\n').filter(l => l.trim() !== '');
  if (lines[lines.length - 1] !== 'original') {
    throw new Error(`audit action is now "${lines[lines.length - 1]}"`);
  }
});

suite('Duplicate billing is impossible at the database');

const doc = (no, state, period = 'Jul 2026', flat = FLAT) => `
INSERT INTO billing_documents
  (society_id, proforma_no, flat_id, period, estimated_tax, gross, issued_on, due_on, state
   ${state === 'cancelled' ? ', cancelled_reason' : ''})
VALUES
  ('${SOCIETY}', '${no}', '${flat}', '${period}', 0, 500000, '2026-07-01', '2026-07-11', '${state}'
   ${state === 'cancelled' ? ", 'test'" : ''});
`;

check('two live documents for one flat and period are rejected', () => {
  expectRejected('duplicate period', FIXTURE + doc('PI-1', 'draft') + doc('PI-2', 'draft'),
    /billing_documents_one_live_per_period|duplicate key value/);
});

check('a cancelled document frees the flat and period', () => {
  expectAccepted('replacement after cancellation',
    FIXTURE + doc('PI-1', 'cancelled') + doc('PI-2', 'draft'));
});

check('two cancelled documents for one period are allowed', () => {
  expectAccepted('two cancellations',
    FIXTURE + doc('PI-1', 'cancelled') + doc('PI-2', 'cancelled'));
});

check('the same period on a different flat is allowed', () => {
  expectAccepted('other flat',
    FIXTURE + doc('PI-1', 'draft') + doc('PI-2', 'draft', 'Jul 2026', FLAT2));
});

check('a document past draft must name its approver', () => {
  expectRejected('released without approval', FIXTURE + doc('PI-1', 'released'),
    /billing_documents_check|violates check constraint/);
});

check('a tax invoice must carry a number and a posted entry', () => {
  expectRejected('tax invoice without a number', FIXTURE + `
INSERT INTO billing_documents
  (society_id, proforma_no, flat_id, period, estimated_tax, gross, issued_on, due_on,
   state, approved_by)
VALUES ('${SOCIETY}', 'PI-1', '${FLAT}', 'Jul 2026', 0, 500000, '2026-07-01', '2026-07-11',
        'tax-invoice', NULL);
`, /violates check constraint/);
});

check('a cancellation must give a reason', () => {
  expectRejected('cancelled without a reason', FIXTURE + `
INSERT INTO billing_documents
  (society_id, proforma_no, flat_id, period, estimated_tax, gross, issued_on, due_on, state)
VALUES ('${SOCIETY}', 'PI-1', '${FLAT}', 'Jul 2026', 0, 500000, '2026-07-01', '2026-07-11', 'cancelled');
`, /violates check constraint/);
});

check('a due date before the issue date is rejected', () => {
  expectRejected('inverted dates', FIXTURE + `
INSERT INTO billing_documents
  (society_id, proforma_no, flat_id, period, estimated_tax, gross, issued_on, due_on, state)
VALUES ('${SOCIETY}', 'PI-1', '${FLAT}', 'Jul 2026', 0, 500000, '2026-07-11', '2026-07-01', 'draft');
`, /violates check constraint/);
});

suite('Ownership cannot be ambiguous');

const OWNER = '66666666-6666-6666-6666-666666666666';
const OWNER2 = '66666666-6666-6666-6666-666666666667';
const OWNERS = `
INSERT INTO owners (id, society_id, full_name, email) VALUES
  ('${OWNER}', '${SOCIETY}', 'First Owner', 'first@example.test'),
  ('${OWNER2}', '${SOCIETY}', 'Second Owner', 'second@example.test');
`;

check('two current owners of one flat are rejected', () => {
  expectRejected('two open ownerships', FIXTURE + OWNERS + `
INSERT INTO flat_ownership (flat_id, owner_id, role, held_from) VALUES
  ('${FLAT}', '${OWNER}', 'owner', '2020-01-01'),
  ('${FLAT}', '${OWNER2}', 'owner', '2024-01-01');
`, /flat_ownership_one_current|duplicate key value/);
});

check('a previous owner plus a current one is allowed', () => {
  expectAccepted('handover', FIXTURE + OWNERS + `
INSERT INTO flat_ownership (flat_id, owner_id, role, held_from, held_until) VALUES
  ('${FLAT}', '${OWNER}', 'owner', '2020-01-01', '2023-12-31');
INSERT INTO flat_ownership (flat_id, owner_id, role, held_from) VALUES
  ('${FLAT}', '${OWNER2}', 'owner', '2024-01-01');
`);
});

check('a current owner and a current tenant are both allowed', () => {
  expectAccepted('owner and tenant', FIXTURE + OWNERS + `
INSERT INTO flat_ownership (flat_id, owner_id, role, held_from) VALUES
  ('${FLAT}', '${OWNER}', 'owner', '2020-01-01'),
  ('${FLAT}', '${OWNER2}', 'tenant', '2024-01-01');
`);
});

check('an ownership ending before it starts is rejected', () => {
  expectRejected('backwards tenure', FIXTURE + OWNERS + `
INSERT INTO flat_ownership (flat_id, owner_id, role, held_from, held_until) VALUES
  ('${FLAT}', '${OWNER}', 'owner', '2024-01-01', '2020-01-01');
`, /violates check constraint/);
});

suite('Other guards');

check('an unknown role is rejected', () => {
  expectRejected('bad role', FIXTURE + `
INSERT INTO users (id, society_id, email) VALUES
  ('77777777-7777-7777-7777-777777777777', '${SOCIETY}', 'u@example.test');
INSERT INTO user_roles (user_id, role) VALUES
  ('77777777-7777-7777-7777-777777777777', 'superuser');
`, /violates check constraint/);
});

check('the five real roles are accepted', () => {
  expectAccepted('all roles', FIXTURE + `
INSERT INTO users (id, society_id, email) VALUES
  ('77777777-7777-7777-7777-777777777777', '${SOCIETY}', 'u@example.test');
INSERT INTO user_roles (user_id, role) VALUES
  ('77777777-7777-7777-7777-777777777777', 'resident'),
  ('77777777-7777-7777-7777-777777777777', 'manager'),
  ('77777777-7777-7777-7777-777777777777', 'treasurer'),
  ('77777777-7777-7777-7777-777777777777', 'secretary'),
  ('77777777-7777-7777-7777-777777777777', 'auditor');
`);
});

check('a session expiring before it was issued is rejected', () => {
  expectRejected('backwards session', FIXTURE + `
INSERT INTO users (id, society_id, email) VALUES
  ('77777777-7777-7777-7777-777777777777', '${SOCIETY}', 'u@example.test');
INSERT INTO sessions (user_id, token_hash, issued_at, expires_at) VALUES
  ('77777777-7777-7777-7777-777777777777', 'h', '2026-07-01', '2026-06-01');
`, /violates check constraint/);
});

check('a zero or negative billing area is rejected', () => {
  expectRejected('zero area', `
INSERT INTO societies (id, name, mode) VALUES ('${SOCIETY}', 'T', 'demo');
INSERT INTO flats (society_id, flat_no, billing_area_sqft, area_basis) VALUES
  ('${SOCIETY}', 'X-1', 0, 'carpet');
`, /violates check constraint/);
});

check('a flat with no area and no basis is allowed, so it can be refused later', () => {
  expectAccepted('area pending', `
INSERT INTO societies (id, name, mode) VALUES ('${SOCIETY}', 'T', 'demo');
INSERT INTO flats (society_id, flat_no) VALUES ('${SOCIETY}', 'X-1');
`);
});

check('an unapproved rate can be stored but is identifiable', () => {
  expectAccepted('rate pending approval', `
INSERT INTO societies (id, name, mode) VALUES ('${SOCIETY}', 'T', 'demo');
INSERT INTO maintenance_rates
  (society_id, rate_paise_per_sqft, area_basis, effective_from, authority)
VALUES ('${SOCIETY}', 450, 'super-built-up', '2026-04-01', 'brief; basis unconfirmed');
SELECT CASE WHEN approved_by IS NULL THEN 'unapproved' ELSE 'approved' END
  FROM maintenance_rates WHERE society_id = '${SOCIETY}';
`);
});

check('an unknown society mode is rejected', () => {
  expectRejected('bad mode',
    `INSERT INTO societies (id, name, mode) VALUES ('${SOCIETY}', 'T', 'staging');`,
    /violates check constraint/);
});

// --- report ---------------------------------------------------------------

console.log('\n' + '='.repeat(66));
if (failures.length === 0) {
  console.log(`ALL ${passed} DATABASE CHECKS PASSED (PostgreSQL, real constraints)`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(66));
