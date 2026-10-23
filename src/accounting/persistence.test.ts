/**
 * Phase 3 persistence tests.
 *
 * The thing being proved is that nothing financial disappears across a reload.
 * A "reload" here is a second `createBooksStore` over the same repository,
 * which is exactly what the browser does on refresh: new store, same storage.
 *
 * Run with: npm run test:persistence
 */

import { fromRupees, formatRupees } from './money';
import { A } from './accounts';
import { Ledger } from './journal';
import { AccountingConfig, DEMO_CONFIG } from './config';
import { fixedClock } from './clock';
import {
  SNAPSHOT_VERSION, SnapshotError, migrate, parseSnapshot, restoreSnapshot,
  validateSnapshot, writeSnapshot, type BooksSnapshotData,
} from './snapshot';
import { BillingRegister } from './documents';
import { balanceSheet, reconcile, trialBalance } from './reports';
import { outstandingInvoices } from './allocation';
import { createBooksStore, type BooksStore } from '../store/booksStore';
import {
  memoryRepository, localStorageRepository, resolveRepository,
  type BooksRepository, type KeyValueStore,
} from '../store/repository';
import type { SourceInvoice, SourceVendorInvoice } from './adapter';

// --- harness --------------------------------------------------------------

let passed = 0;
const failures: string[] = [];
let suiteName = '';

function suite(name: string): void { suiteName = name; console.log(`\n${name}`); }
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    failures.push(`${suiteName} / ${name}\n       ${m.replace(/\n/g, '\n       ')}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${m.replace(/\n/g, '\n       ')}`);
  }
}
function eq<T>(got: T, want: T, what = 'value'): void {
  if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function truthy(c: boolean, what: string): void { if (!c) throw new Error(`expected ${what}`); }
function throws(fn: () => unknown, matching: RegExp | string, what: string): void {
  try { fn(); } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    const ok = typeof matching === 'string' ? m.includes(matching) : matching.test(m);
    if (!ok) throw new Error(`${what}: threw with "${m}"`);
    return;
  }
  throw new Error(`${what}: expected a throw`);
}

const R = fromRupees;
const CLOCK = fixedClock('2026-07-15');
const APPROVED: AccountingConfig = { ...DEMO_CONFIG, reviewedBy: 'Test CA', reviewedOn: '2026-06-01' };

const FLATS = [
  { flatNo: 'A-101', name: 'Priya Nair', billingAreaSqFt: 1750, areaBasis: 'super-built-up' as const },
  { flatNo: 'B-204', name: 'Rohan Mehta', billingAreaSqFt: 2000, areaBasis: 'super-built-up' as const },
  { flatNo: 'C-302', name: 'Suresh Iyer', billingAreaSqFt: 2400, areaBasis: 'super-built-up' as const },
];

/** A fake localStorage, so the browser path is exercised without a browser. */
function fakeStorage(): KeyValueStore & { dump(): Record<string, string>; failNextWrite(): void } {
  const held = new Map<string, string>();
  let failOnce = false;
  return {
    getItem: (k) => held.get(k) ?? null,
    setItem: (k, v) => {
      if (failOnce) { failOnce = false; throw new Error('QuotaExceededError (simulated)'); }
      held.set(k, v);
    },
    removeItem: (k) => { held.delete(k); },
    dump: () => Object.fromEntries(held),
    failNextWrite: () => { failOnce = true; },
  };
}

function storeOn(repository: BooksRepository, mode: 'demo' | 'production' = 'demo'): BooksStore {
  return createBooksStore({ config: APPROVED, clock: CLOCK, repository, mode });
}

