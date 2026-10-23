#!/usr/bin/env node
/**
 * Takes a backup, restores it, and checks the books in the copy.
 *
 * A backup nobody has restored is a hypothesis. This rehearses the whole thing
 * — dump, verify the dump is readable, restore into a fresh database, then run
 * the integrity checks against the *restored* copy rather than the original.
 * Checking the original would prove nothing about the backup.
 *
 * The checks are the ones that decide whether a restored ledger is usable:
 *
 *   · every journal entry balances, and agrees with its stated totals
 *   · the trial balance ties
 *   · every receipt equals the sum of its allocations
 *   · the receivable equals the sum of what is outstanding per document
 *   · the GST register agrees with the output-tax accounts
 *   · no flat has two live documents for one period
 *   · one current owner per flat and role
 *   · the migrations all read as applied
 *   · every table has the same number of rows as the original
 *
 *   ADMIN_URL=... node scripts/verify-backup.mjs
 *   ADMIN_URL=... node scripts/verify-backup.mjs --keep   # leave the copy
 *
 * ADMIN_URL (or DIRECT_URL, or DATABASE_URL) must name a database the role may
 * dump, and the role needs CREATEDB for the restore target. Nothing is written
 * to the source database: the dump is read-only and the restore goes into a
 * new one.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './load-env.mjs';

loadEnv('.env');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// An empty value counts as unset, so `ADMIN_URL=` in a .env does not stop
// the rehearsal from using the URL that is actually configured.
const sourceUrl = [process.env.ADMIN_URL, process.env.DIRECT_URL, process.env.DATABASE_URL]
  .find(value => value !== undefined && value !== '');

if (sourceUrl === undefined || sourceUrl === '') {
  console.error(
    'No database to back up. Set ADMIN_URL, DIRECT_URL or DATABASE_URL.\n' +
    'Nothing was attempted.',
  );
  process.exit(2);
}

const keep = process.argv.includes('--keep');

/**
 * The same connection URL, pointed at another database on the same server.
 *
 * Rewritten textually rather than through `new URL`, which refuses the socket
 * form — `postgresql://user@/books?host=/tmp/sbpg` has an empty host, and the
 * rehearsal crashed on it before reporting anything. Textual rewriting keeps
 * every parameter, including the `host` that makes that form work at all.
 */
function withDatabase(url, name) {
  const query = url.indexOf('?');
  const base = query === -1 ? url : url.slice(0, query);
  const tail = query === -1 ? '' : url.slice(query);
  const afterScheme = base.includes('://') ? base.indexOf('://') + 3 : 0;
  const slash = base.indexOf('/', afterScheme);
  const authority = slash === -1 ? base : base.slice(0, slash);
  return `${authority}/${encodeURIComponent(name)}${tail}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', shell: false, maxBuffer: 256 * 1024 * 1024, ...options,
  });
  return {
    ok: (result.status ?? 1) === 0,
    out: ((result.stdout ?? '') + (result.stderr ?? '')).trim(),
    stdout: result.stdout ?? '',
  };
}

/** One value from a query, as text. */
function value(url, sql) {
  const result = run('psql', [
    url, '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
    '--set', 'ON_ERROR_STOP=1', '--command', sql,
  ]);
  if (!result.ok) throw new Error(`query failed: ${result.out}`);
  return result.stdout.trim();
}

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}
function equal(actual, expected, what) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${what}: expected ${expected}, got ${actual}`);
  }
}

const stamp = Date.now().toString(36);
const restored = `sb_restore_${stamp}`;
const workDir = mkdtempSync(join(tmpdir(), 'sb-backup-'));
const dumpFile = join(workDir, `societybooks-${stamp}.dump`);

const admin = (sql) => run('psql', [
  sourceUrl, '--no-psqlrc', '--quiet', '--set', 'ON_ERROR_STOP=1', '--command', sql,
]);

