#!/usr/bin/env node
/**
 * Tests for the PostgreSQL wire-protocol client.
 *
 * Everything else in the backend sits on this, so it is tested first and
 * directly: real connection, real transactions, real parameter binding,
 * against a real server.
 */

import { randomUUID } from 'node:crypto';
import { PgPool, PgConnection, connectionFromEnv, PgError } from '../.server-build/server/src/pg.js';

let passed = 0;
const failures = [];
let suiteName = '';
const suite = (n) => { suiteName = n; console.log(`\n${n}`); };
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) {
    failures.push(`${suiteName} / ${name}\n       ${err.message}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}
const eq = (got, want, what = 'value') => {
  const a = JSON.stringify(got); const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
};
const truthy = (c, what) => { if (!c) throw new Error(`expected ${what}`); };
async function throwsAsync(fn, matching, what) {
  try { await fn(); } catch (err) {
    const m = err.message ?? String(err);
    const ok = typeof matching === 'string' ? m.includes(matching) : matching.test(m);
    if (!ok) throw new Error(`${what}: threw with "${m}"`);
    return err;
  }
  throw new Error(`${what}: expected a throw`);
}

const options = connectionFromEnv(process.env);
const pool = new PgPool(options, 4);

suite('Connecting and querying');

await check('a connection can be opened and a value read back', async () => {
  const r = await pool.query('SELECT 1 AS one');
  eq(r.rows, [{ one: '1' }], 'rows');
  eq(r.fields, ['one'], 'fields');
});

await check('several columns and types come back as text', async () => {
  const r = await pool.query(
    "SELECT 42 AS n, 'hello' AS s, true AS b, NULL::text AS nothing, now()::date AS d",
  );
  eq(r.rows[0].n, '42', 'integer');
  eq(r.rows[0].s, 'hello', 'text');
  eq(r.rows[0].b, 't', 'boolean');
  eq(r.rows[0].nothing, null, 'null');
  truthy(/^\d{4}-\d{2}-\d{2}$/.test(r.rows[0].d), `date as ISO, got ${r.rows[0].d}`);
});

await check('a multi-row result is fully read', async () => {
  const r = await pool.query('SELECT generate_series(1, 500) AS i');
  eq(r.rows.length, 500, 'row count');
  eq(r.rows[0].i, '1', 'first');
  eq(r.rows[499].i, '500', 'last');
});

await check('a large value spanning TCP chunks is reassembled', async () => {
  // Far bigger than one packet, which is where a naive reader breaks.
  const r = await pool.query("SELECT repeat('x', 500000) AS big");
  eq(r.rows[0].big.length, 500000, 'length');
});

suite('Parameters are bound, never interpolated');

await check('a parameter is passed separately', async () => {
  const r = await pool.query('SELECT $1::int + $2::int AS sum', [2, 3]);
  eq(r.rows[0].sum, '5', 'sum');
});

await check('a value that looks like SQL stays a value', async () => {
  const hostile = "'; DROP TABLE societies; --";
  const r = await pool.query('SELECT $1::text AS v', [hostile]);
  eq(r.rows[0].v, hostile, 'the string came back intact');
  // And the table is still there.
  const still = await pool.query(
    "SELECT to_regclass('public.societies') IS NOT NULL AS alive",
  );
  eq(still.rows[0].alive, 't', 'societies survived');
});

await check('null, boolean and number parameters round-trip', async () => {
  const r = await pool.query(
    'SELECT $1::text AS a, $2::boolean AS b, $3::bigint AS c',
    [null, true, 9007199254740993n.toString()],
  );
  eq(r.rows[0].a, null, 'null');
  eq(r.rows[0].b, 't', 'boolean');
  eq(r.rows[0].c, '9007199254740993', 'bigint beyond float precision');
});

await check('a unicode parameter round-trips', async () => {
  const r = await pool.query('SELECT $1::text AS v', ['₹4.50 — मणि विस्टा']);
  eq(r.rows[0].v, '₹4.50 — मणि विस्टा', 'utf8');
});

suite('Errors');

await check('a SQL error throws with its code and constraint', async () => {
  const err = await throwsAsync(
    () => pool.query('SELECT * FROM table_that_does_not_exist'),
    /does not exist/, 'unknown table',
  );
  eq(err.code, '42P01', 'SQLSTATE for undefined_table');
});

await check('a constraint violation reports the constraint name', async () => {
  const err = await throwsAsync(
    () => pool.query(
      "INSERT INTO societies (id, name, mode) VALUES (gen_random_uuid(), 'x', 'staging')",
    ),
    /violates check constraint/, 'bad mode',
  );
  eq(err.code, '23514', 'SQLSTATE for check_violation');
  truthy(err.constraint !== undefined, 'the constraint name is attached');
});

await check('the connection survives an error and keeps working', async () => {
  await throwsAsync(() => pool.query('SELECT bad_function()'), /does not exist/, 'bad call');
  const r = await pool.query('SELECT 7 AS n');
  eq(r.rows[0].n, '7', 'still usable');
});

await check('parameters are not included in the error message', async () => {
  const secret = 'super-secret-value-9f3a';
  const err = await throwsAsync(
    () => pool.query('INSERT INTO no_such_table (v) VALUES ($1)', [secret]),
    /does not exist/, 'insert into nothing',
  );
  truthy(!err.message.includes(secret), 'the parameter must not appear in the message');
});

suite('Transactions are atomic');

/**
 * Fresh ids for every run.
 *
 * Fixed ids made this suite collide with its own history: a run that failed
 * part way left committed rows, and the next run failed on a duplicate key
 * instead of on its subject. Journal entries cannot be deleted at all — a SQL
 * rule makes DELETE a no-op, by design — so cleaning up afterwards is not an
 * option either. Unique ids per run is.
 */
const RUN = randomUUID().slice(0, 8);
const SOC = randomUUID();
const key = (name) => `${name}-${RUN}`;

await check('a committed transaction persists', async () => {
  await pool.transaction(async (tx) => {
    await tx.query(
      'INSERT INTO societies (id, name, mode) VALUES ($1, $2, $3)',
      [SOC, 'Tx Test', 'demo'],
    );
  });
  const r = await pool.query('SELECT name FROM societies WHERE id = $1', [SOC]);
  eq(r.rows[0]?.name, 'Tx Test', 'row is there');
});

await check('a thrown body rolls everything back', async () => {
  const other = randomUUID();
  await throwsAsync(
    () => pool.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO societies (id, name, mode) VALUES ($1, $2, $3)',
        [other, 'Rolled Back', 'demo'],
      );
      // Prove the row exists inside the transaction.
      const inside = await tx.query('SELECT count(*) AS n FROM societies WHERE id = $1', [other]);
      if (inside.rows[0].n !== '1') throw new Error('row not visible inside its own transaction');
      throw new Error('deliberate failure');
    }),
    'deliberate failure', 'the body threw',
  );
  const after = await pool.query('SELECT count(*) AS n FROM societies WHERE id = $1', [other]);
  eq(after.rows[0].n, '0', 'nothing was left behind');
});

await check('a deferred constraint failure fails the whole COMMIT', async () => {
  // An entry whose legs do not balance: the trigger fires at COMMIT, so the
  // statements all succeed and the transaction still fails as a unit.
  const entry = randomUUID();
  await pool.query(
    `INSERT INTO accounts (society_id, code, name, class, grp, is_cash, control)
     VALUES ($1,'1000','Bank','asset','Cash',true,NULL),
            ($1,'4000','Income','income','Inc',false,NULL)
     ON CONFLICT DO NOTHING`, [SOC],
  );
  await throwsAsync(
    () => pool.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO journal_entries
           (id, society_id, entry_ref, entry_date, narration, source_kind,
            idempotency_key, posted_by_label, total_debit, total_credit)
         VALUES ($1,$2,$3,'2026-07-01','x','manual',$4,'test',100000,100000)`,
        [entry, SOC, key('JE-TX'), key('tx-key')],
      );
      await tx.query(
        `INSERT INTO journal_postings (entry_id, society_id, account_code, debit, credit)
         VALUES ($1,$2,'1000',100000,0), ($1,$2,'4000',0,90000)`,
        [entry, SOC],
      );
      // Both inserts succeed; the imbalance is only caught at COMMIT.
    }),
    /does not balance/, 'unbalanced entry at commit',
  );
  const left = await pool.query('SELECT count(*) AS n FROM journal_entries WHERE id = $1', [entry]);
  eq(left.rows[0].n, '0', 'the entry was not left behind');
});