/** Posts a representative set of transactions and returns what to expect back. */
function buildActivity(store: BooksStore) {
  const run = store.runBillingFor({
    period: 'Jul 2026', flats: FLATS, issuedOn: '2026-07-01',
    sinkingFundPercentOfMaintenance: 20,
  });
  store.approveDocuments(run.documents.map(d => d.proformaNo), 'Treasurer');
  store.releaseDocument(run.documents[0].proformaNo, 'Treasurer');

  // One paid in full, one part paid, one overpaid into advance.
  store.recordMemberPayment({
    proformaNo: run.documents[0].proformaNo,
    amountRupees: 5000, receiptNo: 'RCT-P1', method: 'UPI', by: 'Manager',
  });
  store.recordMemberPayment({
    proformaNo: run.documents[1].proformaNo,
    amountRupees: 2000, receiptNo: 'RCT-P2', method: 'NEFT', by: 'Manager',
  });
  store.depositAdvance({
    flatNo: 'C-302', amountRupees: 30000, receiptNo: 'ADV-P1', method: 'UPI', by: 'Resident',
  });
  return run;
}

function fingerprint(store: BooksStore) {
  const snap = store.snapshot();
  const tb = trialBalance(snap.ledger, '2026-12-31');
  return {
    entries: snap.ledger.all().length,
    documents: snap.register.all().length,
    totalDebit: tb.totalDebit,
    bank: snap.ledger.balanceOf(A.BANK_OPERATING),
    receivable: snap.ledger.balanceOf(A.MAINTENANCE_RECEIVABLE),
    advance: snap.ledger.balanceOf(A.MEMBER_ADVANCE),
    cgst: snap.ledger.balanceOf(A.CGST_OUTPUT),
    taxInvoices: snap.register.all().filter(d => d.state === 'tax-invoice').length,
  };
}

// --- the snapshot codec ---------------------------------------------------

suite('Snapshot round-trips the ledger and the register');

check('a written snapshot restores to the same balances', () => {
  const store = storeOn(memoryRepository());
  buildActivity(store);
  const before = fingerprint(store);

  const snap = store.snapshot();
  const written = writeSnapshot({
    ledger: snap.ledger, register: snap.register, mode: 'demo',
    savedAt: '2026-07-15T00:00:00.000Z', migrationsApplied: [],
  });
  const restored = restoreSnapshot(written, APPROVED, CLOCK);

  eq(restored.entriesRestored, before.entries, 'entries');
  eq(restored.documentsRestored, before.documents, 'documents');
  eq(restored.ledger.balanceOf(A.BANK_OPERATING), before.bank, 'bank');
  eq(restored.ledger.balanceOf(A.MAINTENANCE_RECEIVABLE), before.receivable, 'receivable');
  eq(restored.ledger.balanceOf(A.MEMBER_ADVANCE), before.advance, 'advance');
  eq(restored.ledger.balanceOf(A.CGST_OUTPUT), before.cgst, 'CGST');
});