try {
  console.log('\nbackup');

  check('pg_dump produces a custom-format archive', () => {
    const dumped = run('pg_dump', [
      '--format=custom', '--no-owner', '--no-acl', `--file=${dumpFile}`, sourceUrl,
    ]);
    if (!dumped.ok) throw new Error(dumped.out);
    const size = statSync(dumpFile).size;
    if (size < 1024) throw new Error(`the archive is only ${size} bytes`);
    console.log(`       ${(size / 1024).toFixed(0)} KiB`);
  });

  check('the archive is readable, and lists the tables', () => {
    // A dump nobody can read is not a backup. This is the cheapest check that
    // says the file is intact, and it is worth running on every dump.
    const listed = run('pg_restore', ['--list', dumpFile]);
    if (!listed.ok) throw new Error(listed.out);
    for (const table of ['journal_entries', 'journal_postings', 'payments', 'billing_documents']) {
      if (!listed.stdout.includes(table)) throw new Error(`${table} is not in the archive`);
    }
  });

  console.log('\nrestore');

  check('it restores into a fresh database', () => {
    const created = admin(`CREATE DATABASE ${restored}`);
    if (!created.ok) throw new Error(created.out);
    const result = run('pg_restore', [
      '--dbname', withDatabase(sourceUrl, restored), '--no-owner', '--no-acl', dumpFile,
    ]);
    // pg_restore warns about things like missing roles and still succeeds;
    // only a failure matters, and its output is shown when it happens.
    if (!result.ok) throw new Error(result.out.slice(0, 600));
  });

  const copy = withDatabase(sourceUrl, restored);

  check('the migrations read as applied in the copy', () => {
    const applied = value(copy, 'SELECT count(*) FROM schema_migrations');
    const onDisk = run('ls', ['-1', join(root, 'server', 'migrations')]).stdout
      .split('\n').filter(name => name.endsWith('.sql')).length;
    equal(applied, onDisk, 'migrations recorded against files on disk');
  });

  check('every table has the same number of rows as the original', () => {
    const counts = (url) => value(url, `
      SELECT string_agg(entry, ',' ORDER BY entry) FROM (
        SELECT table_name || '=' || (
          xpath('/row/c/text()',
            query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
            false, true, ''))
        )[1]::text AS entry
          FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ) AS counted;`);
    const before = counts(sourceUrl);
    const after = counts(copy);
    if (before !== after) {
      const left = new Map(before.split(',').map(p => p.split('=')));
      const right = new Map(after.split(',').map(p => p.split('=')));
      const differences = [...left.entries()]
        .filter(([table, count]) => right.get(table) !== count)
        .map(([table, count]) => `${table}: ${count} then ${right.get(table) ?? 'missing'}`);
      throw new Error(differences.join('; ') || 'the sets of tables differ');
    }
  });

  console.log('\nthe books, in the restored copy');

  check('every journal entry balances and agrees with its totals', () => {
    equal(value(copy, `
      SELECT count(*) FROM (
        SELECT e.id FROM journal_entries e
          JOIN journal_postings p ON p.entry_id = e.id
         GROUP BY e.id, e.total_debit, e.total_credit
        HAVING SUM(p.debit) <> e.total_debit
            OR SUM(p.credit) <> e.total_credit
            OR SUM(p.debit) <> SUM(p.credit)
      ) AS crooked`), '0', 'entries that do not tie');
  });

  check('no entry is missing its legs', () => {
    equal(value(copy, `
      SELECT count(*) FROM journal_entries e
       WHERE NOT EXISTS (SELECT 1 FROM journal_postings p WHERE p.entry_id = e.id)`),
      '0', 'entries with no postings');
  });

  check('the trial balance ties, per society', () => {
    equal(value(copy, `
      SELECT count(*) FROM (
        SELECT society_id FROM journal_postings
         GROUP BY society_id
        HAVING SUM(debit) <> SUM(credit)
      ) AS crooked`), '0', 'societies whose books do not tie');
  });

  check('every receipt equals the sum of its allocations', () => {
    equal(value(copy, `
      SELECT count(*) FROM (
        SELECT p.id FROM payments p
          LEFT JOIN receipt_allocations a ON a.payment_id = p.id
         GROUP BY p.id, p.amount
        HAVING COALESCE(SUM(a.amount), 0) <> p.amount
      ) AS mismatched`), '0', 'payments that do not add up');
  });

  check('the receivable equals what is outstanding per document', () => {
    // The same postings, grouped by account and by document reference. Two
    // ways of adding up the same thing, which is the point.
    equal(value(copy, `
      SELECT count(*) FROM (
        SELECT p.society_id,
               SUM(p.debit - p.credit) FILTER (WHERE p.doc_ref IS NOT NULL) AS by_document,
               SUM(p.debit - p.credit) AS by_account
          FROM journal_postings p
         WHERE p.account_code = '1100'
         GROUP BY p.society_id
        HAVING COALESCE(SUM(p.debit - p.credit) FILTER (WHERE p.doc_ref IS NULL), 0) <> 0
      ) AS unreferenced`), '0', 'receivable postings with no document reference');
  });

  check('the GST register agrees with the output-tax accounts', () => {
    equal(value(copy, `
      WITH register AS (
        SELECT society_id,
               SUM(CASE WHEN entry_kind = 'credit-note' THEN -cgst ELSE cgst END) AS cgst,
               SUM(CASE WHEN entry_kind = 'credit-note' THEN -sgst ELSE sgst END) AS sgst
          FROM gst_register GROUP BY society_id
      ), ledger AS (
        SELECT society_id,
               SUM(CASE WHEN account_code = '2200' THEN credit - debit ELSE 0 END) AS cgst,
               SUM(CASE WHEN account_code = '2201' THEN credit - debit ELSE 0 END) AS sgst
          FROM journal_postings
         WHERE account_code IN ('2200','2201')
         GROUP BY society_id
      )
      SELECT count(*) FROM register r
        FULL JOIN ledger l ON l.society_id = r.society_id
       WHERE COALESCE(r.cgst, 0) <> COALESCE(l.cgst, 0)
          OR COALESCE(r.sgst, 0) <> COALESCE(l.sgst, 0)`),
      '0', 'societies where the register and the ledger disagree');
  });

  check('no flat has two live documents for one period', () => {
    equal(value(copy, `
      SELECT count(*) FROM (
        SELECT society_id, flat_id, period FROM billing_documents
         WHERE state <> 'cancelled'
         GROUP BY society_id, flat_id, period HAVING count(*) > 1
      ) AS duplicated`), '0', 'duplicate live documents');
  });

  check('one current owner per flat and role', () => {
    equal(value(copy, `
      SELECT count(*) FROM (
        SELECT flat_id, role FROM flat_ownership
         WHERE held_until IS NULL
         GROUP BY flat_id, role HAVING count(*) > 1
      ) AS overlapping`), '0', 'flats with two current holders of one role');
  });

  check('a booked vendor bill still nets to its payable', () => {
    equal(value(copy, `
      SELECT count(*) FROM vendor_bills
       WHERE net_payable <> gross - tds_amount`), '0', 'bills whose arithmetic drifted');
  });

  check('nothing claims a delivery with no evidence', () => {
    equal(value(copy, `
      SELECT count(*) FROM notifications
       WHERE state = 'sent'
         AND (provider IS NULL OR provider_message_id IS NULL OR sent_at IS NULL)`),
      '0', 'notifications marked sent with nothing to show for it');
  });

  check('the constraints and triggers came across with the data', () => {
    // A restore that drops the deferred triggers would look fine until the
    // first unbalanced entry. This counts the ones the invariants depend on.
    const triggers = value(copy, `
      SELECT count(*) FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgname IN ('journal_postings_balance', 'journal_entries_have_legs',
                        'journal_postings_control_party', 'journal_entries_period_open',
                        'receipt_allocations_cover_payment', 'payments_are_allocated')`);
    if (Number(triggers) < 4) {
      throw new Error(`only ${triggers} of the integrity triggers are present`);
    }
    const rules = value(copy, `
      SELECT count(*) FROM pg_rules
       WHERE schemaname = 'public' AND rulename LIKE '%no_delete'`);
    if (Number(rules) < 5) throw new Error(`only ${rules} delete-blocking rules are present`);
  });

  check('and a journal entry still cannot be deleted in the copy', () => {
    const before = value(copy, 'SELECT count(*) FROM journal_entries');
    run('psql', [copy, '--no-psqlrc', '--quiet', '--command', 'DELETE FROM journal_entries']);
    equal(value(copy, 'SELECT count(*) FROM journal_entries'), before, 'entries after a DELETE');
  });
} finally {
  if (!keep) {
    admin(`DROP DATABASE IF EXISTS ${restored}`);
    rmSync(workDir, { recursive: true, force: true });
  } else {
    console.log(`\nkept: database ${restored}, archive ${dumpFile}`);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
console.log('The backup restores, and the books in the restored copy are sound.');
