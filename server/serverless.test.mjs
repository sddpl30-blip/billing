#!/usr/bin/env node
/**
 * The serverless path, and the things only it can get wrong.
 *
 * `api.test.mjs` runs its whole suite over this transport too
 * (`SB_TEST_TRANSPORT=serverless`), which is what proves the routes, the
 * accounting and the authorisation behave identically. This file covers what
 * that cannot show, because on a socket it cannot happen:
 *
 *  · the body has already been read by the platform;
 *  · the caller's address is in a header, and believing or not believing it
 *    decides whether the login rate limiter works at all;
 *  · the app is built once per instance and must not open a new pool per
 *    request;
 *  · the scheduler is an HTTP endpoint behind a shared secret, and a platform
 *    that gets no answer will call it again;
 *  · a misconfigured deployment must answer legibly rather than 500 with an
 *    empty body.
 *
 *   PGHOST=/tmp/sbpg PGPORT=55432 PGUSER=... PGDATABASE=... \
 *     node server/serverless.test.mjs
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { startVercelHost } from './vercelHost.mjs';

const build = '../.server-build/server/src';
const { seed } = await import(`${build}/seed.js`);
const { PgPool, connectionFromEnv } = await import(`${build}/pg.js`);
const { bodyTextOf, createServerlessHandler } = await import(`${build}/serverless.js`);

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
    throw new Error(`${what}: ${JSON.stringify(String(text).slice(0, 200))} does not match ${pattern}`);
  }
}

async function call(base, method, path, { body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text === '' ? null : JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

// --- fixture ---------------------------------------------------------------

const stamp = randomUUID().slice(0, 8);
const PASSWORD = 'serverless-test-password';
const pool = new PgPool(connectionFromEnv(process.env));
const fixture = await seed(pool, {
  name: `Serverless test society ${stamp}`,
  password: PASSWORD,
  emailDomain: `s${stamp}.invalid`,
});
const treasurer = fixture.users.find(u => u.role === 'treasurer');

const CRON_SECRET = `cron-${randomUUID()}`;

// --- the body the platform already read ------------------------------------

suite('a body the platform has already read');

await check('bodyTextOf turns every shape the runtime produces back into text', () => {
  equal(bodyTextOf(undefined), '', 'no body at all');
  equal(bodyTextOf(null), '', 'a null body');
  equal(bodyTextOf('{"a":1}'), '{"a":1}', 'text left alone');
  equal(bodyTextOf({ a: 1 }), '{"a":1}', 'a parsed object re-serialised');
  equal(bodyTextOf(Buffer.from('{"a":1}')), '{"a":1}', 'a buffer');
  equal(bodyTextOf(new Uint8Array([123, 125])), '{}', 'a byte array');
});

{
  const host = await startVercelHost({ env: { CRON_SECRET } });
  try {
    await check('a POST still reaches the handler with its body intact', async () => {
      // The stream was consumed before the handler ran. If the handler waited
      // on it, this request would hang until the test timed out rather than
      // coming back refused.
      const wrong = await call(host.base, 'POST', '/api/auth/password', {
        body: { email: treasurer.email, password: 'not-the-password' },
      });
      equal(wrong.status, 401, 'the wrong password is refused, which means the body was read');

      const right = await call(host.base, 'POST', '/api/auth/password', {
        body: { email: treasurer.email, password: PASSWORD },
      });
      equal(right.status, 200, 'and the right one signs in');
      truthy(
        (right.headers.getSetCookie?.() ?? []).some(c => /^sb_session=/.test(c)),
        'a session cookie comes back',
      );
    });

    await check('a body that is not JSON is a 400, not a crash', async () => {
      const reply = await call(host.base, 'POST', '/api/auth/password', { body: 'not json at all' });
      equal(reply.status, 400, 'refused');
      equal(reply.body.error, 'invalid_json', 'and says why');
    });

    await check('an oversized body is refused even though it was already parsed', async () => {
      // The platform has no size limit of ours; the handler has to apply its
      // own to what it was handed, not to what it read from a socket.
      const reply = await call(host.base, 'POST', '/api/auth/password', {
        body: { email: treasurer.email, password: 'x'.repeat(1_200_000) },
      });
      equal(reply.status, 413, 'too large');
    });

    await check('a GET carries the security headers and no store', async () => {
      const reply = await call(host.base, 'GET', '/api/health');
      equal(reply.status, 200, 'health answers');
      equal(reply.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
      equal(reply.headers.get('x-frame-options'), 'DENY', 'no framing');
      equal(reply.headers.get('cache-control'), 'no-store', 'nothing cached');
      truthy(reply.headers.get('x-request-id'), 'a request id to correlate the log with');
    });

    await check('an unknown path is a 404 from our router, not from the platform', async () => {
      const reply = await call(host.base, 'GET', '/api/nothing-here');
      equal(reply.status, 404, 'not found');
      equal(reply.body.error, 'not_found', 'and it is our own answer');
    });

    await check('one instance serves many requests without opening a pool each time', async () => {
      const before = await backends();
      for (let i = 0; i < 20; i += 1) {
        const reply = await call(host.base, 'GET', '/api/health');
        equal(reply.status, 200, `health ${i + 1}`);
      }
      const after = await backends();
      truthy(host.invocations >= 20, `the host really served them: ${host.invocations}`);
      // DB_POOL_MAX is 2 under VERCEL=1. A handler that rebuilt the app per
      // request would have opened twenty connections and left them open.
      truthy(
        after - before <= 2,
        `connections opened: ${after - before} (the pool's maximum is 2)`,
      );
    });
  } finally {
    await host.close();
  }
}

// --- the caller's address --------------------------------------------------

suite("the caller's address");

{
  // A small limit, so the limiter can be reached without a hundred requests.
  const host = await startVercelHost({
    env: { CRON_SECRET, RATE_LIMIT_LOGIN_PER_HOUR: '4' },
  });
  try {
    const attempt = (ip) => call(host.base, 'POST', '/api/auth/password', {
      body: { email: treasurer.email, password: 'wrong-on-purpose' },
      headers: { 'x-sb-test-ip': ip },
    });

    await check('the forwarded address is what the rate limiter counts', async () => {
      const mine = `198.18.0.${Math.floor(Math.random() * 200) + 1}`;
      let limited = false;
      for (let i = 0; i < 12 && !limited; i += 1) {
        const reply = await attempt(mine);
        if (reply.status === 429) limited = true;
      }
      truthy(limited, 'one address hammering is eventually refused');
    });

    await check('and another address is not punished for it', async () => {
      // This is the failure the forwarded header prevents: behind a proxy
      // every caller shares the proxy's socket address, so one person
      // guessing passwords would lock out the whole society.
      const reply = await attempt(`198.18.1.${Math.floor(Math.random() * 200) + 1}`);
      equal(reply.status, 401, 'a different caller is refused on the password, not rate limited');
    });
  } finally {
    await host.close();
  }
}

await check('a forwarded address is ignored when the proxy is not trusted', async () => {
  // Directly on a socket, the header is whatever the caller typed. Believing
  // it would let one caller rotate out of the rate-limit bucket at will.
  const host = await startVercelHost({
    env: { CRON_SECRET, TRUST_PROXY: 'false', RATE_LIMIT_LOGIN_PER_HOUR: '4' },
  });
  try {
    let limited = false;
    for (let i = 0; i < 12 && !limited; i += 1) {
      const reply = await call(host.base, 'POST', '/api/auth/password', {
        body: { email: treasurer.email, password: 'wrong-on-purpose' },
        // A new address every time. With the header ignored, the real socket
        // is what counts and the limiter still bites.
        headers: { 'x-sb-test-ip': `198.18.2.${i + 1}` },
      });
      if (reply.status === 429) limited = true;
    }
    truthy(limited, 'rotating the header does not escape the limiter');
  } finally {
    await host.close();
  }
});

// --- the scheduler ---------------------------------------------------------

suite('the scheduler, as an endpoint');

await check('with no secret configured, a scheduled run is refused', async () => {
  const host = await startVercelHost({ env: { CRON_SECRET: '' } });
  try {
    const reply = await call(host.base, 'GET', '/api/cron/run');
    equal(reply.status, 503, 'refused');
    equal(reply.body.error, 'cron_not_configured', 'and says the deployment, not the caller, is wrong');
    const withGuess = await call(host.base, 'GET', '/api/cron/run', {
      headers: { Authorization: 'Bearer anything-at-all' },
    });
    equal(withGuess.status, 503, 'and a guess does not open it');
  } finally {
    await host.close();
  }
});

{
  const host = await startVercelHost({ env: { CRON_SECRET } });
  const authorized = { Authorization: `Bearer ${CRON_SECRET}` };
  try {
    await check('the secret is required, and nothing else will do', async () => {
      equal((await call(host.base, 'GET', '/api/cron/run')).status, 401, 'no header');
      equal(
        (await call(host.base, 'GET', '/api/cron/run', { headers: { Authorization: 'Bearer wrong' } })).status,
        401, 'the wrong secret',
      );
      equal(
        (await call(host.base, 'GET', '/api/cron/run', { headers: { Authorization: CRON_SECRET } })).status,
        401, 'the secret without the Bearer scheme',
      );
      equal(
        (await call(host.base, 'GET', '/api/cron/status')).status,
        401, 'and the status endpoint is closed too',
      );
    });

    await check('a scheduled run needs no session and no CSRF token', async () => {
      // It is called by a scheduler, which has neither.
      const reply = await call(host.base, 'GET', '/api/cron/run', { headers: authorized });
      equal(reply.status, 200, 'it ran');
      equal(reply.body.ran, true, 'and says so');
      equal((reply.headers.getSetCookie?.() ?? []).length, 0, 'and sets no cookie');
    });

    await check('it drains a queued job and is quiet the second time', async () => {
      const runKey = `dispatch-${stamp}-${randomUUID().slice(0, 6)}`;
      await pool.query(
        `INSERT INTO scheduled_jobs (society_id, kind, run_key, scheduled_for, payload)
         VALUES ($1, 'notification-dispatch', $2, current_date, '{}'::jsonb)`,
        [fixture.societyId, runKey],
      );

      const first = await call(host.base, 'GET', '/api/cron/run', { headers: authorized });
      equal(first.status, 200, 'the pass ran');
      truthy(first.body.claimed >= 1, `it claimed the job: ${JSON.stringify(first.body)}`);
      equal(first.body.failed, 0, 'and nothing failed');

      const state = await pool.query(
        `SELECT state FROM scheduled_jobs WHERE run_key = $1`, [runKey],
      );
      equal(state.rows[0].state, 'succeeded', 'the job finished');

      const second = await call(host.base, 'GET', '/api/cron/run', { headers: authorized });
      equal(second.body.claimed, 0, 'a second call finds nothing to do');
      equal(second.body.stoppedBecause, 'queue is empty', 'and says why it stopped');
    });

    await check('a job whose invocation was killed is returned to the queue', async () => {
      // The failure this exists for: a function that exceeds its time limit is
      // killed where it stands, leaving its job 'running' with nobody working
      // on it and no error recorded.
      const runKey = `stalled-${stamp}-${randomUUID().slice(0, 6)}`;
      await pool.query(
        `INSERT INTO scheduled_jobs
           (society_id, kind, run_key, scheduled_for, payload, state, locked_by, locked_at, attempts)
         VALUES ($1, 'notification-dispatch', $2, current_date, '{}'::jsonb,
                 'running', 'cron:killed', now() - interval '45 minutes', 1)`,
        [fixture.societyId, runKey],
      );

      const reply = await call(host.base, 'GET', '/api/cron/run', { headers: authorized });
      equal(reply.status, 200, 'the pass ran');
      truthy(reply.body.requeued >= 1, `it requeued the stalled job: ${JSON.stringify(reply.body)}`);

      const after = await pool.query(
        `SELECT state, attempts::text AS attempts, last_error FROM scheduled_jobs WHERE run_key = $1`,
        [runKey],
      );
      equal(after.rows[0].state, 'succeeded', 'and then ran it in the same pass');
      // The attempt it spent before being killed is not refunded: a job that
      // times out every time must exhaust its attempts and be reported.
      truthy(Number(after.rows[0].attempts) >= 2, `the attempt was kept: ${after.rows[0].attempts}`);
      matches(after.rows[0].last_error, /stopped without finishing/, 'and it records what happened');
    });

    await check('a job still being worked on is left alone', async () => {
      const runKey = `fresh-${stamp}-${randomUUID().slice(0, 6)}`;
      await pool.query(
        `INSERT INTO scheduled_jobs
           (society_id, kind, run_key, scheduled_for, payload, state, locked_by, locked_at, attempts)
         VALUES ($1, 'notification-dispatch', $2, current_date, '{}'::jsonb,
                 'running', 'cron:in-flight', now(), 1)`,
        [fixture.societyId, runKey],
      );
      await call(host.base, 'GET', '/api/cron/run', { headers: authorized });
      const after = await pool.query(
        `SELECT state, locked_by FROM scheduled_jobs WHERE run_key = $1`, [runKey],
      );
      equal(after.rows[0].state, 'running', 'untouched');
      equal(after.rows[0].locked_by, 'cron:in-flight', 'and still held by whoever has it');
    });

    await check('the status endpoint reports the queue without running it', async () => {
      const runKey = `pending-${stamp}-${randomUUID().slice(0, 6)}`;
      await pool.query(
        `INSERT INTO scheduled_jobs (society_id, kind, run_key, scheduled_for, payload)
         VALUES ($1, 'notification-dispatch', $2, current_date, '{}'::jsonb)`,
        [fixture.societyId, runKey],
      );
      const reply = await call(host.base, 'GET', '/api/cron/status', { headers: authorized });
      equal(reply.status, 200, 'it answers');
      equal(reply.body.platform, 'vercel', 'and knows where it is running');
      const dispatch = reply.body.queue.find(q => q.kind === 'notification-dispatch');
      truthy(dispatch !== undefined && dispatch.due >= 1, `the job is reported as due: ${JSON.stringify(reply.body.queue)}`);

      const after = await pool.query(
        `SELECT state FROM scheduled_jobs WHERE run_key = $1`, [runKey],
      );
      equal(after.rows[0].state, 'pending', 'and it did not run it');
      // Tidied up, so the next suite's queue assertions are not polluted.
      await call(host.base, 'GET', '/api/cron/run', { headers: authorized });
    });
  } finally {
    await host.close();
  }
}

// --- a deployment that is wrong --------------------------------------------

suite('a deployment that is misconfigured');

await check('a missing SESSION_SECRET answers legibly, and identically every time', async () => {
  // At module scope this would be an exception the platform turns into a 500
  // with an empty body, which is the hardest kind of deployment problem to
  // diagnose. It must name the variable instead.
  const handler = createServerlessHandler(
    { NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@example.invalid/db?sslmode=require' },
    { platformReadsBody: true },
  );

  const replies = [];
  for (let i = 0; i < 2; i += 1) {
    const res = fakeResponse();
    await handler(fakeRequest('GET', '/api/health'), res.res);
    replies.push(res.read());
  }

  equal(replies[0].status, 500, 'it answers');
  equal(JSON.parse(replies[0].body).error, 'misconfigured', 'and says what kind of problem it is');
  matches(JSON.parse(replies[0].body).detail, /SESSION_SECRET/, 'and names the variable');
  equal(replies[0].body, replies[1].body, 'the second request gets the same answer, from the cache');
});

// --- plumbing for the fake request/response --------------------------------

/**
 * A request object shaped like the one the platform passes in.
 *
 * Already ended, because that is the state a serverless handler receives it
 * in — the body, if there was one, is on `req.body`.
 */
function fakeRequest(method, url, body) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  if (body !== undefined) req.body = body;
  return req;
}

function fakeResponse() {
  const chunks = [];
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    writeHead(status, extra) {
      res.statusCode = status;
      for (const [k, v] of Object.entries(extra ?? {})) headers[k.toLowerCase()] = v;
      return res;
    },
    end(chunk) { if (chunk !== undefined) chunks.push(Buffer.from(chunk)); res.finished = true; },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
  };
  return {
    res,
    read: () => ({ status: res.statusCode, headers, body: Buffer.concat(chunks).toString('utf8') }),
  };
}

/** Client backends on this database, to show the pool is not growing. */
async function backends() {
  const result = await pool.query(
    `SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend'`,
  );
  return Number(result.rows[0].n);
}

await pool.end();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