check('entry ids, keys and reversal links survive a round trip', () => {
  const store = storeOn(memoryRepository());
  const run = buildActivity(store);

  // A reversal has to exist for this test to mean anything, so one is created
  // rather than hoped for: raise a fresh invoice, convert it, cancel it unpaid.
  const extra = store.snapshot().register.issueProforma({
    flatNo: 'A-101', period: 'Aug 2026', issuedOn: '2026-08-01',
    lines: [{ head: 'maintenance', amount: R(4000), taxable: true }],
  });
  store.approveDocuments([extra.proformaNo], 'Treasurer');
  store.snapshot().register.convertToTaxInvoice(extra.proformaNo, {
    on: '2026-08-01', because: 'manual', by: 'T',
  });
  store.cancelDocument(extra.proformaNo, 'T', 'raised on the wrong area');

  const before = store.snapshot().ledger.all();
  const reversals = before.filter(e => e.reversalOf !== undefined);
  const reversed = before.filter(e => e.reversedBy !== undefined);
  eq(reversals.length, 1, 'exactly one reversal entry exists to check');
  eq(reversed.length, 1, 'and exactly one entry is marked as reversed');
  const written = writeSnapshot({
    ledger: store.snapshot().ledger, register: store.snapshot().register,
    mode: 'demo', savedAt: '2026-07-15T00:00:00.000Z', migrationsApplied: [],
  });
  const after = restoreSnapshot(written, APPROVED, CLOCK).ledger.all();

  eq(after.length, before.length, 'entry count');
  for (const [i, e] of before.entries()) {
    eq(after[i].id, e.id, `entry ${i} id`);
    eq(after[i].idempotencyKey, e.idempotencyKey, `entry ${i} key`);
    eq(after[i].postedAt, e.postedAt, `entry ${i} postedAt`);
    eq(after[i].reversalOf, e.reversalOf, `entry ${i} reversalOf`);
    eq(after[i].reversedBy, e.reversedBy, `entry ${i} reversedBy`);
    eq(after[i].postings.length, e.postings.length, `entry ${i} leg count`);
  }

  // Stated positively, so the loop above cannot pass by comparing two
  // undefineds: the pair must still be linked in both directions.
  const afterReversal = after.find(e => e.reversalOf !== undefined);
  const afterReversed = after.find(e => e.reversedBy !== undefined);
  truthy(afterReversal !== undefined, 'the reversal entry came back with its link');
  truthy(afterReversed !== undefined, 'and the original is still marked reversed');
  eq(afterReversal?.reversalOf, afterReversed?.id, 'the two point at each other');
  eq(afterReversed?.reversedBy, afterReversal?.id, 'in both directions');
  void run;
});

check('docRef survives, so invoice statuses come back', () => {
  const store = storeOn(memoryRepository());
  const run = buildActivity(store);
  const before = store.snapshot().register.all()
    .map(d => ({ no: d.proformaNo, status: d.status, outstanding: d.outstanding }));

  const written = writeSnapshot({
    ledger: store.snapshot().ledger, register: store.snapshot().register,
    mode: 'demo', savedAt: '2026-07-15T00:00:00.000Z', migrationsApplied: [],
  });
  const restored = restoreSnapshot(written, APPROVED, CLOCK);
  const after = restored.register.all()
    .map(d => ({ no: d.proformaNo, status: d.status, outstanding: d.outstanding }));

  eq(after.length, before.length, 'document count');
  for (const [i, b] of before.entries()) {
    eq(after[i].no, b.no, `document ${i}`);
    eq(after[i].status, b.status, `${b.no} status`);
    eq(after[i].outstanding, b.outstanding, `${b.no} outstanding`);
  }
  truthy(before.some(b => b.status === 'Partly paid'), 'a part-paid invoice is in the set');
  void run;
});

check('the tax-invoice series continues rather than restarting', () => {
  const store = storeOn(memoryRepository());
  const run = buildActivity(store);
  store.snapshot().register.convertDue('2026-07-11', 'job');
  const issued = store.snapshot().register.all()
    .map(d => d.taxInvoiceNo).filter((n): n is string => n !== undefined);
  truthy(issued.length >= 2, 'more than one tax invoice issued');

  const written = writeSnapshot({
    ledger: store.snapshot().ledger, register: store.snapshot().register,
    mode: 'demo', savedAt: 'x', migrationsApplied: [],
  });
  const restored = restoreSnapshot(written, APPROVED, CLOCK);

  // A fresh document after the restore must not reuse a number.
  const extra = restored.register.issueProforma({
    flatNo: 'D-404', period: 'Aug 2026', issuedOn: '2026-08-01',
    lines: [{ head: 'maintenance', amount: R(5000), taxable: false }],
  });
  restored.register.approve(extra.proformaNo, 'T', '2026-08-01');
  const next = restored.register.convertToTaxInvoice(extra.proformaNo, {
    on: '2026-08-01', because: 'manual', by: 'T',
  });
  truthy(!issued.includes(next.document.taxInvoiceNo as string),
    `${next.document.taxInvoiceNo} reuses an issued number`);
  void run;
});

