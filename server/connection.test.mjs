#!/usr/bin/env node
/**
 * The database connection: URL parsing, TLS, and SCRAM authentication.
 *
 * Two halves. The first is pure — connection strings in, options out — and
 * runs anywhere. The second connects, and needs a PostgreSQL that behaves like
 * a hosted one: TLS on, SCRAM passwords, over TCP. Without one it says which
 * variable to set and skips, rather than passing quietly.
 *
 * Why this exists: a managed PostgreSQL (Neon, RDS, Supabase) refuses a
 * connection that is not encrypted and authenticates with SCRAM-SHA-256. This
 * client had neither until the two were added, so these are the checks that
 * say whether it can talk to one at all.
 *
 *   TEST_TLS_URL='postgresql://user:pass@host:5432/db?sslmode=require' \
 *     node server/connection.test.mjs
 */

const build = '../.server-build/server/src';
const { connectionFromEnv, describeConnection, looksPooled, PgPool, PgError } =
  await import(`${build}/pg.js`);

let passed = 0;
let skipped = 0;
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
const skip = (name, why) => { skipped++; console.log(`  skip ${name} — ${why}`); };

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

// --- connection strings -----------------------------------------------------

suite('connection strings');

await check('a hosted URL is parsed, with its TLS parameters', async () => {
  const options = connectionFromEnv({
    DATABASE_URL:
      'postgresql://books_owner:a-password@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/societybooks?sslmode=require&channel_binding=require',
  });
  equal(options.host, 'ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech', 'host');
  equal(options.port, 5432, 'the default port');
  equal(options.user, 'books_owner', 'user');
  equal(options.database, 'societybooks', 'database');
  equal(options.password, 'a-password', 'password');
  equal(options.sslMode, 'require', 'sslMode');
  equal(options.channelBinding, 'require', 'channelBinding');
});

await check('TLS defaults to prefer over TCP and disable over a socket', async () => {
  equal(
    connectionFromEnv({ DATABASE_URL: 'postgresql://u:p@db.example.org/books' }).sslMode,
    'prefer',
    'no sslmode, over TCP',
  );
  equal(
    connectionFromEnv({
      DATABASE_URL: 'postgresql://u@/books?host=/var/run/postgresql',
    }).sslMode,
    undefined,
    'a unix socket URL leaves it unset, and the client disables it',
  );
  equal(
    describeConnection(connectionFromEnv({ PGHOST: '/var/run/postgresql', PGUSER: 'u', PGDATABASE: 'b' })).sslMode,
    'disable',
    'what an operator is told about a socket connection',
  );
});

await check('a password with URL-escaped characters survives', async () => {
  // A generated password routinely contains these, and getting it wrong looks
  // exactly like a wrong password.
  const options = connectionFromEnv({
    DATABASE_URL: 'postgresql://user:p%40ss%2Fword%3A1@db.example.org:6543/books?sslmode=require',
  });
  equal(options.password, 'p@ss/word:1', 'password');
  equal(options.port, 6543, 'port');
});

await check('the unix socket form parses, which WHATWG URL alone rejects', async () => {
  const options = connectionFromEnv({
    DATABASE_URL: 'postgresql://societybooks@/societybooks?host=/var/run/postgresql',
  });
  equal(options.host, '/var/run/postgresql', 'host');
  equal(options.user, 'societybooks', 'user');
  equal(options.database, 'societybooks', 'database');
});

await check('an unknown sslmode is refused rather than ignored', async () => {
  try {
    connectionFromEnv({ DATABASE_URL: 'postgresql://u:p@h/db?sslmode=yes-please' });
    throw new Error('it was accepted');
  } catch (err) {
    truthy(err instanceof PgError, 'a PgError');
    matches(err.message, /not one this client knows/, 'the message');
  }
});

await check('verify-ca is treated as the stricter verify-full', async () => {
  equal(
    connectionFromEnv({ DATABASE_URL: 'postgresql://u:p@h/db?sslmode=verify-ca' }).sslMode,
    'verify-full',
    'sslMode',
  );
});

