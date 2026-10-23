#!/usr/bin/env node
/**
 * Builds the engine and store as modules a browser can load directly.
 *
 * TypeScript emits the import specifiers exactly as written — extensionless,
 * because Vite resolves them — and a browser's module loader cannot. Rather
 * than putting ".js" into the source (which Vite would then have to be taught
 * about), this rewrites the specifiers in the emitted output.
 *
 * Used only by the Playwright reload test. The real app is built by Vite.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.browser-build');

const localTsc = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const tsc = existsSync(localTsc) ? localTsc : 'tsc';

const compiled = spawnSync(tsc, ['-p', 'tsconfig.browser.json'], {
  cwd: root, stdio: 'inherit', shell: false,
});
if ((compiled.status ?? 1) !== 0) {
  console.error('Browser build failed to compile.');
  process.exit(compiled.status ?? 1);
}

/** Every .js file under a directory, recursively. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SPECIFIER = /(from\s+|import\s*\(\s*)(['"])(\.{1,2}\/[^'"]*?)\2/g;
let rewritten = 0;

for (const file of walk(outDir)) {
  const original = readFileSync(file, 'utf8');
  const patched = original.replace(SPECIFIER, (whole, prefix, quote, spec) => {
    if (spec.endsWith('.js')) return whole;
    // A directory specifier such as '../accounting' means its index module.
    const asFile = resolve(dirname(file), spec + '.js');
    const target = existsSync(asFile) ? spec + '.js' : spec + '/index.js';
    rewritten++;
    return `${prefix}${quote}${target}${quote}`;
  });
  if (patched !== original) writeFileSync(file, patched);
}

console.log(`Browser build ready in .browser-build (${rewritten} import specifiers rewritten).`);