check('a restored ledger still reconciles', () => {
  const store = storeOn(memoryRepository());
  buildActivity(store);
  const written = writeSnapshot({
    ledger: store.snapshot().ledger, register: store.snapshot().register,
    mode: 'demo', savedAt: 'x', migrationsApplied: [],
  });
  const restored = restoreSnapshot(written, APPROVED, CLOCK);
  const result = reconcile(restored.ledger, '2026-07-01', '2026-12-31');
  const bad = result.checks.filter(c => !c.passed);
  if (bad.length > 0) throw new Error(bad.map(c => `${c.name}: ${c.detail}`).join('; '));
  truthy(balanceSheet(restored.ledger, '2026-12-31').balanced, 'balance sheet');
});

// --- corruption refused ---------------------------------------------------

suite('A corrupt snapshot is refused, not loaded');

check('an unbalanced entry is rejected with the amount it is out by', () => {
  const store = storeOn(memoryRepository());
  buildActivity(store);
  const written = writeSnapshot({
    ledger: store.snapshot().ledger, register: store.snapshot().register,
    mode: 'demo', savedAt: 'x', migrationsApplied: [],
  });
  // Tamper with one leg.
  const tampered: BooksSnapshotData = {
    ...written,
    entries: written.entries.map((e, i) =>
      i === 0
        ? { ...e, postings: e.postings.map((p, j) => (j === 0 ? { ...p, d: p.d + 100 } : p)) }
        : e),
  };
  const problems = validateSnapshot(tampered);
  truthy(problems.some(p => /does not balance/.test(p)), `balance complaint, got ${problems.join('; ')}`);
  throws(() => restoreSnapshot(tampered, APPROVED, CLOCK), /does not balance/, 'tampered restore');
});

check('an unknown account is rejected', () => {
  const store = storeOn(memoryRepository());
  buildActivity(store);
  const written = writeSnapshot({
    ledger: store.snapshot().ledger, register: store.snapshot().register,
    mode: 'demo', savedAt: 'x', migrationsApplied: [],
  });
  const tampered = {
    ...written,
    entries: written.entries.map((e, i) =>
      i === 0 ? { ...e, postings: e.postings.map(p => ({ ...p, a: '9999' })) } : e),
  };
  truthy(validateSnapshot(tampered).some(p => /unknown account/.test(p)), 'account complaint');
});

check('two entries with the same idempotency key are rejected', () => {
  const store = storeOn(memoryRepository());
  buildActivity(store);
  const written = writeSnapshot({
    ledger: store.snapshot().ledger, register: store.snapshot().register,
    mode: 'demo', savedAt: 'x', migrationsApplied: [],
  });
  const duplicated: BooksSnapshotData = {
    ...written,
    entries: [...written.entries, { ...written.entries[0], id: 'JE999999' }],
  };
  throws(
    () => restoreSnapshot(duplicated, APPROVED, CLOCK),
    /the same business event was/, 'duplicate key in a snapshot',
  );
});

check('a snapshot from a newer build is refused rather than guessed at', () => {
  throws(
    () => parseSnapshot(JSON.stringify({
      version: SNAPSHOT_VERSION + 1, mode: 'demo', savedAt: 'x',
      entries: [], documents: [], taxInvoiceSequence: 0, migrationsApplied: [],
    })),
    /newer than this build/, 'future version',
  );
});

check('invalid JSON reports as invalid JSON', () => {
  throws(() => parseSnapshot('{not json'), /not valid JSON/, 'bad JSON');
});

check('an invalid date in a snapshot is caught', () => {
  const store = storeOn(memoryRepository());
  buildActivity(store);
  const written = writeSnapshot({
    ledger: store.snapshot().ledger, register: store.snapshot().register,
    mode: 'demo', savedAt: 'x', migrationsApplied: [],
  });
  const tampered = {
    ...written,
    entries: written.entries.map((e, i) => (i === 0 ? { ...e, date: '2026-02-30' } : e)),
  };
  truthy(validateSnapshot(tampered).some(p => /not a real date/.test(p)), 'date complaint');
});