await check('DIRECT_URL is used for migrations and falls back to DATABASE_URL', async () => {
  const env = {
    DATABASE_URL: 'postgresql://u:p@ep-x-pooler.example.neon.tech/books?sslmode=require',
    DIRECT_URL: 'postgresql://u:p@ep-x.example.neon.tech/books?sslmode=require',
  };
  equal(connectionFromEnv(env, 'DATABASE_URL').host, 'ep-x-pooler.example.neon.tech', 'the app');
  equal(connectionFromEnv(env, 'DIRECT_URL').host, 'ep-x.example.neon.tech', 'migrations');
  equal(
    connectionFromEnv({ DATABASE_URL: env.DATABASE_URL }, 'DIRECT_URL').host,
    'ep-x-pooler.example.neon.tech',
    'with no DIRECT_URL set, migrations fall back',
  );
  // `DIRECT_URL=` with nothing after it is what a .env copied from the
  // example file holds. It must mean the same as absent: before this, the
  // empty string was taken as the configured value, no URL reached psql, and
  // the migration ran against whatever the PG* variables pointed at.
  equal(
    connectionFromEnv({ DATABASE_URL: env.DATABASE_URL, DIRECT_URL: '' }, 'DIRECT_URL').host,
    'ep-x-pooler.example.neon.tech',
    'an empty DIRECT_URL falls back too',
  );
});

await check('a pooled hostname is recognised', async () => {
  equal(looksPooled('ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech'), true, 'pooled');
  equal(looksPooled('ep-cool-name-123456.eu-central-1.aws.neon.tech'), false, 'direct');
  equal(looksPooled('pgbouncer.internal'), true, 'a pgbouncer host');
  equal(looksPooled('/var/run/postgresql'), false, 'a socket');
});

await check("libpq's options parameter is passed through to the server", async () => {
  const options = connectionFromEnv({
    DATABASE_URL:
      'postgresql://u:p@h/db?sslmode=require&options=endpoint%3Dep-cool-name-123456',
  });
  equal(options.startupParameters.options, 'endpoint=ep-cool-name-123456', 'options');
});

await check('what an operator is shown carries no password', async () => {
  const described = describeConnection(connectionFromEnv({
    DATABASE_URL: 'postgresql://books_owner:super-secret-password@ep-x-pooler.neon.tech/books?sslmode=require',
  }));
  equal(JSON.stringify(described).includes('super-secret-password'), false,
    'the password must not appear anywhere in the description');
  equal(described.passwordConfigured, true, 'that one is configured is reported');
  equal(described.pooledHostname, true, 'and that the host looks pooled');
});

// --- nothing database-shaped in the front end -------------------------------

suite('the front end holds no database credential');

await check('no database variable is read anywhere the browser can see', async () => {
  const { readdirSync, readFileSync, statSync, existsSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  const walk = (dir) => {
    const out = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.(ts|tsx|js|jsx|html)$/.test(name)) out.push(full);
    }
    return out;
  };

  // Everything the bundler can reach, plus the built browser modules.
  const places = [join(root, 'src'), join(root, 'index.html')]
    .filter(path => existsSync(path));
  const built = join(root, '.browser-build');
  if (existsSync(built)) places.push(built);

  const files = places.flatMap(path =>
    statSync(path).isDirectory() ? walk(path) : [path]);

  const forbidden = [
    // A connection string, or anything that reads one. The browser talks to
    // the API; only the API talks to the database.
    /DATABASE_URL/,
    /DIRECT_URL/,
    /PGPASSWORD/,
    /postgres(?:ql)?:\/\//,
    /SESSION_SECRET/,
    /SMTP_PASSWORD/,
    // Neon's hostname shape, in case one is ever pasted into a component.
    /\.neon\.tech/,
  ];

  const found = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(text)) {
        found.push(`${file.slice(root.length + 1)}: ${pattern}`);
      }
    }
  }
  equal(found.join('\n       ') || 'none', 'none', 'database material reachable by the browser');
  truthy(files.length > 20, `it looked at something: ${files.length} files`);
});

await check('the only environment the front end reads is VITE_', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const session = readFileSync(join(root, 'src', 'api', 'session.ts'), 'utf8');

  // import.meta.env keys, which Vite inlines into the bundle. Anything not
  // prefixed VITE_ is not exposed by Vite — and anything that is, is public.
  const keys = [...session.matchAll(/readViteEnv\('([^']+)'\)/g)].map(m => m[1]);
  truthy(keys.length >= 2, `it found the keys: ${keys.join(', ')}`);
  for (const key of keys) {
    matches(key, /^VITE_/, `${key} is a build-time public variable`);
  }
  equal(keys.includes('VITE_API_BASE'), true, 'the API base is one of them');
});

