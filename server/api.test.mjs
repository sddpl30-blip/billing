#!/usr/bin/env node
/**
 * Integration tests for the API.
 *
 * A real server on a real socket against a real PostgreSQL. No mocked database
 * and no mocked HTTP: the things most likely to be wrong here are the SQL, the
 * deferred triggers, the cookie and CSRF handling and the authorisation, and
 * none of those is exercised by a fake.
 *
 * Each run seeds its own society with a unique name, so a repeated run cannot
 * collide with its own history — which matters because nothing financial can
 * be deleted by design, so cleaning up afterwards is not an option.
 *
 *   PGHOST=/tmp/sbpg PGPORT=55432 PGUSER=... PGDATABASE=... \
 *     node server/api.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const build = '../.server-build/server/src';
const { buildApp } = await import(`${build}/app.js`);
const { seed } = await import(`${build}/seed.js`);
const { PgPool, connectionFromEnv } = await import(`${build}/pg.js`);
const { runDueJobs, backoffMinutes } = await import(`${build}/jobs.js`);
const { createLogger } = await import(`${build}/logger.js`);
const { resolveEmailProvider } = await import(`${build}/providers/email.js`);
const {
  summariseTrialBalance, assembleBalanceSheet, registerAgreesWithLedger,
} = await import(`${build}/reports.js`);

// --- harness ---------------------------------------------------------------

let passed = 0;
const failures = [];
let suiteName = '';
const suite = (n) => { suiteName = n; console.log(`\n${n}`); };

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${suiteName} / ${name}\n       ${err.message}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function equal(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function truthy(value, what) {
  if (!value) throw new Error(`${what}: expected something truthy, got ${JSON.stringify(value)}`);
}
function matches(text, pattern, what) {
  if (!pattern.test(String(text))) {
    throw new Error(`${what}: ${JSON.stringify(String(text).slice(0, 220))} does not match ${pattern}`);
  }
}

function psql(text) {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL;
  const r = spawnSync('psql', [
    // A URL where one is configured, so these checks run against a hosted
    // database — over TLS, with the sslmode the URL asks for — as well as
    // against a local socket.
    ...(url === undefined || url === '' ? [] : [url]),
    '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
    '--set', 'ON_ERROR_STOP=1', '--command', text,
  ], { encoding: 'utf8', shell: false });
  return { ok: r.status === 0, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
}

// --- a client that keeps cookies and sends the CSRF header ------------------

class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  get csrf() { return this.cookies.get('sb_csrf'); }

  async call(method, path, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && this.csrf !== undefined && headers['X-CSRF-Token'] === undefined) {
      headers['X-CSRF-Token'] = this.csrf;
    }
    if (this.cookies.size > 0) {
      headers.Cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '' || /Max-Age=0/.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }

    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text === '' ? null : JSON.parse(text),
    };
  }

  get(path, headers) { return this.call('GET', path, undefined, headers); }
  post(path, body, headers) { return this.call('POST', path, body ?? {}, headers); }
  put(path, body, headers) { return this.call('PUT', path, body ?? {}, headers); }

  async signIn(email, password) {
    const r = await this.post('/api/auth/password', { email, password });
    if (r.status !== 200) throw new Error(`sign-in for ${email} failed: ${JSON.stringify(r.body)}`);
    return r.body;
  }
}

// --- fixture ---------------------------------------------------------------

const PASSWORD = 'integration-test-password';
const stamp = randomUUID().slice(0, 8);
const societyName = `API test society ${stamp}`;
// Its own address space, because an address identifies one account across the
// whole database (migration 005) and the demo society already holds the
// unsuffixed ones.
const domain = `t${stamp}.invalid`;

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.SECURE_COOKIES = 'false';
process.env.SESSION_SECRET = `test-secret-${stamp}-${'x'.repeat(32)}`;
process.env.OTP_PROVIDER = 'local-dev';
process.env.EMAIL_PROVIDER = 'none';
process.env.LOG_LEVEL = 'error';
process.env.RATE_LIMIT_LOGIN_PER_HOUR = '8';

const seedPool = new PgPool(connectionFromEnv(process.env));
const fixture = await seed(seedPool, { name: societyName, password: PASSWORD, emailDomain: domain });
await seedPool.end();

/**
 * Which transport these checks run over.
 *
 * `socket` is the standalone server: the default, and what production looks
 * like on a long-lived host. `serverless` runs the identical wiring through
 * the Vercel adapter, behind a stand-in for the platform's runtime — the body
 * already read, the caller's address only in `x-forwarded-for`, the app built
 * once and reused. Running the same checks both ways is the only way to know
 * the serverless path is the same server and not a second, less tested one.
 *
 *   SB_TEST_TRANSPORT=serverless node server/api.test.mjs
 */
const transport = process.env.SB_TEST_TRANSPORT === 'serverless' ? 'serverless' : 'socket';

let app = null;
let host = null;
let base;

if (transport === 'serverless') {
  const { startVercelHost } = await import('./vercelHost.mjs');
  // One address for the whole run, which is what the socket transport gives
  // (everything arrives from 127.0.0.1) and what a single caller looks like
  // behind the platform. Varying it per request made the login limiter
  // untestable: every attempt looked like a different person.
  host = await startVercelHost({ clientIp: '203.0.113.7', env: { DB_POOL_MAX: '4' } });
  base = host.base;
} else {
  app = buildApp(process.env, { runWorker: false });
  const { port } = await app.listen();
  base = `http://127.0.0.1:${port}`;
}

const flatOf = (flatNo) => {
  const flat = fixture.flats.find(f => f.flatNo === flatNo);
  if (flat === undefined) throw new Error(`no seeded flat ${flatNo}`);
  return flat;
};
const userOf = (role) => {
  const user = fixture.users.find(u => u.role === role);
  if (user === undefined) throw new Error(`no seeded ${role}`);
  return user;
};

const manager = new Client(base);
const treasurer = new Client(base);
const secretary = new Client(base);
const auditor = new Client(base);
const resident = new Client(base);
const anonymous = new Client(base);

const residentEmail = `owner.b204@${domain}`;
const period = 'Jul 2026';
const issuedOn = '2026-07-01';
const key = (what) => `test-${stamp}-${what}`;

