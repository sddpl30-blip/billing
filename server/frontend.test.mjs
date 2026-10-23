#!/usr/bin/env node
/**
 * The front end's data layer, in a real browser against the real server.
 *
 * What this covers that `api.test.mjs` cannot: the code the browser actually
 * runs. The API client's cookie and CSRF handling only means anything in a
 * browser — `credentials: 'include'`, an HttpOnly session cookie the page
 * cannot read, a CSRF cookie it can — and the server store's rehydration only
 * means anything if the engine accepts what the server sent.
 *
 * The page is served from the same origin as the API by a small front door
 * that proxies `/api` through, which is how this is deployed anyway (a static
 * site and the API behind one host). It also makes the test honest: the
 * session cookie is `SameSite=Strict`, so a cross-origin page would not send
 * it and the test would be exercising something the product never does.
 *
 * The React components are not here. They need JSX and react itself, which
 * cannot be installed in this environment — so what runs is every layer below
 * them. That gap is in the production-readiness report, not papered over.
 *
 *   PLAYWRIGHT_RESOLVE_FROM=/opt/node22/lib/node_modules \
 *     node server/frontend.test.mjs
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const browserBuild = join(root, '.browser-build');

if (!existsSync(join(browserBuild, 'api', 'client.js'))) {
  console.error(
    'The browser build is missing. Run `node scripts/build-browser.mjs` first — this test ' +
    'runs the compiled client, not the TypeScript.',
  );
  process.exit(2);
}

// --- playwright, from wherever it is installed ------------------------------

function loadPlaywright() {
  const from = process.env.PLAYWRIGHT_RESOLVE_FROM;
  const candidates = [join(root, 'node_modules'), ...(from === undefined ? [] : [from])];
  for (const base of candidates) {
    try {
      const require = createRequire(join(base, 'placeholder.js'));
      return require('playwright');
    } catch { /* try the next */ }
  }
  return null;
}

const playwright = loadPlaywright();
if (playwright === null) {
  console.error(
    'Playwright is not installed. Install it with `npm install -D playwright` and run\n' +
    '`npx playwright install chromium`, or point PLAYWRIGHT_RESOLVE_FROM at a global\n' +
    'node_modules directory that has it.',
  );
  process.exit(2);
}

// --- the server and the fixture --------------------------------------------

const build = '../.server-build/server/src';
const { buildApp } = await import(`${build}/app.js`);
const { seed } = await import(`${build}/seed.js`);
const { PgPool, connectionFromEnv } = await import(`${build}/pg.js`);

const stamp = randomUUID().slice(0, 8);
const domain = `fe${stamp}.invalid`;
const PASSWORD = 'frontend-test-password';

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.SECURE_COOKIES = 'false';
process.env.SESSION_SECRET = `fe-secret-${stamp}-${'x'.repeat(32)}`;
process.env.EMAIL_PROVIDER = 'none';
process.env.OTP_PROVIDER = 'local-dev';
process.env.LOG_LEVEL = 'error';

const seedPool = new PgPool(connectionFromEnv(process.env));
const fixture = await seed(seedPool, {
  name: `Frontend test society ${stamp}`,
  password: PASSWORD,
  emailDomain: domain,
});
await seedPool.end();

const app = buildApp(process.env, { runWorker: false });
const { port: apiPort } = await app.listen();

/**
 * A month of real activity, through the API, before the browser looks at it.
 *
 * The page needs something to render, and it has to have arrived the way it
 * arrives in production — a billing run, approvals, a conversion, a receipt —
 * rather than being inserted into the database by this test.
 */
const apiBase = `http://127.0.0.1:${apiPort}`;

