#!/usr/bin/env node
/**
 * Structural checks on prisma/schema.prisma, without Prisma.
 *
 * `prisma validate` cannot run here — no registry, so no prisma package — and
 * the first version of this schema shipped with a model referenced in two
 * relations and never defined, which Prisma would have rejected outright. This
 * catches that class of mistake and keeps the schema honest against the SQL
 * that has actually been applied.
 *
 * It is not a substitute for `prisma validate`. Run that too, first chance.
 *
 *   node scripts/check-prisma-schema.mjs            # structure only
 *   PGDATABASE=... node scripts/check-prisma-schema.mjs --compare-db
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) {
    failures.push(`${name}\n       ${err.message}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

const models = [...text.matchAll(/^model\s+(\w+)\s*\{/gm)].map(m => m[1]);
const enums = [...text.matchAll(/^enum\s+(\w+)\s*\{/gm)].map(m => m[1]);
const mapped = [...text.matchAll(/@@map\("([^"]+)"\)/g)].map(m => m[1]);
const known = new Set([...models, ...enums]);

// Scalar types Prisma ships with, so they are not mistaken for model refs.
const SCALARS = new Set([
  'String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes',
  'Unsupported',
]);

console.log('\nStructure');

check('every model has an @@map', () => {
  const blocks = text.split(/^model\s+/m).slice(1);
  const missing = blocks
    .filter(b => !/@@map\("/.test(b.split(/^\}/m)[0]))
    .map(b => b.split(/\s/)[0]);
  if (missing.length > 0) throw new Error(`no @@map on: ${missing.join(', ')}`);
});

check('@@map names are unique', () => {
  const seen = new Set();
  const dupes = mapped.filter(m => (seen.has(m) ? true : (seen.add(m), false)));
  if (dupes.length > 0) throw new Error(`duplicate @@map: ${dupes.join(', ')}`);
});

check('every referenced type is a model, enum or scalar', () => {
  // Field lines look like:  name  Type[]?  @attr
  const unknown = new Set();
  for (const line of text.split('\n')) {
    const m = /^\s{2,}\w+\s+([A-Z]\w*)(\[\])?\??\s/.exec(line);
    if (m === null) continue;
    const type = m[1];
    if (!SCALARS.has(type) && !known.has(type)) unknown.add(type);
  }
  if (unknown.size > 0) {
    throw new Error(`referenced but never defined: ${[...unknown].join(', ')}`);
  }
});

check('no model is defined twice', () => {
  const seen = new Set();
  const dupes = models.filter(m => (seen.has(m) ? true : (seen.add(m), false)));
  if (dupes.length > 0) throw new Error(`duplicate model: ${dupes.join(', ')}`);
});

check('braces balance', () => {
  const open = (text.match(/\{/g) ?? []).length;
  const close = (text.match(/\}/g) ?? []).length;
  if (open !== close) throw new Error(`${open} open braces against ${close} closing`);
});

check('the header states that Prisma has not validated this file', () => {
  const head = text.slice(0, 2000);
  if (!/NOT GENERATED, NOT VALIDATED BY PRISMA/.test(head)) {
    throw new Error('the header must say so, so nobody trusts it further than it has been checked');
  }
});

/**
 * Field declarations inside model blocks only.
 *
 * Both checks below first went wrong by scanning the whole file with a loose
 * regex: "secretary" contains "secret", and two adjacent enum members read as
 * a field and its type. Parsing model blocks and requiring the type to start
 * with a capital removes both classes of false positive.
 */
function modelFields() {
  const out = [];
  for (const block of text.split(/^model\s+/m).slice(1)) {
    const name = block.split(/\s/)[0];
    const body = block.split(/^\}/m)[0];
    for (const line of body.split('\n')) {
      const m = /^\s{2,}(\w+)\s+([A-Z]\w*)(\[\])?(\?)?/.exec(line);
      if (m === null) continue;
      out.push({ model: name, field: m[1], type: m[2], list: m[3] !== undefined });
    }
  }
  return out;
}

const FIELDS = modelFields();

check('no credential field is declared', () => {
  // camelCase segments, so "secretary" does not read as "secret".
  const segments = (f) => f.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
  const FORBIDDEN = new Set(['password', 'secret', 'apikey', 'pin', 'cvv', 'otp', 'token']);
  const bad = FIELDS
    .filter(({ field }) => {
      if (/Hash$/.test(field)) return false;   // a hash is the point
      return segments(field).some(seg => FORBIDDEN.has(seg));
    })
    .map(({ model, field }) => `${model}.${field}`);
  if (bad.length > 0) throw new Error(`credential-shaped fields: ${bad.join(', ')}`);
});

check('money fields are BigInt paise, never Float or Decimal', () => {
  // Exact field names, so "taxable", "valueDate" and "taxPeriod" are not money.
  const MONEY = new Set([
    'amount', 'gross', 'netPayable', 'tdsAmount', 'taxAmount', 'inputGst', 'estimatedTax',
    'totalDebit', 'totalCredit', 'debit', 'credit', 'cgst', 'sgst', 'igst', 'taxableValue',
    'principal', 'interestAccrued', 'budget', 'cost', 'monthlyValue', 'statementBalance',
    'ledgerBalance', 'difference', 'runningBalance', 'ratePaisePerSqft',
    'trialBalanceDebit', 'trialBalanceCredit',
  ]);
  const wrong = FIELDS
    .filter(({ field, type }) => MONEY.has(field) && type !== 'BigInt')
    .map(({ model, field, type }) => `${model}.${field} is ${type}`);
  if (wrong.length > 0) {
    throw new Error(`money must be BigInt paise: ${wrong.join('; ')}`);
  }
});

check('every money field named above actually exists', () => {
  // Guards the check above from rotting into a no-op if a field is renamed.
  const present = new Set(FIELDS.map(f => f.field));
  for (const required of ['amount', 'gross', 'totalDebit', 'totalCredit', 'cgst', 'sgst']) {
    if (!present.has(required)) {
      throw new Error(`"${required}" is not in the schema, so the money check is not checking it`);
    }
  }
});

if (process.argv.includes('--compare-db')) {
  console.log('\nAgainst the applied SQL');

  const psql = (sql) => {
    const r = spawnSync('psql', [
      '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
      '--set', 'ON_ERROR_STOP=1', '--command', sql,
    ], { encoding: 'utf8', shell: false });
    if (r.status !== 0) throw new Error((r.stderr ?? '').trim() || 'psql failed');
    return (r.stdout ?? '').trim().split('\n').filter(l => l !== '');
  };

  check('every applied table has a model', () => {
    const tables = psql(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' " +
      "AND tablename <> 'schema_migrations' ORDER BY 1;",
    );
    const mappedSet = new Set(mapped);
    const missing = tables.filter(t => !mappedSet.has(t));
    if (missing.length > 0) throw new Error(`no model for: ${missing.join(', ')}`);
  });

  check('every model maps to an applied table', () => {
    const tables = new Set(psql(
      "SELECT tablename FROM pg_tables WHERE schemaname='public';",
    ));
    const extra = mapped.filter(m => !tables.has(m));
    if (extra.length > 0) throw new Error(`no table for: ${extra.join(', ')}`);
  });
}

console.log('\n' + '='.repeat(66));
if (failures.length === 0) {
  console.log(`ALL ${passed} PRISMA SCHEMA CHECKS PASSED (structural — not prisma validate)`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(66));
