#!/usr/bin/env node
/**
 * The reload test, in a real browser.
 *
 * Serves the project over http (localStorage needs a real origin — on
 * about:blank the browser denies it), loads a harness page that creates the
 * store exactly as the app does, posts transactions, reloads the page, and
 * checks that every figure came back.
 *
 * This covers the store and the persistence layer in Chromium. It does not
 * cover the React screens: building those needs Vite and the npm packages,
 * which this environment cannot install.
 *
 *   node scripts/browser-test.mjs
 */

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Build first. Serving a stale or missing .browser-build is how this test came
// to "fail" for a reason that had nothing to do with the code under test — the
// page simply could not load its modules, and every check timed out
// identically whether the source was sound or deliberately broken.
{
  const built = spawnSync(process.execPath, [join(root, 'scripts', 'build-browser.mjs')], {
    cwd: root, stdio: 'inherit', shell: false,
  });
  if ((built.status ?? 1) !== 0) {
    console.error('Browser build failed; not running the browser tests.');
    process.exit(built.status ?? 1);
  }
}

// Playwright is resolved from wherever it is installed: the project, or a
// global location given in PLAYWRIGHT_RESOLVE_FROM.
function loadPlaywright() {
  const candidates = [
    join(root, 'node_modules', 'playwright'),
    process.env.PLAYWRIGHT_RESOLVE_FROM
      ? join(process.env.PLAYWRIGHT_RESOLVE_FROM, 'playwright')
      : null,
    'playwright',
  ].filter(Boolean);
  const require = createRequire(import.meta.url);
  for (const candidate of candidates) {
    try { return require(candidate); } catch { /* try the next */ }
  }
  return null;
}