check('two live documents for one flat and period are refused', () => {
  const store = storeOn(memoryRepository());
  const run = buildActivity(store);
  const written = writeSnapshot({
    ledger: store.snapshot().ledger, register: store.snapshot().register,
    mode: 'demo', savedAt: 'x', migrationsApplied: [],
  });
  const doubled: BooksSnapshotData = {
    ...written,
    documents: [
      ...written.documents,
      { ...written.documents[0], proformaNo: written.documents[0].proformaNo + '-DUP' },
    ],
  };
  throws(
    () => restoreSnapshot(doubled, APPROVED, CLOCK),
    /two live documents for flat/, 'duplicate document in a snapshot',
  );
  void run;
});

// --- migration ------------------------------------------------------------

suite('Older snapshots migrate forward');

check('a version 1 snapshot gains mode and migrationsApplied', () => {
  const v1 = {
    version: 1, savedAt: '2026-07-01T00:00:00Z',
    entries: [], documents: [], taxInvoiceSequence: 0,
  } as unknown as BooksSnapshotData;
  const migrated = migrate(v1);
  eq(migrated.version, SNAPSHOT_VERSION, 'version');
  eq(migrated.mode, 'demo', 'mode defaults to demo for pre-mode snapshots');
  eq(migrated.migrationsApplied.length, 0, 'empty migration list');
});

check('a current snapshot migrates to itself unchanged', () => {
  const current: BooksSnapshotData = {
    version: SNAPSHOT_VERSION, savedAt: 'x', mode: 'production',
    entries: [], documents: [], taxInvoiceSequence: 7, migrationsApplied: ['a'],
  };
  const migrated = migrate(current);
  eq(migrated.version, SNAPSHOT_VERSION, 'version');
  eq(migrated.mode, 'production', 'mode preserved');
  eq(migrated.taxInvoiceSequence, 7, 'sequence preserved');
  eq(migrated.migrationsApplied[0], 'a', 'list preserved');
});

// --- the reload cycle -----------------------------------------------------

suite('Nothing disappears on reload');

check('a second store over the same storage sees every transaction', () => {
  const storage = fakeStorage();
  const first = storeOn(localStorageRepository(storage));
  buildActivity(first);
  const before = fingerprint(first);
  truthy(before.entries > 0, 'the first store posted something');

  // The refresh: a brand-new store over the same storage.
  const second = storeOn(localStorageRepository(storage));
  const after = fingerprint(second);

  eq(after.entries, before.entries, 'entries');
  eq(after.documents, before.documents, 'documents');
  eq(after.totalDebit, before.totalDebit, 'trial balance total');
  eq(after.bank, before.bank, 'bank');
  eq(after.receivable, before.receivable, 'receivable');
  eq(after.advance, before.advance, 'member advances');
  eq(after.cgst, before.cgst, 'GST liability');
  truthy(second.snapshot().ready, 'the second store is ready on return');
});

check('the store is ready and loaded before it is handed back', () => {
  const storage = fakeStorage();
  const first = storeOn(localStorageRepository(storage));
  buildActivity(first);

  // No await, no effect, no tick: the snapshot is complete immediately.
  const second = storeOn(localStorageRepository(storage));
  eq(second.snapshot().ready, true, 'ready');
  truthy(second.snapshot().ledger.all().length > 0, 'and the ledger is already populated');
});

check('an invoice part paid before the reload is still part paid after', () => {
  const storage = fakeStorage();
  const first = storeOn(localStorageRepository(storage));
  const run = buildActivity(first);
  const partPaid = first.snapshot().register.all().find(d => d.status === 'Partly paid');
  if (!partPaid) throw new Error('no part-paid invoice to check');

  const second = storeOn(localStorageRepository(storage));
  const after = second.snapshot().register.get(partPaid.proformaNo);
  eq(after?.status, 'Partly paid', 'status');
  eq(after?.outstanding, partPaid.outstanding, 'outstanding');
  void run;
});

