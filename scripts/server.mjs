#!/usr/bin/env node
/**
 * Builds the backend and runs one of its entry points.
 *
 * Two things here are not optional, and both were learned the hard way:
 *
 *  · The project pins TypeScript 5.8. A `tsc` on PATH may be any version, and
 *    verifying a tsconfig against a different compiler from the one the
 *    project uses is how tsconfig.accounting.json came to be broken while
 *    appearing to pass. The project's own tsc is preferred, and a fallback
 *    says so out loud.
 *  · package.json declares "type": "module" while this build emits CommonJS,
 *    so .server-build needs its own package.json saying so. Without it the
 *    output is loaded as ESM and every file fails on `exports`.
 *
 *   node scripts/server.mjs check     # can it reach the database, and how
 *   node scripts/server.mjs serve     # start the API
 *   node scripts/server.mjs seed      # seed a demo society
 *   node scripts/server.mjs test      # the HTTP integration suite
 *   node scripts/server.mjs test:pg   # the Postgres client suite
 *   node scripts/server.mjs build     # compile only
 */

import { spawnSync } from 'node:child_process';
import { loadEnv } from './load-env.mjs';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.server-build');

// A .env file, if there is one. Variables already set win over it.
loadEnv('.env', { quiet: false });

const TARGETS = {
  build: null,
  serve: { node: '.server-build/server/src/app.js' },
  seed: { node: '.server-build/server/src/seed.js' },
  check: { node: '.server-build/server/src/dbcheck.js' },
  test: { node: 'server/api.test.mjs' },
  'test:pg': { node: 'server/pg.test.mjs' },
};

const which = process.argv[2] ?? 'build';
if (!(which in TARGETS)) {
  console.error(`Unknown target "${which}". Use one of: ${Object.keys(TARGETS).join(', ')}.`);
  process.exit(2);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const localTsc = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const tsc = existsSync(localTsc) ? localTsc : 'tsc';
if (tsc === 'tsc') {
  console.warn(
    'Warning: node_modules/.bin/tsc not found, falling back to a tsc on PATH. ' +
    'The TypeScript version this project pins is ~5.8; a different compiler may ' +
    'accept configuration or code that 5.8 rejects. Run npm install.',
  );
}

const compiled = run(tsc, ['-p', 'tsconfig.server.json']);
if (compiled !== 0) {
  console.error('\nCompilation failed; nothing was run.');
  process.exit(compiled);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'package.json'), '{"type":"commonjs"}\n');

const target = TARGETS[which];
if (target === null) {
  console.log('Built to .server-build/.');
  process.exit(0);
}

process.exit(run(process.execPath, [join(root, target.node), ...process.argv.slice(3)]));
