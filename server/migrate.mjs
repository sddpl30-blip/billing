#!/usr/bin/env node
/**
 * The migration runner.
 *
 * Applies every .sql file in migrations/ in filename order, once, inside a
 * transaction, recording a checksum. A migration whose content has changed
 * since it was applied is refused rather than re-run: editing an applied
 * migration is how two deployments end up with different schemas and the same
 * version number.
 *
 * Talks to Postgres through psql rather than a driver, because this
 * environment has no npm registry and so no `pg`. The SQL and the ordering are
 * what is being proved; swapping psql for `pg` is a change to one function.
 *
 *   node server/migrate.mjs            # apply what is pending
 *   node server/migrate.mjs status     # list applied and pending
 *   node server/migrate.mjs verify     # check checksums only
 *
 * Connection comes from DIRECT_URL, or DATABASE_URL, or the PG* variables —
 * in that order. DIRECT_URL first because a migration takes session-level
 * locks that a connection pooler does not hold: against a pooled endpoint a
 * migration can appear to succeed while another connection is mid-statement.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../scripts/load-env.mjs';

// So `node server/migrate.mjs` works with the credentials in .env, as the
// rest of the tooling does.
loadEnv('.env', { quiet: false });

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

/**
 * The connection arguments for psql.
 *
 * A URL where one is configured, so a hosted database works without the PG*
 * variables being set as well — and `sslmode` in that URL is honoured by psql
 * itself. `which` decides between the pooled URL the application uses and the
 * direct one a migration wants.
 *
 * The URL carries the password, so it is passed as an argument to psql and
 * never printed: every caller here logs the command's output, not its
 * arguments.
 */
function connectionArgs(which = 'DATABASE_URL') {
  // An empty value counts as unset. `DIRECT_URL=` with nothing after it is a
  // normal thing to find in a .env copied from the example, and taking it
  // literally meant psql got no connection argument at all and fell back to
  // the local default socket — a migration run against the wrong database,
  // reported as success.
  const candidates = which === 'DIRECT_URL'
    ? [process.env.DIRECT_URL, process.env.DATABASE_URL]
    : [process.env.DATABASE_URL];
  const url = candidates.find(value => value !== undefined && value !== '');
  return url === undefined ? [] : [url];
}

/** Runs SQL through psql and returns { ok, out }. */
function sql(text, { file = false } = {}) {
  const args = [
    ...connectionArgs('DIRECT_URL'),
    '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
    '--set', 'ON_ERROR_STOP=1',
  ];
  if (file) args.push('--file', text);
  else args.push('--command', text);

  const result = spawnSync('psql', args, { encoding: 'utf8', shell: false });
  if (result.error) {
    return { ok: false, out: `psql could not be run: ${result.error.message}` };
  }
  return {
    ok: result.status === 0,
    out: ((result.stdout ?? '') + (result.stderr ?? '')).trim(),
  };
}

const checksum = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter(n => n.endsWith('.sql'))
    .sort()
    .map(name => {
      const text = readFileSync(join(migrationsDir, name), 'utf8');
      return { name, path: join(migrationsDir, name), text, checksum: checksum(text) };
    });
}

/** The applied set, or null when the tracking table does not exist yet. */
function applied() {
  const exists = sql(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL;",
  );
  if (!exists.ok) {
    console.error(`Could not reach the database:\n${exists.out}`);
    process.exit(2);
  }
  if (exists.out.trim() !== 't') return null;
  // chr(9) rather than a '\t' escape: inside a SQL string literal with
  // standard_conforming_strings on, backslash-t is two characters, not a tab —
  // so the split below silently never matched and every applied migration read
  // as pending.
  const rows = sql('SELECT version || chr(9) || checksum FROM schema_migrations ORDER BY version;');
  if (!rows.ok) {
    console.error(rows.out);
    process.exit(2);
  }
  const map = new Map();
  for (const line of rows.out.split('\n').filter(l => l.trim() !== '')) {
    const [version, sum] = line.split('\t');
    map.set(version, sum);
  }
  return map;
}

const command = process.argv[2] ?? 'up';
const files = migrationFiles();
if (files.length === 0) {
  console.error(`No .sql files in ${migrationsDir}`);
  process.exit(2);
}

const have = applied();

if (command === 'status' || command === 'verify') {
  let drift = 0;
  for (const f of files) {
    const seen = have?.get(f.name);
    if (seen === undefined) {
      console.log(`pending   ${f.name}`);
    } else if (seen !== f.checksum) {
      console.log(`CHANGED   ${f.name}  (applied ${seen}, file now ${f.checksum})`);
      drift++;
    } else {
      console.log(`applied   ${f.name}  ${f.checksum}`);
    }
  }
  if (drift > 0) {
    console.error(
      `\n${drift} applied migration(s) have been edited since they ran. ` +
      `Add a new migration instead of changing an applied one.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (command !== 'up') {
  console.error(`Unknown command "${command}". Use up, status or verify.`);
  process.exit(2);
}

let appliedNow = 0;
for (const f of files) {
  const seen = have?.get(f.name);
  if (seen !== undefined) {
    if (seen !== f.checksum) {
      console.error(
        `${f.name} was applied with checksum ${seen} but the file is now ${f.checksum}. ` +
        `Refusing to continue: add a new migration rather than editing an applied one.`,
      );
      process.exit(1);
    }
    continue;
  }

  process.stdout.write(`applying  ${f.name} ... `);
  // Each file opens its own BEGIN/COMMIT, so a failure leaves nothing behind.
  const run = sql(f.path, { file: true });
  if (!run.ok) {
    console.log('FAILED');
    console.error(run.out);
    process.exit(1);
  }
  const record = sql(
    `INSERT INTO schema_migrations (version, checksum) VALUES ('${f.name}', '${f.checksum}');`,
  );
  if (!record.ok) {
    console.log('FAILED to record');
    console.error(record.out);
    process.exit(1);
  }
  console.log('ok');
  appliedNow++;
}

console.log(appliedNow === 0 ? 'Nothing to apply; the schema is up to date.' : `Applied ${appliedNow} migration(s).`);