check('receipt allocations survive, so the right invoice is the settled one', () => {
  const storage = fakeStorage();
  const first = storeOn(localStorageRepository(storage));
  buildActivity(first);
  const beforeByFlat = new Map(
    FLATS.map(f => [f.flatNo, outstandingInvoices(first.snapshot().ledger, f.flatNo)
      .map(i => `${i.docRef}:${i.outstanding}`).join('|')]));

  const second = storeOn(localStorageRepository(storage));
  for (const f of FLATS) {
    const after = outstandingInvoices(second.snapshot().ledger, f.flatNo)
      .map(i => `${i.docRef}:${i.outstanding}`).join('|');
    eq(after, beforeByFlat.get(f.flatNo), `${f.flatNo} allocations`);
  }
});

check('vendor liabilities survive the reload', () => {
  const storage = fakeStorage();
  const vendor: SourceVendorInvoice = {
    id: 'VB-1', vendorId: 'V-1', vendorName: 'Force Aqua', category: 'Water tankers',
    amount: 54000, tdsRate: 2, tdsAmount: 1080, netPayable: 52920,
    status: 'Approved', date: '10 Jul 2026',
  };
  const first = createBooksStore({
    config: APPROVED, clock: CLOCK, repository: localStorageRepository(storage),
    vendorInvoices: [vendor], mode: 'demo',
  });
  first.bookApprovedVendorBill('VB-1', 'Treasurer', A.EXP_WATER);
  const payableBefore = first.snapshot().ledger.balanceOf(A.VENDOR_PAYABLE, { party: 'V-1' });
  const tdsBefore = first.snapshot().ledger.balanceOf(A.TDS_PAYABLE_194C);
  eq(payableBefore, R(52920), 'payable before');

  const second = createBooksStore({
    config: APPROVED, clock: CLOCK, repository: localStorageRepository(storage),
    vendorInvoices: [vendor], mode: 'demo',
  });
  eq(second.snapshot().ledger.balanceOf(A.VENDOR_PAYABLE, { party: 'V-1' }), payableBefore, 'payable');
  eq(second.snapshot().ledger.balanceOf(A.TDS_PAYABLE_194C), tdsBefore, 'TDS liability');
  eq(second.snapshot().ledger.balanceOf(A.EXP_WATER), R(54000), 'expense');
});

check('a reload then a further payment keeps the books tying', () => {
  const storage = fakeStorage();
  const first = storeOn(localStorageRepository(storage));
  const run = buildActivity(first);

  const second = storeOn(localStorageRepository(storage));
  const open = second.snapshot().register.all().find(d => d.outstanding > 0);
  if (!open) throw new Error('nothing left open to pay');
  second.recordMemberPayment({
    proformaNo: open.proformaNo, amountRupees: 500,
    receiptNo: 'RCT-AFTER-RELOAD', method: 'UPI', by: 'Manager',
  });

  const third = storeOn(localStorageRepository(storage));
  const result = reconcile(third.snapshot().ledger, '2026-07-01', '2026-12-31');
  const bad = result.checks.filter(c => !c.passed);
  if (bad.length > 0) throw new Error(bad.map(c => c.name).join(', '));
  truthy(third.snapshot().ledger.all().some(e => e.idempotencyKey === 'receipt:RCT-AFTER-RELOAD'),
    'the post-reload receipt is in the third store');
  void run;
});

check('three reloads in a row do not multiply anything', () => {
  const storage = fakeStorage();
  const first = storeOn(localStorageRepository(storage));
  buildActivity(first);
  const baseline = fingerprint(first);
  for (let i = 0; i < 3; i++) {
    const reloaded = storeOn(localStorageRepository(storage));
    const f = fingerprint(reloaded);
    eq(f.entries, baseline.entries, `entries after reload ${i + 1}`);
    eq(f.totalDebit, baseline.totalDebit, `trial balance after reload ${i + 1}`);
  }
});