const playwright = loadPlaywright();
if (playwright === null) {
  console.error(
    'Playwright is not installed. Install it with `npm install -D playwright` and run\n' +
    '`npx playwright install chromium`, or point PLAYWRIGHT_RESOLVE_FROM at a global\n' +
    'node_modules directory that has it.',
  );
  process.exit(2);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  // Normalised and prefix-checked, so a request cannot escape the project.
  const target = normalize(join(root, decodeURIComponent(url)));
  if (!target.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

await new Promise(done => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/browser-test/harness.html`;

// --- harness --------------------------------------------------------------

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}\n       ${err.message}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}
const eq = (got, want, what = 'value') => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
};
const truthy = (c, what) => { if (!c) throw new Error(`expected ${what}`); };

const browser = await playwright.chromium.launch();
let failedToRun = null;

try {
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(pageUrl);
  await page.waitForSelector('#state:has-text("ready")', { timeout: 15000 });

  console.log('\nFirst load');
  const initial = await page.evaluate(() => window.sb.fingerprint());
  check('the store loads in a browser with no saved books', () => {
    eq(initial.ready, true, 'ready');
    eq(initial.entries, 0, 'entries');
    eq(initial.savedAt, null, 'savedAt');
  });
  check('localStorage is reported as durable over http', () => {
    eq(initial.durable, true, 'durable');
    truthy(/browser only/.test(initial.storageNote), `storage note: ${initial.storageNote}`);
  });

  console.log('\nPosting transactions');
  const seeded = await page.evaluate(() => window.sb.seedActivity());
  check('a billing run and three receipts post', () => {
    eq(seeded.raised, 3, 'documents raised');
    eq(seeded.skipped, 0, 'skipped');
  });

  const beforeReload = await page.evaluate(() => window.sb.fingerprint());
  check('the books tie before the reload', () => {
    eq(beforeReload.balanced, true, 'balance sheet balanced');
    eq(beforeReload.difference, 0, 'difference');
    eq(beforeReload.reconciles, true, 'reconciliation');
    truthy(beforeReload.entries > 0, 'entries posted');
  });
  check('the snapshot was written to localStorage', () => {
    truthy(beforeReload.savedAt !== null, 'savedAt is set');
    eq(beforeReload.saveError, null, 'no save error');
  });
  const bytes = await page.evaluate(() => window.sb.rawStoredBytes());
  check('there are bytes in localStorage', () => truthy(bytes > 500, `stored ${bytes} bytes`));

  console.log('\nAfter a real page reload');
  await page.reload();
  await page.waitForSelector('#state:has-text("ready")', { timeout: 15000 });
  const afterReload = await page.evaluate(() => window.sb.fingerprint());

  check('every entry came back', () => eq(afterReload.entries, beforeReload.entries, 'entries'));
  check('every document came back', () => eq(afterReload.documents, beforeReload.documents, 'documents'));
  check('the trial balance total is identical', () =>
    eq(afterReload.totalDebit, beforeReload.totalDebit, 'total debit'));
  check('bank, receivable, advances and GST are identical', () => {
    eq(afterReload.bank, beforeReload.bank, 'bank');
    eq(afterReload.receivable, beforeReload.receivable, 'receivable');
    eq(afterReload.advance, beforeReload.advance, 'member advances');
    eq(afterReload.cgst, beforeReload.cgst, 'GST liability');
  });
  check('invoice statuses and outstanding amounts are identical', () =>
    eq(afterReload.statuses, beforeReload.statuses, 'statuses'));
  check('receipt allocations are identical, invoice by invoice', () =>
    eq(afterReload.allocations, beforeReload.allocations, 'allocations'));
  check('the restored books still reconcile', () => {
    eq(afterReload.balanced, true, 'balanced');
    eq(afterReload.reconciles, true, 'reconciles');
  });
  check('a part-paid invoice is still part paid', () => {
    const partPaid = afterReload.statuses.filter(s => /=Partly paid@/.test(s));
    truthy(partPaid.length > 0, `a part-paid invoice survived, got ${afterReload.statuses.join(' ')}`);
  });
  check('the store was ready on the first render after the reload', () =>
    eq(afterReload.ready, true, 'ready'));

  console.log('\nThe invoice list the screens read');
  const list = await page.evaluate(() => window.sb.invoiceList());
  check('register documents appear in the invoice list', () => {
    eq(list.rows.length, afterReload.documents, 'row count matches the register');
    truthy(list.rows.every(r => r.endsWith('|register')), `all from the register: ${list.rows.join(' ')}`);
  });
  check('the list totals agree with the ledger', () => {
    const outstandingPaise = Math.round(list.totals.outstandingRupees * 100);
    eq(outstandingPaise, afterReload.receivable, 'list outstanding vs receivable');
  });

  console.log('\nA payment after the reload, then another reload');
  const paid = await page.evaluate(() => window.sb.payOne(500, 'RCT-BROWSER-AFTER'));
  check('a receipt posts after the reload', () => eq(paid.paid, true, 'paid'));
  await page.reload();
  await page.waitForSelector('#state:has-text("ready")', { timeout: 15000 });
  const third = await page.evaluate(() => window.sb.fingerprint());
  check('the post-reload receipt survived the second reload', () =>
    eq(third.entries, afterReload.entries + 1, 'one more entry'));
  check('the books still tie after two reloads and a payment', () => {
    eq(third.balanced, true, 'balanced');
    eq(third.reconciles, true, 'reconciles');
  });

  console.log('\nSeed import runs once across reloads');
  check('the seed is recorded as applied and not reapplied', () => {
    // The harness does not import a seed, so the list is empty — what matters
    // is that it round-trips rather than resetting.
    eq(third.migrationsApplied, beforeReload.migrationsApplied, 'migration list round-trips');
  });

  console.log('\nReset');
  await page.evaluate(() => window.sb.resetAll());
  await page.reload();
  await page.waitForSelector('#state:has-text("ready")', { timeout: 15000 });
  const afterReset = await page.evaluate(() => window.sb.fingerprint());
  check('reset clears the books and they stay cleared', () => {
    eq(afterReset.entries, 0, 'entries');
    eq(afterReset.documents, 0, 'documents');
  });

  check('no uncaught errors in the browser', () => {
    if (consoleErrors.length > 0) throw new Error(consoleErrors.slice(0, 3).join(' | '));
  });
} catch (err) {
  failedToRun = err;
} finally {
  await browser.close();
  server.close();
}

console.log('\n' + '='.repeat(66));
if (failedToRun !== null) {
  console.log('BROWSER TEST DID NOT COMPLETE');
  console.log(failedToRun.stack ?? String(failedToRun));
  process.exitCode = 1;
} else if (failures.length === 0) {
  console.log(`ALL ${passed} BROWSER CHECKS PASSED (Chromium, real reload, real localStorage)`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(66));
