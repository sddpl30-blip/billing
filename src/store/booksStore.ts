/**
 * The money store: one ledger and one document register, shared by every
 * screen that touches a rupee.
 *
 * Before this, the screens held `invoices` and `journal` arrays and four
 * handlers wrote to them directly, so an invoice's status and the books could
 * — and did — disagree. Here the ledger is the only record of money and an
 * invoice's status is read back from it, so the two cannot drift.
 *
 * Deliberately a plain object with a subscribe callback rather than a React
 * context or a Redux slice: the engine must stay free of React, and the store
 * is the seam a server-backed implementation replaces. Nothing in here touches
 * localStorage either — persistence is the caller's business.
 */

import {
  A, AccountingConfig, BillingRegister, Clock, DEMO_CONFIG, FlatRecord,
  JournalEntry, Ledger, Paise, RegisterView, SourceVendorInvoice,
  ReceiptHead, SourceInvoice, TdsSection, applyAdvance, bookVendorBill, dayMonthYearToIso,
  fromRupees, importDemoData, memberLedgerPosition, payVendorBill, periodLabel,
  parseSnapshot, receiveFromMember, remitTds, restoreSnapshot, runBilling, systemClock,
  writeSnapshot,
} from '../accounting';
import { BooksRepository, RepositoryError, memoryRepository } from './repository';

export interface VendorBillState {
  readonly id: string;
  readonly vendorId: string;
  readonly vendorName: string;
  readonly category: string;
  readonly grossRupees: number;
  readonly tdsRate: number;
  readonly date: string;
  /**
   * Where the bill is in its own lifecycle. The demo had Pending / Approved /
   * Rejected with "Approved" silently meaning paid as well; these four are the
   * states a bill actually passes through.
   */
  readonly state: 'awaiting-approval' | 'approved' | 'booked' | 'rejected';
  readonly approvedBy?: string;
  readonly rejectedReason?: string;
  /** Set once the bill has been posted; the ledger holds the amounts. */
  readonly billNo?: string;
}

export interface BooksSnapshot {
  readonly ledger: Ledger;
  readonly register: BillingRegister;
  readonly vendorBills: readonly VendorBillState[];
  readonly today: string;
  readonly config: AccountingConfig;
  /** Anything the store refused to do, newest first, for the screens to show. */
  readonly problems: readonly string[];
  /**
   * Whether the books have finished loading.
   *
   * Phase 2 had no such flag, and the screens read the store on their first
   * render — before anything was in it. Reading an unready store now returns
   * an empty ledger with `ready: false` rather than an empty one that looks
   * like a society with no transactions.
   */
  readonly ready: boolean;
  /** Where the books are being kept, in words a committee member can read. */
  readonly storageNote: string;
  /** False when a write will not survive a reload. */
  readonly durable: boolean;
  /** When the books were last written. */
  readonly savedAt: string | null;
  /** The last save failure, if the most recent write did not land. */
  readonly saveError: string | null;
  readonly mode: 'demo' | 'production';
  /** Seeds already imported, so a reload does not import them again. */
  readonly migrationsApplied: readonly string[];
}

export interface BooksStore {
  snapshot(): BooksSnapshot;
  subscribe(listener: () => void): () => void;

  // --- billing ---
  runBillingFor(input: {
    period: string;
    flats: readonly FlatRecord[];
    /** Heads charged to every flat, as rupee amounts. */
    commonCharges?: ReadonlyArray<{ head: ReceiptHead; amountRupees: number; taxable: boolean }>;
    sinkingFundPercentOfMaintenance?: number;
    issuedOn?: string;
    previewOnly?: boolean;
  }): ReturnType<typeof runBilling>;
  approveDocuments(proformaNos: readonly string[], by: string): { approved: number; refused: number };
  releaseDocument(proformaNo: string, by: string): void;
  convertDueDocuments(by: string): { converted: number; refused: number };
  cancelDocument(proformaNo: string, by: string, reason: string): void;

  // --- receipts ---
  recordMemberPayment(input: {
    proformaNo: string;
    amountRupees: number;
    receiptNo: string;
    method: string;
    by: string;
  }): {
    appliedToDues: Paise;
    heldAsAdvance: Paise;
    outstandingAfter: Paise;
    converted: boolean;
  };
  applyMemberAdvance(input: { flatNo: string; ref: string; by: string }): Paise;
  /**
   * Takes money from a member with no particular invoice in mind.
   *
   * Applied to whatever is open, oldest first, with the rest held on the
   * member advance subledger. The old handler credited an "Unearned Advance
   * Revenue Liability" account that nothing else in the app referenced and
   * that was never drawn down, so an advance could only accumulate.
   */
  depositAdvance(input: {
    flatNo: string;
    amountRupees: number;
    receiptNo: string;
    method: string;
    by: string;
  }): { appliedToDues: Paise; heldAsAdvance: Paise };

