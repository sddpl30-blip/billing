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
import { createServer as createHttpServer } from 'node:http';

const build = '../.server-build/server/src';
const { buildApp } = await import(`${build}/app.js`);
const { seed } = await import(`${build}/seed.js`);
const { PgPool, connectionFromEnv } = await import(`${build}/pg.js`);
const { runDueJobs, backoffMinutes } = await import(`${build}/jobs.js`);
const { createLogger } = await import(`${build}/logger.js`);
const { createProductionSociety, AlreadyBootstrappedError } = await import(`${build}/bootstrap.js`);
const { resolveEmailProvider } = await import(`${build}/providers/email.js`);
const { runBilling } = await import(`${build}/billing.js`);
const { pendingBillingTerms, writeSetting } = await import(`${build}/settings.js`);
const { importFlats } = await import(`${build}/flatImport.js`);
const { parseDeploymentAccounts, provisionInTransaction } = await import(`${build}/deploymentAccounts.js`);
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
process.env.SETUP_TOKEN = `setup-token-${stamp}-0123456789`;

// A stand-in for Google's token endpoint, so the sign-in flow runs end to end
// without the network. It answers with an ID token whose claims each check
// sets, and records what it was sent.
const fakeGoogle = { claims: null, lastBody: null };
const googleServer = createHttpServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    fakeGoogle.lastBody = new URLSearchParams(body);
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id_token: `${part({ alg: 'RS256' })}.${part(fakeGoogle.claims ?? {})}.sig` }));
  });
});
await new Promise((resolve) => googleServer.listen(0, '127.0.0.1', resolve));
process.env.GOOGLE_CLIENT_ID = `test-client-${stamp}.apps.googleusercontent.com`;
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_OAUTH_TOKEN_URL = `http://127.0.0.1:${googleServer.address().port}/token`;

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

// --- first-time setup ------------------------------------------------------

suite('first-time setup');

await check('setup reports whether it is needed, and that it is open', async () => {
  const r = await anonymous.get('/api/setup');
  equal(r.status, 200, 'status');
  equal(typeof r.body.required, 'boolean', 'required');
  equal(r.body.open, r.body.required, 'open exactly while it is needed, with SETUP_TOKEN set');
});

await check('setup with the wrong token is refused', async () => {
  const r = await anonymous.post('/api/setup', {
    token: 'not-the-setup-token',
    societyName: 'Someone Else\'s Society',
    invoicePrefix: 'XX',
    secretaryEmail: `intruder-${stamp}@example.invalid`,
    secretaryPassword: 'a-long-enough-password',
  });
  equal(r.status, 403, 'status');
});

