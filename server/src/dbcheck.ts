/**
 * Connectivity check.
 *
 * Run this first, with the credentials in place. It answers the questions that
 * decide whether anything else will work, and it answers them by connecting
 * rather than by reading the configuration:
 *
 *   · can this process reach the database at all
 *   · is the connection encrypted, and with what
 *   · how did it authenticate
 *   · which server, which database, which user
 *   · is the application's URL a pooled endpoint, and is the migration URL a
 *     direct one — the wrong way round is the mistake worth catching early
 *   · which migrations are applied
 *
 * It prints no password and no connection string. On failure it says which
 * variable it used and what the server or the network said, because "could not
 * connect" on its own sends people to the wrong place.
 *
 *   node .server-build/server/src/dbcheck.js
 */

import { PgPool, connectionFromEnv, describeConnection, looksPooled, PgError } from './pg';

interface Outcome {
  readonly which: 'DATABASE_URL' | 'DIRECT_URL';
  readonly ok: boolean;
  readonly detail: Record<string, unknown>;
}

async function check(which: 'DATABASE_URL' | 'DIRECT_URL'): Promise<Outcome> {
  const options = connectionFromEnv(process.env, which);
  const described = describeConnection(options);
  const pool = new PgPool(options, 1);

  try {
    const result = await pool.query<{
      version: string; database: string; user: string; ssl: string | null;
    }>(
      `SELECT version() AS version, current_database() AS database, current_user AS user,
              (SELECT setting FROM pg_settings WHERE name = 'ssl') AS ssl`,
    );
    const row = result.rows[0];
    const security = pool.connectionSecurity;

    let migrations: string[] = [];
    let migrationsError: string | null = null;
    try {
      const applied = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      migrations = applied.rows.map(r => r.version);
    } catch (err) {
      // A database with no schema yet is the normal state before the first
      // migration, and saying so is more use than an error.
      migrationsError = err instanceof PgError && err.code === '42P01'
        ? 'no schema_migrations table yet — nothing has been migrated'
        : (err instanceof Error ? err.message : String(err));
    }

    return {
      which,
      ok: true,
      detail: {
        ...described,
        encrypted: security?.encrypted ?? false,
        cipher: security?.cipher ?? null,
        authMechanism: security?.authMechanism ?? null,
        serverVersion: (row?.version ?? '').split(' ').slice(0, 2).join(' '),
        database: row?.database ?? null,
        user: row?.user ?? null,
        serverSslEnabled: row?.ssl ?? 'unknown',
        migrations,
        ...(migrationsError === null ? {} : { migrationsNote: migrationsError }),
      },
    };
  } catch (err) {
    return {
      which,
      ok: false,
      detail: {
        ...described,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof PgError && err.code !== undefined ? { sqlState: err.code } : {}),
      },
    };
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const configured = {
    DATABASE_URL: (process.env.DATABASE_URL ?? '') !== '',
    DIRECT_URL: (process.env.DIRECT_URL ?? '') !== '',
    PGHOST: (process.env.PGHOST ?? '') !== '',
  };

  if (!configured.DATABASE_URL && !configured.PGHOST) {
    console.error(
      'No database is configured.\n\n' +
      'Set DATABASE_URL (and DIRECT_URL for migrations) in the environment, or in a .env\n' +
      'file loaded by whatever runs this process. See .env.example and docs/NEON.md for\n' +
      'exactly which value goes where. Nothing was attempted: there is nowhere to connect.',
    );
    process.exit(2);
  }

  const outcomes: Outcome[] = [await check('DATABASE_URL')];
  if (configured.DIRECT_URL) outcomes.push(await check('DIRECT_URL'));

  for (const outcome of outcomes) {
    const label = outcome.which === 'DIRECT_URL'
      ? 'DIRECT_URL (migrations)'
      : 'DATABASE_URL (application queries)';
    console.log(`\n${label}`);
    console.log(`  ${outcome.ok ? 'connected' : 'FAILED'}`);
    for (const [key, value] of Object.entries(outcome.detail)) {
      console.log(`    ${key.padEnd(20)} ${Array.isArray(value) ? value.join(', ') || '(none)' : String(value)}`);
    }
  }

  // The advice, rather than a verdict: both of these are configurations that
  // work and are not what a provider recommends, so they are warnings.
  const app = connectionFromEnv(process.env, 'DATABASE_URL');
  const direct = connectionFromEnv(process.env, 'DIRECT_URL');
  const notes: string[] = [];

  if (!configured.DIRECT_URL) {
    notes.push(
      'DIRECT_URL is not set, so migrations would run over DATABASE_URL. If that is a ' +
      'pooled endpoint, set DIRECT_URL to the direct one: a pooler does not hold the ' +
      'session-level locks a migration takes.',
    );
  }
  if (!looksPooled(app.host) && looksPooled(direct.host)) {
    notes.push(
      'The two look the wrong way round: DATABASE_URL is a direct endpoint and DIRECT_URL ' +
      'is a pooled one. The application wants the pooled endpoint; migrations want the ' +
      'direct one.',
    );
  }
  if (configured.DIRECT_URL && looksPooled(direct.host)) {
    notes.push('DIRECT_URL points at what looks like a pooled endpoint.');
  }
  for (const outcome of outcomes) {
    // A unix socket never leaves the machine, so there is nothing to encrypt
    // and nothing to warn about.
    const overSocket = String(outcome.detail.host ?? '').startsWith('/');
    if (outcome.ok && outcome.detail.encrypted === false && !overSocket) {
      notes.push(
        `${outcome.which} connected without encryption. For anything but a local socket ` +
        'that is a password and a ledger crossing the network in the clear — set ' +
        'sslmode=verify-full.',
      );
    }
  }

  if (notes.length > 0) {
    console.log('\nnotes');
    for (const note of notes) console.log(`  · ${note}`);
  }

  const failed = outcomes.filter(o => !o.ok);
  if (failed.length > 0) {
    console.log(
      `\n${failed.length} of ${outcomes.length} connections failed. Nothing has been ` +
      'migrated or started.',
    );
    process.exit(1);
  }
  console.log('\nAll configured connections work.');
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