async function asRole(role) {
  const jar = new Map();
  const call = async (method, path, body, extra = {}) => {
    const headers = { ...extra };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const csrf = jar.get('sb_csrf');
    if (method !== 'GET' && csrf !== undefined) headers['X-CSRF-Token'] = csrf;
    if (jar.size > 0) {
      headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const response = await fetch(`${apiBase}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  };

  const signIn = await call('POST', '/api/auth/password', {
    email: `${role}@${domain}`, password: PASSWORD,
  });
  if (signIn.status !== 200) {
    throw new Error(`could not sign in as ${role}: ${JSON.stringify(signIn.body)}`);
  }
  return call;
}

const manager = await asRole('manager');
const treasurer = await asRole('treasurer');

const run = await manager('POST', '/api/billing/run', {
  period: 'Jul 2026', issuedOn: '2026-07-01',
});
if (run.status !== 201) throw new Error(`billing run failed: ${JSON.stringify(run.body)}`);

for (const document of run.body.issued) {
  const approved = await treasurer(
    'POST', `/api/billing/documents/${document.documentId}/approve`, { on: '2026-07-01' },
  );
  if (approved.status !== 200) {
    throw new Error(`approval failed: ${JSON.stringify(approved.body)}`);
  }
}

// Two of them raised as tax invoices, so there is a receivable to look at.
for (const document of run.body.issued.slice(0, 2)) {
  const converted = await treasurer(
    'POST', `/api/billing/documents/${document.documentId}/convert`,
    { on: '2026-07-16', because: 'due-date-reached' },
  );
  if (converted.status !== 200) {
    throw new Error(`conversion failed: ${JSON.stringify(converted.body)}`);
  }
}

const firstFlat = (await manager('GET', '/api/flats')).body.flats
  .find(flat => flat.flatNo === run.body.issued[0].flatNo);
const receipt = await manager('POST', '/api/payments', {
  flatId: firstFlat.id,
  amountPaise: 100_000,
  receivedOn: '2026-07-20',
  method: 'upi',
}, { 'Idempotency-Key': `fe-setup-${stamp}` });
if (receipt.status !== 201) throw new Error(`receipt failed: ${JSON.stringify(receipt.body)}`);

// --- the front door: the page and a proxy to the API ------------------------

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>data layer</title></head>
<body><script type="module" src="/test/run.js"></script></body></html>`;

const frontDoor = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://internal');

  if (url.pathname.startsWith('/api/')) {
    // Proxied, so the browser sees one origin. Headers and body pass through
    // untouched, including the cookies — this is a pipe, not a mock.
    const proxied = request.pipe(
      // eslint-disable-next-line node/no-deprecated-api
      requestTo(url, request, response),
    );
    void proxied;
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.writeHead(200, { 'Content-Type': TYPES['.html'] });
    response.end(page);
    return;
  }

  if (url.pathname === '/test/run.js') {
    response.writeHead(200, { 'Content-Type': TYPES['.js'] });
    response.end(runner);
    return;
  }

  if (url.pathname.startsWith('/build/')) {
    const file = join(browserBuild, url.pathname.slice('/build/'.length));
    if (!file.startsWith(browserBuild) || !existsSync(file)) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'text/plain' });
    response.end(readFileSync(file));
    return;
  }

  response.writeHead(404).end('not found');
});

function requestTo(url, incoming, outgoing) {
  const { request: send } = await0();
  const proxied = send(
    {
      host: '127.0.0.1',
      port: apiPort,
      method: incoming.method,
      path: `${url.pathname}${url.search}`,
      headers: { ...incoming.headers, host: `127.0.0.1:${apiPort}` },
    },
    upstream => {
      outgoing.writeHead(upstream.statusCode ?? 500, upstream.headers);
      upstream.pipe(outgoing);
    },
  );
  proxied.on('error', (err) => {
    outgoing.writeHead(502, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ error: 'proxy_failed', message: err.message }));
  });
  return proxied;
}

// `node:http`'s request function, fetched once. Kept in a function so the
// import above stays at the top with the others.
function await0() {
  return httpModule;
}
const httpModule = await import('node:http');