await check('a balanced entry commits', async () => {
  const entry = randomUUID();
  await pool.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO journal_entries
         (id, society_id, entry_ref, entry_date, narration, source_kind,
          idempotency_key, posted_by_label, total_debit, total_credit)
       VALUES ($1,$2,$3,'2026-07-01','ok','manual',$4,'test',100000,100000)`,
      [entry, SOC, key('JE-OK'), key('tx-ok')],
    );
    await tx.query(
      `INSERT INTO journal_postings (entry_id, society_id, account_code, debit, credit)
       VALUES ($1,$2,'1000',100000,0), ($1,$2,'4000',0,100000)`,
      [entry, SOC],
    );
  });
  const r = await pool.query('SELECT count(*) AS n FROM journal_entries WHERE id = $1', [entry]);
  eq(r.rows[0].n, '1', 'committed');
});

await check('two transactions do not see each other before commit', async () => {
  const a = randomUUID();
  let sawInside = null;
  await pool.transaction(async (tx) => {
    await tx.query('INSERT INTO societies (id, name, mode) VALUES ($1,$2,$3)', [a, 'Iso', 'demo']);
    // A separate pooled connection must not see the uncommitted row.
    const outside = await pool.query('SELECT count(*) AS n FROM societies WHERE id = $1', [a]);
    sawInside = outside.rows[0].n;
  });
  eq(sawInside, '0', 'the other connection saw nothing uncommitted');
  const after = await pool.query('SELECT count(*) AS n FROM societies WHERE id = $1', [a]);
  eq(after.rows[0].n, '1', 'and sees it once committed');
  await pool.query('DELETE FROM societies WHERE id = $1', [a]);
});

suite('The pool');

await check('concurrent queries all succeed', async () => {
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) => pool.query('SELECT $1::int AS i', [i])),
  );
  eq(results.length, 40, 'all returned');
  for (const [i, r] of results.entries()) eq(r.rows[0].i, String(i), `result ${i}`);
});

await check('more concurrent work than the pool size is queued, not dropped', async () => {
  const results = await Promise.all(
    Array.from({ length: 30 }, () => pool.query('SELECT pg_sleep(0.01), 1 AS ok')),
  );
  truthy(results.every(r => r.rows[0].ok === '1'), 'every query completed');
});

await check('the pool reports its own state', async () => {
  const s = pool.stats;
  truthy(typeof s.idle === 'number' && typeof s.borrowed === 'number', 'stats are numbers');
});

suite('Connection options');

await check('PG* environment variables are read', () => {
  const o = connectionFromEnv({
    PGHOST: '/tmp/x', PGPORT: '6000', PGUSER: 'u', PGDATABASE: 'd',
  });
  eq(o.host, '/tmp/x', 'host');
  eq(o.port, 6000, 'port');
  eq(o.user, 'u', 'user');
  eq(o.database, 'd', 'database');
});

await check('a DATABASE_URL is parsed, including a socket host', () => {
  const o = connectionFromEnv({
    DATABASE_URL: 'postgresql://bob:pw@localhost:5433/books',
  });
  eq(o.user, 'bob', 'user');
  eq(o.password, 'pw', 'password');
  eq(o.database, 'books', 'database');
  eq(o.port, 5433, 'port');

  const sock = connectionFromEnv({
    DATABASE_URL: 'postgresql://bob@/books?host=/var/run/postgresql',
  });
  eq(sock.host, '/var/run/postgresql', 'socket directory from the host parameter');
});

await check('a connection to nowhere fails with a clear message, not a hang', async () => {
  const bad = new PgConnection({
    host: '/tmp/definitely-not-a-socket-dir', port: 1, user: 'x', database: 'y',
    connectTimeoutMs: 1500,
  });
  await throwsAsync(() => bad.connect(), /ENOENT|timed out|connect/, 'bad socket');
});

// --- cleanup --------------------------------------------------------------
//
// Journal entries and postings cannot be deleted — a SQL rule makes DELETE a
// no-op, which is the point of an audit trail — and societies they reference
// are ON DELETE RESTRICT. So this run's rows stay in the test database, under
// ids unique to this run. Nothing to clean up, and nothing that collides with
// the next run.

await pool.end();

console.log('\n' + '='.repeat(66));
if (failures.length === 0) {
  console.log(`ALL ${passed} POSTGRES CLIENT CHECKS PASSED (real server, real transactions)`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(66));
void PgError;