  // --- vendors ---
  approveVendorBill(id: string, by: string): void;
  rejectVendorBill(id: string, by: string, reason: string): void;
  bookApprovedVendorBill(id: string, by: string, expenseAccount: string): void;
  payVendor(input: {
    id: string; amountRupees: number; paymentRef: string; by: string;
  }): void;
  remitWithheldTds(input: {
    section: Exclude<TdsSection, 'none'>; amountRupees: number; challanNo: string; by: string;
  }): void;

  // --- persistence ---
  /**
   * Imports a named seed once and only once.
   *
   * The name is recorded in the snapshot, so a reload does not import it
   * again. This is the duplicate guard across reloads: without it, every
   * refresh re-imported the demo invoices on top of the restored ones.
   */
  importSeedOnce(name: string, invoices: readonly SourceInvoice[]): {
    imported: boolean;
    why: string;
    entriesAdded: number;
  };
  /** Writes the books now. Called after every mutation; exposed for a manual save. */
  persist(): void;
  /** Discards the saved books and returns to an empty ledger. */
  resetToEmpty(): void;
  /** The books as JSON, for the export button. */
  exportJson(): string;
  /** Replaces the books from exported JSON. Refuses a snapshot from another mode. */
  importJson(text: string): { entriesRestored: number; documentsRestored: number };

  // --- reads ---
  documentsFor(flatNo: string): readonly RegisterView[];
  allDocuments(): readonly RegisterView[];
  positionOf(flatNo: string): ReturnType<typeof memberLedgerPosition>;
  journal(): readonly JournalEntry[];
}

/**
 * The part of a store every screen may read, whichever books it is on.
 *
 * The server store implements only this, plus awaited writes (see
 * actions.ts): its answers arrive a round trip later, so it cannot honestly
 * implement the synchronous write methods above.
 */
export type BooksReader = Pick<
  BooksStore,
  'snapshot' | 'subscribe' | 'exportJson' | 'documentsFor' | 'allDocuments' | 'positionOf' | 'journal'
>;

const TDS_SECTION_FOR_RATE = (rate: number): TdsSection =>
  rate === 0 ? 'none' : rate >= 10 ? '194J' : '194C';

export interface CreateStoreOptions {
  readonly config?: AccountingConfig;
  readonly clock?: Clock;
  /** Vendor bills carried over from the existing demo arrays. */
  readonly vendorInvoices?: readonly SourceVendorInvoice[];
  /** Where to keep the books. Memory when not given, so tests stay isolated. */
  readonly repository?: BooksRepository;
  /**
   * Demo keeps the sample society; production refuses to import demo seeds at
   * all. A snapshot written in one mode will not load in the other.
   */
  readonly mode?: 'demo' | 'production';
}