const runner = `
import { ApiClient, ApiError, readCookie } from '/build/api/client.js';
import { createServerStore } from '/build/store/serverStore.js';
import { resolveDataSource } from '/build/store/dataSource.js';
import { residentsFrom, invoicesFrom, ticketsFrom } from '/build/api/legacy.js';
import { systemClock } from '/build/accounting/index.js';

const results = [];
const record = (name, fn) => {
  try {
    const value = fn();
    return Promise.resolve(value)
      .then(() => { results.push({ name, ok: true }); })
      .catch(err => { results.push({ name, ok: false, why: String(err && err.message || err) }); });
  } catch (err) {
    results.push({ name, ok: false, why: String(err && err.message || err) });
    return Promise.resolve();
  }
};
const equal = (actual, expected, what) => {
  if (actual !== expected) {
    throw new Error(what + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
};
const truthy = (value, what) => {
  if (!value) throw new Error(what + ': expected something truthy, got ' + JSON.stringify(value));
};

const role = new URLSearchParams(location.search).get('as') || 'treasurer';
const domain = ${JSON.stringify(domain)};

window.__READY__ = (async () => {
  const email = role + '@' + domain;
  const password = ${JSON.stringify(PASSWORD)};
  const client = new ApiClient({ base: '' });
  const isTreasurer = role === 'treasurer';

  await record('health is reachable from the page', async () => {
    const health = await client.get('/api/health');
    equal(health.status, 'ok', 'status');
    equal(health.database.reachable, true, 'database');
  });

  await record('an unauthenticated read is an ApiError with 401', async () => {
    try {
      await client.get('/api/auth/me');
      throw new Error('it was allowed');
    } catch (err) {
      truthy(err instanceof ApiError, 'an ApiError');
      equal(err.status, 401, 'status');
      equal(err.unauthenticated, true, 'unauthenticated');
    }
  });

  await record('a write with no session is refused before anything happens', async () => {
    try {
      await client.post('/api/billing/run', { period: 'Jul 2026', issuedOn: '2026-07-01' });
      throw new Error('it was allowed');
    } catch (err) {
      truthy(err.status === 401 || err.status === 403, 'refused, got ' + err.status);
    }
  });

  await record('signing in sets a readable CSRF cookie and an unreadable session', async () => {
    await client.post('/api/auth/password', { email, password });
    truthy(readCookie('sb_csrf'), 'the CSRF cookie is readable by the page');
    equal(document.cookie.includes('sb_session'), false,
      'the session cookie must not be readable: it is HttpOnly');
  });

  await record('the session works for a read', async () => {
    const me = await client.get('/api/auth/me');
    equal(me.email, email, 'email');
    truthy(
      me.permissions.includes(isTreasurer ? 'billing.approve' : 'payment.record'),
      'the permissions this role should hold',
    );
  });

  await record('a write without the CSRF header is refused by the server', async () => {
    // The client sends it; this goes round the client to prove the server is
    // the one enforcing it.
    const response = await fetch('/api/billing/periods/Jul%202026/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ template: 'invoice-issued' }),
    });
    equal(response.status, 403, 'status');
    const body = await response.json();
    equal(body.error, 'csrf_failed', 'error');
  });

  let store = null;

  await record('the server store rehydrates the engine from the snapshot', async () => {
    store = createServerStore({ client, clock: systemClock });
    await store.refresh();
    const snapshot = store.snapshot();
    equal(snapshot.ready, true, 'ready');
    equal(snapshot.durable, true, 'durable');
    equal(snapshot.problems.length, 0, 'problems: ' + snapshot.problems.join(' | '));
    truthy(snapshot.ledger.all().length > 0, 'entries in the ledger');
    truthy(store.allDocuments().length > 0, 'documents in the register');
  });

  await record('the rehydrated ledger ties out', async () => {
    const entries = store.snapshot().ledger.all();
    let debit = 0;
    let credit = 0;
    for (const entry of entries) {
      for (const leg of entry.postings) { debit += leg.debit; credit += leg.credit; }
    }
    equal(debit, credit, 'debits against credits in the browser ledger');
  });

  await record('the engine agrees with the server on what is outstanding', async () => {
    const documents = store.allDocuments().filter(d => d.state === 'tax-invoice');
    truthy(documents.length > 0, 'some invoices');
    const fromEngine = documents.reduce((sum, d) => sum + d.outstanding, 0);
    const fromServer = await client.get('/api/billing/documents?asAt=' + systemClock.today());
    const theirs = fromServer.documents
      .filter(d => d.state === 'tax-invoice')
      .reduce((sum, d) => sum + d.outstanding, 0);
    equal(fromEngine, theirs, 'the engine in the browser against the server');
  });

  await record('nothing was written to localStorage in server mode', async () => {
    // The point of the exercise: no second copy of the books on the device.
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    equal(keys.filter(k => k && k.startsWith('gm_')).join(',') || 'none', 'none',
      'keys the demo store would have written');
  });

  await record('the legacy mapping produces the shapes the screens take', async () => {
    const snapshot = await client.get('/api/books/snapshot');
    const residents = residentsFrom(snapshot);
    equal(residents.length, 10, 'residents');
    truthy(residents.every(r => r.flatNo && r.wing), 'each has a flat and a wing');

    const documents = store.allDocuments();
    const invoices = invoicesFrom(documents, new Map(residents.map(r => [r.flatNo, r.name])));
    truthy(invoices.length > 0, 'invoices');

    // Each mapped status against the engine's own for the same document, not
    // merely "one of the three" — which any constant would satisfy.
    for (const invoice of invoices) {
      const document = documents.find(d => d.proformaNo === invoice.id);
      truthy(document, 'the document behind ' + invoice.id);
      const expected = document.status === 'Paid'
        ? 'Paid'
        : document.status === 'Overdue' ? 'Overdue' : 'Pending';
      equal(invoice.status, expected,
        invoice.id + ' (engine says ' + document.status + ')');
      equal(invoice.total, Math.round(document.gross) / 100, invoice.id + ' total in rupees');
    }

    // And at least one of each of the two that are not Pending, so the
    // mapping is exercised rather than merely agreed with.
    truthy(invoices.some(i => i.status === 'Pending'), 'something pending');
    truthy(
      documents.some(d => d.status === 'Partly paid' || d.status === 'Paid'),
      'something paid or part paid, so the Paid branch is reached',
    );
  });

  await record('an entry the engine refuses is reported, not swallowed', async () => {
    // The store's own handling, with a stand-in client. A snapshot naming an
    // account the engine does not know is exactly what a server and an engine
    // drifting apart looks like, and the screens must not quietly show a
    // ledger that is short of a transaction.
    const good = await client.get('/api/books/snapshot');
    const broken = {
      ...good,
      entries: [
        ...good.entries,
        {
          id: 'JE-BROKEN',
          date: '2026-07-01',
          narration: 'An entry naming an account that does not exist',
          source: { kind: 'maintenance-billing' },
          postings: [
            { accountCode: '9999', debit: 100, credit: 0 },
            { accountCode: '1000', debit: 0, credit: 100 },
          ],
          idempotencyKey: 'broken-1',
          postedBy: 'test',
          postedAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    };
    const stub = { get: async () => broken, post: async () => ({}), pdf: async () => new Blob() };
    const problems = [];
    const store2 = createServerStore({
      client: stub,
      clock: systemClock,
      onProblem: message => problems.push(message),
    });
    await store2.refresh();

    truthy(problems.length > 0, 'a problem was reported');
    truthy(
      problems.some(p => /refused/.test(p)),
      'and it says records were refused: ' + problems.join(' | '),
    );
    // The sound entries still load; one bad record does not empty the ledger.
    equal(
      store2.snapshot().ledger.all().length,
      good.entries.length,
      'the entries the engine accepted',
    );
  });

  if (!isTreasurer) {
  await record('a payment through the store reaches the database', async () => {
    const before = await client.get('/api/payments');
    const flats = await client.get('/api/flats');
    const flat = flats.flats.find(f => f.flatNo === 'A-102');
    await client.post(
      '/api/payments',
      {
        flatId: flat.id,
        amountPaise: 123400,
        receivedOn: systemClock.today(),
        method: 'upi',
      },
      { idempotencyKey: 'frontend-test-' + ${JSON.stringify(stamp)} },
    );
    const after = await client.get('/api/payments');
    equal(after.payments.length, before.payments.length + 1, 'payments');
    equal(after.payments[0].amountPaise, 123400, 'the amount recorded');
  });

  await record('the store sees it after a refresh', async () => {
    const beforeRefresh = store.snapshot().ledger.all().length;
    await store.refresh();
    truthy(store.snapshot().ledger.all().length > beforeRefresh, 'more entries than before');
  });

  await record('a replayed idempotency key is refused, in the browser too', async () => {
    const flats = await client.get('/api/flats');
    const flat = flats.flats.find(f => f.flatNo === 'A-102');
    try {
      await client.post(
        '/api/payments',
        { flatId: flat.id, amountPaise: 123400, receivedOn: systemClock.today(), method: 'upi' },
        { idempotencyKey: 'frontend-test-' + ${JSON.stringify(stamp)} },
      );
      throw new Error('it was taken twice');
    } catch (err) {
      equal(err.status, 409, 'status');
    }
  });

  }

  await record('a PDF comes back as a PDF', async () => {
    const documents = await client.get('/api/billing/documents');
    const invoice = documents.documents.find(d => d.state === 'tax-invoice')
      || documents.documents[0];
    const blob = await client.pdf('/api/billing/documents/' + invoice.id + '/pdf');
    equal(blob.type, 'application/pdf', 'the blob type');
    truthy(blob.size > 1000, 'a plausible size, got ' + blob.size);
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    equal(String.fromCharCode(...head).slice(0, 5), '%PDF-', 'the file header');
  });

  await record('resolveDataSource finds the server when it is there', async () => {
    const resolved = await resolveDataSource({ clock: systemClock, force: 'auto' });
    equal(resolved.kind, 'server', 'kind');
    truthy(resolved.note.includes('schema'), 'the note names the schema version');
  });

  await record('and falls back to the demonstration when told there is none', async () => {
    const resolved = await resolveDataSource({ clock: systemClock, force: 'demo' });
    equal(resolved.kind, 'demo', 'kind');
    equal(resolved.store.snapshot().mode, 'demo', 'mode');
  });

  await record('signing out ends the session for the page', async () => {
    await client.post('/api/auth/sign-out');
    try {
      await client.get('/api/auth/me');
      throw new Error('still signed in');
    } catch (err) {
      equal(err.status, 401, 'status');
    }
  });

  return results;
})();
`;

