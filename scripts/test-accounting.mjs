#!/usr/bin/env node
/**
 * Compiles the accounting engine and runs one of its entry points.
 *
 * This exists because the npm script that used to do the same thing inlined a
 * `node -e` call with four levels of quote escaping, which is fragile across
 * shells and silently different on Windows. It also marks the build output as
 * CommonJS, which is needed because package.json declares "type": "module"
 * while the engine's test build emits CommonJS — see tsconfig.accounting.json.
 *
 *   node scripts/test-accounting.mjs              # the unit suite
 *   node scripts/test-accounting.mjs integration  # the integration suite
 *   node scripts/test-accounting.mjs demo         # a worked month, printed
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.accounting-build');

// Paths inside .accounting-build, which mirrors src/ (see tsconfig.accounting.json).
const ENTRIES = {
  unit: 'accounting/selftest.js',
  integration: 'accounting/integration.test.js',
  persistence: 'accounting/persistence.test.js',
  demo: 'accounting/demo.js',
};

const which = process.argv[2] ?? 'unit';
const entry = ENTRIES[which];
if (entry === undefined) {
  const known = Object.keys(ENTRIES).join(', ');
  console.error('Unknown target "' + which + '". Use one of: ' + known + '.');
  process.exit(2);
}

/** Runs a command, inheriting stdio, and returns its exit code. */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) {
    console.error('Could not run ' + command + ': ' + result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

// npm puts node_modules/.bin on PATH, so prefer the project's own tsc rather
// than whatever tsc happens to be installed globally. Getting this wrong is how
// tsconfig.accounting.json came to be verified against a different compiler
// than the one the project pins.
const localTsc = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const tsc = existsSync(localTsc) ? localTsc : 'tsc';
if (tsc === 'tsc') {
  console.warn(
    'Warning: node_modules/.bin/tsc not found, falling back to a tsc on PATH. ' +
    'Run npm install so the pinned TypeScript version is used.',
  );
}

const compiled = run(tsc, ['-p', 'tsconfig.accounting.json']);
if (compiled !== 0) {
  console.error('\nCompilation failed; not running ' + entry + '.');
  process.exit(compiled);
}

// package.json says "type": "module"; this build output is CommonJS.
writeFileSync(join(outDir, 'package.json'), '{"type":"commonjs"}\n');

process.exit(run(process.execPath, [join(outDir, entry)]));
