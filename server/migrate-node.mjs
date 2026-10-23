#!/usr/bin/env node
/**
 * The migration runner, without psql.
 *
 * `migrate.mjs` drives psql, which is the right tool when it is there: it is
 * the reference implementation of the client, and its errors are the ones the
 * database's own documentation describes. But a deployment whose only moving
 * parts are Vercel and Neon has nowhere to run psql — the build image does not
 * carry it, a serverless function must not run migrations at all, and a
 * developer on Windows or a fresh Mac may not have it either.
 *
 * So this runs the same files, with the same bookkeeping, over this project's
 * own PostgreSQL client. Deliberately the same:
 *
 *  · the same directory, in the same lexical order;
 *  · the same `schema_migrations` table, with the same 16-character checksum,
 *    so the two runners read each other's work and `verify` means the same
 *    thing whichever applied it;
 *  · each file as one simple query, because each file opens its own
 *    BEGIN/COMMIT — a failure leaves nothing behind;
 *  · the same refusal to continue when an applied migration's file has been
 *    edited since.
 *
 * Added, because this one knows it may be run from two places at once: a
 * session-level advisory lock for the whole run. Two deploys racing would
 * otherwise both see the same migration as pending and both try to apply it.
 *
 *   DIRECT_URL=... node server/migrate-node.mjs          # apply
 *   DIRECT_URL=... node server/migrate-node.mjs status
 *   DIRECT_URL=... node server/migrate-node.mjs verify
 *
 * It uses DIRECT_URL in preference to DATABASE_URL: a migration takes locks
 * that a connection pooler in transaction mode cannot hold.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../scripts/load-env.mjs';

loadEnv('.env');

const build = '../.server-build/server/src';
const { PgConnection, connectionFromEnv, looksPooled, describeConnection } =
  await import(`${build}/pg.js`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'server', 'migrations');

const checksum = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter(name => name.endsWith('.sql'))
    .sort()
    .map(name => {
      const text = readFileSync(join(migrationsDir, name), 'utf8');
      return { name, text, checksum: checksum(text) };
    });
}

const command = process.argv[2] ?? 'up';
if (!['up', 'status', 'verify'].includes(command)) {
  console.error(`Unknown command "${command}". Use up, status or verify.`);
  process.exit(2);
}

const files = migrationFiles();
if (files.length === 0) {
  console.error(`No .sql files in ${migrationsDir}`);
  process.exit(2);
}

const options = connectionFromEnv(process.env, 'DIRECT_URL');
const described = describeConnection(options);
if (looksPooled(String(described.host ?? ''))) {
  console.error(
    `${described.host} looks like a pooled endpoint. Migrations need the direct one: set ` +
    'DIRECT_URL to the connection string without "-pooler" in the hostname. A pooler in ' +
    'transaction mode cannot hold the locks a migration takes.',
  );
  process.exit(2);
}

const connection = new PgConnection(options);
try {
  await connection.connect();
} catch (err) {
  console.error(`Could not reach the database: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`(host ${described.host}, database ${described.database}, user ${described.user})`);
  process.exit(2);
}

let locked = false;
let exitCode = 0;

try {
  if (command === 'up') {
    // Session-level, held for the whole run and released when the connection
    // closes — including if this process is killed.
    await connection.query("SELECT pg_advisory_lock(hashtext('societybooks:migrate')::bigint)");
    locked = true;
  }

  const exists = await connection.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  const have = new Map();
  if (exists.rows[0]?.present === 't' || exists.rows[0]?.present === true) {
    const rows = await connection.query(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    for (const row of rows.rows) have.set(row.version, row.checksum);
  }

  if (command === 'status' || command === 'verify') {
    let drift = 0;
    for (const file of files) {
      const seen = have.get(file.name);
      if (seen === undefined) {
        console.log(`pending   ${file.name}`);
      } else if (seen !== file.checksum) {
        console.log(`CHANGED   ${file.name}  (applied ${seen}, file now ${file.checksum})`);
        drift += 1;
      } else {
        console.log(`applied   ${file.name}  ${file.checksum}`);
      }
    }
    if (drift > 0) {
      console.error(
        `\n${drift} applied migration(s) have been edited since they ran. ` +
        'Add a new migration instead of changing an applied one.',
      );
      exitCode = 1;
    }
  } else {
    let appliedNow = 0;
    for (const file of files) {
      const seen = have.get(file.name);
      if (seen !== undefined) {
        if (seen !== file.checksum) {
          console.error(
            `${file.name} was applied with checksum ${seen} but the file is now ` +
            `${file.checksum}. Refusing to continue: add a new migration rather than ` +
            'editing an applied one.',
          );
          exitCode = 1;
          break;
        }
        continue;
      }

      process.stdout.write(`applying  ${file.name} ... `);
      try {
        // A simple query, because the file contains several statements and its
        // own transaction. The extended protocol allows only one statement.
        await connection.simple(file.text);
      } catch (err) {
        console.log('FAILED');
        console.error(err instanceof Error ? err.message : String(err));
        exitCode = 1;
        break;
      }
      await connection.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [file.name, file.checksum],
      );
      console.log('ok');
      appliedNow += 1;
    }

    if (exitCode === 0) {
      console.log(appliedNow === 0
        ? 'Nothing to apply; the schema is up to date.'
        : `Applied ${appliedNow} migration(s).`);
    }
  }
} finally {
  if (locked) {
    try {
      await connection.query("SELECT pg_advisory_unlock(hashtext('societybooks:migrate')::bigint)");
    } catch { /* closing the connection releases it anyway */ }
  }
  await connection.close();
}

process.exit(exitCode);