await new Promise(resolve => frontDoor.listen(0, '127.0.0.1', () => resolve()));
const frontPort = frontDoor.address().port;

// --- run it -----------------------------------------------------------------

const { chromium } = playwright;
let exitCode = 0;

const browser = await chromium.launch({
  ...(existsSync('/opt/pw-browsers/chromium') ? {} : {}),
});

try {
  // One browser context per role, so each has its own cookie jar — two
  // sessions in one jar would overwrite each other's session cookie.
  const consoleErrors = [];
  const results = [];
  for (const role of ['treasurer', 'manager']) {
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${frontPort}` });
    const tab = await context.newPage();
    tab.on('console', message => {
      if (message.type() === 'error') {
        // A 4xx on a request the page deliberately makes is logged by the
        // browser; those are the refusals being tested, not faults.
        const text = message.text();
        if (!/Failed to load resource: the server responded with a status of (401|403|409)/.test(text)) {
          consoleErrors.push(text);
        }
      }
    });
    tab.on('pageerror', error => consoleErrors.push(String(error.message)));

    await tab.goto(`http://127.0.0.1:${frontPort}/?as=${role}`, { waitUntil: 'load' });
    const roleResults = await tab.evaluate(() => window.__READY__);
    for (const result of roleResults) results.push({ ...result, name: `[${role}] ${result.name}` });
    await context.close();
  }

  let passed = 0;
  const failures = [];
  console.log('\nthe data layer, in Chromium, against the real server');
  for (const result of results) {
    if (result.ok) {
      passed++;
      console.log(`  ok   ${result.name}`);
    } else {
      failures.push(`${result.name}\n       ${result.why}`);
      console.log(`  FAIL ${result.name}`);
      console.log(`       ${result.why}`);
    }
  }

  console.log('');
  if (consoleErrors.length === 0) {
    passed++;
    console.log('  ok   no uncaught errors in the browser');
  } else {
    failures.push(`uncaught errors in the browser\n       ${consoleErrors.join('\n       ')}`);
    console.log('  FAIL no uncaught errors in the browser');
    for (const error of consoleErrors) console.log(`       ${error}`);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log('\nfailures:');
    for (const failure of failures) console.log(`  · ${failure}`);
    exitCode = 1;
  }
} finally {
  await browser.close();
  frontDoor.close();
  await app.close();
}

process.exit(exitCode);