// --- seed migration -------------------------------------------------------

suite('Seed data imports once');

const SEED: readonly SourceInvoice[] = [
  {
    id: 's1', invoiceNo: 'GM-2026-06-B204', flatNo: 'B-204', name: 'Rohan Mehta',
    period: 'Jun 2026', maintenance: 2500, sinkingFund: 500, waterCharges: 300,
    parkingCharges: 0, nonOccupancyCharges: 0, latePenalty: 0, gst: 0, total: 3300,
    status: 'Overdue', dueDate: '10 Jun 2026',
  },
  {
    id: 's2', invoiceNo: 'GM-2026-06-A101', flatNo: 'A-101', name: 'Priya Nair',
    period: 'Jun 2026', maintenance: 2500, sinkingFund: 500, waterCharges: 300,
    parkingCharges: 0, nonOccupancyCharges: 0, latePenalty: 0, gst: 0, total: 3300,
    status: 'Paid', dueDate: '10 Jun 2026', paidDate: '05 Jun 2026', paymentMethod: 'UPI',
  },
];

check('a seed imports on the first run', () => {
  const store = storeOn(memoryRepository());
  const result = store.importSeedOnce('demo-invoices', SEED);
  truthy(result.imported, result.why);
  truthy(result.entriesAdded > 0, 'entries added');
  truthy(store.snapshot().migrationsApplied.includes('demo-invoices'), 'recorded as applied');
});

check('the same seed does not import twice in one session', () => {
  const store = storeOn(memoryRepository());
  const first = store.importSeedOnce('demo-invoices', SEED);
  const before = store.snapshot().ledger.all().length;
  const second = store.importSeedOnce('demo-invoices', SEED);
  truthy(!second.imported, 'the second attempt declined');
  truthy(/already imported/.test(second.why), second.why);
  eq(store.snapshot().ledger.all().length, before, 'no entries added');
  void first;
});

check('the same seed does not import again after a reload', () => {
  const storage = fakeStorage();
  const first = storeOn(localStorageRepository(storage));
  first.importSeedOnce('demo-invoices', SEED);
  const before = fingerprint(first);

  const second = storeOn(localStorageRepository(storage));
  truthy(second.snapshot().migrationsApplied.includes('demo-invoices'), 'the record survived');
  const result = second.importSeedOnce('demo-invoices', SEED);
  truthy(!result.imported, 'declined after the reload');
  eq(fingerprint(second).entries, before.entries, 'entry count unchanged');
  eq(fingerprint(second).totalDebit, before.totalDebit, 'trial balance unchanged');
});

check('a seed is skipped when the ledger already holds postings', () => {
  const store = storeOn(memoryRepository());
  buildActivity(store);
  const before = store.snapshot().ledger.all().length;
  const result = store.importSeedOnce('demo-invoices', SEED);
  truthy(!result.imported, 'declined');
  truthy(/already holds/.test(result.why), result.why);
  eq(store.snapshot().ledger.all().length, before, 'nothing added on top');
});

check('production mode never imports a demo seed', () => {
  const store = storeOn(memoryRepository(), 'production');
  const result = store.importSeedOnce('demo-invoices', SEED);
  truthy(!result.imported, 'declined');
  truthy(/production mode/.test(result.why), result.why);
  eq(store.snapshot().ledger.all().length, 0, 'ledger untouched');
});

// --- mode separation ------------------------------------------------------

suite('Demo and production books stay apart');

check('demo books do not load into a production store', () => {
  const storage = fakeStorage();
  const demo = storeOn(localStorageRepository(storage), 'demo');
  buildActivity(demo);
  truthy(demo.snapshot().ledger.all().length > 0, 'demo has postings');

  const production = storeOn(localStorageRepository(storage), 'production');
  eq(production.snapshot().ledger.all().length, 0, 'the production store is empty');
  truthy(production.snapshot().problems.some(p => /written in demo mode/.test(p)),
    'and it says why');
});