try {

// --- health ----------------------------------------------------------------

suite('health');

await check('reports ok with the database reachable', async () => {
  const r = await anonymous.get('/api/health');
  equal(r.status, 200, 'status');
  equal(r.body.status, 'ok', 'body.status');
  equal(r.body.database.reachable, true, 'database.reachable');
});

await check('names the schema version it is running against', async () => {
  const r = await anonymous.get('/api/health');
  // Compared with the migrations on disk, not a literal: a hardcoded number
  // here means this check has to be edited every time the schema moves, and a
  // check nobody trusts gets edited without being read.
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(new URL('./migrations', import.meta.url))
    .filter(name => name.endsWith('.sql'))
    .sort();
  equal(r.body.schemaVersion, files[files.length - 1], 'the latest migration applied');
});

await check('does not claim a provider it has not got', async () => {
  const r = await anonymous.get('/api/health');
  equal(r.body.providers.emailDelivers, false, 'emailDelivers with EMAIL_PROVIDER=none');
});

// --- authentication --------------------------------------------------------

suite('authentication');

await check('a wrong password is refused', async () => {
  const r = await anonymous.post('/api/auth/password', {
    email: `treasurer@${domain}`, password: 'not-the-password',
  });
  equal(r.status, 401, 'status');
  matches(r.body.message, /do not match/, 'message');
});

await check('an unknown address is refused in the same words', async () => {
  const r = await anonymous.post('/api/auth/password', {
    email: 'nobody@demo.invalid', password: 'not-the-password',
  });
  equal(r.status, 401, 'status');
  matches(r.body.message, /do not match/, 'message');
});

await check('a correct password signs in and sets both cookies', async () => {
  const body = await treasurer.signIn(`treasurer@${domain}`, PASSWORD);
  truthy(treasurer.cookies.get('sb_session'), 'session cookie');
  truthy(treasurer.cookies.get('sb_csrf'), 'csrf cookie');
  truthy(body.user.roles.includes('treasurer'), 'roles include treasurer');
});

await check('the session token is never in the response body', async () => {
  const client = new Client(base);
  const body = await client.signIn(`manager@${domain}`, PASSWORD);
  const token = client.cookies.get('sb_session');
  truthy(token, 'session cookie');
  truthy(!JSON.stringify(body).includes(token), 'body does not carry the session token');
});

await check('the session cookie is HttpOnly and SameSite=Strict', async () => {
  const client = new Client(base);
  const r = await client.post('/api/auth/password', {
    email: `auditor@${domain}`, password: PASSWORD,
  });
  const cookies = r.headers.getSetCookie();
  const session = cookies.find(c => c.startsWith('sb_session='));
  matches(session, /HttpOnly/, 'session cookie');
  matches(session, /SameSite=Strict/, 'session cookie');
});

await check('the csrf cookie is readable by the page', async () => {
  const client = new Client(base);
  const r = await client.post('/api/auth/password', {
    email: `auditor@${domain}`, password: PASSWORD,
  });
  const csrf = r.headers.getSetCookie().find(c => c.startsWith('sb_csrf='));
  truthy(!/HttpOnly/.test(csrf), 'csrf cookie must not be HttpOnly: the page has to send it back');
});

await check('an unauthenticated read is 401', async () => {
  const r = await anonymous.get('/api/auth/me');
  equal(r.status, 401, 'status');
});

await check('/me reports roles, permissions and flats from the database', async () => {
  const r = await treasurer.get('/api/auth/me');
  equal(r.status, 200, 'status');
  truthy(r.body.permissions.includes('billing.approve'), 'treasurer has billing.approve');
  truthy(!r.body.permissions.includes('billing.run'), 'treasurer must not have billing.run');
});

await check('signing out revokes the session', async () => {
  const client = new Client(base);
  await client.signIn(`auditor@${domain}`, PASSWORD);
  equal((await client.get('/api/auth/me')).status, 200, 'before sign-out');
  await client.post('/api/auth/sign-out');
  equal((await client.get('/api/auth/me')).status, 401, 'after sign-out');
});

await check('a one-time code request says the same thing either way', async () => {
  const known = await anonymous.post('/api/auth/request-code', { email: `secretary@${domain}` });
  const unknown = await anonymous.post('/api/auth/request-code', { email: `nobody-${stamp}@demo.invalid` });
  equal(known.status, 200, 'known address');
  equal(unknown.status, 200, 'unknown address');
  equal(known.body.message, unknown.body.message, 'the two messages');
});

await check('a wrong one-time code is counted, even though the attempt is refused', async () => {
  const email = `auditor@${domain}`;
  equal((await anonymous.post('/api/auth/request-code', { email })).status, 200, 'code issued');
  for (let i = 0; i < 2; i++) {
    const r = await anonymous.post('/api/auth/verify-code', { email, code: '000000' });
    equal(r.status, 401, `wrong code ${i + 1}`);
  }
  // Counted on the pool, outside the transaction the refusal rolls back.
  const attempts = psql(
    `SELECT c.attempts FROM login_codes c JOIN users u ON u.id = c.user_id
      WHERE u.email = '${email}' AND c.consumed_at IS NULL
      ORDER BY c.issued_at DESC LIMIT 1;`,
  );
  equal(attempts.out, '2', 'attempts recorded');
});

await check('sign-in from another site is refused', async () => {
  const r = await anonymous.post('/api/auth/password', {
    email: `auditor@${domain}`, password: PASSWORD,
  }, { Origin: 'https://attacker.example' });
  equal(r.status, 403, 'status');
  equal(r.body.error, 'csrf_failed', 'error');
});

// --- CSRF ------------------------------------------------------------------

suite('CSRF');

await check('a write with no CSRF header is refused', async () => {
  const r = await treasurer.post('/api/billing/run', { period, issuedOn }, { 'X-CSRF-Token': '' });
  equal(r.status, 403, 'status');
  equal(r.body.error, 'csrf_failed', 'error');
});

await check('a write with the wrong CSRF token is refused', async () => {
  const r = await treasurer.post(
    '/api/billing/run', { period, issuedOn }, { 'X-CSRF-Token': 'not-the-token' },
  );
  equal(r.status, 403, 'status');
});

await check('a read needs no CSRF token', async () => {
  const r = await treasurer.get('/api/auth/me', { 'X-CSRF-Token': 'nonsense' });
  equal(r.status, 200, 'status');
});

// --- authorisation ---------------------------------------------------------

suite('authorisation');

await manager.signIn(`manager@${domain}`, PASSWORD);
await secretary.signIn(`secretary@${domain}`, PASSWORD);
await auditor.signIn(`auditor@${domain}`, PASSWORD);
await resident.signIn(residentEmail, PASSWORD);

await check('a treasurer cannot run a billing cycle', async () => {
  const r = await treasurer.post('/api/billing/run', { period, issuedOn });
  equal(r.status, 403, 'status');
  matches(r.body.message, /billing\.run/, 'message');
});

await check('a manager cannot approve a bill they could have raised', async () => {
  const r = await manager.post('/api/billing/documents/00000000-0000-0000-0000-000000000000/approve', {
    on: issuedOn,
  });
  equal(r.status, 403, 'status');
  matches(r.body.message, /billing\.approve/, 'message');
});

await check('an auditor holds no write permission at all', async () => {
  const attempts = await Promise.all([
    auditor.post('/api/billing/run', { period, issuedOn }),
    auditor.post('/api/vendors', {
      name: 'x', category: 'y', tdsSection: 'none', payeeKind: 'company',
    }),
    auditor.post('/api/periods/2026-07/close'),
  ]);
  for (const r of attempts) equal(r.status, 403, 'status');
});

await check('a resident cannot read another flat', async () => {
  const other = flatOf('A-101');
  const r = await resident.get(`/api/flats/${other.id}/dues`);
  equal(r.status, 403, 'status');
  matches(r.body.message, /access to that flat/, 'message');
});

await check('a resident can read their own flat', async () => {
  const own = flatOf('B-204');
  const r = await resident.get(`/api/flats/${own.id}/dues`);
  equal(r.status, 200, 'status');
  equal(r.body.flatNo, 'B-204', 'flatNo');
});

await check('a resident listing flats sees only their own', async () => {
  const r = await resident.get('/api/flats');
  equal(r.status, 200, 'status');
  equal(r.body.flats.length, 1, 'number of flats');
  equal(r.body.flats[0].flatNo, 'B-204', 'the one flat');
});

await check('a manager listing flats sees the whole society', async () => {
  const r = await manager.get('/api/flats');
  equal(r.body.flats.length, 10, 'number of flats');
});

await check('a manager cannot read the audit trail', async () => {
  equal((await manager.get('/api/audit')).status, 403, 'status');
});

await check('an auditor can read the audit trail', async () => {
  const r = await auditor.get('/api/audit');
  equal(r.status, 200, 'status');
  truthy(Array.isArray(r.body.entries), 'entries');
});

// --- the billing run -------------------------------------------------------

suite('billing run');

let documents = [];

await check('the manager bills the period and nothing is posted', async () => {
  const r = await manager.post('/api/billing/run', { period, issuedOn });
  equal(r.status, 201, 'status');
  equal(r.body.issued.length, 10, 'documents issued');
  equal(r.body.skipped.length, 0, 'documents skipped');
  equal(r.body.posted, false, 'posted');
  documents = r.body.issued;
});

await check('the charge is area times the approved rate', async () => {
  const b204 = documents.find(d => d.flatNo === 'B-204');
  // 985 sq ft at 450 paise = 443,250 paise, plus a 10% sinking contribution.
  equal(b204.net, 443_250 + 44_325, 'net for B-204');
  equal(b204.estimatedTax, 0, 'estimated tax with GST off');
});

await check('nothing reached the ledger', async () => {
  const r = await treasurer.get(`/api/reports/trial-balance?asAt=${issuedOn}`);
  equal(r.body.lines.length, 0, 'trial balance lines after a billing run');
});

await check('a second run for the same period bills nobody twice', async () => {
  const r = await manager.post('/api/billing/run', { period, issuedOn });
  equal(r.body.issued.length, 0, 'documents issued');
  equal(r.body.skipped.length, 10, 'documents skipped');
  matches(r.body.skipped[0].why, /already billed/, 'reason');
});

await check('the duplicate guard is the database, not the query', async () => {
  const flat = flatOf('B-204');
  const r = psql(
    `INSERT INTO billing_documents
       (society_id, proforma_no, flat_id, period, estimated_tax, gross, issued_on, due_on, state)
     VALUES ('${fixture.societyId}', 'DUP/${stamp}', '${flat.id}', '${period}', 0, 100,
             '${issuedOn}', '${issuedOn}', 'draft');`,
  );
  truthy(!r.ok, 'the database accepted a second live document for the same flat and period');
  matches(r.out, /billing_documents_one_live_per_period/, 'the index that refused it');
});

await check('an unapproved proforma cannot become a tax invoice', async () => {
  const b204 = documents.find(d => d.flatNo === 'B-204');
  const r = await treasurer.post(`/api/billing/documents/${b204.documentId}/convert`, {
    on: '2026-07-16', because: 'manual',
  });
  equal(r.status, 409, 'status');
  matches(r.body.message, /not been approved/, 'message');
});

await check('the treasurer approves', async () => {
  for (const document of documents) {
    const r = await treasurer.post(`/api/billing/documents/${document.documentId}/approve`, {
      on: issuedOn,
    });
    equal(r.status, 200, `approving ${document.flatNo}`);
  }
});

await check('approving twice is refused', async () => {
  const r = await treasurer.post(`/api/billing/documents/${documents[0].documentId}/approve`, {
    on: issuedOn,
  });
  equal(r.status, 409, 'status');
});

await check('maker-checker is enforced by the database, not only by the roles', async () => {
  const requester = userOf('manager').id;
  const r = psql(
    `UPDATE approvals SET decided_by = '${requester}', decided_at = now(), decision = 'approved'
      WHERE society_id = '${fixture.societyId}' AND subject_table = 'billing_documents'
      LIMIT 1;`,
  );
  // LIMIT is not valid on UPDATE, so this fails on syntax first; the real
  // check is the one below, which the database must refuse on the constraint.
  const direct = psql(
    `UPDATE approvals SET decided_by = requested_by, decided_at = now(), decision = 'approved'
      WHERE society_id = '${fixture.societyId}' AND subject_table = 'billing_documents';`,
  );
  truthy(!direct.ok, 'the database allowed a requester to be their own approver');
  matches(direct.out, /approvals_check|violates check constraint/, 'the constraint that refused it');
  void r;
});

await check('releasing says plainly that nothing was emailed', async () => {
  const r = await treasurer.post(`/api/billing/documents/${documents[0].documentId}/release`, {
    channel: 'email',
  });
  equal(r.status, 200, 'status');
  equal(r.body.delivered, false, 'delivered');
  matches(r.body.note, /No email provider is configured/, 'note');
});

await check('the dispatch attempt is recorded as undelivered', async () => {
  const r = await manager.get(`/api/billing/documents?period=${encodeURIComponent(period)}`);
  const document = r.body.documents.find(d => d.id === documents[0].documentId);
  equal(document.dispatch.length, 1, 'dispatch attempts');
  equal(document.dispatch[0].delivered, false, 'delivered');
});

// --- conversion and the ledger ---------------------------------------------

suite('conversion');

let firstInvoice = null;

await check('converting posts the receivable and the income', async () => {
  const b204 = documents.find(d => d.flatNo === 'B-204');
  const r = await treasurer.post(`/api/billing/documents/${b204.documentId}/convert`, {
    on: '2026-07-16', because: 'due-date-reached',
  });
  equal(r.status, 200, 'status');
  equal(r.body.posted, true, 'posted');
  matches(r.body.taxInvoiceNo, /^MV\/2026\/00001$/, 'tax invoice number');
  equal(r.body.gross, 443_250 + 44_325, 'gross');
  equal(r.body.cgst, 0, 'cgst with GST off');
  firstInvoice = r.body;
});

await check('the trial balance ties out', async () => {
  const r = await treasurer.get('/api/reports/trial-balance?asAt=2026-07-31');
  equal(r.body.tiesOut, true, 'tiesOut');
  equal(r.body.totalDebit, 487_575, 'total debit');
  equal(r.body.totalDebit, r.body.totalCredit, 'debit against credit');
});

await check('the sinking fund is credited to the fund, not to income', async () => {
  const r = await treasurer.get('/api/reports/trial-balance?asAt=2026-07-31');
  const sinking = r.body.lines.find(l => l.code === '3000');
  const maintenance = r.body.lines.find(l => l.code === '4000');
  equal(sinking.credit, 44_325, 'sinking fund credit');
  equal(maintenance.credit, 443_250, 'maintenance income credit');
  equal(sinking.class, 'fund', 'the sinking account class');
});

await check('the balance sheet balances without a plug', async () => {
  const r = await treasurer.get('/api/reports/balance-sheet?asAt=2026-07-31');
  equal(r.body.balances, true, 'balances');
  equal(r.body.totalAssets, 487_575, 'total assets');
  equal(r.body.surplus, 443_250, 'surplus');
  equal(r.body.totalFunds, 44_325, 'total funds');
});

await check('the invoice reads as pending before its due date', async () => {
  const r = await manager.get(
    `/api/billing/documents?period=${encodeURIComponent(period)}&asAt=2026-07-16`,
  );
  const document = r.body.documents.find(d => d.flatNo === 'B-204');
  equal(document.paymentStatus, 'Pending', 'paymentStatus');
  equal(document.outstanding, 487_575, 'outstanding');
});

await check('and as overdue after it', async () => {
  const r = await manager.get(
    `/api/billing/documents?period=${encodeURIComponent(period)}&asAt=2026-08-20`,
  );
  const document = r.body.documents.find(d => d.flatNo === 'B-204');
  equal(document.paymentStatus, 'Overdue', 'paymentStatus');
});

await check('converting the same document twice is refused', async () => {
  const b204 = documents.find(d => d.flatNo === 'B-204');
  const r = await treasurer.post(`/api/billing/documents/${b204.documentId}/convert`, {
    on: '2026-07-17', because: 'manual',
  });
  equal(r.status, 409, 'status');
  matches(r.body.message, /already a tax invoice/, 'message');
});

// --- GST -------------------------------------------------------------------

suite('GST treatment');

await check('a treasurer cannot change a setting', async () => {
  const r = await treasurer.put('/api/settings/gst.treatment', {
    value: { chargeGst: true, ratePercent: 18 },
  });
  equal(r.status, 403, 'status');
});

await check('the secretary sets GST on, and it is not approved by being typed', async () => {
  const r = await secretary.put('/api/settings/gst.treatment', {
    value: { chargeGst: true, ratePercent: 18 },
    note: 'Set by the integration test.',
  });
  equal(r.status, 200, 'status');
  equal(r.body.approved, false, 'approved');
});

await check('billing refuses to charge an unapproved tax', async () => {
  const a101 = documents.find(d => d.flatNo === 'A-101');
  const r = await treasurer.post(`/api/billing/documents/${a101.documentId}/convert`, {
    on: '2026-07-18', because: 'manual',
  });
  equal(r.status, 409, 'status');
  matches(r.body.message, /has not been confirmed/, 'message');
});

await check('the treasurer records the sign-off', async () => {
  const r = await treasurer.post('/api/settings/gst.treatment/approve', { on: '2026-07-17' });
  equal(r.status, 200, 'status');
  equal(r.body.approved, true, 'approved');
});

await check('now the tax is charged, and split into equal halves', async () => {
  const a101 = documents.find(d => d.flatNo === 'A-101');
  const r = await treasurer.post(`/api/billing/documents/${a101.documentId}/convert`, {
    on: '2026-07-18', because: 'manual',
  });
  equal(r.status, 200, 'status');
  // 1150 sq ft at 450 paise = 517,500 taxable; the sinking share is not.
  // 18% of 517,500 is 93,150, which halves exactly.
  equal(r.body.cgst, 46_575, 'cgst');
  equal(r.body.sgst, 46_575, 'sgst');
  equal(r.body.cgst + r.body.sgst, 93_150, 'cgst plus sgst');
  equal(r.body.gross, 517_500 + 51_750 + 93_150, 'gross');
});

await check('the GST register agrees with the ledger', async () => {
  const r = await treasurer.get('/api/reports/gst?taxPeriod=2026-07');
  equal(r.body.agrees, true, 'agrees');
  equal(r.body.cgst, 46_575, 'register cgst');
  equal(r.body.ledgerCgst, 46_575, 'ledger cgst');
  equal(r.body.filed, false, 'filed');
});

await check('changing the value drops the sign-off', async () => {
  await secretary.put('/api/settings/gst.treatment', {
    value: { chargeGst: true, ratePercent: 5 },
  });
  const r = await secretary.get('/api/settings');
  const gst = r.body.settings.find(s => s.key === 'gst.treatment');
  equal(gst.approved, false, 'approved after the rate changed');
  // Put it back, approved, for the rest of the suite.
  await secretary.put('/api/settings/gst.treatment', {
    value: { chargeGst: true, ratePercent: 18 },
  });
  await treasurer.post('/api/settings/gst.treatment/approve', { on: '2026-07-17' });
});

// --- receipts --------------------------------------------------------------

suite('receipts');

const b204 = () => documents.find(d => d.flatNo === 'B-204');

await check('a payment needs an idempotency key', async () => {
  const r = await manager.post('/api/payments', {
    flatId: flatOf('B-204').id, amountPaise: 100_000, receivedOn: '2026-07-20', method: 'upi',
  });
  equal(r.status, 400, 'status');
  matches(r.body.message, /Idempotency-Key/, 'message');
});

await check('a part payment is allocated and leaves the rest outstanding', async () => {
  const r = await manager.post('/api/payments', {
    flatId: flatOf('B-204').id, amountPaise: 200_000, receivedOn: '2026-07-20', method: 'upi',
  }, { 'Idempotency-Key': key('part-payment') });
  equal(r.status, 201, 'status');
  equal(r.body.appliedToDues, 200_000, 'applied to dues');
  equal(r.body.heldAsAdvance, 0, 'held as advance');
  equal(r.body.allocations.length, 1, 'allocations');
  equal(r.body.allocations[0].taxInvoiceNo, firstInvoice.taxInvoiceNo, 'allocated invoice');
});

await check('the invoice now reads as partly paid', async () => {
  const r = await manager.get(
    `/api/billing/documents?period=${encodeURIComponent(period)}&asAt=2026-07-20`,
  );
  const document = r.body.documents.find(d => d.flatNo === 'B-204');
  equal(document.paymentStatus, 'Partly paid', 'paymentStatus');
  equal(document.outstanding, 487_575 - 200_000, 'outstanding');
});

await check('replaying the same key does not take the money twice', async () => {
  const r = await manager.post('/api/payments', {
    flatId: flatOf('B-204').id, amountPaise: 200_000, receivedOn: '2026-07-20', method: 'upi',
  }, { 'Idempotency-Key': key('part-payment') });
  equal(r.status, 409, 'status');
  matches(r.body.message, /does not take the money twice/, 'message');

  const count = psql(
    `SELECT COUNT(*) FROM payments WHERE society_id = '${fixture.societyId}'
      AND idempotency_key = '${key('part-payment')}';`,
  );
  equal(count.out, '1', 'payments with that key');
});

await check('two concurrent requests with one key produce one payment', async () => {
  const body = {
    flatId: flatOf('B-204').id, amountPaise: 50_000, receivedOn: '2026-07-21', method: 'neft',
  };
  const headers = { 'Idempotency-Key': key('concurrent') };
  const [a, b] = await Promise.all([
    manager.post('/api/payments', body, headers),
    manager.post('/api/payments', body, headers),
  ]);
  const statuses = [a.status, b.status].sort();
  equal(statuses[0], 201, 'one request succeeded');
  truthy(statuses[1] === 409, `the other was refused, got ${statuses[1]}`);

  const count = psql(
    `SELECT COUNT(*) FROM payments WHERE society_id = '${fixture.societyId}'
      AND idempotency_key = '${key('concurrent')}';`,
  );
  equal(count.out, '1', 'payments with that key');
});

await check('an overpayment is held as an advance, not left on the receivable', async () => {
  const outstanding = 487_575 - 200_000 - 50_000;
  const r = await manager.post('/api/payments', {
    flatId: flatOf('B-204').id,
    amountPaise: outstanding + 100_000,
    receivedOn: '2026-07-22',
    method: 'neft',
  }, { 'Idempotency-Key': key('overpayment') });
  equal(r.status, 201, 'status');
  equal(r.body.appliedToDues, outstanding, 'applied to dues');
  equal(r.body.heldAsAdvance, 100_000, 'held as advance');
});

await check('the invoice is paid and the advance is visible on the flat', async () => {
  const flat = flatOf('B-204');
  const r = await manager.get(`/api/flats/${flat.id}/dues?asAt=2026-07-31`);
  equal(r.body.outstandingPaise, 0, 'receivable');
  equal(r.body.advancePaise, 100_000, 'advance');
  equal(r.body.netPayablePaise, -100_000, 'net payable');
  equal(r.body.invoices.length, 0, 'open invoices');
});

await check('the books still tie after four receipts', async () => {
  const r = await treasurer.get('/api/reports/trial-balance?asAt=2026-07-31');
  equal(r.body.tiesOut, true, 'tiesOut');
  const bank = r.body.lines.find(l => l.code === '1000');
  equal(bank.debit - bank.credit, 587_575, 'bank balance');
});

await check('the collection summary is computed, not asserted', async () => {
  const r = await treasurer.get('/api/reports/collections?from=2026-07-01&to=2026-07-31');
  equal(r.body.billed, 487_575 + 662_400, 'billed');
  equal(r.body.collected, 487_575, 'collected');
  // Not a round number anybody chose: collected over billed.
  equal(r.body.collectionRateBps, Math.round((487_575 * 10000) / (487_575 + 662_400)), 'rate');
  equal(r.body.advances, 100_000, 'advances');
});

await check('the member statement runs to the same closing balance', async () => {
  const flat = flatOf('B-204');
  const r = await resident.get(`/api/reports/statement/${flat.id}?to=2026-07-31`);
  equal(r.body.closing, -100_000, 'closing balance');
  equal(r.body.rows.length, 5, 'statement rows');
});

await check('a reversal leaves both entries in the ledger', async () => {
  const payment = psql(
    `SELECT id FROM payments WHERE society_id = '${fixture.societyId}'
      AND idempotency_key = '${key('part-payment')}';`,
  );
  const r = await treasurer.post(`/api/payments/${payment.out}/reverse`, {
    on: '2026-07-25', reason: 'Cheque returned unpaid by the bank.',
  });
  equal(r.status, 200, 'status');
  truthy(r.body.reversalEntryId, 'a reversal entry id');

  const entries = psql(
    `SELECT COUNT(*) FROM journal_entries
      WHERE society_id = '${fixture.societyId}' AND source_kind = 'member-receipt';`,
  );
  equal(entries.out, '3', 'receipt entries: the three originals are still there');
  const reversals = psql(
    `SELECT COUNT(*) FROM journal_entries
      WHERE society_id = '${fixture.societyId}' AND reversal_of IS NOT NULL;`,
  );
  equal(reversals.out, '1', 'reversal entries');
});

await check('and the trial balance still ties after the reversal', async () => {
  const r = await treasurer.get('/api/reports/trial-balance?asAt=2026-07-31');
  equal(r.body.tiesOut, true, 'tiesOut');
});

// --- ageing ----------------------------------------------------------------

suite('ageing');

await check('an unpaid invoice ages into a bucket', async () => {
  const r = await treasurer.get('/api/reports/ageing?asAt=2026-09-30');
  const a101 = r.body.rows.find(row => row.flatNo === 'A-101');
  truthy(a101, 'a row for A-101');
  equal(a101.buckets[0].label, '61-90', 'bucket');
  equal(a101.outstanding, 662_400, 'outstanding');
});

await check('a resident sees only their own ageing', async () => {
  const r = await resident.get('/api/reports/ageing?asAt=2026-09-30');
  equal(r.status, 200, 'status');
  for (const row of r.body.rows) equal(row.flatNo, 'B-204', 'every row is the resident own flat');
});

// --- vendors ---------------------------------------------------------------

suite('vendors');

let vendorId = null;
let billId = null;

await check('the manager records a vendor with no credential anywhere', async () => {
  const r = await manager.post('/api/vendors', {
    name: `Demo Facility Services ${stamp}`,
    category: 'housekeeping',
    pan: 'AAACD1234E',
    tdsSection: '194C',
    payeeKind: 'company',
    bankLast4: '4321',
    bankIfsc: 'DEMO0123456',
  });
  equal(r.status, 201, 'status');
  vendorId = r.body.id;

  const columns = psql(
    `SELECT COUNT(*) FROM information_schema.columns
      WHERE table_name = 'vendors'
        AND (column_name LIKE '%password%' OR column_name LIKE '%secret%'
             OR column_name LIKE '%account_no%' OR column_name LIKE '%token%');`,
  );
  equal(columns.out, '0', 'credential-shaped columns on vendors');
});

await check('a bill withholds 2% for a company under 194C', async () => {
  const r = await manager.post(`/api/vendors/${vendorId}/bills`, {
    billNo: `FS-${stamp}-01`,
    billDate: '2026-07-05',
    expenseAccount: '5050',
    grossPaise: 1_000_000,
  });
  equal(r.status, 201, 'status');
  equal(r.body.tdsRateBps, 200, 'rate');
  equal(r.body.tdsPaise, 20_000, 'tds');
  equal(r.body.netPayablePaise, 980_000, 'net payable');
  equal(r.body.posted, false, 'posted');
  billId = r.body.id;
});

await check('an unapproved bill cannot be booked', async () => {
  const r = await treasurer.post(`/api/vendor-bills/${billId}/book`, { on: '2026-07-06' });
  equal(r.status, 409, 'status');
  matches(r.body.message, /not been approved/, 'message');
});

await check('the manager who entered it cannot approve it', async () => {
  equal((await manager.post(`/api/vendor-bills/${billId}/approve`)).status, 403, 'status');
});

await check('the treasurer approves, and still nothing is posted', async () => {
  const r = await treasurer.post(`/api/vendor-bills/${billId}/approve`);
  equal(r.status, 200, 'status');
  equal(r.body.posted, false, 'posted');
  const entries = psql(
    `SELECT COUNT(*) FROM journal_entries
      WHERE society_id = '${fixture.societyId}' AND source_kind = 'vendor-bill';`,
  );
  equal(entries.out, '0', 'vendor-bill entries after approval');
});

await check('booking posts the expense, the payable and the withholding', async () => {
  const r = await treasurer.post(`/api/vendor-bills/${billId}/book`, { on: '2026-07-06' });
  equal(r.status, 200, 'status');
  equal(r.body.posted, true, 'posted');

  const tb = await treasurer.get('/api/reports/trial-balance?asAt=2026-07-31');
  const expense = tb.body.lines.find(l => l.code === '5050');
  const payable = tb.body.lines.find(l => l.code === '2000');
  const tds = tb.body.lines.find(l => l.code === '2100');
  equal(expense.debit, 1_000_000, 'expense at gross');
  equal(payable.credit, 980_000, 'payable net of tax');
  equal(tds.credit, 20_000, 'tds withheld');
  equal(tb.body.tiesOut, true, 'tiesOut');
});

await check('paying more than the bill is refused', async () => {
  const r = await treasurer.post(`/api/vendor-bills/${billId}/pay`, {
    amountPaise: 1_000_000, paidOn: '2026-07-10', method: 'neft',
    paymentRef: `PAY-${stamp}-over`,
  }, { 'Idempotency-Key': key('vendor-over') });
  equal(r.status, 400, 'status');
  matches(r.body.message, /exceeds the 980000 paise outstanding/, 'message');
});

await check('paying the net clears the payable and says what it did not do', async () => {
  const r = await treasurer.post(`/api/vendor-bills/${billId}/pay`, {
    amountPaise: 980_000, paidOn: '2026-07-10', method: 'neft',
    paymentRef: `PAY-${stamp}-01`,
  }, { 'Idempotency-Key': key('vendor-pay') });
  equal(r.status, 200, 'status');
  matches(r.body.note, /No transfer was initiated/, 'note');

  const tb = await treasurer.get('/api/reports/trial-balance?asAt=2026-07-31');
  const payable = tb.body.lines.find(l => l.code === '2000');
  equal(payable.credit - payable.debit, 0, 'payable after payment');
});

await check('a replayed vendor payment key is refused', async () => {
  const r = await treasurer.post(`/api/vendor-bills/${billId}/pay`, {
    amountPaise: 1, paidOn: '2026-07-10', method: 'neft',
    paymentRef: `PAY-${stamp}-02`,
  }, { 'Idempotency-Key': key('vendor-pay') });
  equal(r.status, 409, 'status');
  matches(r.body.message, /already recorded/, 'message');
});

await check('the vendor payable balance reads back against the vendor', async () => {
  const r = await manager.get('/api/vendors');
  const vendor = r.body.vendors.find(x => x.id === vendorId);
  equal(vendor.payablePaise, 0, 'payable');
  equal(vendor.bankLast4, '4321', 'the last four digits');
});

await check('the TDS register shows the deduction as unremitted', async () => {
  const r = await treasurer.get('/api/reports/tds?quarter=Q2-FY26-27');
  equal(r.body.total, 20_000, 'total');
  equal(r.body.unremitted, 20_000, 'unremitted');
  equal(r.body.bySection[0].section, '194C', 'section');
  equal(r.body.bySection[0].rateBps ?? 200, 200, 'rate');
});

await check('remitting clears it against a challan and nothing is filed', async () => {
  const r = await treasurer.post('/api/tds/Q2-FY26-27/remit', {
    section: '194C', challanNo: `CH-${stamp}`, challanDate: '2026-07-30',
  }, { 'Idempotency-Key': key('tds') });
  equal(r.status, 200, 'status');
  equal(r.body.amount, 20_000, 'amount');
  matches(r.body.note, /Nothing was filed with the income-tax portal/, 'note');

  const after = await treasurer.get('/api/reports/tds?quarter=Q2-FY26-27');
  equal(after.body.unremitted, 0, 'unremitted after the challan');
});

await check('remitting again is refused', async () => {
  const r = await treasurer.post('/api/tds/Q2-FY26-27/remit', {
    section: '194C', challanNo: `CH-${stamp}-again`, challanDate: '2026-07-31',
  }, { 'Idempotency-Key': key('tds-again') });
  equal(r.status, 409, 'status');
  matches(r.body.message, /Nothing is outstanding/, 'message');
});

// --- banking ---------------------------------------------------------------

suite('banking');

const statement = [
  'Date,Narration,Reference,Debit,Credit,Balance',
  '20/07/2026,UPI RECEIPT FLAT B-204,UPI123456,,2000.00,2000.00',
  '10/07/2026,NEFT TO FACILITY SERVICES,NEFT998877,9800.00,,-7800.00',
].join('\n');

await check('importing a statement records the lines and posts nothing', async () => {
  const r = await manager.post('/api/bank/imports', {
    bankAccountId: fixture.bankAccountId,
    format: 'csv',
    filename: `july-${stamp}.csv`,
    content: statement,
  });
  equal(r.status, 201, 'status');
  equal(r.body.inserted, 2, 'inserted');
  equal(r.body.posted, false, 'posted');
});

await check('the same file is refused rather than imported twice', async () => {
  const r = await manager.post('/api/bank/imports', {
    bankAccountId: fixture.bankAccountId,
    format: 'csv',
    filename: `july-again-${stamp}.csv`,
    content: statement,
  });
  equal(r.status, 409, 'status');
  matches(r.body.message, /already imported/, 'message');
});

await check('an unmatched line is offered with a suggestion', async () => {
  const r = await manager.get('/api/bank/transactions?state=unmatched');
  equal(r.body.transactions.length, 2, 'unmatched lines');
  const credit = r.body.transactions.find(t => t.amountPaise > 0);
  equal(credit.amountPaise, 200_000, 'the credit line');
  truthy(credit.suggestedReceiptNo, 'a suggested receipt');
});

await check('a match whose amount disagrees is refused', async () => {
  const lines = await manager.get('/api/bank/transactions?state=unmatched');
  const debit = lines.body.transactions.find(t => t.amountPaise < 0);
  const payment = psql(
    `SELECT id FROM payments WHERE society_id = '${fixture.societyId}'
      AND idempotency_key = '${key('overpayment')}';`,
  );
  const r = await manager.post(`/api/bank/transactions/${debit.id}/match`, {
    paymentId: payment.out,
  });
  equal(r.status, 409, 'status');
  matches(r.body.message, /does not agree on the amount/, 'message');
});

await check('a match that agrees is accepted', async () => {
  const lines = await manager.get('/api/bank/transactions?state=unmatched');
  const credit = lines.body.transactions.find(t => t.amountPaise === 200_000);
  const r = await manager.post(`/api/bank/transactions/${credit.id}/match`, {
    paymentId: credit.suggestedPaymentId,
  });
  equal(r.status, 200, 'status');
  equal(r.body.matched, true, 'matched');
});

await check('a line nobody can place goes to suspense with a reason', async () => {
  const lines = await manager.get('/api/bank/transactions?state=unmatched');
  const debit = lines.body.transactions.find(t => t.amountPaise < 0);
  const r = await manager.post(`/api/bank/transactions/${debit.id}/match`, {
    suspenseReason: 'No vendor payment on record for this reference.',
  });
  equal(r.status, 200, 'status');
  equal(r.body.matched, false, 'matched');
});

await check('a reconciliation with a difference is not signed off', async () => {
  const r = await treasurer.post('/api/bank/reconciliations', {
    bankAccountId: fixture.bankAccountId,
    asAt: '2026-07-31',
    statementBalancePaise: 1,
  });
  equal(r.status, 200, 'status');
  equal(r.body.signedOff, false, 'signedOff');
  truthy(r.body.differencePaise !== 0, 'a difference');
});

await check('one that agrees with the ledger is', async () => {
  const tb = await treasurer.get('/api/reports/trial-balance?asAt=2026-07-31');
  const bank = tb.body.lines.find(l => l.code === '1000');
  const balance = bank.debit - bank.credit;
  const r = await treasurer.post('/api/bank/reconciliations', {
    bankAccountId: fixture.bankAccountId,
    asAt: '2026-07-31',
    statementBalancePaise: balance,
  });
  equal(r.body.differencePaise, 0, 'difference');
  equal(r.body.signedOff, true, 'signedOff');
});

// --- helpdesk --------------------------------------------------------------

suite('helpdesk');

let ticketId = null;

await check('a resident raises a ticket on their own flat', async () => {
  const r = await resident.post('/api/tickets', {
    flatId: flatOf('B-204').id,
    category: 'plumbing',
    description: 'The kitchen tap has been dripping since Tuesday.',
    priority: 'normal',
  });
  equal(r.status, 201, 'status');
  matches(r.body.ticketNo, /^TKT-\d{5}$/, 'ticket number');
  ticketId = r.body.id;
});

await check('and cannot raise one on somebody else flat', async () => {
  const r = await resident.post('/api/tickets', {
    flatId: flatOf('A-101').id,
    category: 'plumbing',
    description: 'Not my flat.',
    priority: 'low',
  });
  equal(r.status, 403, 'status');
});

await check('an unknown category is refused', async () => {
  const r = await resident.post('/api/tickets', {
    flatId: flatOf('B-204').id,
    category: 'teleportation',
    description: 'x',
    priority: 'low',
  });
  equal(r.status, 400, 'status');
  matches(r.body.message, /not a ticket category/, 'message');
});

await check('the SLA sets the due date rather than a stored flag', async () => {
  const r = await manager.get('/api/tickets');
  const ticket = r.body.tickets.find(t => t.id === ticketId);
  const hours = (new Date(ticket.dueAt) - new Date(ticket.raisedAt)) / 3_600_000;
  equal(Math.round(hours), 24, 'hours to the due date for plumbing');
  equal(ticket.breachingSla, false, 'breachingSla');
});

await check('the manager resolves and the resident has the last word', async () => {
  const r = await manager.post(`/api/tickets/${ticketId}/resolve`, {
    resolution: 'Washer replaced.',
  });
  equal(r.status, 200, 'status');
  matches(r.body.note, /closes when the resident confirms/, 'note');
});

await check('a resident who is not satisfied reopens it', async () => {
  const r = await resident.post(`/api/tickets/${ticketId}/confirm`, { satisfied: false });
  equal(r.status, 200, 'status');
  equal(r.body.state, 'reopened', 'state');
  const count = psql(`SELECT reopened_count FROM tickets WHERE id = '${ticketId}';`);
  equal(count.out, '1', 'reopened count');
});

await check('and confirms once it is actually fixed', async () => {
  await manager.post(`/api/tickets/${ticketId}/resolve`, { resolution: 'Tap replaced.' });
  const r = await resident.post(`/api/tickets/${ticketId}/confirm`, {
    satisfied: true, satisfaction: 4,
  });
  equal(r.body.state, 'confirmed', 'state');
});

// --- periods ---------------------------------------------------------------

suite('financial periods');

await check('closing a period records the trial balance it closed on', async () => {
  const before = await treasurer.get('/api/reports/trial-balance?asAt=2026-07-31');
  const r = await treasurer.post('/api/periods/2026-07/close');
  equal(r.status, 200, 'status');
  // The figure recorded is the trial balance, not a number the endpoint chose.
  equal(r.body.trialBalancePaise, before.body.totalDebit, 'the recorded figure');
  truthy(before.body.totalDebit > 0, 'there was something to close over');
});

await check('a period cannot be recorded as closed over a ledger that does not tie', async () => {
  // The application refuses this too, and that check cannot be reached from
  // here: the ledger cannot be made not to tie, because a deferred trigger
  // refuses an unbalanced entry. This is the layer that can be tested, and it
  // is the one that holds against anything reaching the table at all.
  const r = psql(
    `INSERT INTO financial_periods
       (society_id, period, starts_on, ends_on, state, closed_by, closed_at,
        trial_balance_debit, trial_balance_credit)
     VALUES ('${fixture.societyId}', '2025-01', '2025-01-01', '2025-01-31', 'closed',
             '${userOf('treasurer').id}', now(), 1000, 999);`,
  );
  truthy(!r.ok, 'the database accepted a close whose two sides disagree');
  matches(r.out, /violates check constraint/, 'the constraint that refused it');
});

await check('and cannot be closed without saying who closed it', async () => {
  const r = psql(
    `INSERT INTO financial_periods
       (society_id, period, starts_on, ends_on, state, trial_balance_debit, trial_balance_credit)
     VALUES ('${fixture.societyId}', '2025-02', '2025-02-01', '2025-02-28', 'closed', 500, 500);`,
  );
  truthy(!r.ok, 'the database accepted a close with no closer');
  matches(r.out, /violates check constraint/, 'the constraint that refused it');
});

await check('the database then refuses a posting into that period', async () => {
  const r = await manager.post('/api/payments', {
    flatId: flatOf('A-102').id, amountPaise: 1_000, receivedOn: '2026-07-28', method: 'cash',
  }, { 'Idempotency-Key': key('into-closed') });
  equal(r.status, 409, 'status');
  matches(r.body.message, /2026-07/, 'message names the period');
  matches(r.body.message, /closed/, 'message says it is closed');
});

await check('a posting into an open period still works', async () => {
  const r = await manager.post('/api/payments', {
    flatId: flatOf('A-102').id, amountPaise: 1_000, receivedOn: '2026-08-03', method: 'cash',
  }, { 'Idempotency-Key': key('into-open') });
  equal(r.status, 201, 'status');
});

await check('only the secretary can reopen', async () => {
  equal((await treasurer.post('/api/periods/2026-07/reopen', { reason: 'x' })).status, 403, 'treasurer');
  const r = await secretary.post('/api/periods/2026-07/reopen', {
    reason: 'An invoice was raised against the wrong flat and has to be corrected.',
  });
  equal(r.status, 200, 'status');
});

await check('and after reopening the posting is accepted', async () => {
  const r = await manager.post('/api/payments', {
    flatId: flatOf('A-102').id, amountPaise: 2_000, receivedOn: '2026-07-28', method: 'cash',
  }, { 'Idempotency-Key': key('after-reopen') });
  equal(r.status, 201, 'status');
});

// --- with an email provider actually configured ------------------------------

suite('delivery');

// A second server, built with the development email provider, so the positive
// side of "only record a send the provider confirmed" is exercised too. With
// EMAIL_PROVIDER=none every delivery is false, which would pass just as well
// if the code never set it to true.
// A provider that actually reports a delivery, which neither adapter in this
// repository does: the development one writes to the log and says so. Injected
// through buildApp so the code that records a confirmed send is exercised.
const sentMessages = [];
const workingEmailProvider = {
  name: 'test-double',
  delivers: true,
  async send(message) {
    sentMessages.push(message);
    return { provider: 'test-double', providerMessageId: `msg-${sentMessages.length}` };
  },
};
const refusingEmailProvider = {
  name: 'test-double-refusing',
  delivers: true,
  async send() {
    throw new Error('the provider rejected the recipient');
  },
};

await check('a release through a working provider records its message id', async () => {
  const withEmail = buildApp({ ...process.env, PORT: '0' }, {
    runWorker: false, email: workingEmailProvider,
  });
  try {
    const { port: emailPort } = await withEmail.listen();
    const client = new Client(`http://127.0.0.1:${emailPort}`);
    await client.signIn(`treasurer@${domain}`, PASSWORD);

    const target = documents.find(d => d.flatNo === 'A-102');
    const r = await client.post(`/api/billing/documents/${target.documentId}/release`, {
      channel: 'email',
    });
    equal(r.status, 200, 'status');
    equal(r.body.delivered, true, 'delivered');
    matches(r.body.note, /Emailed via test-double/, 'note');
    equal(sentMessages.length, 1, 'messages the provider was given');
    matches(sentMessages[0].to, /^owner\.a102@/, 'the recipient');

    const attempt = psql(
      `SELECT delivered || ' ' || COALESCE(provider_id, 'none')
         FROM dispatch_attempts WHERE document_id = '${target.documentId}';`,
    );
    equal(attempt.out, 'true msg-1', 'the dispatch row records the delivery and the id');
  } finally {
    await withEmail.close();
  }
});

await check('a provider that refuses the message is recorded as a failure', async () => {
  const withEmail = buildApp({ ...process.env, PORT: '0' }, {
    runWorker: false, email: refusingEmailProvider,
  });
  try {
    const { port: emailPort } = await withEmail.listen();
    const client = new Client(`http://127.0.0.1:${emailPort}`);
    await client.signIn(`treasurer@${domain}`, PASSWORD);

    const target = documents.find(d => d.flatNo === 'B-101');
    const r = await client.post(`/api/billing/documents/${target.documentId}/release`, {
      channel: 'email',
    });
    equal(r.status, 200, 'status');
    equal(r.body.delivered, false, 'delivered');
    matches(r.body.note, /rejected the recipient/, 'note');

    const attempt = psql(
      `SELECT delivered || ' ' || COALESCE(failure, 'none')
         FROM dispatch_attempts WHERE document_id = '${target.documentId}';`,
    );
    matches(attempt.out, /^false the provider rejected/, 'the dispatch row records the failure');
  } finally {
    await withEmail.close();
  }
});

await check('a release to a flat with no owner on record emails nobody', async () => {
  const withEmail = buildApp({ ...process.env, PORT: '0' }, {
    runWorker: false, email: workingEmailProvider,
  });
  try {
    const { port: emailPort } = await withEmail.listen();
    const client = new Client(`http://127.0.0.1:${emailPort}`);
    await client.signIn(`treasurer@${domain}`, PASSWORD);

    const target = documents.find(d => d.flatNo === 'C-301');
    psql(`UPDATE flat_ownership SET held_until = current_date - 1
            WHERE flat_id = '${flatOf('C-301').id}' AND held_until IS NULL;`);

    const r = await client.post(`/api/billing/documents/${target.documentId}/release`, {
      channel: 'email',
    });
    equal(r.body.delivered, false, 'delivered');
    matches(r.body.note, /No current owner email/, 'note');
  } finally {
    await withEmail.close();
  }
});

// --- cancelling a raised invoice ---------------------------------------------

suite('cancellation');

await check('cancelling a tax invoice reverses it rather than unposting it', async () => {
  const target = documents.find(d => d.flatNo === 'A-201');
  const convert = await treasurer.post(`/api/billing/documents/${target.documentId}/convert`, {
    on: '2026-07-19', because: 'manual',
  });
  equal(convert.status, 200, 'the conversion');

  const before = await treasurer.get(
    '/api/reports/income-expenditure?from=2026-07-01&to=2026-07-31',
  );

  const r = await treasurer.post(`/api/billing/documents/${target.documentId}/cancel`, {
    reason: 'Raised against the wrong flat.', on: '2026-07-19',
  });
  equal(r.status, 200, 'status');
  truthy(r.body.reversalEntryId, 'a reversal entry id');

  // The income it raised is taken back out by a debit on the income account,
  // which is the figure a report has to net off rather than add up.
  const after = await treasurer.get(
    '/api/reports/income-expenditure?from=2026-07-01&to=2026-07-31',
  );
  // A-201 is 1150 sq ft at 450 paise: 517,500 of maintenance income. The
  // sinking share and the GST came off the fund and the tax accounts, not out
  // of income, so only the maintenance figure moves here.
  equal(after.body.totalIncome, before.body.totalIncome - 517_500, 'income after the cancellation');

  // The original is still there, now linked to its mirror. Nothing was
  // removed: a cancellation is two entries, not zero.
  const links = psql(
    `SELECT (e.reversed_by IS NOT NULL) || ' ' || (r.reversal_of = e.id)
       FROM journal_entries e
       JOIN journal_entries r ON r.id = e.reversed_by
      WHERE e.id = '${convert.body.entryId}';`,
  );
  equal(links.out, 'true true', 'the original points at its reversal and back');
});

await check('and the document reads as cancelled with nothing outstanding', async () => {
  const r = await manager.get(`/api/billing/documents?period=${encodeURIComponent(period)}`);
  const document = r.body.documents.find(d => d.flatNo === 'A-201');
  equal(document.state, 'cancelled', 'state');
  equal(document.paymentStatus, 'Cancelled', 'paymentStatus');
  equal(document.outstanding, 0, 'outstanding');
});

await check('and the trial balance still ties', async () => {
  const r = await treasurer.get('/api/reports/trial-balance?asAt=2026-07-31');
  equal(r.body.tiesOut, true, 'tiesOut');
});

await check('and the GST register no longer reports the cancelled invoice', async () => {
  // A cancellation reverses the invoice in the ledger. The register has to
  // follow, or a return built from it overstates output tax by exactly the
  // cancelled invoice — which is what a whole-database sweep found: 55 test
  // societies each off by one invoice's CGST.
  //
  // In GST terms a cancellation of an issued invoice is a credit note, so that
  // is what it writes: an adjustment, and a register row that nets it off.
  const r = await treasurer.get('/api/reports/gst?taxPeriod=2026-07');
  equal(r.status, 200, 'status');
  equal(r.body.agrees, true, 'the register and the ledger agree after the cancellation');
  truthy(r.body.creditNotes >= 1, `a credit note for it, got ${r.body.creditNotes}`);

  const note = psql(
    `SELECT a.note_no || ' ' || a.amount || ' ' || a.tax_amount
       FROM invoice_adjustments a
       JOIN billing_documents d ON d.id = a.document_id
      WHERE d.society_id = '${fixture.societyId}' AND d.state = 'cancelled';`,
  );
  matches(note.out, /^CN\//, 'a credit note was raised for the cancellation');

  const [, amount, tax] = note.out.split(' ');
  // A-201 is 1150 sq ft at 450 paise: 517,500 maintenance plus a 51,750
  // sinking share, and 18% on the maintenance part only.
  equal(Number(amount), 517_500 + 51_750, 'the note covers the whole invoice');
  equal(Number(tax), 93_150, 'and its tax');
});

// --- rates -----------------------------------------------------------------

suite('rates');

await check('a new rate is recorded unapproved and says so', async () => {
  const r = await secretary.post('/api/rates', {
    paisePerSqFt: 500,
    basis: 'super-built-up',
    effectiveFrom: '2026-09-01',
    authority: 'Committee minute of the integration test.',
  });
  equal(r.status, 201, 'status');
  equal(r.body.approved, false, 'approved');
  matches(r.body.note, /refuses to use an unapproved rate/, 'note');
});

await check('and billing refuses to use it', async () => {
  const r = await manager.post('/api/billing/run', { period: 'Sep 2026', issuedOn: '2026-09-01' });
  equal(r.status, 400, 'status');
  matches(r.body.message, /has not been approved/, 'message');
  matches(r.body.message, /2026-09-01/, 'message names the rate in force');

  const documents = psql(
    `SELECT COUNT(*) FROM billing_documents
      WHERE society_id = '${fixture.societyId}' AND period = 'Sep 2026';`,
  );
  equal(documents.out, '0', 'documents issued for September');
});

await check('once approved, the new rate is the one billed from', async () => {
  const rates = await secretary.get('/api/rates');
  const pending = rates.body.rates.find(x => x.effectiveFrom === '2026-09-01');
  equal((await secretary.post(`/api/rates/${pending.id}/approve`, { on: '2026-08-25' })).status, 403,
    'a secretary cannot approve a rate');
  equal((await treasurer.post(`/api/rates/${pending.id}/approve`, { on: '2026-08-25' })).status, 200,
    'the treasurer can');

  const r = await manager.post('/api/billing/run', { period: 'Sep 2026', issuedOn: '2026-09-01' });
  equal(r.status, 201, 'status');
  equal(r.body.rate.ratePerSqFt, 5, 'the rate used');
  const b204 = r.body.issued.find(d => d.flatNo === 'B-204');
  // 985 sq ft at 500 paise, plus the 10% sinking share, plus 18% on the
  // maintenance part only.
  equal(b204.net, 492_500 + 49_250, 'net');
  equal(b204.estimatedTax, 88_650, 'estimated tax');
});

await check('approving a rate twice is refused', async () => {
  const rates = await secretary.get('/api/rates');
  const approved = rates.body.rates.find(x => x.effectiveFrom === '2026-09-01');
  const r = await treasurer.post(`/api/rates/${approved.id}/approve`, { on: '2026-08-25' });
  equal(r.status, 409, 'status');
});

// --- the approval chain ----------------------------------------------------

suite('approval chain');

await check('a document with no pending approval request cannot be approved', async () => {
  const run = await manager.post('/api/billing/run', { period: 'Oct 2026', issuedOn: '2026-10-01' });
  equal(run.status, 201, 'the run');
  const document = run.body.issued[0];

  // The maker's request, removed. Approving now would be an approval with no
  // recorded maker, which is the thing maker-checker exists to prevent.
  psql(
    `DELETE FROM approvals WHERE society_id = '${fixture.societyId}'
       AND subject_table = 'billing_documents' AND subject_id = '${document.documentId}';`,
  );
  const r = await treasurer.post(`/api/billing/documents/${document.documentId}/approve`, {
    on: '2026-10-01',
  });
  equal(r.status, 409, 'status');
  matches(r.body.message, /no pending approval request/, 'message');

  const state = psql(
    `SELECT state FROM billing_documents WHERE id = '${document.documentId}';`,
  );
  equal(state.out, 'draft', 'the document was left as it was');
});

await check('a document with one can be', async () => {
  const documents = await manager.get('/api/billing/documents?period=Oct%202026');
  const withRequest = documents.body.documents.find(d => d.state === 'draft'
    && psql(`SELECT COUNT(*) FROM approvals WHERE subject_id = '${d.id}' AND decision IS NULL;`).out === '1');
  truthy(withRequest, 'a draft with a pending request');
  const r = await treasurer.post(`/api/billing/documents/${withRequest.id}/approve`, {
    on: '2026-10-01',
  });
  equal(r.status, 200, 'status');
});

// --- scheduled jobs --------------------------------------------------------

suite('scheduled jobs');

const jobPool = new PgPool(connectionFromEnv(process.env));
const jobContext = {
  pool: jobPool,
  log: createLogger({ logLevel: 'error', mode: 'test' }),
  email: resolveEmailProvider('none', createLogger({ logLevel: 'error', mode: 'test' })),
  now: () => '2026-08-01',
};

await check('the backoff grows and is capped', async () => {
  equal(backoffMinutes(1), 1, 'first retry');
  equal(backoffMinutes(2), 2, 'second');
  equal(backoffMinutes(4), 8, 'fourth');
  equal(backoffMinutes(30), 60, 'capped');
});

await check('a scheduled billing run bills the period once', async () => {
  const scheduled = await manager.post('/api/jobs', {
    kind: 'monthly-billing',
    runKey: `aug-${stamp}`,
    scheduledFor: '2026-08-01',
    payload: { period: 'Aug 2026', issuedOn: '2026-08-01' },
  });
  equal(scheduled.status, 201, 'scheduling');

  const summary = await runDueJobs(jobContext, { worker: `test-${stamp}` });
  equal(summary.claimed, 1, 'claimed');
  equal(summary.succeeded, 1, 'succeeded');

  const documents = psql(
    `SELECT COUNT(*) FROM billing_documents
      WHERE society_id = '${fixture.societyId}' AND period = 'Aug 2026';`,
  );
  equal(documents.out, '10', 'documents for August');
});

await check('a queued job can be run by hand, by whoever may queue one', async () => {
  // The platform limit this exists for: on Vercel's Hobby plan a cron may run
  // only once a day, so a notification queued this morning would sit until the
  // small hours. Whoever just released the bills can send them now instead.
  const runKey = `drain-${stamp}`;
  const scheduled = await manager.post('/api/jobs', {
    kind: 'notification-dispatch',
    runKey,
    scheduledFor: '2026-08-01',
    payload: {},
  });
  equal(scheduled.status, 201, 'queued');

  const drained = await manager.post('/api/jobs/drain');
  equal(drained.status, 200, 'the pass ran');
  truthy(drained.body.claimed >= 1, `it claimed the job: ${JSON.stringify(drained.body)}`);

  const state = psql(`SELECT state FROM scheduled_jobs WHERE run_key = '${runKey}';`);
  equal(state.out, 'succeeded', 'and the job finished');
});

await check('running the queue by hand needs the permission that queues work', async () => {
  // It carries out queued work and cannot create any, so it cannot step
  // around maker-checker — but it is still not something a resident does.
  const refused = await resident.post('/api/jobs/drain');
  equal(refused.status, 403, 'a resident is refused');
  const auditorTry = await auditor.post('/api/jobs/drain');
  equal(auditorTry.status, 403, 'and so is an auditor, who may read everything');
});

await check('running the queue by hand is still a write, so it needs the CSRF header', async () => {
  const r = await manager.call('POST', '/api/jobs/drain', {}, { 'X-CSRF-Token': 'wrong' });
  equal(r.status, 403, 'refused');
  equal(r.body.error, 'csrf_failed', 'on the CSRF check');
});

await check('the same run key cannot be scheduled twice', async () => {
  const r = await manager.post('/api/jobs', {
    kind: 'monthly-billing',
    runKey: `aug-${stamp}`,
    scheduledFor: '2026-08-01',
    payload: { period: 'Aug 2026' },
  });
  equal(r.status, 409, 'status');
});

await check('a claimed job is not claimed again', async () => {
  const summary = await runDueJobs(jobContext, { worker: `test-${stamp}` });
  equal(summary.claimed, 0, 'claimed');
});

await check('a failing job is retried with a backoff and keeps its error', async () => {
  psql(
    `INSERT INTO scheduled_jobs (society_id, kind, run_key, scheduled_for, payload, max_attempts)
     VALUES ('${fixture.societyId}', 'monthly-billing', 'broken-${stamp}', now(), '{}'::jsonb, 2);`,
  );
  const first = await runDueJobs(jobContext, { worker: `test-${stamp}` });
  equal(first.retrying, 1, 'retrying');
  const state = psql(
    `SELECT state || ' ' || (next_attempt_at > now())::text || ' ' || left(last_error, 20)
       FROM scheduled_jobs WHERE run_key = 'broken-${stamp}';`,
  );
  matches(state.out, /^pending true this job needs/, 'state after the first failure');
});

await check('and is abandoned with its last error once the attempts run out', async () => {
  psql(`UPDATE scheduled_jobs SET next_attempt_at = now() - interval '1 hour'
          WHERE run_key = 'broken-${stamp}';`);
  const second = await runDueJobs(jobContext, { worker: `test-${stamp}` });
  equal(second.failed, 1, 'failed');
  equal(psql(`SELECT state FROM scheduled_jobs WHERE run_key = 'broken-${stamp}';`).out,
    'failed', 'state');
  equal(psql(`SELECT last_error IS NOT NULL FROM scheduled_jobs WHERE run_key = 'broken-${stamp}';`).out,
    't', 'last_error is kept');
});

await check('a manager cannot schedule a conversion, which is the treasurer\'s call', async () => {
  const r = await manager.post('/api/jobs', {
    kind: 'due-date-conversion',
    runKey: `mgr-convert-${stamp}`,
    scheduledFor: '2026-08-20',
    payload: { on: '2026-08-20' },
  });
  equal(r.status, 403, 'status');
});

await check('a conversion cannot be scheduled for a date still to come', async () => {
  const r = await treasurer.post('/api/jobs', {
    kind: 'due-date-conversion',
    runKey: `future-convert-${stamp}`,
    scheduledFor: '2026-08-20',
    payload: { on: '2099-12-31' },
  });
  equal(r.status, 400, 'status');
});

await check('the due-date conversion job converts what is past due', async () => {
  await treasurer.post('/api/jobs', {
    kind: 'due-date-conversion',
    runKey: `aug-convert-${stamp}`,
    scheduledFor: '2026-08-20',
    payload: { on: '2026-08-20' },
  });
  psql(`UPDATE scheduled_jobs SET scheduled_for = now()
          WHERE run_key = 'aug-convert-${stamp}';`);

  // Whatever is approved, unconverted and past due on 20 August — counted
  // first, so the expectation is the database's answer rather than a number
  // that has to be edited whenever another test converts one more document.
  const due = psql(
    `SELECT COUNT(*) FROM billing_documents
      WHERE society_id = '${fixture.societyId}'
        AND state IN ('approved','released') AND due_on <= '2026-08-20';`,
  );
  truthy(Number(due.out) > 0, 'there was something past due');

  const summary = await runDueJobs(jobContext, { worker: `test-${stamp}` });
  equal(summary.claimed, 1, 'claimed');
  equal(summary.succeeded, 1, 'succeeded');

  const result = psql(
    `SELECT result::text FROM scheduled_jobs WHERE run_key = 'aug-convert-${stamp}';`,
  );
  const converted = JSON.parse(result.out).converted;
  equal(converted.length, Number(due.out), 'invoices raised');

  // August's are still drafts and must not be touched: an unapproved document
  // cannot become a tax invoice.
  const august = psql(
    `SELECT COUNT(*) FROM billing_documents
      WHERE society_id = '${fixture.societyId}' AND period = 'Aug 2026'
        AND state = 'tax-invoice';`,
  );
  equal(august.out, '0', "August's drafts were left alone");
});

await check('the dispatch job reports that no provider is configured', async () => {
  await manager.post('/api/jobs', {
    kind: 'notification-dispatch',
    runKey: `dispatch-${stamp}`,
    scheduledFor: '2026-08-01',
    payload: {},
  });
  psql(`UPDATE scheduled_jobs SET scheduled_for = now() WHERE run_key = 'dispatch-${stamp}';`);
  await runDueJobs(jobContext, { worker: `test-${stamp}` });
  const result = psql(`SELECT result::text FROM scheduled_jobs WHERE run_key = 'dispatch-${stamp}';`);
  matches(result.out, /no email provider is configured/, 'result');
  matches(result.out, /"sent": 0|"sent":0/, 'nothing was sent');
});


// --- the snapshot the screens read -----------------------------------------

suite('books snapshot');

await check('the snapshot is engine-shaped and the engine accepts it', async () => {
  const r = await treasurer.get('/api/books/snapshot');
  equal(r.status, 200, 'status');
  equal(r.body.scope, 'society', 'scope');
  truthy(r.body.entries.length > 5, 'entries');
  truthy(r.body.documents.length > 5, 'documents');

  // The shapes the client rehydrates. Checked field by field, because a
  // missing one is a screen that renders nothing with no error.
  const entry = r.body.entries[0];
  for (const field of ['id', 'date', 'narration', 'source', 'postings', 'idempotencyKey', 'postedBy']) {
    truthy(entry[field] !== undefined, `entry.${field}`);
  }
  truthy(Array.isArray(entry.postings) && entry.postings.length >= 2, 'at least two legs');
  for (const field of ['accountCode', 'debit', 'credit']) {
    truthy(entry.postings[0][field] !== undefined, `leg.${field}`);
  }
  const document = r.body.documents.find(d => d.state === 'tax-invoice');
  for (const field of ['proformaNo', 'flatNo', 'period', 'lines', 'gross', 'issuedOn', 'dueOn', 'state']) {
    truthy(document[field] !== undefined, `document.${field}`);
  }
});

await check('every entry in the snapshot balances', async () => {
  const r = await treasurer.get('/api/books/snapshot');
  for (const entry of r.body.entries) {
    const debit = entry.postings.reduce((sum, leg) => sum + leg.debit, 0);
    const credit = entry.postings.reduce((sum, leg) => sum + leg.credit, 0);
    equal(debit, credit, `entry ${entry.id} (${entry.narration.slice(0, 40)})`);
  }
});

await check('every account the snapshot names is in the engine chart', async () => {
  // The reason the seed takes its chart from the engine. An account the engine
  // does not know makes `Ledger.restore` refuse the entry, and the screens
  // then show a ledger quietly missing transactions.
  const { CHART } = await import('../.server-build/src/accounting/accounts.js');
  const known = new Set(CHART.map(a => a.code));
  const r = await treasurer.get('/api/books/snapshot');
  const unknown = new Set();
  for (const entry of r.body.entries) {
    for (const leg of entry.postings) if (!known.has(leg.accountCode)) unknown.add(leg.accountCode);
  }
  equal([...unknown].join(',') || 'none', 'none', 'accounts the engine does not know');
});

await check('the snapshot carries the society identity without inventing one', async () => {
  const r = await treasurer.get('/api/books/snapshot');
  equal(r.body.gstin, null, 'gstin, which this society has not recorded');
  equal(r.body.registrationNo, null, 'registration number');
  equal(r.body.mode, 'demo', 'mode');
  truthy(r.body.societyName.includes('API test society'), 'society name');
});

await check('a resident gets only their own flat, documents and entries', async () => {
  const r = await resident.get('/api/books/snapshot');
  equal(r.status, 200, 'status');
  equal(r.body.scope, 'own-flats', 'scope');
  equal(r.body.flats.length, 1, 'flats');
  equal(r.body.flats[0].flatNo, 'B-204', 'the flat');
  for (const document of r.body.documents) equal(document.flatNo, 'B-204', 'every document');
  truthy(r.body.entries.length > 0, 'some entries');
  // Every entry has a leg naming their flat; nothing about another one.
  for (const entry of r.body.entries) {
    truthy(
      entry.postings.some(leg => leg.party === 'B-204'),
      `entry ${entry.narration.slice(0, 40)} touches their flat`,
    );
  }
  equal(r.body.vendorBills.length, 0, 'vendor bills a resident may see');
});

await check('a resident sees fewer entries than the treasurer', async () => {
  const mine = await resident.get('/api/books/snapshot');
  const all = await treasurer.get('/api/books/snapshot');
  truthy(
    mine.body.entries.length < all.body.entries.length,
    `resident ${mine.body.entries.length} against treasurer ${all.body.entries.length}`,
  );
});

await check('the snapshot reports the settings and the rate with their approvals', async () => {
  const r = await treasurer.get('/api/books/snapshot');
  equal(r.body.settings.gst.chargeGst, true, 'GST is on');
  equal(r.body.settings.gst.approved, true, 'and approved by this point in the suite');
  equal(r.body.rate.approved, true, 'the rate in force is approved');
  equal(r.body.settings.sinkingFundPercent, 10, 'the sinking share');
});

// --- documents as PDFs ------------------------------------------------------

suite('PDF documents');

let invoicePdfBytes = null;

await check('a tax invoice renders as a PDF', async () => {
  const documents = await manager.get('/api/billing/documents?period=Jul%202026');
  const invoice = documents.body.documents.find(d => d.state === 'tax-invoice');
  truthy(invoice, 'a tax invoice to print');

  const response = await fetch(`${base}/api/billing/documents/${invoice.id}/pdf`, {
    headers: { Cookie: [...treasurer.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  equal(response.status, 200, 'status');
  equal(response.headers.get('content-type'), 'application/pdf', 'content type');
  matches(response.headers.get('content-disposition'), /\.pdf"$/, 'filename');

  invoicePdfBytes = Buffer.from(await response.arrayBuffer());
  matches(invoicePdfBytes.subarray(0, 8).toString('latin1'), /^%PDF-1\.4/, 'the file header');
  matches(invoicePdfBytes.subarray(-6).toString('latin1'), /%%EOF/, 'the trailer');
  truthy(invoicePdfBytes.length > 1200, `a plausible size, got ${invoicePdfBytes.length}`);
});

await check('a resident cannot regenerate the official copy of a document', async () => {
  const documents = await manager.get('/api/billing/documents?period=Jul%202026');
  const own = documents.body.documents.find(d => d.flatNo === 'B-204' && d.state !== 'draft');
  truthy(own, 'a printable document for B-204');
  const response = await fetch(
    `${base}/api/billing/documents/${own.id}/pdf?regenerate=true`,
    { headers: { Cookie: [...resident.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } },
  );
  equal(response.status, 409, 'status');
});

await check('the PDF carries the figures, not placeholders', async () => {
  const text = invoicePdfBytes.toString('latin1');
  matches(text, /TAX INVOICE/, 'the document title');
  matches(text, /MV\/2026\/0000/, 'the invoice number');
  matches(text, /Maintenance charges/, 'the line label');
  // The society has no GSTIN, and the document says so rather than printing one.
  matches(text, /No registration or GSTIN on record/, 'the absence, stated');
  matches(text, /DEMONSTRATION DATA/, 'the demo-mode warning');
});

await check('a reprint is byte-identical', async () => {
  const documents = await manager.get('/api/billing/documents?period=Jul%202026');
  const invoice = documents.body.documents.find(d => d.state === 'tax-invoice');
  const headers = {
    Cookie: [...treasurer.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
  };
  const again = await fetch(`${base}/api/billing/documents/${invoice.id}/pdf`, { headers });
  equal(again.headers.get('x-document-reprinted'), 'true', 'reported as a reprint');
  const bytes = Buffer.from(await again.arrayBuffer());
  // The stored render payload is why: an invoice is a legal document and must
  // not change because a rate did.
  equal(bytes.length, invoicePdfBytes.length, 'the same length');
  equal(bytes.equals(invoicePdfBytes), true, 'the same bytes');
});

await check('a receipt renders as a PDF with its allocations', async () => {
  const payments = await manager.get('/api/payments');
  const payment = payments.body.payments.find(p => p.allocations.length > 0);
  const response = await fetch(`${base}/api/payments/${payment.id}/pdf`, {
    headers: { Cookie: [...treasurer.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  equal(response.status, 200, 'status');
  const text = Buffer.from(await response.arrayBuffer()).toString('latin1');
  matches(text, /^%PDF-1\.4/, 'a PDF');
  matches(text, /RECEIPT/, 'the title');
  matches(text, /Amount received/, 'the amount block');
  matches(text, new RegExp(payment.receiptNo.replace(/\//g, '\\/')), 'the receipt number');
});

await check('a resident may print their own invoice and not another flat\'s', async () => {
  const mine = await resident.get('/api/billing/documents');
  const ownInvoice = mine.body.documents.find(d => d.state === 'tax-invoice');
  const residentHeaders = {
    Cookie: [...resident.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
  };
  const own = await fetch(`${base}/api/billing/documents/${ownInvoice.id}/pdf`, {
    headers: residentHeaders,
  });
  equal(own.status, 200, 'their own');

  const all = await manager.get('/api/billing/documents?period=Jul%202026');
  const other = all.body.documents.find(d => d.flatNo !== 'B-204' && d.state === 'tax-invoice');
  const refused = await fetch(`${base}/api/billing/documents/${other.id}/pdf`, {
    headers: residentHeaders,
  });
  equal(refused.status, 403, "another flat's");
});

await check('an unapproved draft has nothing to print', async () => {
  const run = await manager.post('/api/billing/run', { period: 'Nov 2026', issuedOn: '2026-11-01' });
  const draft = run.body.issued[0];
  const response = await fetch(`${base}/api/billing/documents/${draft.documentId}/pdf`, {
    headers: { Cookie: [...treasurer.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  equal(response.status, 409, 'status');
});

// --- credit and debit notes -------------------------------------------------

suite('credit and debit notes');

await check('a note cannot be raised against a proforma', async () => {
  const documents = await manager.get('/api/billing/documents?period=Nov%202026');
  const draft = documents.body.documents[0];
  const r = await treasurer.post(`/api/billing/documents/${draft.id}/notes`, {
    kind: 'credit', amountPaise: 1000, reason: 'Too early.', on: '2026-11-02', withTax: false,
  });
  equal(r.status, 409, 'status');
  matches(r.body.message, /only be raised against a tax invoice/, 'message');
});

let creditNoteNo = null;

await check('a credit note reduces the receivable and takes the income back', async () => {
  const documents = await manager.get('/api/billing/documents?asAt=2026-08-31');
  const invoice = documents.body.documents.find(
    d => d.state === 'tax-invoice' && d.outstanding > 200_000,
  );
  truthy(invoice, 'an invoice with something outstanding');

  const before = await treasurer.get('/api/reports/trial-balance?asAt=2026-08-31');
  const receivableBefore = before.body.lines.find(l => l.code === '1100');

  const r = await treasurer.post(`/api/billing/documents/${invoice.id}/notes`, {
    kind: 'credit',
    amountPaise: 100_000,
    reason: 'Lift was out of service for three weeks.',
    on: '2026-08-15',
    withTax: true,
  });
  equal(r.status, 201, 'status');
  // The number, not a specific one: a cancellation earlier in the suite also
  // raises a credit note, so this is not necessarily the first.
  matches(r.body.noteNo, /^CN\/2026\/\d{4}$/, 'note number');
  creditNoteNo = r.body.noteNo;
  equal(r.body.taxPaise, 18_000, 'tax on the note at 18%');
  equal(r.body.totalPaise, 118_000, 'total credited');

  const after = await treasurer.get('/api/reports/trial-balance?asAt=2026-08-31');
  const receivableAfter = after.body.lines.find(l => l.code === '1100');
  equal(
    (receivableAfter.debit - receivableAfter.credit),
    (receivableBefore.debit - receivableBefore.credit) - 118_000,
    'the receivable after the note',
  );
  equal(after.body.tiesOut, true, 'and the books still tie');
});

await check('the note shows against the invoice it was raised on', async () => {
  const r = await treasurer.get('/api/billing/notes');
  equal(r.status, 200, 'status');
  const note = r.body.notes.find(n => n.noteNo === creditNoteNo);
  truthy(note, `the note ${creditNoteNo}`);
  equal(note.amountPaise, 100_000, 'amount');
  truthy(note.taxInvoiceNo !== null, 'the invoice it adjusts');
});

await check('the GST register nets the note, so a return would agree', async () => {
  const r = await treasurer.get('/api/reports/gst?taxPeriod=2026-08');
  equal(r.status, 200, 'status');
  equal(r.body.creditNotes, 1, 'credit notes in the period');

  // The row is stored positive — a return reports a note in its own table,
  // not as a negative invoice — so the summary has to subtract it. The proof
  // is that it ties to the ledger, where the note was posted as a debit.
  const rows = psql(
    `SELECT COALESCE(SUM(CASE WHEN entry_kind = 'credit-note' THEN -cgst ELSE cgst END), 0)
       FROM gst_register
      WHERE society_id = '${fixture.societyId}' AND tax_period = '2026-08';`,
  );
  equal(r.body.cgst, Number(rows.out), 'summary against the register, netted');
  equal(r.body.agrees, true, 'register against the ledger');

  const invoicesOnly = psql(
    `SELECT COALESCE(SUM(cgst), 0) FROM gst_register
      WHERE society_id = '${fixture.societyId}' AND tax_period = '2026-08'
        AND entry_kind = 'invoice';`,
  );
  // The invoices for the month, less the note's own 9,000 paise of CGST.
  equal(r.body.cgst, Number(invoicesOnly.out) - 9_000, 'invoices less the credit note');
});

await check('a note that would carry an unapproved tax is refused', async () => {
  await secretary.put('/api/settings/gst.treatment', {
    value: { chargeGst: true, ratePercent: 18 },
  });
  const documents = await manager.get('/api/billing/documents?asAt=2026-08-31');
  const invoice = documents.body.documents.find(d => d.state === 'tax-invoice');
  const r = await treasurer.post(`/api/billing/documents/${invoice.id}/notes`, {
    kind: 'debit', amountPaise: 5_000, reason: 'Correction.', on: '2026-08-20', withTax: true,
  });
  equal(r.status, 409, 'status');
  matches(r.body.message, /has not been confirmed/, 'message');
  // Put the approval back for the rest of the suite.
  await treasurer.post('/api/settings/gst.treatment/approve', { on: '2026-07-17' });
});

await check('a manager cannot raise a note', async () => {
  const documents = await manager.get('/api/billing/documents?asAt=2026-08-31');
  const invoice = documents.body.documents.find(d => d.state === 'tax-invoice');
  const r = await manager.post(`/api/billing/documents/${invoice.id}/notes`, {
    kind: 'credit', amountPaise: 1_000, reason: 'No.', on: '2026-08-21', withTax: false,
  });
  equal(r.status, 403, 'status');
});

// --- the notification queue -------------------------------------------------

suite('notifications');

await check('queueing says plainly that nothing has been sent', async () => {
  const r = await treasurer.post('/api/billing/periods/Jul%202026/notify', {
    template: 'invoice-issued',
  });
  equal(r.status, 201, 'status');
  // Every document for the period whose flat has a current owner with an
  // address. The ones without are reported, not silently dropped.
  const documents = await manager.get('/api/billing/documents?period=Jul%202026');
  const live = documents.body.documents.filter(d => d.state !== 'cancelled').length;
  equal(r.body.queued + r.body.withoutAnAddress.length, live, 'queued plus those with no address');
  truthy(r.body.queued > 0, `queued, got ${r.body.queued}`);
  equal(r.body.sent, 0, 'sent');
  equal(r.body.providerDelivers, false, 'the provider does not deliver');
  matches(r.body.note, /no sending provider is configured/, 'note');
});

await check('a queued notification cannot be marked sent without evidence', async () => {
  const r = psql(
    `UPDATE notifications SET state = 'sent', sent_at = now()
      WHERE society_id = '${fixture.societyId}' AND state = 'queued';`,
  );
  truthy(!r.ok, 'the database accepted a send with no provider and no message id');
  matches(r.out, /violates check constraint/, 'the constraint that refused it');
});

await check('the dispatch job sends them when a provider can, and attaches the document', async () => {
  const sent = [];
  const workingProvider = {
    name: 'test-double',
    delivers: true,
    async send(message) {
      sent.push(message);
      return { provider: 'test-double', providerMessageId: `queued-${sent.length}` };
    },
  };

  const summary = await runDueJobs(
    { ...jobContext, email: workingProvider },
    { worker: `test-${stamp}` },
  );
  void summary;

  await manager.post('/api/jobs', {
    kind: 'notification-dispatch',
    runKey: `dispatch-queue-${stamp}`,
    scheduledFor: '2026-08-01',
    payload: {},
  });
  psql(`UPDATE scheduled_jobs SET scheduled_for = now()
          WHERE run_key = 'dispatch-queue-${stamp}';`);
  await runDueJobs({ ...jobContext, email: workingProvider }, { worker: `test-${stamp}` });

  truthy(sent.length > 0, 'messages the provider was given');
  const withAttachment = sent.find(m => (m.attachments ?? []).length > 0);
  truthy(withAttachment, 'one of them carried the document');
  matches(withAttachment.attachments[0].filename, /\.pdf$/, 'the attachment is a PDF');
  matches(
    withAttachment.attachments[0].body.subarray(0, 8).toString('latin1'),
    /^%PDF-1\.4/,
    'and it is a real PDF',
  );

  const state = psql(
    `SELECT state || ' ' || (provider_message_id IS NOT NULL)
       FROM notifications WHERE society_id = '${fixture.societyId}'
       ORDER BY queued_at LIMIT 1;`,
  );
  equal(state.out, 'sent true', 'the row records the send and its evidence');
});

await check('the queue is visible with what each delivery is evidenced by', async () => {
  const r = await treasurer.get('/api/notifications');
  equal(r.status, 200, 'status');
  const row = r.body.notifications.find(n => n.state === 'sent');
  truthy(row, 'a sent row');
  truthy(row.providerMessageId !== null, 'with a provider message id');
  equal(row.provider, 'test-double', 'and the provider that accepted it');
});

// --- administration ---------------------------------------------------------

suite('administration');

let newUserId = null;

await check('nobody can change their own roles', async () => {
  const r = await secretary.post(`/api/users/${userOf('secretary').id}/roles`, {
    roles: ['secretary', 'auditor'],
  });
  equal(r.status, 409, 'status');
});

await check('secretary and treasurer cannot be held by one account', async () => {
  const r = await secretary.post(`/api/users/${userOf('auditor').id}/roles`, {
    roles: ['secretary', 'treasurer'],
  });
  equal(r.status, 400, 'status');
});

await check('only the secretary may list accounts', async () => {
  equal((await treasurer.get('/api/users')).status, 403, 'treasurer');
  equal((await manager.get('/api/users')).status, 403, 'manager');
  const r = await secretary.get('/api/users');
  equal(r.status, 200, 'secretary');
  truthy(r.body.users.length >= 14, 'the seeded accounts');
  // Never the hash, only whether one is set.
  truthy(r.body.users.every(u => u.hasPassword !== undefined && u.passwordHash === undefined),
    'no password material in the listing');
});

await check('a new account is created with roles and no password by default', async () => {
  const r = await secretary.post('/api/users', {
    email: `auditor2.${stamp}@${domain}`,
    roles: ['auditor'],
  });
  equal(r.status, 201, 'status');
  equal(r.body.passwordSet, false, 'passwordSet');
  newUserId = r.body.id;
});

await check('an account cannot be both maker and checker', async () => {
  const r = await secretary.post('/api/users', {
    email: `both.${stamp}@${domain}`,
    roles: ['manager', 'treasurer'],
  });
  equal(r.status, 400, 'status');
  matches(r.body.message, /raise a bill and approve it/, 'message');
});

await check('roles can be changed and the trail records both sides', async () => {
  const r = await secretary.post(`/api/users/${newUserId}/roles`, { roles: ['resident'] });
  equal(r.status, 200, 'status');
  const trail = await auditor.get('/api/audit?action=user.roles');
  const entry = trail.body.entries[0];
  equal(JSON.stringify(entry.detail.from), '["auditor"]', 'from');
  equal(JSON.stringify(entry.detail.to), '["resident"]', 'to');
});

await check('a role change takes effect without a new sign-in', async () => {
  // Sessions carry no roles; they are read on every request. Granting a role
  // to an account that is already signed in is the case that proves it.
  const client = new Client(base);
  const email = `roleshift.${stamp}@${domain}`;
  await secretary.post('/api/users', { email, roles: ['resident'], password: 'a-long-enough-password' });
  await client.signIn(email, 'a-long-enough-password');
  equal((await client.get('/api/reports/trial-balance')).status, 403, 'before the grant');

  const users = await secretary.get('/api/users');
  const target = users.body.users.find(u => u.email === email);
  await secretary.post(`/api/users/${target.id}/roles`, { roles: ['resident', 'manager'] });

  equal((await client.get('/api/reports/trial-balance')).status, 200, 'after the grant');
});

await check('deactivating an account ends its sessions at once', async () => {
  const client = new Client(base);
  const email = `leaving.${stamp}@${domain}`;
  const created = await secretary.post('/api/users', {
    email, roles: ['resident'], password: 'another-long-password',
  });
  await client.signIn(email, 'another-long-password');
  equal((await client.get('/api/auth/me')).status, 200, 'signed in');

  const r = await secretary.post(`/api/users/${created.body.id}/deactivate`, {
    reason: 'Sold the flat.',
  });
  equal(r.status, 200, 'status');
  truthy(r.body.sessionsRevoked >= 1, 'sessions revoked');
  equal((await client.get('/api/auth/me')).status, 401, 'and the session is gone');

  // Revoked, not merely unusable. The account being inactive would make the
  // session fail anyway; the token has to be dead in its own right, or
  // reactivating the account later would hand the old cookie back its access.
  const live = psql(
    `SELECT COUNT(*) FROM sessions
      WHERE user_id = '${created.body.id}' AND revoked_at IS NULL;`,
  );
  equal(live.out, '0', 'sessions still live for that account');
});

await check('and cannot be done to your own account', async () => {
  const users = await secretary.get('/api/users');
  const self = users.body.users.find(u => u.email === `secretary@${domain}`);
  const r = await secretary.post(`/api/users/${self.id}/deactivate`, { reason: 'Oops.' });
  equal(r.status, 400, 'status');
  matches(r.body.message, /lock you out/, 'message');
});

await check('a flat needs its area and basis together or neither', async () => {
  const r = await manager.post('/api/flats', {
    flatNo: `D-${stamp.slice(0, 3)}`,
    billingAreaSqFt: 900,
  });
  equal(r.status, 400, 'status');
  matches(r.body.message, /basis together/, 'message');
});

await check('a flat added with both is billable', async () => {
  const r = await manager.post('/api/flats', {
    flatNo: `D-${stamp.slice(0, 3)}`,
    wing: 'D',
    floor: 1,
    billingAreaSqFt: 900,
    areaBasis: 'super-built-up',
  });
  equal(r.status, 201, 'status');
  equal(r.body.billable, true, 'billable');
});

await check('a change of owner does not move what the flat owes', async () => {
  const flats = await manager.get('/api/flats');
  const flat = flats.body.flats.find(f => f.flatNo === 'A-101');
  const duesBefore = await manager.get(`/api/flats/${flat.id}/dues?asAt=2026-12-31`);

  const r = await manager.post(`/api/flats/${flat.id}/owner`, {
    fullName: 'New Owner (demo)',
    email: `newowner.${stamp}@${domain}`,
    role: 'owner',
    heldFrom: '2026-12-01',
    replaceCurrent: true,
  });
  equal(r.status, 201, 'status');
  matches(r.body.note, /stays against the flat/, 'note');

  const duesAfter = await manager.get(`/api/flats/${flat.id}/dues?asAt=2026-12-31`);
  equal(duesAfter.body.outstandingPaise, duesBefore.body.outstandingPaise, 'the dues');
});

await check('and the new owner is the one the flat list shows', async () => {
  const flats = await manager.get('/api/flats');
  const flat = flats.body.flats.find(f => f.flatNo === 'A-101');
  equal(flat.owner, 'New Owner (demo)', 'the current owner');

  // One open ownership row per flat and role, which is what stops a previous
  // owner's arrears attaching to the new one.
  const open = psql(
    `SELECT COUNT(*) FROM flat_ownership fo
      WHERE fo.flat_id = '${flat.id}' AND fo.role = 'owner' AND fo.held_until IS NULL;`,
  );
  equal(open.out, '1', 'open ownership rows');
});

// --- concurrency across the number series ----------------------------------

suite('concurrent writes');

// Every document carries a number from a per-society series, and each was
// allocated with MAX(...) + 1. Under READ COMMITTED two concurrent
// transactions read the same maximum and the second loses on the unique
// index: measured before series.ts existed, one of eight concurrent payments
// succeeded and seven were refused. These are the checks that say it is fixed.

await check('eight payments at once all succeed, with eight distinct numbers', async () => {
  const flats = (await manager.get('/api/flats')).body.flats.slice(0, 8);
  const results = await Promise.all(flats.map((flat, index) =>
    manager.post('/api/payments', {
      flatId: flat.id,
      amountPaise: 2_000 + index,
      receivedOn: '2026-08-10',
      method: 'upi',
    }, { 'Idempotency-Key': `concurrent-series-${stamp}-${index}` })));

  const refused = results.filter(r => r.status !== 201);
  equal(
    refused.map(r => `${r.status} ${r.body?.message ?? ''}`).join(' | ') || 'none',
    'none',
    'refusals',
  );

  const numbers = new Set(results.map(r => r.body.receiptNo));
  equal(numbers.size, 8, 'distinct receipt numbers');
});

await check('and the numbers are gapless, which is why this serialises', async () => {
  // A sequence would be simpler and would leave gaps when a transaction rolls
  // back. A tax invoice series with a number missing is a question from an
  // auditor, so the series is serialised instead.
  const august = psql(
    `SELECT string_agg(DISTINCT regexp_replace(receipt_no, '^.*/', ''), ',' ORDER BY regexp_replace(receipt_no, '^.*/', ''))
       FROM payments
      WHERE society_id = '${fixture.societyId}' AND receipt_no LIKE 'RC/2026-08/%';`,
  );
  const numbers = august.out.split(',').map(Number).sort((a, b) => a - b);
  truthy(numbers.length >= 8, `receipts in August: ${numbers.length}`);
  for (const [index, value] of numbers.entries()) {
    equal(value, index + 1, `the ${index + 1}th number in the series`);
  }
});

await check('six tickets at once all succeed', async () => {
  const flat = flatOf('B-204');
  const results = await Promise.all([...Array(6)].map((_, index) =>
    resident.post('/api/tickets', {
      flatId: flat.id,
      category: 'plumbing',
      description: `Concurrent ticket ${index}`,
      priority: 'low',
    })));
  const refused = results.filter(r => r.status !== 201);
  equal(refused.map(r => r.status).join(',') || 'none', 'none', 'refusals');
  equal(new Set(results.map(r => r.body.ticketNo)).size, 6, 'distinct ticket numbers');
});

await check('concurrent conversions take distinct invoice numbers', async () => {
  const run = await manager.post('/api/billing/run', {
    period: 'Dec 2026', issuedOn: '2026-12-01',
  });
  equal(run.status, 201, 'the run');
  for (const document of run.body.issued) {
    const approved = await treasurer.post(
      `/api/billing/documents/${document.documentId}/approve`, { on: '2026-12-01' },
    );
    equal(approved.status, 200, `approving ${document.flatNo}`);
  }

  const results = await Promise.all(run.body.issued.slice(0, 6).map(document =>
    treasurer.post(`/api/billing/documents/${document.documentId}/convert`, {
      on: '2026-12-16', because: 'manual',
    })));

  const refused = results.filter(r => r.status !== 200);
  equal(
    refused.map(r => `${r.status} ${r.body?.message ?? ''}`).join(' | ') || 'none',
    'none',
    'refusals',
  );
  equal(new Set(results.map(r => r.body.taxInvoiceNo)).size, 6, 'distinct invoice numbers');
});

await check('and the books still tie after all of that', async () => {
  const r = await treasurer.get('/api/reports/trial-balance?asAt=2026-12-31');
  equal(r.body.tiesOut, true, 'tiesOut');
});

// --- the rate is the one in force during the month billed -------------------

suite('back-dated billing');

await check('a back-dated run charges the rate in force in that month', async () => {
  // The rate changed from 2026-09-01 earlier in this suite: 450 paise before,
  // 500 after. Billing June — months before that — must use 450, whatever
  // today is, because the charge is for June's service.
  const r = await manager.post('/api/billing/run', {
    period: 'Jun 2026', issuedOn: '2026-12-20',
  });
  equal(r.status, 201, 'status');
  equal(r.body.rate.ratePerSqFt, 4.5, 'the rate used');
  // The seed dates the older rate a year before today, so the date itself
  // moves; what matters is that it is the rate in force before June.
  equal(r.body.rate.effectiveFrom < '2026-06-01', true, 'the rate it came from predates June');

  const b204 = r.body.issued.find(d => d.flatNo === 'B-204');
  // 985 sq ft at 450 paise, plus the 10% sinking share.
  equal(b204.net, 443_250 + 44_325, 'net at the older rate');
});

await check('and a run inside the new rate period uses the new rate', async () => {
  const r = await manager.post('/api/billing/run', {
    period: 'Oct 2026', issuedOn: '2026-12-20',
  });
  equal(r.status, 201, 'status');
  equal(r.body.rate.ratePerSqFt, 5, 'the rate used');
});

// --- the arithmetic behind the reports --------------------------------------

suite('report arithmetic');

// These run on constructed figures rather than on the database. On real data
// every one of these flags is true, because the ledger cannot hold anything
// else — so reading them back from a live report would pass just as happily if
// the code returned a hardcoded `true`. Handing the arithmetic figures that do
// not tie is the only way to prove it is doing a comparison.

await check('the trial balance says so when the two sides do not tie', async () => {
  const crooked = summariseTrialBalance([
    { code: '1000', name: 'Bank', class: 'asset', debit: 500, credit: 0 },
    { code: '4000', name: 'Income', class: 'income', debit: 0, credit: 499 },
  ]);
  equal(crooked.tiesOut, false, 'tiesOut on 500 against 499');
  equal(crooked.totalDebit, 500, 'total debit');
  equal(crooked.totalCredit, 499, 'total credit');
});

await check('and says so when they do', async () => {
  const sound = summariseTrialBalance([
    { code: '1000', name: 'Bank', class: 'asset', debit: 500, credit: 0 },
    { code: '4000', name: 'Income', class: 'income', debit: 0, credit: 500 },
  ]);
  equal(sound.tiesOut, true, 'tiesOut');
});

await check('a zero line is left out of the trial balance', async () => {
  const summary = summariseTrialBalance([
    { code: '1000', name: 'Bank', class: 'asset', debit: 500, credit: 0 },
    { code: '5000', name: 'Unused', class: 'expenditure', debit: 0, credit: 0 },
    { code: '4000', name: 'Income', class: 'income', debit: 0, credit: 500 },
  ]);
  equal(summary.lines.length, 2, 'lines with a figure');
});

await check('the balance sheet says so when the two sides do not meet', async () => {
  const sheet = assembleBalanceSheet([
    { code: '1000', name: 'Bank', class: 'asset', debit: 1000, credit: 0 },
    { code: '2000', name: 'Payable', class: 'liability', debit: 0, credit: 300 },
    { code: '4000', name: 'Income', class: 'income', debit: 0, credit: 500 },
  ], '2026-07-31');
  // 1000 of assets against 300 of liabilities and a 500 surplus: 200 short.
  equal(sheet.balances, false, 'balances');
  equal(sheet.totalAssets, 1000, 'total assets');
  equal(sheet.surplus, 500, 'surplus');
});

await check('and when they do, including a fund and an expense', async () => {
  const sheet = assembleBalanceSheet([
    { code: '1000', name: 'Bank', class: 'asset', debit: 1000, credit: 0 },
    { code: '2000', name: 'Payable', class: 'liability', debit: 0, credit: 300 },
    { code: '3000', name: 'Sinking fund', class: 'fund', debit: 0, credit: 200 },
    { code: '4000', name: 'Income', class: 'income', debit: 0, credit: 600 },
    { code: '5000', name: 'Security', class: 'expenditure', debit: 100, credit: 0 },
  ], '2026-07-31');
  equal(sheet.surplus, 500, 'surplus');
  equal(sheet.totalFunds, 200, 'funds');
  equal(sheet.balances, true, 'balances');
});

await check('a contra entry nets off rather than doubling a balance', async () => {
  const sheet = assembleBalanceSheet([
    { code: '1000', name: 'Bank', class: 'asset', debit: 1000, credit: 400 },
    { code: '2000', name: 'Payable', class: 'liability', debit: 100, credit: 700 },
  ], '2026-07-31');
  equal(sheet.totalAssets, 600, 'assets net of the credit side');
  equal(sheet.totalLiabilities, 600, 'liabilities net of the debit side');
  equal(sheet.balances, true, 'balances');
});

await check('the GST comparison fails when the register and the ledger disagree', async () => {
  equal(
    registerAgreesWithLedger({ cgst: 100, sgst: 100 }, { cgst: 100, sgst: 99 }),
    false,
    'one paisa apart on SGST',
  );
  equal(
    registerAgreesWithLedger({ cgst: 100, sgst: 100 }, { cgst: 100, sgst: 100 }),
    true,
    'in agreement',
  );
  // Not a total comparison: two halves that add to the same figure the wrong
  // way round would file a wrong return.
  equal(
    registerAgreesWithLedger({ cgst: 150, sgst: 50 }, { cgst: 100, sgst: 100 }),
    false,
    'same total, different split',
  );
});

// --- the request surface ---------------------------------------------------

suite('request handling');

await check('an unknown path is 404', async () => {
  const r = await treasurer.get('/api/nothing-here');
  equal(r.status, 404, 'status');
});

await check('a known path with the wrong verb is 405', async () => {
  const r = await treasurer.post('/api/health');
  equal(r.status, 405, 'status');
});

await check('a malformed percent-escape in the path is 400, not 500', async () => {
  const r = await treasurer.get('/api/billing/documents/%E0%A4%A/pdf');
  equal(r.status, 400, 'status');
});

await check('a body that is not JSON is 400', async () => {
  const response = await fetch(`${base}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  equal(response.status, 400, 'status');
});

await check('an unexpected field is rejected rather than ignored', async () => {
  const r = await manager.post('/api/payments', {
    flatId: flatOf('A-102').id,
    amountRupees: 500,
    receivedOn: '2026-08-05',
    method: 'cash',
  }, { 'Idempotency-Key': key('wrong-field') });
  equal(r.status, 400, 'status');
  matches(JSON.stringify(r.body.detail), /unexpected key/, 'detail');
});

await check('a fractional amount is rejected', async () => {
  const r = await manager.post('/api/payments', {
    flatId: flatOf('A-102').id,
    amountPaise: 100.5,
    receivedOn: '2026-08-05',
    method: 'cash',
  }, { 'Idempotency-Key': key('fractional') });
  equal(r.status, 400, 'status');
});

await check('every response carries the security headers', async () => {
  const r = await anonymous.get('/api/health');
  equal(r.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
  equal(r.headers.get('x-frame-options'), 'DENY', 'frame options');
  equal(r.headers.get('cache-control'), 'no-store', 'cache control');
  truthy(r.headers.get('x-request-id'), 'request id');
});

await check('sign-in attempts are rate limited', async () => {
  const client = new Client(base);
  let limited = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = await client.post('/api/auth/password', {
      email: `manager@${domain}`, password: 'wrong-on-purpose',
    });
    if (r.status === 429) {
      limited = true;
      truthy(r.headers.get('retry-after'), 'a Retry-After header');
      break;
    }
  }
  truthy(limited, 'the eighth or so attempt should have been rate limited');
});

await check('the rate limit table does not hold the addresses it limited', async () => {
  const leaked = psql(
    `SELECT COUNT(*) FROM rate_limit_buckets WHERE subject_hash LIKE '%${domain}%';`,
  );
  equal(leaked.out, '0', 'rows holding a readable address');
});

// --- the audit trail -------------------------------------------------------

suite('audit trail');

await check('every financial action left a trail', async () => {
  const r = await auditor.get('/api/audit?limit=500');
  const actions = new Set(r.body.entries.map(e => e.action));
  for (const action of [
    'billing.run', 'billing.approve', 'billing.convert', 'payment.record',
    'payment.reverse', 'vendor.bill.book', 'vendor.pay', 'tds.remit',
    'bank.import', 'bank.reconcile', 'period.close', 'period.reopen',
  ]) {
    truthy(actions.has(action), `an audit entry for ${action}`);
  }
});

await check('the trail names the actor and the request', async () => {
  const r = await auditor.get('/api/audit?action=payment.record');
  const entry = r.body.entries[0];
  equal(entry.actorLabel, `manager@${domain}`, 'actor');
  truthy(entry.requestId, 'request id');
});

await check('the audit trail cannot be deleted', async () => {
  const before = psql(
    `SELECT COUNT(*) FROM audit_log WHERE society_id = '${fixture.societyId}';`,
  );
  psql(`DELETE FROM audit_log WHERE society_id = '${fixture.societyId}';`);
  const after = psql(
    `SELECT COUNT(*) FROM audit_log WHERE society_id = '${fixture.societyId}';`,
  );
  equal(after.out, before.out, 'rows after a DELETE');
  truthy(Number(before.out) > 20, 'there were rows to begin with');
});

await check('and neither can a journal entry', async () => {
  psql(`DELETE FROM journal_entries WHERE society_id = '${fixture.societyId}';`);
  const after = psql(
    `SELECT COUNT(*) FROM journal_entries WHERE society_id = '${fixture.societyId}';`,
  );
  truthy(Number(after.out) > 5, `entries after a DELETE: ${after.out}`);
});

// --- one last consistency sweep --------------------------------------------

suite('consistency');

await check('the trial balance ties out over everything this suite did', async () => {
  const r = await treasurer.get('/api/reports/trial-balance?asAt=2026-12-31');
  equal(r.body.tiesOut, true, 'tiesOut');
});

await check('the balance sheet balances over everything this suite did', async () => {
  const r = await treasurer.get('/api/reports/balance-sheet?asAt=2026-12-31');
  equal(r.body.balances, true, 'balances');
});

await check('the receivable agrees with the sum of what is outstanding per invoice', async () => {
  const tb = await treasurer.get('/api/reports/trial-balance?asAt=2026-12-31');
  const receivable = tb.body.lines.find(l => l.code === '1100');
  const ledgerBalance = receivable.debit - receivable.credit;

  // Per invoice, from the same postings but grouped by document reference
  // rather than by account. Not clamped at zero: a reversal can push one
  // document credit-side, and hiding that would make the two agree by
  // arithmetic rather than because the books do.
  const documents = await manager.get('/api/billing/documents?asAt=2026-12-31');
  const fromDocuments = documents.body.documents.reduce((sum, d) => sum + d.outstanding, 0);

  equal(ledgerBalance, fromDocuments, 'receivable against the sum per document');
});

await check('money on account sits on the advance account, not on the receivable', async () => {
  const tb = await treasurer.get('/api/reports/trial-balance?asAt=2026-12-31');
  const advances = tb.body.lines.find(l => l.code === '2300');
  const held = advances.credit - advances.debit;

  // Against the allocation rows rather than a constant: every slice of a
  // receipt that settled no document is money on account, and the advance
  // account should hold exactly that. A figure typed in here would have to be
  // edited whenever another test takes a payment, and an expectation that gets
  // edited without being read is not a check.
  const unallocated = psql(
    `SELECT COALESCE(SUM(a.amount), 0)
       FROM receipt_allocations a
       JOIN payments p ON p.id = a.payment_id
      WHERE p.society_id = '${fixture.societyId}' AND a.document_id IS NULL;`,
  );
  equal(held, Number(unallocated.out), 'advances against the unallocated receipt slices');
  truthy(held > 0, 'there is money on account to check');
  equal(advances.class, 'liability', 'the advance account class');
});

await check('every journal entry in the database balances', async () => {
  const crooked = psql(
    `SELECT COUNT(*) FROM (
       SELECT e.id FROM journal_entries e
         JOIN journal_postings p ON p.entry_id = e.id
        WHERE e.society_id = '${fixture.societyId}'
        GROUP BY e.id, e.total_debit, e.total_credit
       HAVING SUM(p.debit) <> e.total_debit OR SUM(p.credit) <> e.total_credit
           OR SUM(p.debit) <> SUM(p.credit)
     ) AS bad;`,
  );
  equal(crooked.out, '0', 'entries whose legs do not agree with their totals');
});

  // The pool the job suites used, closed here rather than in `finally`: it is
  // declared inside this block and the finally cannot see it.
  await jobPool.end();
} finally {
  if (host !== null) await host.close();
  if (app !== null) await app.close();
}

// --- report ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
