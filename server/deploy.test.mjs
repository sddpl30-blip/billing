#!/usr/bin/env node
/**
 * The deployment configuration, checked rather than hoped for.
 *
 * Everything here is a mistake that costs a deploy to discover and reads as
 * something else entirely when it happens: a cron pointing at a path no route
 * answers (a silent 404 once a day, and billing simply never runs), a
 * rewrite that swallows /api into index.html (every call returns HTML and the
 * app reports the server as unreachable), a cron schedule the platform
 * refuses on the current plan (the whole deployment is rejected), the worker
 * started inside a function (a timer in a process that is about to be frozen),
 * or migrations wired into the request path (a schema change racing itself on
 * every cold start).
 *
 * All static: it reads the files the platform reads.
 *
 *   node server/deploy.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

let passed = 0;
const failures = [];
let suiteName = '';
const suite = (n) => { suiteName = n; console.log(`\n${n}`); };

function check(name, fn) {
  try {
    fn();
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

const config = JSON.parse(read('vercel.json'));
const routeSource = ['server/src/routes.ts', 'server/src/routesAdmin.ts', 'server/src/routesCron.ts']
  .map(read).join('\n');

// --- the function ----------------------------------------------------------

suite('the function');

check('there is exactly one function, and it is a catch-all', () => {
  const files = readdirSync(join(root, 'api'));
  equal(files.length, 1, `files in api/: ${files.join(', ')}`);
  // A function per endpoint would multiply cold starts and connection pools.
  matches(files[0], /^\[\.\.\..+\]\.js$/, 'the one file is a catch-all');
});

check('the build command compiles the server the function imports', () => {
  // The function imports .server-build; a deployment that only ran the Vite
  // build would ship an entry point whose import does not exist.
  matches(config.buildCommand, /server:build/, `buildCommand: ${config.buildCommand}`);
});

// package.json says "type": "module". A .ts entry importing the server's
// extensionless sources compiled to ESM and failed on the platform with
// ERR_MODULE_NOT_FOUND; this imports the real entry the way Node will.
let loadedEntry;
try {
  const { pathToFileURL } = await import('node:url');
  loadedEntry = await import(pathToFileURL(join(root, 'api', '[...path].js')).href);
} catch (err) {
  loadedEntry = err;
}
check('the function loads as an ES module', () => {
  if (loadedEntry instanceof Error) throw loadedEntry;
  equal(typeof loadedEntry.default, 'function', 'the default export is the handler');
});

check('the function delegates to the shared wiring', () => {
  const entry = read('api/[...path].js');
  matches(entry, /createServerlessHandler/, 'it uses the adapter');
  matches(entry, /\.server-build\/server\/src\/serverless\.js/, 'from the built server, not a copy of it');
  // Anything else in here is a second implementation of the thing that is
  // already tested.
  equal(/createApp|createRoutes|PgPool/.test(entry), false, 'and wires nothing itself');
});

check('the function never runs migrations and never starts the worker', () => {
  const entry = read('api/[...path].js');
  const adapter = read('server/src/serverless.ts');
  for (const [where, text] of [['the entry point', entry], ['the adapter', adapter]]) {
    equal(/migrate|schema_migrations/.test(text), false, `${where} does not migrate`);
    equal(/startWorker/.test(text), false, `${where} does not start a worker`);
  }
  // Positively, not just by absence: the app is built with the worker off.
  matches(adapter, /runWorker:\s*false/, 'the app is built with no worker');
});

check('the adapter is the only thing that reads an already-parsed body', () => {
  // If the standalone server started trusting `req.body` it would be reading
  // something nothing sets, and every write would arrive empty.
  const http = read('server/src/http.ts');
  matches(http, /prepared\.bodyText \?\? await readBody\(req\)/, 'the socket path still reads the socket');
});

// --- routing ---------------------------------------------------------------

suite('routing');

check('the SPA rewrite does not swallow the API', () => {
  const rewrites = config.rewrites ?? [];
  truthy(rewrites.length > 0, 'there is a rewrite for the single-page app');
  for (const rule of rewrites) {
    if (rule.destination !== '/index.html') continue;
    // Without the exclusion, every /api call returns the app's HTML and the
    // client reports the server as unreachable rather than as misrouted.
    matches(rule.source, /\(\?!api\//, 'the rewrite excludes /api');
  }
});

check('the function config covers the api directory', () => {
  const functions = config.functions ?? {};
  const keys = Object.keys(functions);
  truthy(keys.length > 0, 'there is a functions block');
  truthy(keys.some(k => k.startsWith('api/')), `a key for the api directory: ${keys.join(', ')}`);
  for (const settings of Object.values(functions)) {
    truthy(
      settings.maxDuration === undefined || settings.maxDuration >= 30,
      `maxDuration leaves room for a scheduled pass: ${settings.maxDuration}`,
    );
  }
});

check('the build produces the directory the platform serves', () => {
  equal(config.outputDirectory, 'dist', 'outputDirectory');
  matches(config.buildCommand, /npm run build/, 'buildCommand');
  const pkg = JSON.parse(read('package.json'));
  matches(pkg.scripts.build, /vite build/, 'and that script is the real production build');
});

// --- the scheduler ---------------------------------------------------------

suite('the scheduler');

check('every cron points at a path the server actually answers', () => {
  const crons = config.crons ?? [];
  truthy(crons.length > 0, 'at least one scheduled run is configured');
  for (const cron of crons) {
    // A cron on a path with no route is a 404 once a day and a billing cycle
    // that never happens, with nothing on screen to say so.
    const pattern = new RegExp(`route\\('GET',\\s*'${cron.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
    matches(routeSource, pattern, `a GET route for ${cron.path}`);
  }
});

check('the cron endpoints are closed unless a secret is configured', () => {
  const cron = read('server/src/routesCron.ts');
  matches(cron, /config\.cronSecret === null/, 'an unset secret is handled explicitly');
  matches(cron, /timingSafeEqual/, 'and the comparison is constant-time');
  matches(cron, /authenticated: false, csrfExempt: true/, 'the scheduler has no session and no cookie');
});

check('the cron schedules are valid, and run no more than daily', () => {
  // Vercel's Hobby plan refuses a schedule that would run more than once a
  // day — and refuses the whole deployment with it. Anything tighter than
  // daily belongs in a comment until the plan allows it.
  for (const cron of config.crons ?? []) {
    const fields = cron.schedule.trim().split(/\s+/);
    equal(fields.length, 5, `${cron.schedule} has five fields`);
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    equal(/^\d+$/.test(minute), true, `the minute is fixed, not a range: ${minute}`);
    equal(/^\d+$/.test(hour), true, `the hour is fixed, so it runs once a day: ${hour}`);
    for (const [name, field] of [['day of month', dayOfMonth], ['month', month], ['day of week', dayOfWeek]]) {
      equal(field, '*', `${name} is every`);
    }
  }
});

check('the worker is still there for a long-lived host', () => {
  // The serverless deployment is not the only way to run this, and removing
  // the timer would strand anyone running it on a server.
  matches(read('server/src/app.ts'), /startWorker/, 'app.ts can still start a worker');
  matches(read('server/src/jobs.ts'), /export function startWorker/, 'and the worker exists');
});

// --- migrations ------------------------------------------------------------

suite('migrations');

check('the Node runner refuses a pooled endpoint', () => {
  // The failure it prevents is quiet: a migration against a pooler in
  // transaction mode cannot hold the locks it takes.
  const result = spawnSync(process.execPath, [join(root, 'server', 'migrate-node.mjs'), 'status'], {
    encoding: 'utf8',
    shell: false,
    cwd: root,
    env: {
      ...process.env,
      DIRECT_URL: 'postgresql://u:p@ep-x-123456-pooler.eu-central-1.aws.neon.tech/books?sslmode=require',
      DATABASE_URL: '',
    },
  });
  equal(result.status, 2, `it refuses: ${(result.stdout ?? '') + (result.stderr ?? '')}`);
  matches(result.stderr, /looks like a pooled endpoint/, 'and says which URL to change');
  matches(result.stderr, /DIRECT_URL/, 'naming the variable');
});

check('both runners keep the same bookkeeping', () => {
  // They have to read each other's work: whichever applied a migration, the
  // other must see it as applied rather than pending.
  const psqlRunner = read('server/migrate.mjs');
  const nodeRunner = read('server/migrate-node.mjs');
  for (const [name, text] of [['psql', psqlRunner], ['node', nodeRunner]]) {
    matches(text, /schema_migrations/, `${name}: the same table`);
    matches(text, /slice\(0, 16\)/, `${name}: the same checksum length`);
    matches(text, /sha256/, `${name}: the same digest`);
  }
});

check('nothing in the deployment config runs a migration', () => {
  const text = JSON.stringify(config);
  equal(/migrate/.test(text), false, 'no migration in the build or the crons');
  matches(read('docs/VERCEL.md'), /npm run db:migrate/, 'it is a documented step a person takes');
});

// --- what the frontend is told ---------------------------------------------

suite('what the frontend is told');

check('no secret is named in a VITE_ variable anywhere', () => {
  // VITE_ variables are compiled into the bundle a browser downloads.
  const text = [read('.env.example'), read('docs/VERCEL.md'), JSON.stringify(config)].join('\n');
  for (const name of text.matchAll(/VITE_[A-Z0-9_]+/g)) {
    equal(
      /SECRET|PASSWORD|DATABASE|DIRECT|TOKEN|KEY/.test(name[0]),
      false,
      `${name[0]} must not be a VITE_ variable`,
    );
  }
});

check('the production front end is told to require the server', () => {
  matches(read('.env.example'), /VITE_DATA_SOURCE=server/, 'the template sets it');
  matches(read('docs/VERCEL.md'), /VITE_DATA_SOURCE[^\n]{0,16}server/, 'and the instructions say to');
});

check('every variable the deployment needs is in the template', () => {
  const template = read('.env.example');
  for (const name of [
    'DATABASE_URL', 'DIRECT_URL', 'SESSION_SECRET', 'CRON_SECRET', 'TRUST_PROXY',
    'DB_POOL_MAX', 'EMAIL_PROVIDER', 'OTP_PROVIDER', 'VITE_DATA_SOURCE', 'VITE_API_BASE',
  ]) {
    matches(template, new RegExp(`\\b${name}\\b`), `${name} is documented`);
  }
});

check('the instructions exist and name the settings a person has to make', () => {
  truthy(existsSync(join(root, 'docs', 'VERCEL.md')), 'docs/VERCEL.md');
  const doc = read('docs/VERCEL.md');
  for (const topic of [/Root Directory/i, /CRON_SECRET/, /DIRECT_URL/, /Environment Variables/i]) {
    matches(doc, topic, `it covers ${topic}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