check('exported demo books cannot be imported into production', () => {
  const demo = storeOn(memoryRepository(), 'demo');
  buildActivity(demo);
  const json = demo.exportJson();
  const production = storeOn(memoryRepository(), 'production');
  throws(() => production.importJson(json), /holds demo books/, 'cross-mode import');
});

check('export and re-import returns the same books', () => {
  const source = storeOn(memoryRepository());
  buildActivity(source);
  const before = fingerprint(source);
  const json = source.exportJson();

  const target = storeOn(memoryRepository());
  const result = target.importJson(json);
  eq(result.entriesRestored, before.entries, 'entries restored');
  eq(fingerprint(target).totalDebit, before.totalDebit, 'trial balance');
  eq(fingerprint(target).receivable, before.receivable, 'receivable');
});

// --- storage failure ------------------------------------------------------

suite('Storage failure is reported, not hidden');

check('a failed write is surfaced instead of appearing to save', () => {
  const storage = fakeStorage();
  const store = storeOn(localStorageRepository(storage));
  storage.failNextWrite();
  store.depositAdvance({
    flatNo: 'A-101', amountRupees: 1000, receiptNo: 'ADV-FAIL', method: 'UPI', by: 'R',
  });
  truthy(store.snapshot().saveError !== null, 'the save error is recorded');
  truthy(store.snapshot().problems.some(p => /could not be saved/.test(p)), 'and surfaced');
});

check('a store whose storage throws on every write still runs in memory', () => {
  const broken: KeyValueStore = {
    getItem: () => null,
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  // resolveRepository probes the store and falls back to memory.
  const repository = resolveRepository(broken);
  truthy(!repository.isDurable(), 'reports itself as not durable');
  truthy(/memory/i.test(repository.describe()), `describe says so: ${repository.describe()}`);
  const store = storeOn(repository);
  buildActivity(store);
  truthy(store.snapshot().ledger.all().length > 0, 'the session still works');
  truthy(!store.snapshot().durable, 'and the screens can tell it is not durable');
});

check('no storage at all gives a memory repository, not a crash', () => {
  const repository = resolveRepository(undefined);
  truthy(!repository.isDurable(), 'not durable');
  const store = storeOn(repository);
  buildActivity(store);
  truthy(store.snapshot().ledger.all().length > 0, 'still usable');
});

check('a corrupt stored value is reported and the file left in place', () => {
  const storage = fakeStorage();
  storage.setItem('sb_books_snapshot_v3', '{ this is not json');
  const store = storeOn(localStorageRepository(storage));
  eq(store.snapshot().ledger.all().length, 0, 'nothing loaded');
  truthy(store.snapshot().ready, 'but the store is ready rather than stuck');
  eq(storage.getItem('sb_books_snapshot_v3'), '{ this is not json',
     'the unreadable value was not deleted');
});

check('reset clears the saved books', () => {
  const storage = fakeStorage();
  const store = storeOn(localStorageRepository(storage));
  buildActivity(store);
  truthy(store.snapshot().ledger.all().length > 0, 'something posted');
  store.resetToEmpty();
  eq(store.snapshot().ledger.all().length, 0, 'ledger empty');

  const reloaded = storeOn(localStorageRepository(storage));
  eq(reloaded.snapshot().ledger.all().length, 0, 'and it stays empty across a reload');
});

// --- report ---------------------------------------------------------------

console.log('\n' + '='.repeat(66));
if (failures.length === 0) {
  console.log(`ALL ${passed} PERSISTENCE CHECKS PASSED`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log('  - ' + f);
}
console.log('='.repeat(66));
if (failures.length > 0 && typeof process !== 'undefined') process.exitCode = 1;

void formatRupees; void Ledger; void BillingRegister; void SnapshotError;