// --- against a real server --------------------------------------------------

const tlsUrl = process.env.TEST_TLS_URL;

suite('TLS and SCRAM, against a real server');

if (tlsUrl === undefined || tlsUrl === '') {
  skip('the whole suite', 'set TEST_TLS_URL to a TLS-enabled PostgreSQL with a SCRAM password');
} else {
  const base = new URL(tlsUrl);

  const withParameters = (parameters) => {
    const url = new URL(tlsUrl);
    for (const [key, value] of Object.entries(parameters)) {
      if (value === null) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    return url.toString();
  };

  const connect = async (url) => {
    const pool = new PgPool(connectionFromEnv({ DATABASE_URL: url }), 1);
    try {
      const result = await pool.query('SELECT 1::text AS one');
      return { ok: true, one: result.rows[0].one, security: pool.connectionSecurity };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await pool.end();
    }
  };

  await check('it connects, encrypted, with SCRAM', async () => {
    const result = await connect(withParameters({ sslmode: 'require' }));
    truthy(result.ok, `connected: ${result.error ?? ''}`);
    equal(result.one, '1', 'the query came back');
    equal(result.security.encrypted, true, 'encrypted');
    matches(result.security.cipher, /TLS/, 'a TLS cipher');
    matches(result.security.authMechanism, /^SCRAM-SHA-256/, 'the mechanism');
  });

  await check('channel binding is used when the server offers it', async () => {
    const result = await connect(withParameters({
      sslmode: 'require', channel_binding: 'require',
    }));
    truthy(result.ok, `connected: ${result.error ?? ''}`);
    // SCRAM-SHA-256-PLUS binds the exchange to this TLS connection, so a
    // proxy that terminates TLS cannot relay the handshake.
    equal(result.security.authMechanism, 'SCRAM-SHA-256-PLUS', 'the mechanism');
  });

  await check('channel binding can be turned off, and then is not used', async () => {
    const result = await connect(withParameters({
      sslmode: 'require', channel_binding: 'disable',
    }));
    truthy(result.ok, `connected: ${result.error ?? ''}`);
    equal(result.security.authMechanism, 'SCRAM-SHA-256', 'the mechanism');
  });

  await check('a wrong password fails as a password failure', async () => {
    const url = new URL(withParameters({ sslmode: 'require' }));
    url.password = 'definitely-not-the-password';
    const result = await connect(url.toString());
    equal(result.ok, false, 'it must not connect');
    matches(result.error, /password authentication failed|SASL/, 'the reason');
  });

  await check('channel binding required without TLS is refused by the client', async () => {
    const result = await connect(withParameters({
      sslmode: 'disable', channel_binding: 'require',
    }));
    equal(result.ok, false, 'it must not connect');
    // Refused here, before anything is sent: the password does not leave the
    // process when the connection cannot be bound.
    matches(result.error, /channel binding is required|not encrypted|rejects connection/, 'the reason');
  });

  await check('verify-full against an unknown certificate authority fails closed', async () => {
    const result = await connect(withParameters({ sslmode: 'verify-full' }));
    if (result.ok) {
      // A server with a certificate from a public CA — which is what a managed
      // provider has — is expected to pass this.
      truthy(result.security.encrypted, 'encrypted, and the certificate verified');
    } else {
      matches(
        result.error,
        /self-signed|self signed|unable to verify|certificate/,
        'the reason names the certificate',
      );
    }
  });

  await check('the server really is refusing unencrypted connections', async () => {
    // Otherwise the checks above prove less than they appear to: a server that
    // accepts plaintext would let a misconfigured client through.
    const result = await connect(withParameters({ sslmode: 'disable', channel_binding: null }));
    if (result.ok) {
      throw new Error(
        'the test server accepted an unencrypted connection, so it is not configured like ' +
        'a hosted database and the TLS checks above are weaker than they look',
      );
    }
    matches(result.error, /no encryption|SSL|rejects connection/, 'the refusal');
  });

  await check('the host in the URL is what it connected to', async () => {
    const options = connectionFromEnv({ DATABASE_URL: tlsUrl });
    equal(options.host, base.hostname, 'host');
  });
}

console.log(`\n${passed} passed, ${failures.length} failed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
if (failures.length > 0) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