await check('setup creates one production society with its structure and secretary, once', async () => {
  // Inside a transaction that is rolled back: the test database must not be
  // left holding a production society, or setup would be closed for every
  // later run.
  const pool = new PgPool(connectionFromEnv(process.env));
  const rollback = new Error('rollback');
  try {
    await pool.transaction(async (tx) => {
      const { societyId, secretaryId } = await createProductionSociety(tx, {
        societyName: `Setup test ${stamp}`,
        invoicePrefix: 'ST',
        secretaryEmail: `setup-${stamp}@example.invalid`,
        secretaryPassword: 'a-long-enough-password',
        bank: { bankName: 'Test Bank', last4: '1234', ifsc: 'TEST0123456' },
      });
      const one = async (sql, params) => (await tx.query(sql, params)).rows[0];
      equal((await one('SELECT mode FROM societies WHERE id = $1', [societyId])).mode, 'production', 'mode');
      truthy(Number((await one('SELECT count(*)::text AS n FROM accounts WHERE society_id = $1', [societyId])).n) > 20, 'chart of accounts');
      truthy(Number((await one('SELECT count(*)::text AS n FROM receipt_heads WHERE society_id = $1', [societyId])).n) > 3, 'receipt heads');
      equal((await one('SELECT role FROM user_roles WHERE user_id = $1', [secretaryId])).role, 'secretary', 'the first account is the secretary');
      equal((await one('SELECT ifsc FROM bank_accounts WHERE society_id = $1', [societyId])).ifsc, 'TEST0123456', 'the bank account');
      const gst = await one(`SELECT value::text, approved_by FROM society_settings WHERE society_id = $1 AND key = 'gst.treatment'`, [societyId]);
      equal(gst.approved_by, null, 'GST starts unapproved');
      let second = null;
      try {
        await createProductionSociety(tx, {
          societyName: 'A second one', invoicePrefix: 'XX',
          secretaryEmail: `second-${stamp}@example.invalid`, secretaryPassword: 'a-long-enough-password',
        });
      } catch (err) { second = err; }
      truthy(second instanceof AlreadyBootstrappedError, 'a second setup is refused');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  } finally {
    await pool.end();
  }
});

await check('office accounts in the deployment settings are read strictly, and a mistake is reported, not thrown', async () => {
  equal(parseDeploymentAccounts({}).kind, 'none', 'nothing set');
  const bad = (env, pattern) => {
    const r = parseDeploymentAccounts(env);
    equal(r.kind, 'invalid', JSON.stringify(env));
    matches(r.problem, pattern, 'problem');
  };
  bad({ OFFICE_ACCOUNTS: 'a@x.in=secretary' }, /OFFICE_START_PASSWORD is empty/);
  bad({ OFFICE_ACCOUNTS: 'a@x.in=secretary', OFFICE_START_PASSWORD: 'short' }, /at least 12/);
  bad({ OFFICE_ACCOUNTS: 'a@x.in=president', OFFICE_START_PASSWORD: 'a-long-enough-password' }, /not a role/);
  bad({ OFFICE_ACCOUNTS: 'a@x.in=secretary,A@x.in=treasurer', OFFICE_START_PASSWORD: 'a-long-enough-password' }, /twice/);
  const ok = parseDeploymentAccounts({
    OFFICE_ACCOUNTS: ' Sec@x.in = secretary , t@x.in=treasurer ',
    OFFICE_START_PASSWORD: 'a-long-enough-password', BOOTSTRAP_SOCIETY_NAME: 'Env Society',
  });
  equal(ok.kind, 'ok', 'parsed');
  equal(ok.spec.accounts[0].email, 'sec@x.in', 'lower-cased and trimmed');
  equal(ok.spec.society.invoicePrefix, 'MV', 'default prefix');
});

await check('the deployment settings create the society and its office accounts once, and never touch an existing account', async () => {
  const pool = new PgPool(connectionFromEnv(process.env));
  const rollback = new Error('rollback');
  const log = createLogger({ logLevel: 'error', mode: 'test' });
  const sec = `envsec-${stamp}@example.invalid`;
  const tre = `envtre-${stamp}@example.invalid`;
  const man = `envman-${stamp}@example.invalid`;
  const spec = parseDeploymentAccounts({
    OFFICE_ACCOUNTS: `${sec}=secretary,${tre}=treasurer,${man}=manager`,
    OFFICE_START_PASSWORD: 'shared-start-password-1',
    BOOTSTRAP_SOCIETY_NAME: `Env society ${stamp}`, BOOTSTRAP_STATE_CODE: '19',
  }).spec;
  try {
    await pool.transaction(async (tx) => {
      const first = await provisionInTransaction(tx, spec, log);
      equal(first.societyCreated, true, 'society created');
      equal(first.created.length, 3, 'three accounts');
      const roles = await tx.query(
        `SELECT u.email, r.role, u.password_hash FROM users u JOIN user_roles r ON r.user_id = u.id
          JOIN societies s ON s.id = u.society_id AND s.mode = 'production' ORDER BY u.email`,
      );
      equal(roles.rows.map(r => `${r.email}=${r.role}`).join(','),
        `${man}=manager,${sec}=secretary,${tre}=treasurer`, 'one role each');
      truthy(roles.rows.every(r => r.password_hash.startsWith('scrypt$')), 'hashed, never stored as typed');

      // The treasurer changes their password, the manager is deactivated:
      // running again must leave both exactly as they are.
      await tx.query(`UPDATE users SET password_hash = 'changed' WHERE email = $1`, [tre]);
      await tx.query(`UPDATE users SET is_active = false WHERE email = $1`, [man]);
      const again = await provisionInTransaction(tx, spec, log);
      equal(again.societyCreated, false, 'no second society');
      equal(again.created.length, 0, 'nothing new');
      equal(again.alreadyThere.length, 3, 'all there');
      const after = await tx.query(`SELECT email, password_hash, is_active FROM users WHERE email IN ($1, $2) ORDER BY email`, [tre, man]);
      equal(after.rows.find(r => r.email === tre).password_hash, 'changed', 'a changed password is not reset');
      truthy(['f', 'false'].includes(String(after.rows.find(r => r.email === man).is_active)), 'a deactivated account stays off');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  } finally {
    await pool.end();
  }
});

await check('without a society name the deployment settings wait, and create nothing', async () => {
  const pool = new PgPool(connectionFromEnv(process.env));
  const rollback = new Error('rollback');
  const spec = parseDeploymentAccounts({
    OFFICE_ACCOUNTS: `nosoc-${stamp}@example.invalid=secretary`, OFFICE_START_PASSWORD: 'shared-start-password-1',
  }).spec;
  try {
    await pool.transaction(async (tx) => {
      const r = await provisionInTransaction(tx, spec, createLogger({ logLevel: 'error', mode: 'test' }));
      matches(r.problem, /BOOTSTRAP_SOCIETY_NAME/, 'says what is missing');
      equal(r.created.length, 0, 'nothing created');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  } finally {
    await pool.end();
  }
});

await check('a live society starts with its payment terms pending verification, and cannot bill until they are approved', async () => {
  const pool = new PgPool(connectionFromEnv(process.env));
  const rollback = new Error('rollback');
  try {
    await pool.transaction(async (tx) => {
      const { societyId, secretaryId } = await createProductionSociety(tx, {
        societyName: `Terms test ${stamp}`,
        invoicePrefix: 'TT',
        secretaryEmail: `terms-${stamp}@example.invalid`,
        secretaryPassword: 'a-long-enough-password',
      });
      const keys = (await tx.query(
        `SELECT key FROM society_settings WHERE society_id = $1 AND key IN ('billing.dueDays','billing.sinkingFundPercent')`,
        [societyId],
      )).rows;
      equal(keys.length, 0, 'no days-to-pay or sinking share is written at setup');
      equal((await pendingBillingTerms(tx, societyId)).length, 2, 'both terms pending');

      // An approved rate, so the only thing in the way is the terms.
      const treasurer = (await tx.query(
        `INSERT INTO users (society_id, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
        [societyId, `terms-treasurer-${stamp}@example.invalid`],
      )).rows[0].id;
      await tx.query(
        `INSERT INTO maintenance_rates (society_id, rate_paise_per_sqft, area_basis, effective_from, authority, approved_by, approved_on)
         VALUES ($1, 450, 'super-built-up', '2026-10-01', 'test', $2, '2026-10-01')`,
        [societyId, treasurer],
      );
      let refused = null;
      try {
        await tx.query('SAVEPOINT terms');
        await runBilling(tx, { societyId, period: 'Oct 2026', issuedOn: '2026-10-01', requestedBy: secretaryId });
      } catch (err) { refused = err; await tx.query('ROLLBACK TO SAVEPOINT terms'); }
      truthy(refused !== null && /pending verification/.test(refused.message), `billing refused: ${refused?.message}`);

      // Entered but not approved is still pending.
      await writeSetting(tx, { societyId, key: 'billing.dueDays', value: 10, requestedBy: secretaryId });
      await writeSetting(tx, { societyId, key: 'billing.sinkingFundPercent', value: 10, requestedBy: secretaryId });
      const awaiting = await pendingBillingTerms(tx, societyId);
      equal(awaiting.length, 2, 'entered, not approved');
      truthy(awaiting.every(t => /awaiting approval/.test(t)), 'says awaiting approval');

      await tx.query(
        `UPDATE society_settings SET approved_by = $1, approved_on = '2026-10-01'
          WHERE society_id = $2 AND key IN ('billing.dueDays','billing.sinkingFundPercent')`,
        [treasurer, societyId],
      );
      equal((await pendingBillingTerms(tx, societyId)).length, 0, 'approved terms clear the check');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  } finally {
    await pool.end();
  }
});

await check('with no approved rate, an imported flat without a basis keeps it pending, not a guessed one', async () => {
  const pool = new PgPool(connectionFromEnv(process.env));
  const rollback = new Error('rollback');
  try {
    await pool.transaction(async (tx) => {
      const { societyId, secretaryId } = await createProductionSociety(tx, {
        societyName: `Basis test ${stamp}`, invoicePrefix: 'BT',
        secretaryEmail: `basis-${stamp}@example.invalid`, secretaryPassword: 'a-long-enough-password',
      });
      const csv = 'flat_no,area_sqft,owner_name,owner_email\r\nT-1,1200,Test Owner,basis-owner-' + stamp + '@example.invalid\r\n';
      const report = await importFlats(tx, { societyId, csv, dryRun: false, heldFrom: '2026-10-01', actorUserId: secretaryId });
      equal(report.errors.length, 0, `no errors: ${JSON.stringify(report.errors)}`);
      equal(report.defaultAreaBasis, null, 'no default basis without an approved rate');
      const flat = (await tx.query(`SELECT area_basis FROM flats WHERE society_id = $1 AND flat_no = 'T-1'`, [societyId])).rows[0];
      equal(flat.area_basis, null, 'the basis is left pending');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  } finally {
    await pool.end();
  }
});

await check('a demo society keeps billing on its seeded terms', async () => {
  const pool = new PgPool(connectionFromEnv(process.env));
  try {
    equal((await pendingBillingTerms(pool, fixture.societyId)).length, 0, 'nothing pending for a demo society');
  } finally {
    await pool.end();
  }
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

// --- Sign in with Google ---------------------------------------------------

/** Runs start, then a callback with the given claims; returns the callback's response. */
const googleSignIn = async (claims, { tamperState = false } = {}) => {
  const start = await fetch(`${base}/api/auth/google/start`, { redirect: 'manual' });
  const location = new URL(start.headers.get('location'));
  const cookie = start.headers.getSetCookie().find(c => c.startsWith('sb_google=')).split(';')[0];
  const state = tamperState ? 'not-the-state' : location.searchParams.get('state');
  fakeGoogle.claims = claims;
  const callback = await fetch(
    `${base}/api/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
    { redirect: 'manual', headers: { Cookie: cookie } },
  );
  return { start, location, callback };
};
const googleClaims = (email, extra = {}) => ({
  iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 600, email, email_verified: true, ...extra,
});

await check('Google sign-in is offered when configured', async () => {
  const r = await anonymous.get('/api/auth/google/status');
  equal(r.body.enabled, true, 'enabled');
});

await check('start sends the browser to Google with PKCE and a state', async () => {
  const { start, location } = await googleSignIn(null);
  equal(start.status, 302, 'redirect');
  equal(location.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID, 'client id');
  equal(location.searchParams.get('code_challenge_method'), 'S256', 'PKCE');
  truthy(location.searchParams.get('state'), 'a state');
  matches(location.searchParams.get('redirect_uri'), /\/api\/auth\/google\/callback$/, 'redirect uri');
});

await check('a registered member signs in with Google, with no password', async () => {
  const { callback } = await googleSignIn(googleClaims(residentEmail.toUpperCase()));
  equal(callback.status, 302, 'redirect');
  truthy(!/login_error/.test(callback.headers.get('location')), `back to the app: ${callback.headers.get('location')}`);
  equal(fakeGoogle.lastBody.get('grant_type'), 'authorization_code', 'code exchanged');
  truthy(fakeGoogle.lastBody.get('code_verifier'), 'with the PKCE verifier');
  const cookies = callback.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => /^sb_(session|csrf)=/.test(c));
  equal(cookies.length, 2, 'session and csrf cookies set');
  const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookies.join('; ') } });
  equal(me.status, 200, 'the session works');
  equal((await me.json()).email, residentEmail, 'as that member');
});

await check('a Google account the society does not know is refused; nothing is created', async () => {
  const email = `stranger-${stamp}@gmail.example`;
  const { callback } = await googleSignIn(googleClaims(email));
  matches(callback.headers.get('location'), /login_error=google_not_registered/, 'refused');
  equal(callback.headers.getSetCookie().some(c => c.startsWith('sb_session=') && !c.startsWith('sb_session=;')), false, 'no session');
  equal(psql(`SELECT count(*) FROM users WHERE lower(email) = lower('${email}');`).out, '0', 'no account created');
});

await check('an unverified Google e-mail is refused', async () => {
  const { callback } = await googleSignIn(googleClaims(residentEmail, { email_verified: false }));
  matches(callback.headers.get('location'), /login_error=google_unverified/, 'refused');
});

await check('a token meant for another client is refused', async () => {
  const { callback } = await googleSignIn(googleClaims(residentEmail, { aud: 'someone-else.apps.googleusercontent.com' }));
  matches(callback.headers.get('location'), /login_error=google_unverified/, 'refused');
});

await check('a callback whose state was not issued to this browser is refused', async () => {
  const { callback } = await googleSignIn(googleClaims(residentEmail), { tamperState: true });
  matches(callback.headers.get('location'), /login_error=google_state/, 'refused');
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
  // No per-member exemption for this society, so the checks below exercise
  // the tax arithmetic on these flats, every one of which bills under the
  // statutory ₹7,500. The exemption itself is checked in "billing defects",
  // against a society that leaves it at its default.
  const r = await secretary.put('/api/settings/gst.treatment', {
    value: { chargeGst: true, ratePercent: 18, memberThresholdRupees: 0 },
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
    value: { chargeGst: true, ratePercent: 18, memberThresholdRupees: 0 },
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
  matches(r.body.message, /exceeds the ₹9,800 outstanding/, 'message');
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

let matchedPaymentId = null;

await check('a Description column before Deposit is not read as the credit', async () => {
  // 'cr' as a substring found "Description" first, and the narration was
  // parsed as the amount.
  const r = await manager.post('/api/bank/imports', {
    bankAccountId: fixture.bankAccountId,
    format: 'csv',
    filename: `july-dup-${stamp}.csv`,
    content: [
      'Txn Date,Description,Ref No,Withdrawal,Deposit,Balance',
      '20/07/2026,UPI RECEIPT AGAIN,UPI-DUP-1,,2000.00,4000.00',
    ].join('\n'),
  });
  equal(r.status, 201, 'status');
  equal(r.body.inserted, 1, 'inserted');
  const lines = await manager.get('/api/bank/transactions?state=unmatched');
  const line = lines.body.transactions.find(t => t.reference === 'UPI-DUP-1');
  equal(line.amountPaise, 200_000, 'the deposit column is the amount');
  equal(line.narration, 'UPI RECEIPT AGAIN', 'and the description is the narration');
});

await check('each statement line is listed once, however many receipts could match it', async () => {
  const lines = await manager.get('/api/bank/transactions?state=unmatched');
  const ids = lines.body.transactions.map(t => t.id);
  equal(new Set(ids).size, ids.length, 'no line appears twice');
});

await check('a receipt already matched cannot be matched to a second line', async () => {
  const matched = await manager.get('/api/bank/transactions?state=matched');
  matchedPaymentId = psql(
    `SELECT matched_payment_id FROM bank_transactions
      WHERE id = '${matched.body.transactions[0].id}';`,
  ).out;
  const lines = await manager.get('/api/bank/transactions?state=unmatched');
  const line = lines.body.transactions.find(t => t.reference === 'UPI-DUP-1');
  const r = await manager.post(`/api/bank/transactions/${line.id}/match`, {
    paymentId: matchedPaymentId,
  });
  equal(r.status, 409, 'status');
  matches(r.body.message, /already matched to another statement line/, 'message');
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
    value: { chargeGst: true, ratePercent: 18, memberThresholdRupees: 0 },
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

await check('a new account cannot be created as secretary and treasurer at once', async () => {
  // The roles route refused this combination and account creation did not,
  // so one account could still propose a rate and approve it.
  const r = await secretary.post('/api/users', {
    email: `dual-${stamp}@${domain}`, roles: ['secretary', 'treasurer'],
  });
  equal(r.status, 400, 'status');
});

await check('only the treasurer approves bills; the secretary no longer can', async () => {
  const me = await secretary.get('/api/auth/me');
  truthy(!me.body.permissions.includes('billing.approve'), 'secretary has no billing.approve');
  truthy(me.body.permissions.includes('billing.release'), 'secretary can still release');
  const docs = await treasurer.get('/api/billing/documents');
  const draft = (docs.body.documents ?? docs.body).find?.(d => d.state === 'draft');
  if (draft !== undefined) {
    equal((await secretary.post(`/api/billing/documents/${draft.id}/approve`, { on: draft.issuedOn })).status,
      403, 'secretary approving a draft');
  }
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

// --- a member's e-mail and password, set by the office ----------------------

await check('the office changes a resident\'s e-mail; sign-in and the owner record move with it', async () => {
  const flat = await manager.post('/api/flats', {
    flatNo: `E-${stamp.slice(0, 3)}`, billingAreaSqFt: 800, areaBasis: 'carpet',
  });
  equal(flat.status, 201, 'flat');
  const oldEmail = `mover.${stamp}@${domain}`;
  const newEmail = `Mover.New.${stamp}@${domain}`;
  const owner = await manager.post(`/api/flats/${flat.body.id}/owner`, {
    fullName: 'Mover (test)', email: oldEmail, role: 'owner',
    heldFrom: '2026-07-01', replaceCurrent: false,
  });
  equal(owner.status, 201, 'owner');
  const created = await secretary.post('/api/users', {
    email: oldEmail, roles: ['resident'], ownerId: owner.body.ownerId,
    password: 'mover-password-123',
  });
  equal(created.status, 201, 'account');

  const r = await secretary.post(`/api/users/${created.body.id}/email`, { email: newEmail });
  equal(r.status, 200, 'status');
  equal(r.body.email, newEmail.toLowerCase(), 'stored lower-case');
  equal(r.body.ownerEmailUpdated, true, 'owner e-mail followed');

  const client = new Client(base);
  equal((await client.post('/api/auth/password', { email: oldEmail, password: 'mover-password-123' })).status,
    401, 'old address no longer signs in');
  await client.signIn(newEmail.toLowerCase(), 'mover-password-123');
  equal(psql(`SELECT email FROM owners WHERE id = '${owner.body.ownerId}';`).out,
    newEmail.toLowerCase(), 'owner record');
  const trail = await auditor.get('/api/audit?action=user.email');
  equal(trail.body.entries[0].detail.from, oldEmail, 'trail from');
});

await check('an e-mail another active account uses is refused', async () => {
  const created = await secretary.post('/api/users', {
    email: `dupe.${stamp}@${domain}`, roles: ['resident'],
  });
  const r = await secretary.post(`/api/users/${created.body.id}/email`, { email: residentEmail });
  equal(r.status, 409, 'status');
});

await check('the office sets a resident\'s password; old sessions end and the new one works', async () => {
  const email = `forgot.${stamp}@${domain}`;
  const created = await secretary.post('/api/users', {
    email, roles: ['resident'], password: 'first-password-123',
  });
  const old = new Client(base);
  await old.signIn(email, 'first-password-123');

  const short = await secretary.post(`/api/users/${created.body.id}/password`, { password: 'short' });
  equal(short.status, 400, 'too short');

  const r = await secretary.post(`/api/users/${created.body.id}/password`, {
    password: 'second-password-123',
  });
  equal(r.status, 200, 'status');
  truthy(r.body.sessionsRevoked >= 1, 'sessions revoked');
  equal((await old.get('/api/auth/me')).status, 401, 'old session ended');

  const fresh = new Client(base);
  await fresh.signIn(email, 'second-password-123');
  const trail = await auditor.get('/api/audit?action=user.password.set');
  const detail = JSON.stringify(trail.body.entries[0].detail);
  truthy(!detail.includes('second-password-123'), 'no password in the trail');
});

await check('an office-bearer\'s e-mail or password cannot be changed by the office', async () => {
  const target = userOf('treasurer').id;
  const p = await secretary.post(`/api/users/${target}/password`, { password: 'takeover-password-1' });
  equal(p.status, 409, 'password');
  matches(p.body.message, /Only a resident account/, 'message');
  const e = await secretary.post(`/api/users/${target}/email`, { email: `takeover.${stamp}@${domain}` });
  equal(e.status, 409, 'email');
});

await check('nor the secretary\'s own, and only the secretary may use these', async () => {
  const self = userOf('secretary').id;
  equal((await secretary.post(`/api/users/${self}/password`, { password: 'my-own-password-1' })).status,
    409, 'self');
  const users = await secretary.get('/api/users');
  const res = users.body.users.find(u => u.email === residentEmail);
  equal((await manager.post(`/api/users/${res.id}/password`, { password: 'manager-sets-this-1' })).status,
    403, 'manager');
  equal((await resident.post(`/api/users/${res.id}/email`, { email: `x.${stamp}@${domain}` })).status,
    403, 'resident');
});

await check('anyone changes their own password with the current one; other sessions end', async () => {
  const email = `self.${stamp}@${domain}`;
  await secretary.post('/api/users', { email, roles: ['auditor'], password: 'self-password-one' });
  const here = new Client(base);
  const elsewhere = new Client(base);
  await here.signIn(email, 'self-password-one');
  await elsewhere.signIn(email, 'self-password-one');

  const wrong = await here.post('/api/auth/password/change', {
    currentPassword: 'not-the-password', newPassword: 'self-password-two',
  });
  equal(wrong.status, 400, 'wrong current password');
  matches(wrong.body.message, /current password/, 'message');

  const r = await here.post('/api/auth/password/change', {
    currentPassword: 'self-password-one', newPassword: 'self-password-two',
  });
  equal(r.status, 200, 'status');
  equal(r.body.otherSessionsEnded, 1, 'the other session');
  equal((await here.get('/api/auth/me')).status, 200, 'this session stays');
  equal((await elsewhere.get('/api/auth/me')).status, 401, 'the other one ends');
  equal((await new Client(base).post('/api/auth/password', { email, password: 'self-password-one' })).status,
    401, 'old password refused');
  await new Client(base).signIn(email, 'self-password-two');
  // Its session was ended above; it still carries a CSRF cookie, so this is
  // refused for want of a session, not for want of the header.
  equal((await elsewhere.post('/api/auth/password/change', {
    currentPassword: 'self-password-two', newPassword: 'self-password-three',
  })).status, 401, 'needs a session');
});

// --- bank accounts, added from the Office -----------------------------------

await check('the secretary adds the sinking fund account; last four and IFSC only', async () => {
  const r = await secretary.post('/api/bank-accounts', {
    purpose: 'sinking', bankName: 'ICICI Bank', last4: '2178', ifsc: 'icic0001064',
  });
  equal(r.status, 201, 'status');
  equal(r.body.ledgerAccount, '1010', 'the sinking fund bank ledger');
  const list = await secretary.get('/api/bank-accounts');
  const added = list.body.accounts.find(a => a.id === r.body.id);
  equal(added.ifsc, 'ICIC0001064', 'IFSC upper-cased');
  equal(added.accountLast4, '2178', 'last four');
  const trail = await auditor.get('/api/audit?action=bank_account.create');
  equal(trail.body.entries[0].detail.last4, '2178', 'in the trail');
});

await check('a second active account on the same ledger is refused', async () => {
  // The seeded society already has its operating account.
  const r = await secretary.post('/api/bank-accounts', {
    purpose: 'operating', bankName: 'Another Bank', last4: '9999', ifsc: 'ABCD0123456',
  });
  equal(r.status, 409, 'status');
  matches(r.body.message, /already the society's operating account/, 'message');
});

await check('a bank account needs a real IFSC and four digits, and only the secretary adds one', async () => {
  equal((await secretary.post('/api/bank-accounts', {
    purpose: 'sinking', bankName: 'X Bank', last4: '12', ifsc: 'ICIC0001064',
  })).status, 400, 'three digits');
  equal((await secretary.post('/api/bank-accounts', {
    purpose: 'sinking', bankName: 'X Bank', last4: '1234', ifsc: 'ICIC1001064',
  })).status, 400, 'IFSC without its zero');
  equal((await secretary.post('/api/bank-accounts', {
    purpose: 'sinking', bankName: 'X Bank', last4: '1234', ifsc: 'ICIC0001064', accountNumber: '106405002178',
  })).status, 400, 'a full account number is not accepted');
  equal((await manager.post('/api/bank-accounts', {
    purpose: 'sinking', bankName: 'X Bank', last4: '1234', ifsc: 'ICIC0001064',
  })).status, 403, 'manager');
  equal((await treasurer.post('/api/bank-accounts', {
    purpose: 'sinking', bankName: 'X Bank', last4: '1234', ifsc: 'ICIC0001064',
  })).status, 403, 'treasurer');
});

// --- bulk payment upload -----------------------------------------------------

const bulkFlatNo = `P-${stamp.slice(0, 4)}`;
const paymentsCount = () => Number(psql('SELECT COUNT(*) FROM payments;').out);

await check('a payments CSV is checked line by line and nothing is recorded by a check', async () => {
  const flat = await manager.post('/api/flats', { flatNo: bulkFlatNo, billingAreaSqFt: 900, areaBasis: 'super-built-up' });
  equal(flat.status, 201, 'test flat');
  const before = paymentsCount();
  const csv = [
    'Flat No,Amount,Date,Mode,UTR',
    `${bulkFlatNo},"4,500.00",15/09/2026,GPay,UTR-A1`,
    `${bulkFlatNo},2000,2026-09-16,cheque,CHQ-77`,
    'Z-999,100,15/09/2026,upi,',
    `${bulkFlatNo},abc,15/09/2026,upi,`,
    `${bulkFlatNo},100,31/02/2026,upi,`,
    `${bulkFlatNo},100,15/09/2026,bitcoin,`,
    `${bulkFlatNo},"4,500.00",15/09/2026,upi,UTR-A1`,
  ].join('\n');
  const r = await manager.post('/api/payments/import', { csv, confirm: false });
  equal(r.status, 200, 'status');
  equal(r.body.checked, 7, 'lines');
  equal(r.body.problems, 5, 'problem lines');
  const byLine = Object.fromEntries(r.body.lines.map(l => [l.line, l]));
  equal(byLine[2].method, 'upi', 'GPay read as UPI');
  equal(byLine[2].amountPaise, 450_000, 'Indian grouping read');
  equal(byLine[3].method, 'cheque', 'cheque');
  matches(byLine[4].problems[0], /no flat "Z-999"/, 'unknown flat');
  matches(byLine[5].problems[0], /not rupees/, 'bad amount');
  matches(byLine[6].problems[0], /not a date/, 'bad date');
  matches(byLine[7].problems[0], /payment mode/, 'bad mode');
  matches(byLine[8].problems[0], /repeats line 2/, 'a repeated line');
  equal(paymentsCount(), before, 'nothing recorded');

  const refused = await manager.post('/api/payments/import', { csv, confirm: true },
    { 'Idempotency-Key': key('bulk-bad') });
  equal(refused.status, 409, 'a file with problems is refused whole');
  equal(paymentsCount(), before, 'still nothing recorded');
});

await check('a clean payments CSV records every line, and the same file cannot be taken twice', async () => {
  const before = paymentsCount();
  const csv = [
    'flat_no,amount,received_on,method,reference',
    `${bulkFlatNo},4500,15/09/2026,upi,UTR-B1`,
    `${bulkFlatNo},2000,16/09/2026,neft,UTR-B2`,
  ].join('\n');
  const r = await manager.post('/api/payments/import', { csv, confirm: true },
    { 'Idempotency-Key': key('bulk-good') });
  equal(r.status, 200, 'status');
  equal(r.body.recorded.length, 2, 'two receipts');
  truthy(r.body.recorded.every(x => /^RC\/2026-09\//.test(x.receiptNo)), 'receipt numbers');
  equal(paymentsCount(), before + 2, 'two payments on the books');

  const again = await manager.post('/api/payments/import', { csv, confirm: false });
  equal(again.body.problems, 2, 'both lines now flagged');
  matches(again.body.lines[0].problems[0], /already recorded as receipt RC\/2026-09\//, 'says which receipt');

  const r2 = await treasurer.get('/api/reports/trial-balance?asAt=2026-12-31');
  equal(r2.body.tiesOut, true, 'the books still tie');
});

await check('only an account that records payments may upload them', async () => {
  const csv = `flat_no,amount,received_on,method\n${bulkFlatNo},1,15/09/2026,cash`;
  equal((await secretary.post('/api/payments/import', { csv, confirm: false })).status, 403, 'secretary');
  equal((await resident.post('/api/payments/import', { csv, confirm: false })).status, 403, 'resident');
  equal((await manager.post('/api/payments/import', { csv, confirm: true })).status, 400,
    'confirming needs an Idempotency-Key');
});

// --- notices -----------------------------------------------------------------

await check('the secretary publishes a notice: on the board, and e-mails queued to owners', async () => {
  const r = await secretary.post('/api/notices', {
    title: `Water tank cleaning ${stamp}`,
    body: 'Water supply will be off on Sunday from 10 am to 2 pm.',
    email: true,
  });
  equal(r.status, 201, 'status');
  truthy(r.body.emailsQueued >= 5, 'e-mails queued to the owners');
  const queued = psql(
    `SELECT COUNT(*) FROM notifications WHERE template = 'notice' AND channel = 'email'
        AND state = 'queued' AND subject = 'Water tank cleaning ${stamp}';`,
  );
  equal(Number(queued.out), r.body.emailsQueued, 'queued, not claimed sent');

  const board = await resident.get('/api/notices');
  equal(board.status, 200, 'a resident reads the board');
  const mine = board.body.notices.find(n => n.title === `Water tank cleaning ${stamp}`);
  truthy(mine !== undefined, 'the notice is on the board');
  matches(mine.body, /Sunday/, 'its text');
  const trail = await auditor.get('/api/audit?action=notice.publish');
  equal(trail.body.entries[0].detail.title, `Water tank cleaning ${stamp}`, 'in the trail');
});

await check('a notice can be board-only, and only the secretary publishes', async () => {
  const r = await secretary.post('/api/notices', { title: `AGM on 15 Nov ${stamp}`, body: 'Clubhouse, 6 pm.', email: false });
  equal(r.status, 201, 'status');
  equal(r.body.emailsQueued, 0, 'no e-mail');
  equal((await manager.post('/api/notices', { title: 'Not mine', body: 'x', email: false })).status, 403, 'manager');
  equal((await resident.post('/api/notices', { title: 'Not mine', body: 'x', email: false })).status, 403, 'resident');
  equal((await secretary.post('/api/notices', { title: 'x', body: 'y', email: false })).status, 400, 'a title too short');
  equal((await anonymous.get('/api/notices')).status, 401, 'the board needs a sign-in');
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

// --- billing defects: regressions for the accounting audit -------------------

suite('billing defects');

// A society of its own, so these checks start from a known, empty ledger and
// leave the main society's figures — which every check above asserts exactly —
// untouched. Same seed, same flats and the same ₹4.50 rate; GST starts off.
const dStamp = randomUUID().slice(0, 8);
const dDomain = `d${dStamp}.invalid`;
const dSeedPool = new PgPool(connectionFromEnv(process.env));
const dFixture = await seed(dSeedPool, {
  name: `Billing defects society ${dStamp}`, password: PASSWORD, emailDomain: dDomain,
});
await dSeedPool.end();
const dFlat = (flatNo) => {
  const flat = dFixture.flats.find(f => f.flatNo === flatNo);
  if (flat === undefined) throw new Error(`no seeded flat ${flatNo}`);
  return flat;
};
const dManager = new Client(base);
const dTreasurer = new Client(base);
const dSecretary = new Client(base);
await dManager.signIn(`manager@${dDomain}`, PASSWORD);
await dTreasurer.signIn(`treasurer@${dDomain}`, PASSWORD);
await dSecretary.signIn(`secretary@${dDomain}`, PASSWORD);
const dKey = (what) => `defects-${dStamp}-${what}`;
const { computeBillTax, creditAccountForHead, financialYearStart } = await import(`${build}/posting.js`);
const { isoDateInIndia, canonicalPeriod } = await import('../.server-build/src/accounting/clock.js');

// One flat over the ₹7,500 per-member threshold: 2,000 sq ft at 450 paise is
// ₹9,000 of maintenance. Every other seeded flat bills under it.
psql(`UPDATE flats SET billing_area_sqft = 2000 WHERE id = '${dFlat('C-301').id}';`);

let dJuly = [];
const dDoc = (flatNo) => {
  const found = dJuly.find(d => d.flatNo === flatNo);
  if (found === undefined) throw new Error(`no July document for ${flatNo}`);
  return found;
};
const dOutstanding = (taxInvoiceNo) => Number(psql(
  `SELECT COALESCE(SUM(p.debit - p.credit), 0) FROM journal_postings p
    WHERE p.society_id = '${dFixture.societyId}' AND p.account_code = '1100'
      AND p.doc_ref = '${taxInvoiceNo}';`,
).out);

// 1. The period, canonicalised.

await check('a period typed with two spaces is stored as the one spelling', async () => {
  const r = await dManager.post('/api/billing/run', { period: 'Jul  2026', issuedOn: '2026-07-01' });
  equal(r.status, 201, 'status');
  equal(r.body.period, 'Jul 2026', 'the period the run reports');
  equal(r.body.issued.length, 10, 'documents issued');
  dJuly = r.body.issued;
  const stored = psql(
    `SELECT DISTINCT period FROM billing_documents WHERE society_id = '${dFixture.societyId}';`,
  );
  equal(stored.out, 'Jul 2026', 'what was stored');
});

await check('and other spellings of the same month bill nobody twice', async () => {
  for (const period of ['jul 2026', 'July 2026', ' JUL 2026 ']) {
    const r = await dManager.post('/api/billing/run', { period, issuedOn: '2026-07-01' });
    equal(r.status, 201, `status for "${period}"`);
    equal(r.body.issued.length, 0, `documents issued for "${period}"`);
    equal(r.body.skipped.length, 10, `documents skipped for "${period}"`);
    matches(r.body.skipped[0].why, /already billed for Jul 2026/, 'reason');
  }
  const bad = await dManager.post('/api/billing/run', { period: 'Julyy 2026', issuedOn: '2026-07-01' });
  equal(bad.status, 400, 'a word that only starts like a month');
  equal(canonicalPeriod('Sept 2026'), 'Sep 2026', 'the engine rule the validator uses');
});

await check('a listing finds the month however it is typed', async () => {
  const r = await dManager.get('/api/billing/documents?period=jul%20%202026');
  equal(r.body.documents.length, 10, 'documents found');
});

await check('and the database refuses a second spelling from anywhere', async () => {
  const r = psql(
    `INSERT INTO billing_documents
       (society_id, proforma_no, flat_id, period, estimated_tax, gross, issued_on, due_on, state)
     VALUES ('${dFixture.societyId}', 'DUP/${dStamp}', '${dFlat('B-204').id}', 'Jul  2026', 0, 100,
             '2026-07-01', '2026-07-01', 'draft');`,
  );
  truthy(!r.ok, 'the database accepted a period written with two spaces');
  matches(r.out, /not written the one way a period is written/, 'the trigger that refused it');
});

// Low: two billing runs for one period at the same moment.

await check('two concurrent runs for one period skip, rather than collide', async () => {
  const [a, b] = await Promise.all([
    dManager.post('/api/billing/run', { period: 'Aug 2026', issuedOn: '2026-08-01' }),
    dManager.post('/api/billing/run', { period: 'Aug 2026', issuedOn: '2026-08-01' }),
  ]);
  equal(a.status, 201, 'the first run');
  equal(b.status, 201, 'the second run, which used to fail on the unique index');
  equal(a.body.issued.length + b.body.issued.length, 10, 'documents issued between them');
  equal(a.body.skipped.length + b.body.skipped.length, 10, 'documents skipped between them');
});

// 5. The per-member GST threshold, and equal halves.

await check('GST is set on with no threshold named, so the statutory ₹7,500 applies', async () => {
  const set = await dSecretary.put('/api/settings/gst.treatment', {
    value: { chargeGst: true, ratePercent: 18 },
  });
  equal(set.status, 200, 'setting');
  const approve = await dTreasurer.post('/api/settings/gst.treatment/approve', { on: '2026-07-01' });
  equal(approve.status, 200, 'sign-off');
  // Everything approved except B-101, which stays a draft for the receipts
  // checks below.
  for (const document of dJuly.filter(d => d.flatNo !== 'B-101')) {
    const r = await dTreasurer.post(`/api/billing/documents/${document.documentId}/approve`, {
      on: '2026-07-01',
    });
    equal(r.status, 200, `approving ${document.flatNo}`);
  }
});

await check('a member above the threshold pays GST on the whole amount', async () => {
  const r = await dTreasurer.post(`/api/billing/documents/${dDoc('C-301').documentId}/convert`, {
    on: '2026-07-16', because: 'manual',
  });
  equal(r.status, 200, 'status');
  // ₹9,000 of maintenance: 9% of all of it on each half, not on the excess.
  equal(r.body.cgst, 81_000, 'cgst');
  equal(r.body.sgst, 81_000, 'sgst');
  equal(r.body.gross, 900_000 + 90_000 + 162_000, 'gross');
});

await check('a member at or under it pays none, and the register records no row', async () => {
  const b204 = dDoc('B-204');
  const r = await dTreasurer.post(`/api/billing/documents/${b204.documentId}/convert`, {
    on: '2026-07-16', because: 'manual',
  });
  equal(r.status, 200, 'status');
  equal(r.body.cgst, 0, 'cgst on ₹4,432.50 of maintenance');
  equal(r.body.gross, 443_250 + 44_325, 'gross');
  const rows = psql(`SELECT COUNT(*) FROM gst_register WHERE document_id = '${b204.documentId}';`);
  equal(rows.out, '0', 'register rows for an exempt supply');
  const gst = await dTreasurer.get('/api/reports/gst?taxPeriod=2026-07');
  equal(gst.body.agrees, true, 'register against ledger');
  equal(gst.body.cgst, 81_000, 'register cgst is the one taxed member only');
});

await check('the threshold is a boundary: equal is exempt, a paisa over is taxed in full', async () => {
  const gst = { chargeGst: true, ratePercent: 18, approved: true, memberThresholdPaise: 750_000 };
  equal(computeBillTax([{ head: 'maintenance', amount: 750_000, taxable: true }], gst).total, 0,
    'at ₹7,500.00');
  const over = computeBillTax([{ head: 'maintenance', amount: 750_001, taxable: true }], gst);
  equal(over.taxableValue, 750_001, 'the whole amount is taxable');
  equal(over.total, 135_000, 'tax at ₹7,500.01');
  // The sinking share is not a taxable supply and does not count towards it.
  equal(computeBillTax([
    { head: 'maintenance', amount: 700_000, taxable: true },
    { head: 'sinking', amount: 70_000, taxable: false },
  ], gst).total, 0, 'maintenance under the threshold with a sinking share on top');
});

await check('CGST and SGST are computed as equal halves, never a paisa apart', async () => {
  // 18% of 750,005 is 135,000.9, which rounds to the odd 135,001 and used to
  // be split 67,501 / 67,500 under an invoice printing both at 9%.
  const tax = computeBillTax([{ head: 'maintenance', amount: 750_005, taxable: true }], {
    chargeGst: true, ratePercent: 18, approved: true, memberThresholdPaise: 0,
  });
  equal(tax.cgst, 67_500, 'cgst');
  equal(tax.sgst, 67_500, 'sgst');
  equal(tax.total, 135_000, 'total');
});

// 4. A partly paid invoice cannot be cancelled.

await check('cancelling an invoice with money against it is refused', async () => {
  const a101 = dDoc('A-101');
  const convert = await dTreasurer.post(`/api/billing/documents/${a101.documentId}/convert`, {
    on: '2026-07-16', because: 'manual',
  });
  equal(convert.status, 200, 'the conversion');
  const pay = await dManager.post('/api/payments', {
    flatId: dFlat('A-101').id, amountPaise: 100_000, receivedOn: '2026-07-20', method: 'upi',
  }, { 'Idempotency-Key': dKey('a101-part') });
  equal(pay.status, 201, 'the part payment');

  const r = await dTreasurer.post(`/api/billing/documents/${a101.documentId}/cancel`, {
    reason: 'Raised in error.', on: '2026-07-21',
  });
  equal(r.status, 409, 'status');
  matches(r.body.message, /₹1,000 received or credited/, 'message');
  const state = psql(`SELECT state FROM billing_documents WHERE id = '${a101.documentId}';`);
  equal(state.out, 'tax-invoice', 'the invoice was left as it was');
  equal(dOutstanding(convert.body.taxInvoiceNo), 569_250 - 100_000, 'and nothing went below zero');
});

// 2. A cancelled invoice can be replaced.

await check('a cancelled invoice is replaced and the replacement posts', async () => {
  const a102 = dDoc('A-102');
  const convert = await dTreasurer.post(`/api/billing/documents/${a102.documentId}/convert`, {
    on: '2026-07-16', because: 'manual',
  });
  equal(convert.status, 200, 'the first conversion');
  const cancel = await dTreasurer.post(`/api/billing/documents/${a102.documentId}/cancel`, {
    reason: 'Wrong area on file.', on: '2026-07-17',
  });
  equal(cancel.status, 200, 'the cancellation');

  const rerun = await dManager.post('/api/billing/run', {
    period: 'Jul 2026', issuedOn: '2026-07-01', flatIds: [dFlat('A-102').id],
  });
  equal(rerun.status, 201, 'the re-run');
  equal(rerun.body.issued.length, 1, 'a replacement document');
  const replacement = rerun.body.issued[0];
  equal((await dTreasurer.post(`/api/billing/documents/${replacement.documentId}/approve`, {
    on: '2026-07-17',
  })).status, 200, 'approving the replacement');

  // This is the conversion that was refused: the billing entry was keyed on
  // flat and period, and the cancelled invoice's key was never released.
  const r = await dTreasurer.post(`/api/billing/documents/${replacement.documentId}/convert`, {
    on: '2026-07-18', because: 'manual',
  });
  equal(r.status, 200, 'the replacement converts');
  equal(r.body.gross, 443_250 + 44_325, 'gross');
  const key = psql(`SELECT idempotency_key FROM journal_entries WHERE id = '${r.body.entryId}';`);
  equal(key.out, `bill:doc:${replacement.documentId}`, 'keyed on the document');
});

// 3. A payment for a proforma converts it.

await check('a payment against an approved proforma converts it and settles it', async () => {
  const a201 = dDoc('A-201');
  const r = await dManager.post('/api/payments', {
    flatId: dFlat('A-201').id, amountPaise: 569_250, receivedOn: '2026-07-21', method: 'neft',
    againstDocumentId: a201.documentId,
  }, { 'Idempotency-Key': dKey('a201-proforma') });
  equal(r.status, 201, 'status');
  equal(r.body.converted.length, 1, 'documents converted');
  equal(r.body.appliedToDues, 569_250, 'applied to dues');
  equal(r.body.heldAsAdvance, 0, 'held as advance — this was the whole payment');

  const list = await dManager.get('/api/billing/documents?period=Jul%202026&asAt=2026-07-31');
  const document = list.body.documents.find(d => d.id === a201.documentId);
  equal(document.state, 'tax-invoice', 'state');
  equal(document.paymentStatus, 'Paid', 'paymentStatus');
  const because = psql(`SELECT converted_because FROM billing_documents WHERE id = '${a201.documentId}';`);
  equal(because.out, 'payment-received', 'why it was converted');
});

await check('and without naming it, the oldest approved proforma is converted', async () => {
  const r = await dManager.post('/api/payments', {
    flatId: dFlat('A-202').id, amountPaise: 487_575, receivedOn: '2026-07-21', method: 'upi',
  }, { 'Idempotency-Key': dKey('a202-proforma') });
  equal(r.status, 201, 'status');
  equal(r.body.converted.length, 1, 'documents converted');
  equal(r.body.heldAsAdvance, 0, 'held as advance');
  equal(r.body.appliedToDues, 487_575, 'applied to dues');
});

await check('but a draft is not turned into a tax invoice by a payment', async () => {
  const b101 = dDoc('B-101');
  const named = await dManager.post('/api/payments', {
    flatId: dFlat('B-101').id, amountPaise: 10_000, receivedOn: '2026-07-21', method: 'upi',
    againstDocumentId: b101.documentId,
  }, { 'Idempotency-Key': dKey('b101-named') });
  equal(named.status, 409, 'naming an unapproved proforma');
  matches(named.body.message, /not been approved/, 'message');

  const unnamed = await dManager.post('/api/payments', {
    flatId: dFlat('B-101').id, amountPaise: 10_000, receivedOn: '2026-07-21', method: 'upi',
  }, { 'Idempotency-Key': dKey('b101-unnamed') });
  equal(unnamed.status, 201, 'status');
  equal(unnamed.body.converted.length, 0, 'documents converted');
  equal(unnamed.body.heldAsAdvance, 10_000, 'held as advance, visibly');
});

// 12. Receipts for one flat in different months, and credit notes, capped.

await check('two receipts for one flat dated in different months cannot both spend one invoice', async () => {
  const b102 = dDoc('B-102');
  const convert = await dTreasurer.post(`/api/billing/documents/${b102.documentId}/convert`, {
    on: '2026-07-16', because: 'manual',
  });
  equal(convert.status, 200, 'the conversion');
  const flatId = dFlat('B-102').id;
  const [a, b] = await Promise.all([
    dManager.post('/api/payments', {
      flatId, amountPaise: 569_250, receivedOn: '2026-07-25', method: 'neft',
    }, { 'Idempotency-Key': dKey('b102-july') }),
    dManager.post('/api/payments', {
      flatId, amountPaise: 569_250, receivedOn: '2026-08-05', method: 'neft',
    }, { 'Idempotency-Key': dKey('b102-august') }),
  ]);
  equal(a.status, 201, 'the July receipt');
  equal(b.status, 201, 'the August receipt');
  equal(a.body.appliedToDues + b.body.appliedToDues, 569_250, 'applied between them: the invoice once');
  equal(a.body.heldAsAdvance + b.body.heldAsAdvance, 569_250, 'the rest on account');
  equal(dOutstanding(convert.body.taxInvoiceNo), 0, 'the invoice is settled, not credit-side');
});

await check('a credit note on a settled invoice goes to the advance, not below zero', async () => {
  const b102 = dDoc('B-102');
  const before = await dManager.get(`/api/flats/${dFlat('B-102').id}/dues?asAt=2026-08-31`);
  const r = await dTreasurer.post(`/api/billing/documents/${b102.documentId}/notes`, {
    kind: 'credit', amountPaise: 50_000, reason: 'Lift out of service.', on: '2026-08-10',
    withTax: false,
  });
  equal(r.status, 201, 'status');
  equal(r.body.appliedToInvoicePaise, 0, 'applied to the invoice');
  equal(r.body.heldAsAdvancePaise, 50_000, 'held as advance');
  const after = await dManager.get(`/api/flats/${dFlat('B-102').id}/dues?asAt=2026-08-31`);
  equal(after.body.outstandingPaise, 0, 'receivable');
  equal(after.body.advancePaise, before.body.advancePaise + 50_000, 'advance');
});

await check('and a credit note larger than the invoice is refused', async () => {
  const r = await dTreasurer.post(`/api/billing/documents/${dDoc('B-102').documentId}/notes`, {
    kind: 'credit', amountPaise: 600_000, reason: 'Too much.', on: '2026-08-11', withTax: false,
  });
  equal(r.status, 400, 'status');
  matches(r.body.message, /more than the ₹5,192.50/, 'message');
});

// 7. Tax invoices numbered by financial year.

await check('an invoice in January continues its financial year\'s series', async () => {
  equal(financialYearStart('2027-03-31'), 2026, 'the last day of FY 2026-27');
  equal(financialYearStart('2027-04-01'), 2027, 'the first day of FY 2027-28');
  const run = await dManager.post('/api/billing/run', {
    period: 'Jan 2027', issuedOn: '2027-01-01', flatIds: [dFlat('B-201').id],
  });
  equal(run.status, 201, 'the run');
  const document = run.body.issued[0];
  await dTreasurer.post(`/api/billing/documents/${document.documentId}/approve`, { on: '2027-01-01' });
  const r = await dTreasurer.post(`/api/billing/documents/${document.documentId}/convert`, {
    on: '2027-01-10', because: 'manual',
  });
  equal(r.status, 200, 'status');
  // Eight July conversions came before it in this society — the cancelled one
  // keeps its number — all in FY 2026-27.
  equal(r.body.taxInvoiceNo, 'MV/2026/00009', 'the next number in FY 2026-27, not MV/2027/00001');
});

// 6. A report's default start is the financial year of its end.

await check('a report ending in February starts the April before, not the April after', async () => {
  const r = await dTreasurer.get('/api/reports/income-expenditure?to=2027-02-15');
  equal(r.status, 200, 'status — this was 400, "from is after to"');
  equal(r.body.from, '2026-04-01', 'from');
  const july = await dTreasurer.get('/api/reports/income-expenditure?to=2026-07-31');
  equal(july.body.from, '2026-04-01', 'from for a date after April');
});

// 8. "Today" is India's date.

await check('today is the date in India, not in UTC', async () => {
  equal(isoDateInIndia(new Date('2026-07-31T18:29:59Z')), '2026-07-31', 'at 23:59:59 IST');
  equal(isoDateInIndia(new Date('2026-07-31T18:30:00Z')), '2026-08-01', 'at 00:00 IST, still 31 July in UTC');
  equal(isoDateInIndia(new Date('2027-03-31T20:00:00Z')), '2027-04-01', 'a new financial year in India');
});

// 9. TDS on the value of the service, rounded as the engine rounds.

let dVendorId = null;

await check('TDS is withheld on the bill less its GST', async () => {
  const vendor = await dManager.post('/api/vendors', {
    name: `Defects Lift Services ${dStamp}`, category: 'lift', pan: 'AAACL1234E',
    tdsSection: '194C', payeeKind: 'company',
  });
  equal(vendor.status, 201, 'the vendor');
  dVendorId = vendor.body.id;
  const r = await dManager.post(`/api/vendors/${dVendorId}/bills`, {
    billNo: `LS-${dStamp}-01`, billDate: '2026-07-05', expenseAccount: '5020',
    grossPaise: 1_180_000, inputGstPaise: 180_000,
  });
  equal(r.status, 201, 'status');
  // 2% of the ₹10,000 service, not of the ₹11,800 including GST (23,600).
  equal(r.body.tdsPaise, 20_000, 'tds');
  equal(r.body.netPayablePaise, 1_160_000, 'net payable');

  equal((await dTreasurer.post(`/api/vendor-bills/${r.body.id}/approve`)).status, 200, 'approval');
  equal((await dTreasurer.post(`/api/vendor-bills/${r.body.id}/book`, { on: '2026-07-06' })).status, 200,
    'booking');
  const register = psql(`SELECT gross || ' ' || tds_amount FROM tds_register WHERE bill_id = '${r.body.id}';`);
  equal(register.out, '1000000 20000', 'the register records the amount it was deducted on');
});

await check('and rounded half-up to the paisa, as the browser engine rounds', async () => {
  const r = await dManager.post(`/api/vendors/${dVendorId}/bills`, {
    billNo: `LS-${dStamp}-02`, billDate: '2026-07-05', expenseAccount: '5020', grossPaise: 10_025,
  });
  equal(r.status, 201, 'status');
  // 2% of 10,025 is 200.5: 201 half-up; the server's Math.floor said 200.
  equal(r.body.tdsPaise, 201, 'tds');
});

// 10. Festival collections follow the fund treatment.

await check('a festival collection is credited to the festival fund by default', async () => {
  equal(creditAccountForHead('festival', false), '3010', 'festival, fund treatment');
  equal(creditAccountForHead('festival', true), '4020', 'festival, through income');
  equal(creditAccountForHead('sinking', true), '4010', 'sinking, through income');

  const c302 = dDoc('C-302');
  psql(`INSERT INTO billing_document_lines (document_id, head, amount, taxable, position)
        VALUES ('${c302.documentId}', 'festival', 50000, false, 2);`);
  const r = await dTreasurer.post(`/api/billing/documents/${c302.documentId}/convert`, {
    on: '2026-07-16', because: 'manual',
  });
  equal(r.status, 200, 'status');
  const legs = psql(
    `SELECT account_code || ':' || credit FROM journal_postings
      WHERE entry_id = '${r.body.entryId}' AND account_code IN ('3010', '4020');`,
  );
  equal(legs.out, '3010:50000', 'the fund, not festival income');
});

await check('and routing it through income needs a sign-off first', async () => {
  await dSecretary.put('/api/settings/accounting.sinkingFundThroughIncome', { value: true });
  const r = await dTreasurer.post(`/api/billing/documents/${dDoc('B-201').documentId}/convert`, {
    on: '2026-07-16', because: 'manual',
  });
  equal(r.status, 409, 'status');
  matches(r.body.message, /has not been signed off/, 'message');
  await dSecretary.put('/api/settings/accounting.sinkingFundThroughIncome', { value: false });
});

// Low: ageing separates what is not yet due from what is overdue.

await check('ageing puts an invoice on its due date in "not-due", and after it in "1-30"', async () => {
  // C-301's July invoice, unpaid, due 2026-07-16.
  const onDue = await dTreasurer.get('/api/reports/ageing?asAt=2026-07-16');
  const c301 = onDue.body.rows.find(row => row.flatNo === 'C-301');
  equal(c301.buckets[0].label, 'not-due', 'on the due date');
  const later = await dTreasurer.get('/api/reports/ageing?asAt=2026-07-20');
  equal(later.body.rows.find(row => row.flatNo === 'C-301').buckets[0].label, '1-30', 'four days late');
});

await check('and this society\'s books tie after all of it', async () => {
  const tb = await dTreasurer.get('/api/reports/trial-balance?asAt=2027-03-31');
  equal(tb.body.tiesOut, true, 'tiesOut');
  const receivable = tb.body.lines.find(l => l.code === '1100');
  const documents = await dManager.get('/api/billing/documents?asAt=2027-03-31');
  equal(receivable.debit - receivable.credit,
    documents.body.documents.reduce((sum, d) => sum + d.outstanding, 0),
    'receivable against the sum per document');
  for (const d of documents.body.documents) {
    truthy(d.outstanding >= 0, `${d.proformaNo} is not credit-side (${d.outstanding})`);
  }
});

// --- GST treatment choices: sinking fund taxable, rounding to the rupee -----

suite('GST treatment: sinkingFundTaxable and roundToRupee');

// A society of its own, as "billing defects" has, so changing its GST
// treatment month by month touches nobody else's figures. The worked figures
// are the approach note's: ₹4.50/sq ft at 18%.
const gStamp = randomUUID().slice(0, 8);
const gDomain = `g${gStamp}.invalid`;
const gSeedPool = new PgPool(connectionFromEnv(process.env));
const gFixture = await seed(gSeedPool, {
  name: `GST treatment society ${gStamp}`, password: PASSWORD, emailDomain: gDomain,
});
await gSeedPool.end();
const gFlat = (flatNo) => {
  const flat = gFixture.flats.find(f => f.flatNo === flatNo);
  if (flat === undefined) throw new Error(`no seeded flat ${flatNo}`);
  return flat;
};
const gManager = new Client(base);
const gTreasurer = new Client(base);
const gSecretary = new Client(base);
await gManager.signIn(`manager@${gDomain}`, PASSWORD);
await gTreasurer.signIn(`treasurer@${gDomain}`, PASSWORD);
await gSecretary.signIn(`secretary@${gDomain}`, PASSWORD);
const gCookie = () => [...gTreasurer.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

// 1,750 and 2,250 sq ft from the note; 1,600 sq ft is ₹7,200 of maintenance,
// under the ₹7,500 exemption alone and over it once a 10% sinking fund counts.
psql(`UPDATE flats SET billing_area_sqft = 1750 WHERE id = '${gFlat('A-101').id}';`);
psql(`UPDATE flats SET billing_area_sqft = 2250 WHERE id = '${gFlat('A-102').id}';`);
psql(`UPDATE flats SET billing_area_sqft = 1600 WHERE id = '${gFlat('B-101').id}';`);

/** Sets the treatment as the secretary and has the treasurer sign it off. */
const gTreat = async (value, sinkingPercent) => {
  equal((await gSecretary.put('/api/settings/gst.treatment', { value })).status, 200, 'setting GST');
  equal((await gTreasurer.post('/api/settings/gst.treatment/approve', { on: '2026-07-01' })).status,
    200, 'signing GST off');
  equal((await gSecretary.put('/api/settings/billing.sinkingFundPercent', { value: sinkingPercent })).status,
    200, 'setting the sinking share');
};
/** Runs a month, approves and converts the named flats, and says what each became. */
const gBill = async (period, issuedOn, flatNos) => {
  const run = await gManager.post('/api/billing/run', { period, issuedOn });
  equal(run.status, 201, `the ${period} run`);
  const out = {};
  for (const flatNo of flatNos) {
    const issued = run.body.issued.find(d => d.flatNo === flatNo);
    truthy(issued, `a ${period} document for ${flatNo}`);
    equal((await gTreasurer.post(`/api/billing/documents/${issued.documentId}/approve`, { on: issuedOn })).status,
      200, `approving ${flatNo}`);
    const converted = await gTreasurer.post(`/api/billing/documents/${issued.documentId}/convert`, {
      on: issuedOn, because: 'manual',
    });
    equal(converted.status, 200, `converting ${flatNo}`);
    const register = psql(
      `SELECT taxable_value || ',' || cgst || ',' || sgst FROM gst_register
        WHERE document_id = '${issued.documentId}';`,
    ).out;
    const lines = psql(
      `SELECT string_agg(head || ':' || taxable::text, ',' ORDER BY position)
         FROM billing_document_lines WHERE document_id = '${issued.documentId}';`,
    ).out;
    out[flatNo] = { issued, converted: converted.body, register, lines };
  }
  return out;
};

let gAug = null;

await check('flags absent: the note\'s figures to the paisa, as before', async () => {
  await gTreat({ chargeGst: true, ratePercent: 18 }, 0);
  const july = await gBill('Jul 2026', '2026-07-01', ['A-101', 'A-102']);
  const a = july['A-101'];
  equal(a.issued.estimatedTax, 141_750, '1,750 sq ft: the proforma estimate');
  equal(a.converted.cgst, 70_875, '1,750 sq ft: CGST ₹708.75');
  equal(a.converted.sgst, 70_875, '1,750 sq ft: SGST ₹708.75');
  equal(a.converted.gross, 929_250, '1,750 sq ft: total ₹9,292.50');
  equal(a.register, '787500,70875,70875', '1,750 sq ft: the GST register row');
  const b = july['A-102'];
  equal(b.converted.cgst, 91_125, '2,250 sq ft: CGST ₹911.25');
  equal(b.converted.gross, 1_194_750, '2,250 sq ft: total ₹11,947.50');
  equal(b.register, '1012500,91125,91125', '2,250 sq ft: the GST register row');
});

await check('roundToRupee: CGST and SGST each to the nearest rupee, half up, still equal', async () => {
  await gTreat({ chargeGst: true, ratePercent: 18, roundToRupee: true }, 0);
  gAug = await gBill('Aug 2026', '2026-08-01', ['A-101', 'A-102']);
  const a = gAug['A-101'];
  equal(a.issued.estimatedTax, 141_800, '1,750 sq ft: the proforma estimate');
  equal(a.issued.gross, 929_300, '1,750 sq ft: the proforma total');
  equal(a.converted.cgst, 70_900, '1,750 sq ft: CGST ₹709');
  equal(a.converted.sgst, 70_900, '1,750 sq ft: SGST ₹709');
  equal(a.converted.gross, 929_300, '1,750 sq ft: total ₹9,293.00');
  equal(a.register, '787500,70900,70900', '1,750 sq ft: the GST register row');
  const b = gAug['A-102'];
  equal(b.converted.cgst, 91_100, '2,250 sq ft: CGST ₹911 — .25 rounds down');
  equal(b.converted.sgst, 91_100, '2,250 sq ft: SGST ₹911');
  equal(b.converted.gross, 1_194_700, '2,250 sq ft: total ₹11,947.00');
  const report = await gTreasurer.get('/api/reports/gst?taxPeriod=2026-08');
  equal(report.body.agrees, true, 'register against ledger');
  equal(report.body.cgst, 70_900 + 91_100, 'register CGST for August');
});

await check('roundToRupee: the tax invoice PDF prints the whole rupees and says so', async () => {
  const id = gAug['A-101'].issued.documentId;
  const response = await fetch(`${base}/api/billing/documents/${id}/pdf`, { headers: { Cookie: gCookie() } });
  equal(response.status, 200, 'status');
  const text = Buffer.from(await response.arrayBuffer()).toString('latin1');
  matches(text, /709\.00/, 'CGST and SGST');
  matches(text, /9,293\.00/, 'the total');
  matches(text, /rounded to the nearest rupee/, 'the rounding, stated');
});

await check('roundToRupee: a credit note carries tax rounded the same way', async () => {
  // ₹1,000.50 at 9% is ₹90.045 a half: ₹90 to the rupee, where the paisa
  // rule would give ₹90.05.
  const id = gAug['A-101'].issued.documentId;
  const r = await gTreasurer.post(`/api/billing/documents/${id}/notes`, {
    kind: 'credit', amountPaise: 100_050, reason: 'Rounding check.', on: '2026-08-05', withTax: true,
  });
  equal(r.status, 201, 'status');
  equal(r.body.taxPaise, 18_000, 'tax on the note');
  equal(r.body.totalPaise, 118_050, 'note total');
  const report = await gTreasurer.get('/api/reports/gst?taxPeriod=2026-08');
  equal(report.body.agrees, true, 'register against ledger after the note');
});

await check('sinkingFundTaxable: the sinking line is taxed and counts towards the exemption', async () => {
  await gTreat({ chargeGst: true, ratePercent: 18, sinkingFundTaxable: true }, 10);
  const sept = await gBill('Sep 2026', '2026-09-01', ['A-101', 'B-101']);
  const a = sept['A-101'];
  equal(a.lines, 'maintenance:true,sinking:true', 'both lines taxable');
  // ₹7,875 + ₹787.50 = ₹8,662.50 taxable; 9% is ₹779.625, ₹779.63 to the paisa.
  equal(a.issued.estimatedTax, 155_926, '1,750 sq ft + 10% sinking: the proforma estimate');
  equal(a.converted.cgst, 77_963, '1,750 sq ft + 10% sinking: CGST');
  equal(a.converted.sgst, 77_963, '1,750 sq ft + 10% sinking: SGST');
  equal(a.converted.gross, 866_250 + 155_926, '1,750 sq ft + 10% sinking: total ₹10,221.76');
  equal(a.register, '866250,77963,77963', 'the register\'s taxable value includes the sinking fund');
  // ₹7,200 of maintenance alone is exempt; with ₹720 of sinking fund the
  // taxable contribution is ₹7,920, so GST is due on all of it.
  const b = sept['B-101'];
  equal(b.converted.cgst, 71_280, '1,600 sq ft: CGST on ₹7,920');
  equal(b.converted.gross, 792_000 + 142_560, '1,600 sq ft: total');
});

await check('both flags: sinking fund taxed and each half rounded to the rupee', async () => {
  await gTreat({ chargeGst: true, ratePercent: 18, sinkingFundTaxable: true, roundToRupee: true }, 10);
  const oct = await gBill('Oct 2026', '2026-10-01', ['A-101']);
  const a = oct['A-101'];
  equal(a.converted.cgst, 78_000, '₹779.625 rounds to ₹780');
  equal(a.converted.sgst, 78_000, 'SGST equal');
  equal(a.converted.gross, 866_250 + 156_000, 'total ₹10,222.50');
});

await check('an approved proforma\'s PDF shows the estimated halves, not "No GST"', async () => {
  const list = await gManager.get('/api/billing/documents?period=Oct%202026');
  const proforma = list.body.documents.find(d => d.flatNo === 'A-102');
  equal((await gTreasurer.post(`/api/billing/documents/${proforma.id}/approve`, { on: '2026-10-01' })).status,
    200, 'approving A-102');
  const response = await fetch(`${base}/api/billing/documents/${proforma.id}/pdf`, { headers: { Cookie: gCookie() } });
  equal(response.status, 200, 'status');
  const text = Buffer.from(await response.arrayBuffer()).toString('latin1');
  // ₹10,125 + ₹1,012.50 taxable: 9% is ₹1,002.375, so ₹1,002 a half.
  matches(text, /1,002\.00/, 'each half, to the rupee');
  // Parentheses are escaped inside a PDF string.
  matches(text, /SGST @ 9\.00% \\\(estimate\\\)/, 'marked as an estimate');
  matches(text, /13,141\.50/, 'the total');
  truthy(!/No GST charged/.test(text), 'no claim that nothing is charged');
});

await check('flags off again: the sinking fund is not taxed and not counted', async () => {
  await gTreat({ chargeGst: true, ratePercent: 18, sinkingFundTaxable: false, roundToRupee: false }, 10);
  const nov = await gBill('Nov 2026', '2026-11-01', ['A-101', 'B-101']);
  equal(nov['A-101'].lines, 'maintenance:true,sinking:false', 'the sinking line is not taxable');
  equal(nov['A-101'].converted.cgst, 70_875, '1,750 sq ft: CGST on maintenance alone');
  equal(nov['A-101'].converted.gross, 787_500 + 78_750 + 141_750, '1,750 sq ft: total');
  equal(nov['B-101'].converted.cgst, 0, '1,600 sq ft: exempt on ₹7,200 of maintenance');
  equal(nov['B-101'].converted.gross, 792_000, '1,600 sq ft: total');
  equal(nov['B-101'].register, '', 'no register row for an exempt supply');
});

await check('a flag that is not true or false is refused, not guessed', async () => {
  equal((await gSecretary.put('/api/settings/gst.treatment', {
    value: { chargeGst: true, ratePercent: 18, roundToRupee: 'yes' },
  })).status, 200, 'stored');
  const r = await gManager.post('/api/billing/run', { period: 'Dec 2026', issuedOn: '2026-12-01' });
  equal(r.status, 400, 'the run refuses');
  matches(r.body.message, /roundToRupee/, 'and names the field');
});

await check('the GST treatment society\'s trial balance ties out', async () => {
  const r = await gTreasurer.get('/api/reports/trial-balance?asAt=2026-12-31');
  equal(r.body.tiesOut, true, 'tiesOut');
});

await check('computeBillTax applies both flags as the engine rule does', async () => {
  const gst = {
    chargeGst: true, ratePercent: 18, approved: true, memberThresholdPaise: 750_000,
    sinkingFundTaxable: false, roundToRupee: false,
  };
  const lines = [{ head: 'maintenance', amount: 787_500, taxable: true }];
  equal(computeBillTax(lines, gst).cgst, 70_875, 'to the paisa');
  const rounded = computeBillTax(lines, { ...gst, roundToRupee: true });
  equal(rounded.cgst, 70_900, 'to the rupee');
  equal(rounded.sgst, 70_900, 'halves equal');
  equal(rounded.total, 141_800, 'total twice one half');
  // Exactly half a rupee rounds up: 0.3% of ₹3,500 is ₹10.50, so ₹11.
  const half = computeBillTax([{ head: 'maintenance', amount: 350_000, taxable: true }],
    { ...gst, memberThresholdPaise: 0, ratePercent: 0.6, roundToRupee: true });
  equal(half.cgst, 1_100, '₹10.50 rounds half up to ₹11');
  // The paisa figure is not rounded again: 0.3% of ₹4,165 is ₹12.495, which
  // is ₹12 — rounding ₹12.50 would have made it ₹13.
  const exact = computeBillTax([{ head: 'maintenance', amount: 416_500, taxable: true }],
    { ...gst, memberThresholdPaise: 0, ratePercent: 0.6, roundToRupee: true });
  equal(exact.cgst, 1_200, '₹12.495 rounds to ₹12, not via ₹12.50');
});

// --- going live ------------------------------------------------------------

suite('go-live: flat and owner import');

// A society of its own, for the same reason as the billing-defects society:
// these checks bring in 200 flats and an opening position, and every figure
// the main society's checks assert must stay as it was.
const oStamp = randomUUID().slice(0, 8);
const oDomain = `g${oStamp}.invalid`;
const oSeedPool = new PgPool(connectionFromEnv(process.env));
const oFixture = await seed(oSeedPool, {
  name: `Go-live society ${oStamp}`, password: PASSWORD, emailDomain: oDomain,
});
await oSeedPool.end();
const oFlat = (flatNo) => {
  const flat = oFixture.flats.find(f => f.flatNo === flatNo);
  if (flat === undefined) throw new Error(`no seeded flat ${flatNo}`);
  return flat;
};
const oManager = new Client(base);
const oTreasurer = new Client(base);
const oSecretary = new Client(base);
await oManager.signIn(`manager@${oDomain}`, PASSWORD);
await oTreasurer.signIn(`treasurer@${oDomain}`, PASSWORD);
await oSecretary.signIn(`secretary@${oDomain}`, PASSWORD);
const oKey = (what) => `golive-${oStamp}-${what}`;
const oCount = (sql) => Number(psql(sql).out);

const IMPORT_HEADER =
  'flat_no,tower,floor,area_sqft,area_basis,owner_name,owner_email,owner_mobile,co_owner_name,co_owner_email,owner_pan';
// 200 flats in four towers of ten floors, five to a floor, between 1,750 and
// 2,600 sq ft — the shape of the society this is for.
const importRows = Array.from({ length: 200 }, (_, i) => {
  const tower = 'ABCD'[Math.floor(i / 50)];
  const floor = 1 + Math.floor((i % 50) / 5);
  const unit = 1 + (i % 5);
  const flatNo = `${tower}-${floor}${String(unit).padStart(2, '0')}`;
  const area = 1750 + (i % 18) * 50;
  const co = i % 10 === 0 ? `,Co-owner ${i},co${i}@${oDomain}` : ',,';
  return `${flatNo},${tower},${floor},${area},,Owner ${i},o${i}@${oDomain},98300${String(i).padStart(5, '0')}${co},`;
});
const importCsv = [IMPORT_HEADER, ...importRows].join('\n');

await check('a dry run reports every bad row by line, under tolerated header spellings', async () => {
  const csv = [
    'Flat No,Wing,Floor,Area (sq ft),Basis,Owner,E-mail,Mobile,PAN',
    `Z-1,Z,1,1800,super built up,Asha Roy,asha@${oDomain},9830012345,ABCDE1234F`,
    `Z-2,Z,1,,carpet,Bimal Sen,bimal@${oDomain},,`,
    `Z-3,Z,G,12x0,attic,Chitra Das,not-an-email,12345,BAD`,
    `Z-1,Z,2,1900,,Dipa Ghosh,dipa@${oDomain},,`,
    `Z-5,Z,2,1900,,Esha Paul,asha@${oDomain},,`,
  ].join('\n');
  const before = oCount(`SELECT count(*) FROM flats WHERE society_id = '${oFixture.societyId}';`);
  const r = await oSecretary.post('/api/flats/import', { csv, dryRun: true });
  equal(r.status, 200, 'status');
  equal(r.body.committed, false, 'committed');
  const lines = (n) => r.body.errors.filter(e => e.line === n).map(e => e.message).join(' | ');
  equal(lines(2), '', 'line 2 is clean');
  matches(lines(3), /area_sqft is empty/, 'line 3: missing area');
  matches(lines(4), /area_sqft "12x0"/, 'line 4: bad area');
  matches(lines(4), /area_basis "attic"/, 'line 4: bad basis');
  matches(lines(4), /not an email address/, 'line 4: bad email');
  matches(lines(4), /mobile/, 'line 4: bad mobile');
  matches(lines(4), /PAN/, 'line 4: bad PAN');
  matches(lines(5), /flat Z-1 is also on line 2/, 'line 5: duplicate flat');
  matches(lines(6), /asha@.* is also on line 2/, 'line 6: duplicate email');
  equal(oCount(`SELECT count(*) FROM flats WHERE society_id = '${oFixture.societyId}';`), before, 'nothing written');
});

await check('a commit of a file with errors writes nothing', async () => {
  const csv = `${IMPORT_HEADER}\nZ-9,Z,1,1800,,Ok Person,ok9@${oDomain},,,,\nZ-10,Z,1,-4,,Bad Area,bad10@${oDomain},,,,`;
  const r = await oSecretary.post('/api/flats/import', { csv, dryRun: false });
  equal(r.status, 400, 'status');
  matches(r.body.message, /Nothing was imported/, 'message');
  equal(r.body.detail.errors[0].line, 3, 'the bad line');
  equal(oCount(`SELECT count(*) FROM flats WHERE society_id = '${oFixture.societyId}' AND flat_no = 'Z-9';`), 0,
    'the good row was not written either');
});

await check('an address that signs in to another society is refused', async () => {
  const csv = `${IMPORT_HEADER}\nZ-11,Z,1,1800,,Someone,treasurer@${domain},,,,`;
  const r = await oSecretary.post('/api/flats/import', { csv, dryRun: true });
  matches(r.body.errors.map(e => e.message).join(' '), /another society/, 'refusal');
});

await check('only an account that manages members may import', async () => {
  const r = await oTreasurer.post('/api/flats/import', { csv: importCsv, dryRun: true });
  equal(r.status, 403, 'status');
});

await check('a 200-flat dry run counts what a commit would do', async () => {
  const started = Date.now();
  const r = await oSecretary.post('/api/flats/import', { csv: importCsv, dryRun: true });
  equal(r.status, 200, 'status');
  equal(r.body.errors.length, 0, `errors: ${JSON.stringify(r.body.errors.slice(0, 3))}`);
  // All ten seeded flats share numbers with the sheet, so they are updates.
  equal(r.body.flats.new, 190, 'new flats');
  equal(r.body.flats.updated, 10, 'updated flats');
  equal(r.body.accounts.created, 220, 'accounts: 200 owners and 20 co-owners');
  equal(r.body.defaultAreaBasis, 'super-built-up', 'the approved rate\'s basis fills a blank');
  truthy(Date.now() - started < 10_000, 'in reasonable time');
});

await check('the commit creates flats, owners, tenures and code-only resident accounts, audited', async () => {
  const r = await oSecretary.post('/api/flats/import', { csv: importCsv, dryRun: false, filename: 'flats.csv' });
  equal(r.status, 201, `status ${JSON.stringify(r.body).slice(0, 200)}`);
  equal(r.body.committed, true, 'committed');
  equal(oCount(`SELECT count(*) FROM flats WHERE society_id = '${oFixture.societyId}';`), 200, 'flats');
  const user = psql(
    `SELECT (u.password_hash IS NULL)::text || ',' || o.full_name || ',' || f.flat_no || ',' ||
            (SELECT string_agg(role, '+') FROM user_roles WHERE user_id = u.id)
       FROM users u JOIN owners o ON o.id = u.owner_id
       JOIN flat_ownership fo ON fo.owner_id = o.id AND fo.held_until IS NULL
       JOIN flats f ON f.id = fo.flat_id
      WHERE u.email = 'o0@${oDomain}';`,
  );
  equal(user.out, 'true,Owner 0,A-101,resident', 'no password, linked to the owner of A-101, resident');
  equal(oCount(
    `SELECT count(*) FROM flat_ownership fo JOIN flats f ON f.id = fo.flat_id
      WHERE f.society_id = '${oFixture.societyId}' AND fo.role = 'co-owner';`), 20, 'co-owner tenures');
  // A-101 was a seeded flat: its area is now the file's and its owner the file's.
  equal(psql(`SELECT billing_area_sqft::int FROM flats WHERE id = '${oFlat('A-101').id}';`).out, '1750', 'A-101 area');
  const logged = psql(
    `SELECT detail->>'flatsNew' || '/' || (detail->>'accountsCreated') FROM audit_log
      WHERE society_id = '${oFixture.societyId}' AND action = 'member.import';`,
  );
  matches(logged.out, /^\d+\/220$/, 'audit row with the counts');
  truthy(!/98300/.test(psql(`SELECT detail::text FROM audit_log WHERE society_id = '${oFixture.societyId}' AND action = 'member.import';`).out),
    'no member phone numbers in the audit log');
});

await check('re-importing the same file changes nothing', async () => {
  const tenures = oCount(`SELECT count(*) FROM flat_ownership fo JOIN flats f ON f.id = fo.flat_id WHERE f.society_id = '${oFixture.societyId}';`);
  const r = await oSecretary.post('/api/flats/import', { csv: importCsv, dryRun: false });
  equal(r.status, 201, 'status');
  equal(r.body.flats.unchanged, 200, 'unchanged');
  equal(r.body.flats.new + r.body.flats.updated, 0, 'new or updated');
  equal(r.body.accounts.created + r.body.accounts.linked, 0, 'accounts');
  equal(oCount(`SELECT count(*) FROM flat_ownership fo JOIN flats f ON f.id = fo.flat_id WHERE f.society_id = '${oFixture.societyId}';`),
    tenures, 'tenures');
  equal(oCount(`SELECT count(*) FROM flats WHERE society_id = '${oFixture.societyId}';`), 200, 'flats');
});

await check('a corrected row updates that flat and nothing else', async () => {
  const corrected = importCsv.replace(`A-102,A,1,1800,,Owner 1,o1@${oDomain}`, `A-102,A,1,1825,,Owner One,owner1@${oDomain}`);
  const dry = await oSecretary.post('/api/flats/import', { csv: corrected, dryRun: true });
  equal(dry.body.flats.updated, 1, 'updated');
  equal(dry.body.flats.unchanged, 199, 'unchanged');
  const change = dry.body.changes.find(c => c.flatNo === 'A-102');
  matches(change.what.join(','), /area/, 'the area');
  matches(change.what.join(','), /owner/, 'the owner');
  const r = await oSecretary.post('/api/flats/import', { csv: corrected, dryRun: false });
  equal(r.status, 201, 'status');
  const holder = psql(
    `SELECT o.email FROM flat_ownership fo JOIN owners o ON o.id = fo.owner_id
      WHERE fo.flat_id = '${oFlat('A-102').id}' AND fo.role = 'owner' AND fo.held_until IS NULL;`,
  );
  equal(holder.out, `owner1@${oDomain}`, 'the new owner holds A-102');
});

suite('go-live: opening balances');

let oVendorId = null;
const OPENING_AS_AT = '2026-09-30';
const openingCsv = [
  'flat_no,opening_due,opening_advance,due_since',
  'A-101,"5,000.00",,2026-06-30',
  'A-102,0,1200,',
  'B-101,2500.50,0,',
  'C-302,0,0,',
].join('\n');
const accountLines = () => [
  { accountCode: '1000', debitPaise: 150_000_000, creditPaise: 0, memo: 'Operating account per bank statement' },
  { accountCode: '1200', debitPaise: 500_000_000, creditPaise: 0 },
  { accountCode: '3000', debitPaise: 0, creditPaise: 520_000_000 },
  { accountCode: '3010', debitPaise: 0, creditPaise: 2_000_000 },
  {
    accountCode: '2000', debitPaise: 0, creditPaise: 3_500_000, vendorId: oVendorId,
    reference: 'SEC/SEP/26', expenseAccount: '5010',
  },
];
// Debits 5,00,000 + 2,50,050 + 15,00,00,000 + 50,00,00,000 paise; credits
// 1,20,000 + 52,00,00,000 + 20,00,000 + 35,00,000. The difference is the
// general fund.
const OPENING_DEBITS = 500_000 + 250_050 + 150_000_000 + 500_000_000;
const OPENING_CREDITS = 120_000 + 520_000_000 + 2_000_000 + 3_500_000;
const GENERAL_FUND = OPENING_DEBITS - OPENING_CREDITS;

await check('a vendor to owe', async () => {
  const r = await oManager.post('/api/vendors', {
    name: `Guards ${oStamp}`, category: 'security', tdsSection: '194C', payeeKind: 'company',
  });
  equal(r.status, 201, 'status');
  oVendorId = r.body.id;
});

await check('a dry run reports bad per-flat rows by line and saves nothing', async () => {
  const csv = 'flat_no,opening_due,opening_advance\nA-101,100,50\nNO-SUCH,10,\nB-101,abc,\nB-101,5,';
  const r = await oSecretary.post('/api/opening-balances/draft', {
    asAt: OPENING_AS_AT, autoBalance: false, dryRun: true, flatsCsv: csv, accountLines: [],
  });
  equal(r.status, 200, 'status');
  const at = (line) => r.body.plan.errors.filter(e => e.line === line).map(e => e.message).join(' | ');
  matches(at(2), /both a due and an advance/, 'line 2');
  matches(at(3), /no such flat/, 'line 3');
  matches(at(4), /not an amount/, 'line 4');
  equal(oCount(`SELECT count(*) FROM opening_balance_batches WHERE society_id = '${oFixture.societyId}';`), 0, 'no batch');
});

await check('income and per-flat control accounts are refused as society balances', async () => {
  const r = await oSecretary.post('/api/opening-balances/draft', {
    asAt: OPENING_AS_AT, autoBalance: true, dryRun: true,
    accountLines: [
      { accountCode: '4000', debitPaise: 0, creditPaise: 100 },
      { accountCode: '1100', debitPaise: 100, creditPaise: 0 },
    ],
  });
  matches(r.body.plan.errors[0].message, /income account/, 'income');
  matches(r.body.plan.errors[1].message, /per flat/, 'control account');
});

let batchId = null;

await check('the secretary saves an unbalanced draft, which says it cannot post', async () => {
  const r = await oSecretary.post('/api/opening-balances/draft', {
    asAt: OPENING_AS_AT, autoBalance: false, dryRun: false, flatsCsv: openingCsv, accountLines: accountLines(),
  });
  equal(r.status, 201, `status ${JSON.stringify(r.body).slice(0, 300)}`);
  batchId = r.body.batchId;
  equal(r.body.plan.totals.debitPaise, OPENING_DEBITS, 'debits');
  equal(r.body.plan.totals.creditPaise, OPENING_CREDITS, 'credits');
  equal(r.body.plan.flats.length, 3, 'a zero row is not a line');
  matches(r.body.plan.blockers.join(' '), /out by/, 'the difference is the blocker');
});

await check('posting an unbalanced batch is refused and posts nothing', async () => {
  const r = await oTreasurer.post(`/api/opening-balances/${batchId}/approve`, {});
  equal(r.status, 409, 'status');
  matches(r.body.message, /out by/, 'message');
  equal(oCount(`SELECT count(*) FROM journal_entries WHERE society_id = '${oFixture.societyId}';`), 0, 'no entry');
});

await check('the preparer cannot approve, by role and by the database', async () => {
  const r = await oSecretary.post(`/api/opening-balances/${batchId}/approve`, {});
  equal(r.status, 403, 'the secretary has no right to post');
  const db = psql(
    `UPDATE opening_balance_batches SET approved_by = prepared_by WHERE id = '${batchId}';`,
  );
  truthy(!db.ok, 'the database refused maker = checker');
  matches(db.out, /opening_balance_maker_is_not_checker/, 'the constraint');
});

await check('with the balancing figure to the general reserve, the treasurer posts one balanced entry', async () => {
  const saved = await oSecretary.post('/api/opening-balances/draft', {
    asAt: OPENING_AS_AT, autoBalance: true, dryRun: false, flatsCsv: openingCsv, accountLines: accountLines(),
  });
  equal(saved.status, 201, 'saved');
  equal(saved.body.batchId, batchId, 'the same draft, replaced');
  const balancing = saved.body.plan.accounts.find(a => a.isBalancing);
  equal(balancing.accountCode, '3020', 'to the general reserve');
  equal(balancing.creditPaise, GENERAL_FUND, 'the balancing figure');
  equal(saved.body.plan.blockers.length, 0, `blockers: ${saved.body.plan.blockers}`);

  const r = await oTreasurer.post(`/api/opening-balances/${batchId}/approve`, {});
  equal(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}`);
  equal(r.body.documents, 2, 'two opening dues');
  equal(r.body.vendorBills, 1, 'one opening payable');
  equal(r.body.totalPaise, OPENING_DEBITS, 'the entry total');

  const tb = await oTreasurer.get(`/api/reports/trial-balance?asAt=${OPENING_AS_AT}`);
  equal(tb.body.tiesOut, true, 'tiesOut');
  equal(tb.body.totalDebit, OPENING_DEBITS, 'total debit');
  const line = (code) => tb.body.lines.find(l => l.code === code) ?? { debit: 0, credit: 0 };
  equal(line('3020').credit, GENERAL_FUND, 'general reserve');
  equal(line('1100').debit, 750_050, 'receivable');
  equal(line('2300').credit, 120_000, 'member advances');
  equal(line('2200').credit + line('2201').credit, 0, 'no output GST');
  equal(oCount(`SELECT count(*) FROM journal_entries WHERE society_id = '${oFixture.societyId}' AND source_kind = 'opening-balance';`), 1, 'one entry');
  equal(oCount(`SELECT count(*) FROM gst_register WHERE society_id = '${oFixture.societyId}';`), 0, 'no GST register rows');
  equal(oCount(`SELECT count(*) FROM approvals WHERE subject_id = '${batchId}' AND decision = 'approved';`), 1, 'in the approvals register');
});

await check('a second opening position is refused, by the API and by the database', async () => {
  const again = await oSecretary.post('/api/opening-balances/draft', {
    asAt: OPENING_AS_AT, autoBalance: true, dryRun: false, flatsCsv: openingCsv, accountLines: [],
  });
  equal(again.status, 409, 'a new draft');
  matches(again.body.message, /already posted/, 'message');
  const twice = await oTreasurer.post(`/api/opening-balances/${batchId}/approve`, {});
  equal(twice.status, 409, 'approving twice');
  const db = psql(
    `INSERT INTO opening_balance_batches (society_id, batch_no, as_at, prepared_by)
     SELECT society_id, 99, as_at, prepared_by FROM opening_balance_batches WHERE id = '${batchId}';`,
  );
  truthy(!db.ok, 'the database refused a second live batch');
  matches(db.out, /opening_balance_one_live/, 'the index');
});

await check('an opening due is not cancelled on its own, and carries no GST row even if asked', async () => {
  const docs = await oManager.get(`/api/flats/${oFlat('A-101').id}/dues?asAt=2026-10-01`);
  const due = docs.body.invoices[0];
  matches(due.taxInvoiceNo, /^OB\/1\/\d{5}$/, 'numbered in the opening series');
  const r = await oTreasurer.post(`/api/billing/documents/${due.documentId}/cancel`, { reason: 'test', on: '2026-10-01' });
  equal(r.status, 409, 'status');
  matches(r.body.message, /opening balance/, 'message');
  const db = psql(
    `INSERT INTO gst_register (society_id, document_id, tax_period, invoice_no, invoice_date, counterparty,
       supply_type, taxable_value, cgst, sgst, rate_bps)
     VALUES ('${oFixture.societyId}', '${due.documentId}', '2026-09', 'X', '2026-09-30', 'A-101', 'B2C', 1, 0, 0, 0);`,
  );
  truthy(!db.ok, 'the register refused it');
  matches(db.out, /not a supply/, 'the reason');
});

await check('a correction is a reversal and a fresh batch, both audited', async () => {
  const r = await oTreasurer.post(`/api/opening-balances/${batchId}/reverse`, { reason: 'Bank figure was the passbook, not the statement' });
  equal(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 200)}`);
  const tb = await oTreasurer.get(`/api/reports/trial-balance?asAt=${OPENING_AS_AT}`);
  for (const line of tb.body.lines) equal(line.debit, line.credit, `account ${line.code} nets to nothing at the as-at date`);
  equal(oCount(`SELECT count(*) FROM billing_documents WHERE opening_batch_id = '${batchId}' AND state = 'cancelled';`), 2, 'dues cancelled');

  const lines = accountLines();
  lines[0] = { ...lines[0], debitPaise: 150_500_000 };
  const saved = await oSecretary.post('/api/opening-balances/draft', {
    asAt: OPENING_AS_AT, autoBalance: true, dryRun: false, flatsCsv: openingCsv, accountLines: lines,
  });
  equal(saved.status, 201, `re-entry saved ${JSON.stringify(saved.body).slice(0, 300)}`);
  const posted = await oTreasurer.post(`/api/opening-balances/${saved.body.batchId}/approve`, {});
  equal(posted.status, 200, `re-entry posted ${JSON.stringify(posted.body).slice(0, 300)}`);
  batchId = saved.body.batchId;
  const actions = psql(
    `SELECT string_agg(action, ',' ORDER BY id) FROM audit_log
      WHERE society_id = '${oFixture.societyId}' AND action LIKE 'opening.%';`,
  );
  equal(actions.out, 'opening.prepare,opening.prepare,opening.post,opening.reverse,opening.prepare,opening.post', 'the trail');
  const tb2 = await oTreasurer.get(`/api/reports/trial-balance?asAt=${OPENING_AS_AT}`);
  const bank = tb2.body.lines.find(l => l.code === '1000');
  equal(bank.debit - bank.credit, 150_500_000, 'the corrected bank balance');
  const reserve = tb2.body.lines.find(l => l.code === '3020');
  equal(reserve.credit - reserve.debit, GENERAL_FUND + 500_000, 'and the general fund moves with it');
  equal(tb2.body.tiesOut, true, 'tiesOut');
});

await check('an opening due ages from when it fell due', async () => {
  const r = await oTreasurer.get('/api/reports/ageing?asAt=2026-10-23');
  const a101 = r.body.rows.find(row => row.flatNo === 'A-101');
  equal(a101.outstanding, 500_000, 'A-101 outstanding');
  equal(a101.buckets[0].label, '90+', 'bucket, from 30 June');
  const b101 = r.body.rows.find(row => row.flatNo === 'B-101');
  equal(b101.outstanding, 250_050, 'B-101 outstanding');
});

let openingReceipt = null;

await check('a later receipt settles the opening due first, like an invoice', async () => {
  const r = await oManager.post('/api/payments', {
    flatId: oFlat('A-101').id, amountPaise: 300_000, receivedOn: '2026-10-25', method: 'upi',
  }, { 'Idempotency-Key': oKey('opening-receipt') });
  equal(r.status, 201, `status ${JSON.stringify(r.body).slice(0, 200)}`);
  equal(r.body.allocations.length, 1, 'allocations');
  matches(r.body.allocations[0].taxInvoiceNo, /^OB\/2\//, 'against the opening due');
  equal(r.body.appliedToDues, 300_000, 'applied');
  openingReceipt = r.body;
  const ageing = await oTreasurer.get('/api/reports/ageing?asAt=2026-10-25');
  equal(ageing.body.rows.find(row => row.flatNo === 'A-101').outstanding, 200_000, 'what is left, in ageing');
  const statement = await oTreasurer.get(`/api/reports/statement/${oFlat('A-101').id}?to=2026-10-31`);
  equal(statement.status, 200, 'statement');
  equal(statement.body.closing, 200_000, 'the flat statement agrees');
});

await check('an opening advance is applied to the next bill', async () => {
  const run = await oManager.post('/api/billing/run', { period: 'Oct 2026', issuedOn: '2026-10-01' });
  equal(run.status, 201, 'billing run');
  const doc = run.body.issued.find(d => d.flatNo === 'A-102');
  equal((await oTreasurer.post(`/api/billing/documents/${doc.documentId}/approve`, { on: '2026-10-01' })).status, 200, 'approved');
  const converted = await oTreasurer.post(`/api/billing/documents/${doc.documentId}/convert`, { on: '2026-10-16', because: 'due-date-reached' });
  equal(converted.status, 200, 'converted');

  const applied = await oTreasurer.post('/api/advances/apply', { on: '2026-10-16', flatId: oFlat('A-102').id });
  equal(applied.status, 200, `status ${JSON.stringify(applied.body).slice(0, 200)}`);
  equal(applied.body.appliedPaise, 120_000, 'the whole advance');
  equal(applied.body.applications[0].allocations[0].taxInvoiceNo, converted.body.taxInvoiceNo, 'against the October bill');

  const dues = await oTreasurer.get(`/api/flats/${oFlat('A-102').id}/dues?asAt=2026-10-16`);
  equal(dues.body.advancePaise, 0, 'nothing left on account');
  equal(dues.body.outstandingPaise, converted.body.gross - 120_000, 'the bill, less the advance');
  const again = await oTreasurer.post('/api/advances/apply', { on: '2026-10-16', flatId: oFlat('A-102').id });
  equal(again.body.appliedPaise, 0, 'applying again finds nothing to apply');
});

await check('the opening payable is a booked bill the payment route can settle', async () => {
  const bill = psql(
    `SELECT id || ',' || state || ',' || net_payable FROM vendor_bills
      WHERE vendor_id = '${oVendorId}' AND opening_batch_id = '${batchId}';`,
  );
  const [billId, state, net] = bill.out.split(',');
  equal(state, 'booked', 'state');
  equal(Number(net), 3_500_000, 'payable');
  const r = await oTreasurer.post(`/api/vendor-bills/${billId}/pay`, {
    amountPaise: 3_500_000, paidOn: '2026-10-10', method: 'neft', paymentRef: `NEFT-${oStamp}`,
  }, { 'Idempotency-Key': oKey('opening-vendor-pay') });
  equal(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 200)}`);
});

await check('the opening entry and everything after it restore in the browser engine\'s chart', async () => {
  const { CHART } = await import('../.server-build/src/accounting/accounts.js');
  const known = new Set(CHART.map(a => a.code));
  const snap = await oTreasurer.get('/api/books/snapshot');
  for (const entry of snap.body.entries) {
    for (const leg of entry.postings) truthy(known.has(leg.accountCode), `account ${leg.accountCode}`);
  }
  equal(snap.body.taxInvoiceSequence, 1, 'the opening series does not move the tax invoice series');
});

suite('go-live: society profile');

const GSTIN_WB = '19AAACI1681G1ZM';

await check('anyone with report access can read it; only settings.manage can change it', async () => {
  const r = await oManager.get('/api/society');
  equal(r.status, 200, 'status');
  equal(r.body.gstin, null, 'no GSTIN yet');
  equal(r.body.canEdit, false, 'the manager cannot edit');
  const put = await oManager.put('/api/society', { name: 'Taken over' });
  equal(put.status, 403, 'the manager is refused');
});

await check('a GSTIN is checked for shape, check digit and state', async () => {
  const basics = { name: 'Mani Vista RWA' };
  const shape = await oSecretary.put('/api/society', { ...basics, gstin: '19ABC', stateCode: '19' });
  equal(shape.status, 400, 'shape');
  matches(shape.body.message, /15 characters/, 'shape message');
  const digit = await oSecretary.put('/api/society', { ...basics, gstin: '19AAACI1681G1ZN', stateCode: '19' });
  equal(digit.status, 400, 'check digit');
  matches(digit.body.message, /mistyped/, 'check digit message');
  const state = await oSecretary.put('/api/society', { ...basics, gstin: GSTIN_WB, stateCode: '27' });
  equal(state.status, 400, 'state');
  matches(state.body.message, /begins 19, but the state code is 27/, 'state message');
  const tan = await oSecretary.put('/api/society', { ...basics, tan: 'CAL12345B' });
  equal(tan.status, 400, 'TAN');
  matches(tan.body.message, /TAN/, 'TAN message');
});

await check('a valid change is saved, audited with before and after, and reaches the documents', async () => {
  const r = await oSecretary.put('/api/society', {
    name: `Mani Vista RWA ${oStamp}`, registrationNo: 'WB/RWA/123/2015', gstin: GSTIN_WB.toLowerCase(),
    stateCode: '19', tan: 'calm12345b', address: 'Kolkata 700 156', contactEmail: 'Office@ManiVista.invalid',
  });
  equal(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 200)}`);
  equal(r.body.gstin, GSTIN_WB, 'normalised to capitals');
  equal(r.body.tan, 'CALM12345B', 'TAN');
  matches(r.body.changed.join(','), /name.*gstin|gstin.*name/, 'what changed');

  const change = (field) => psql(
    `SELECT COALESCE(c->>'from', '(none)') || ' -> ' || (c->>'to')
       FROM audit_log, jsonb_array_elements(detail->'changes') AS c
      WHERE society_id = '${oFixture.societyId}' AND action = 'society.profile' AND c->>'field' = '${field}';`,
  ).out;
  equal(change('gstin'), `(none) -> ${GSTIN_WB}`, 'GSTIN before and after');
  equal(change('tan'), '(none) -> CALM12345B', 'TAN before and after');
  equal(change('name'), `Go-live society ${oStamp} -> Mani Vista RWA ${oStamp}`, 'name before and after');

  const snap = await oTreasurer.get('/api/books/snapshot');
  equal(snap.body.gstin, GSTIN_WB, 'the header reads it');
  equal(snap.body.societyName, `Mani Vista RWA ${oStamp}`, 'and the name');

  const response = await fetch(`${base}/api/payments/${openingReceipt.paymentId}/pdf`, {
    headers: { Cookie: [...oTreasurer.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  equal(response.status, 200, 'receipt PDF');
  const text = Buffer.from(await response.arrayBuffer()).toString('latin1');
  matches(text, new RegExp(`Mani Vista RWA ${oStamp}`), 'the new name on the receipt');
  matches(text, new RegExp(`GSTIN ${GSTIN_WB}`), 'the GSTIN on the receipt');

  const same = await oSecretary.put('/api/society', {
    name: `Mani Vista RWA ${oStamp}`, registrationNo: 'WB/RWA/123/2015', gstin: GSTIN_WB,
    stateCode: '19', tan: 'CALM12345B', address: 'Kolkata 700 156', contactEmail: 'office@manivista.invalid',
  });
  equal(same.body.changed.length, 0, 'saving the same values changes nothing');
  equal(oCount(`SELECT count(*) FROM audit_log WHERE society_id = '${oFixture.societyId}' AND action = 'society.profile';`), 1,
    'and logs nothing');
});

// --- one last consistency sweep --------------------------------------------

suite('scheduled release at 6 am');

// The approach note: the treasurer approves the batch, and it is released
// and e-mailed at 06:00 IST on the 1st.
const releasePeriod = 'Feb 2027';
let scheduledReleaseId = null;
const indiaToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

await check('a batch is raised and approved for the period', async () => {
  const run = await manager.post('/api/billing/run', { period: releasePeriod, issuedOn: '2027-02-01' });
  equal(run.status, 201, 'billing run');
  for (const document of run.body.issued) {
    const r = await treasurer.post(`/api/billing/documents/${document.documentId}/approve`, { on: '2027-02-01' });
    equal(r.status, 200, `approving ${document.flatNo}`);
  }
});

await check('a manager cannot schedule the release; it is the treasurer\'s', async () => {
  const r = await manager.post(`/api/billing/periods/${encodeURIComponent(releasePeriod)}/schedule-release`, { on: indiaToday });
  equal(r.status, 403, 'status');
});

await check('a release cannot be scheduled for a date that has passed', async () => {
  const r = await treasurer.post(`/api/billing/periods/${encodeURIComponent(releasePeriod)}/schedule-release`, { on: '2020-01-01' });
  equal(r.status, 400, 'status');
});

await check('the treasurer schedules it for 06:00 IST', async () => {
  const r = await treasurer.post(`/api/billing/periods/${encodeURIComponent(releasePeriod)}/schedule-release`, { on: indiaToday });
  equal(r.status, 201, 'status');
  equal(r.body.scheduledFor, `${indiaToday}T06:00:00+05:30`, 'six in the morning, India time');
  truthy(r.body.approvedNow > 0, 'approved proformas waiting');
  scheduledReleaseId = r.body.id;
  const again = await treasurer.post(`/api/billing/periods/${encodeURIComponent(releasePeriod)}/schedule-release`, { on: indiaToday });
  equal(again.status, 409, 'a second schedule for the same period is refused');
});

await check('a scheduled release can be cancelled and set again', async () => {
  const cancelled = await treasurer.post(`/api/billing/scheduled-releases/${scheduledReleaseId}/cancel`);
  equal(cancelled.status, 200, 'cancelled');
  const r = await treasurer.post(`/api/billing/periods/${encodeURIComponent(releasePeriod)}/schedule-release`, { on: indiaToday });
  equal(r.status, 201, 'scheduled again');
  scheduledReleaseId = r.body.id;
  const list = await treasurer.get('/api/billing/scheduled-releases');
  truthy(list.body.releases.some(x => x.id === scheduledReleaseId && x.state === 'pending'), 'listed as pending');
});

await check('at the time, the approved proformas are released and their emails queued', async () => {
  // Brought forward, so the check does not depend on the hour it runs at.
  psql(`UPDATE scheduled_jobs SET scheduled_for = now() - interval '1 minute' WHERE id = '${scheduledReleaseId}';`);
  const summary = await runDueJobs(jobContext, { worker: `release-${stamp}` });
  truthy(summary.succeeded >= 1, `the job ran: ${JSON.stringify(summary)}`);

  const states = psql(
    `SELECT string_agg(DISTINCT state, ',') FROM billing_documents
      WHERE society_id = '${fixture.societyId}' AND period = '${releasePeriod}';`,
  );
  equal(states.out, 'released', 'every approved proforma is released');
  const queued = psql(
    `SELECT count(*) FROM notifications
      WHERE society_id = '${fixture.societyId}' AND template = 'invoice-issued'
        AND payload->>'period' = '${releasePeriod}' AND payload->>'kind' = 'proforma';`,
  );
  truthy(Number(queued.out) > 0, 'an email per owner is queued, as a proforma');
  const list = await treasurer.get('/api/billing/scheduled-releases');
  const done = list.body.releases.find(x => x.id === scheduledReleaseId);
  equal(done.state, 'succeeded', 'the release is recorded as done');
  truthy(done.result.released > 0, 'with how many went out');
});

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
  googleServer.close();
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