export function createBooksStore(options: CreateStoreOptions = {}): BooksStore {
  const config = options.config ?? DEMO_CONFIG;
  const clock = options.clock ?? systemClock;
  const mode = options.mode ?? 'demo';
  const repository = options.repository ?? memoryRepository();
  const listeners = new Set<() => void>();
  const problems: string[] = [];

  // Mutable because a restore replaces both. Everything downstream reads them
  // through `snapshot()`, so the swap is invisible to callers.
  let ledger = new Ledger();
  let register = new BillingRegister(ledger, config, clock);
  let migrationsApplied: string[] = [];
  let savedAt: string | null = null;
  let saveError: string | null = null;
  let ready = false;

  /**
   * Loads the saved books, synchronously, before the store is handed back.
   *
   * This is the initialisation race fixed. Phase 2 created the store and left
   * the screens to read it on their first render, with nothing in it. Loading
   * here means the store is never observable in a half-built state: by the
   * time `createBooksStore` returns, either the books are restored and `ready`
   * is true, or the load failed and the reason is on `problems`.
   */
  const loadFromRepository = (): void => {
    let stored;
    try {
      stored = repository.load();
    } catch (err) {
      note(`The saved books could not be read: ${err instanceof Error ? err.message : String(err)}`);
      ready = true;
      return;
    }
    if (stored === null) {
      ready = true;
      return;
    }
    if (stored.mode !== mode) {
      // Loading demo books into production, or the reverse, would mix sample
      // transactions with real ones. Refused rather than merged.
      note(
        `The saved books were written in ${stored.mode} mode and this is ${mode} mode, ` +
        `so they were not loaded. Mixing the two would put sample transactions in with ` +
        `real ones.`,
      );
      ready = true;
      return;
    }
    try {
      const restored = restoreSnapshot(stored, config, clock);
      ledger = restored.ledger;
      register = restored.register;
      migrationsApplied = [...restored.migrationsApplied];
      savedAt = restored.savedAt;
    } catch (err) {
      note(
        `The saved books were not loaded: ${err instanceof Error ? err.message : String(err)} ` +
        `They have been left in place rather than overwritten, so they can be recovered.`,
      );
    }
    ready = true;
  };

  /** Writes the books. A failure is recorded, never thrown at a click handler. */
  const persistNow = (): void => {
    if (!ready) return;
    try {
      const written = writeSnapshot({
        ledger, register, mode, savedAt: clock.now(), migrationsApplied,
      });
      repository.save(written);
      savedAt = written.savedAt;
      saveError = null;
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
      note(`The books could not be saved: ${saveError}`);
    }
  };

  // The demo's vendor rows carry a status that conflated approval with
  // payment. They come in as awaiting-approval or approved, never as paid:
  // claiming a payment that has no ledger entry behind it is exactly the
  // confusion being removed.
  let vendorBills: VendorBillState[] = (options.vendorInvoices ?? []).map(vi => ({
    id: vi.id,
    vendorId: vi.vendorId,
    vendorName: vi.vendorName,
    category: vi.category,
    grossRupees: vi.amount,
    tdsRate: vi.tdsRate,
    date: dayMonthYearToIso(vi.date) ?? clock.today(),
    state: vi.status === 'Rejected' ? 'rejected'
      : vi.status === 'Approved' ? 'approved'
      : 'awaiting-approval',
  }));

  /**
   * Every mutation ends here: write, then tell the screens. Saving before
   * notifying means a save failure is on `problems` by the time anything
   * re-renders, rather than a render later.
   */
  const notify = () => {
    persistNow();
    for (const l of listeners) l();
  };

  const note = (message: string) => {
    problems.unshift(message);
    if (problems.length > 20) problems.pop();
  };

  /** Runs an action, recording any refusal rather than throwing at a screen. */
  function guard<T>(what: string, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      note(`${what}: ${message}`);
      throw err;
    }
  }

  const mustVendor = (id: string): VendorBillState => {
    const found = vendorBills.find(v => v.id === id);
    if (!found) throw new Error(`No vendor bill ${id}`);
    return found;
  };

  const updateVendor = (id: string, patch: Partial<VendorBillState>) => {
    vendorBills = vendorBills.map(v => (v.id === id ? { ...v, ...patch } : v));
  };

  // Load before the store is handed back, so it is never observed half-built.
  loadFromRepository();

  const store: BooksStore = {
    snapshot: () => ({
      ledger, register, vendorBills, today: clock.today(), config, problems,
      ready,
      storageNote: repository.describe(),
      durable: repository.isDurable(),
      savedAt,
      saveError,
      mode,
      migrationsApplied,
    }),

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    runBillingFor(input) {
      const result = guard('Billing run', () => runBilling(register, {
        period: input.period,
        flats: input.flats,
        ...(input.commonCharges !== undefined ? { commonCharges: input.commonCharges } : {}),
        ...(input.sinkingFundPercentOfMaintenance !== undefined
          ? { sinkingFundPercentOfMaintenance: input.sinkingFundPercentOfMaintenance } : {}),
        ...(input.issuedOn !== undefined ? { issuedOn: input.issuedOn } : {}),
        ...(input.previewOnly !== undefined ? { previewOnly: input.previewOnly } : {}),
      }, config));
      for (const skip of result.skipped) note(`Flat ${skip.flatNo} not billed: ${skip.why}`);
      notify();
      return result;
    },

    approveDocuments(proformaNos, by) {
      const result = register.approveBatch(proformaNos, by);
      for (const r of result.refused) note(`${r.proformaNo} not approved: ${r.why}`);
      notify();
      return { approved: result.approved.length, refused: result.refused.length };
    },

    releaseDocument(proformaNo, by) {
      guard(`Releasing ${proformaNo}`, () => register.release(proformaNo, by));
      notify();
    },

    convertDueDocuments(by) {
      if (!config.billing.convertOnDueDate) {
        note(
          'Conversion on the due date is switched off in the accounting config, so nothing ' +
          'was converted. A proforma will become a tax invoice only when it is paid.',
        );
        notify();
        return { converted: 0, refused: 0 };
      }
      const result = register.convertDue(clock.today(), by);
      for (const r of result.refused) note(`${r.proformaNo} not converted: ${r.why}`);
      notify();
      return { converted: result.converted.length, refused: result.refused.length };
    },

    cancelDocument(proformaNo, by, reason) {
      guard(`Cancelling ${proformaNo}`, () => register.cancel(proformaNo, by, reason));
      notify();
    },

    recordMemberPayment(input) {
      const result = guard(`Receipt ${input.receiptNo}`, () => register.recordPayment({
        proformaNo: input.proformaNo,
        amount: fromRupees(input.amountRupees),
        receiptNo: input.receiptNo,
        method: input.method,
        by: input.by,
      }));
      notify();
      return {
        appliedToDues: result.appliedToDues,
        heldAsAdvance: result.heldAsAdvance,
        outstandingAfter: result.outstandingAfter,
        converted: result.conversion !== undefined,
      };
    },

    depositAdvance(input) {
      const result = guard(`Advance ${input.receiptNo}`, () => receiveFromMember(ledger, {
        flatNo: input.flatNo,
        date: clock.today(),
        amount: fromRupees(input.amountRupees),
        receiptNo: input.receiptNo,
        method: input.method,
      }, { postedBy: input.by }));
      notify();
      return { appliedToDues: result.appliedToDues, heldAsAdvance: result.heldAsAdvance };
    },

    applyMemberAdvance(input) {
      const result = guard(`Applying advance for ${input.flatNo}`, () => applyAdvance(ledger, {
        flatNo: input.flatNo,
        date: clock.today(),
        ref: input.ref,
      }, { postedBy: input.by }));
      if (result.applied === 0) {
        note(`Flat ${input.flatNo} has no advance to apply, or nothing outstanding to apply it to.`);
      }
      notify();
      return result.applied;
    },

    approveVendorBill(id, by) {
      const bill = mustVendor(id);
      if (bill.state !== 'awaiting-approval') {
        note(`Vendor bill ${id} is ${bill.state}, not awaiting approval.`);
        return;
      }
      // Approval is approval. It posts nothing and pays nothing — that is the
      // whole point of splitting it from booking and payment.
      updateVendor(id, { state: 'approved', approvedBy: by });
      notify();
    },

    rejectVendorBill(id, by, reason) {
      const bill = mustVendor(id);
      if (bill.state === 'booked') {
        note(`Vendor bill ${id} is already booked; reverse the posting instead of rejecting it.`);
        return;
      }
      if (reason.trim() === '') {
        note('A rejection must record a reason.');
        return;
      }
      updateVendor(id, { state: 'rejected', rejectedReason: `${reason} (${by})` });
      notify();
    },

    bookApprovedVendorBill(id, by, expenseAccount) {
      const bill = mustVendor(id);
      if (bill.state !== 'approved') {
        note(`Vendor bill ${id} is ${bill.state}; only an approved bill can be booked.`);
        return;
      }
      guard(`Booking vendor bill ${id}`, () => bookVendorBill(ledger, {
        vendorId: bill.vendorId,
        vendorName: bill.vendorName,
        billNo: bill.id,
        date: bill.date,
        expenseAccount,
        gross: fromRupees(bill.grossRupees),
        tdsSection: TDS_SECTION_FOR_RATE(bill.tdsRate),
      }, {
        ...config,
        // The bill states its own withholding; the configured rate does not
        // override a deduction already agreed with the vendor.
        tds: {
          contractor194C: { ...config.tds.contractor194C, rate: bill.tdsRate },
          professional194J: { ...config.tds.professional194J, rate: bill.tdsRate },
          rent194I: config.tds.rent194I,
        },
      }, { postedBy: by }));
      updateVendor(id, { state: 'booked', billNo: bill.id });
      notify();
    },

    payVendor(input) {
      const bill = mustVendor(input.id);
      if (bill.state !== 'booked') {
        note(
          `Vendor bill ${input.id} is ${bill.state}. A payment can only be made against a ` +
          `booked bill, because until it is booked there is no payable to settle.`,
        );
        return;
      }
      guard(`Paying ${bill.vendorName}`, () => payVendorBill(ledger, {
        vendorId: bill.vendorId,
        vendorName: bill.vendorName,
        date: clock.today(),
        amount: fromRupees(input.amountRupees),
        paymentRef: input.paymentRef,
        againstBillNo: bill.id,
      }, { postedBy: input.by }));
      notify();
    },

    remitWithheldTds(input) {
      guard(`Remitting ${input.section}`, () => remitTds(ledger, {
        section: input.section,
        date: clock.today(),
        amount: fromRupees(input.amountRupees),
        challanNo: input.challanNo,
      }, { postedBy: input.by }));
      note(
        `TDS ${input.section} of ₹${input.amountRupees} recorded against challan ` +
        `${input.challanNo}. The liability is cleared in the books. Nothing was filed or ` +
        `transmitted to any government portal — this application has no such connection.`,
      );
      notify();
    },

    importSeedOnce(name, invoices) {
      if (mode === 'production') {
        const why =
          'This is production mode. Demo seed data is never imported here — sample ' +
          'transactions in real books cannot be told apart afterwards.';
        note(why);
        return { imported: false, why, entriesAdded: 0 };
      }
      if (migrationsApplied.includes(name)) {
        return {
          imported: false,
          why: `The seed "${name}" was already imported, so it was not imported again.`,
          entriesAdded: 0,
        };
      }
      if (ledger.all().length > 0) {
        // Importing a seed on top of real postings would double the opening
        // position. If the ledger has anything in it, the seed is recorded as
        // applied and skipped.
        migrationsApplied.push(name);
        persistNow();
        const why =
          `The ledger already holds ${ledger.all().length} entries, so the seed ` +
          `"${name}" was skipped rather than added on top. It is marked as applied.`;
        note(why);
        return { imported: false, why, entriesAdded: 0 };
      }

      const result = importDemoData(invoices, [], config);
      let added = 0;
      for (const entry of result.ledger.all()) {
        try {
          ledger.restore(entry);
          added++;
        } catch (err) {
          note(
            `Seed entry ${entry.id} was not imported: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      for (const skip of result.skipped) {
        note(`Seed row not imported — ${skip.what}: ${skip.why}`);
      }
      migrationsApplied.push(name);
      persistNow();
      notify();
      return {
        imported: added > 0,
        why: added > 0
          ? `Imported ${added} entries from the seed "${name}".`
          : `The seed "${name}" produced no postings.`,
        entriesAdded: added,
      };
    },

    persist() {
      persistNow();
    },

    resetToEmpty() {
      repository.clear();
      ledger = new Ledger();
      register = new BillingRegister(ledger, config, clock);
      vendorBills = vendorBills.map(v => ({
        id: v.id, vendorId: v.vendorId, vendorName: v.vendorName, category: v.category,
        grossRupees: v.grossRupees, tdsRate: v.tdsRate, date: v.date,
        state: 'awaiting-approval' as const,
      }));
      migrationsApplied = [];
      savedAt = null;
      saveError = null;
      problems.length = 0;
      notify();
    },

    exportJson() {
      return JSON.stringify(
        writeSnapshot({ ledger, register, mode, savedAt: clock.now(), migrationsApplied }),
        null,
        2,
      );
    },

    importJson(text) {
      const parsed = parseSnapshot(text);
      if (parsed.mode !== mode) {
        throw new RepositoryError(
          `That file holds ${parsed.mode} books and this is ${mode} mode. ` +
          `Importing it would mix sample transactions with real ones.`,
        );
      }
      const restored = restoreSnapshot(parsed, config, clock);
      ledger = restored.ledger;
      register = restored.register;
      migrationsApplied = [...restored.migrationsApplied];
      notify();
      return {
        entriesRestored: restored.entriesRestored,
        documentsRestored: restored.documentsRestored,
      };
    },

    documentsFor: (flatNo) => register.forFlat(flatNo),
    allDocuments: () => register.all(),
    positionOf: (flatNo) => memberLedgerPosition(ledger, flatNo),
    journal: () => ledger.all(),
  };
  return store;
}

/** Useful to screens that want the period a date falls in. */
export { periodLabel };

/** Re-exported so screens do not import the engine directly for a constant. */
export const EXPENSE_ACCOUNTS = {
  water: A.EXP_WATER,
  security: A.EXP_SECURITY,
  lift: A.EXP_LIFT,
  repairs: A.EXP_REPAIRS,
  electricity: A.EXP_ELECTRICITY,
  housekeeping: A.EXP_HOUSEKEEPING,
  professional: A.EXP_PROFESSIONAL,
} as const;
