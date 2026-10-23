#!/usr/bin/env node
/**
 * Every API path the frontend calls is a route the server declares.
 *
 * The browser tests exercise the paths the screens happen to walk through in a
 * scenario. This checks the rest: a path the client builds but no test has
 * clicked — a PDF link, a TDS remittance, a vendor bill being paid — is still
 * a path that must exist on the server. A typo there is a 404 in front of a
 * treasurer at the end of a month, and nothing else in the suite would catch
 * it.
 *
 * Static, both ways:
 *   · every path the frontend asks for is declared by the server;
 *   · every route the server declares is reachable (named in its own table).
 *
 * Paths are compared as templates: `/api/payments/${id}/pdf` in the client is
 * the server's `/api/payments/:id/pdf`. The comparison is on segments, not
 * strings, so an extra or missing segment is a failure rather than a near-miss.
 *
 *   node server/wiring.test.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

function walk(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (ext.some(e => name.endsWith(e))) out.push(full);
  }
  return out;
}

/** `/api/payments/${id}/pdf?x=1` → `/api/payments/:param/pdf`. */
function template(path) {
  return path
    .split('?')[0]
    .replace(/\$\{[^}]*\}/g, ':param')
    .replace(/\/+$/, '');
}

const sameShape = (a, b) => {
  const left = a.split('/');
  const right = b.split('/');
  if (left.length !== right.length) return false;
  return left.every((segment, i) => {
    const other = right[i];
    if (segment.startsWith(':') || other.startsWith(':')) return true;
    return segment === other;
  });
};

// --- what the frontend asks for --------------------------------------------

const clientFiles = walk(join(root, 'src'), ['.ts', '.tsx']);
const requested = new Map(); // template -> the files that build it

for (const file of clientFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/[`']\/api\/[^`'\n]*[`']/g)) {
    const raw = match[0].slice(1, -1);
    const key = template(raw);
    if (!requested.has(key)) requested.set(key, []);
    requested.get(key).push(file.slice(root.length + 1));
  }
}

// --- what the server declares ----------------------------------------------

const serverFiles = walk(join(root, 'server', 'src'), ['.ts'])
  .filter(f => /routes/.test(f));
const declared = [];

for (const file of serverFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/route\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g)) {
    declared.push({ method: match[1], path: match[2], file: file.slice(root.length + 1) });
  }
}

// --- the checks ------------------------------------------------------------

suite('the wiring between the app and the server');

check('the server declares a route table worth checking against', () => {
  // A regex that stops matching would otherwise make every check below pass
  // for the wrong reason.
  equal(declared.length > 25, true, `routes found: ${declared.length}`);
  equal(requested.size > 10, true, `paths the frontend builds: ${requested.size}`);
});

check('every path the frontend calls is declared by the server', () => {
  const missing = [];
  for (const [path, files] of requested) {
    if (!declared.some(r => sameShape(r.path, path))) {
      missing.push(`${path} (built in ${[...new Set(files)].join(', ')})`);
    }
  }
  equal(missing.join('\n       '), '', 'paths with no route');
});

check('no frontend path collides with two different routes', () => {
  // Two routes of the same shape mean the second is unreachable, whichever
  // the router happens to try first.
  const collisions = [];
  for (const path of requested.keys()) {
    const hits = declared.filter(r => sameShape(r.path, path));
    const methods = new Set(hits.map(h => `${h.method} ${h.path}`));
    const paths = new Set(hits.map(h => h.path));
    if (paths.size > 1) collisions.push(`${path} → ${[...methods].join(' / ')}`);
  }
  equal(collisions.join('; '), '', 'ambiguous paths');
});

check('no two routes share a method and a path', () => {
  const seen = new Map();
  const duplicates = [];
  for (const route of declared) {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) duplicates.push(`${key} (${seen.get(key)} and ${route.file})`);
    else seen.set(key, route.file);
  }
  equal(duplicates.join('; '), '', 'duplicate routes');
});

check('every declared route is mounted, not just written', () => {
  // `route(...)` builds a handler; it does the nothing at all unless the
  // handler is put in the list the server serves. A route written and never
  // mounted is a 404 that reads like a bug in the client.
  const mounted = serverFiles
    .map(f => readFileSync(f, 'utf8'))
    .join('\n');

  const unmounted = [];
  for (const file of serverFiles) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/const (\w+) = route\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g)) {
      const [, name, method, path] = match;
      // The declaration itself is one mention; being served is another.
      const mentions = mounted.split(new RegExp(`\\b${name}\\b`)).length - 1;
      if (mentions < 2) unmounted.push(`${method} ${path} (${name})`);
    }
  }
  equal(unmounted.join('; '), '', 'routes that are never served');
});

check('nothing reaches the server over plain http in the client', () => {
  const offenders = [];
  for (const file of clientFiles) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/['"`]http:\/\/[^'"`\n]*/g)) {
      // localhost is how the developer runs it; anything else is a mistake
      // that would send a session cookie over the wire in the clear.
      if (!/localhost|127\.0\.0\.1/.test(match[0])) {
        offenders.push(`${file.slice(root.length + 1)}: ${match[0]}`);
      }
    }
  }
  equal(offenders.join('; '), '', 'plain-http URLs in the client');
});

check('no database URL or password reaches the frontend bundle', () => {
  // The one mistake that cannot be walked back: a connection string compiled
  // into a file served to every member's browser.
  const offenders = [];
  for (const file of clientFiles) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of [/postgres(ql)?:\/\//, /\bDATABASE_URL\b/, /\bDIRECT_URL\b/, /\bSMTP_PASSWORD\b/]) {
      if (pattern.test(text)) offenders.push(`${file.slice(root.length + 1)} matches ${pattern}`);
    }
  }
  equal(offenders.join('; '), '', 'server-side secrets referenced in client code');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
