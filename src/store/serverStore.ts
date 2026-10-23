/**
 * The books, read from the server.
 *
 * This implements the same `BooksStore` interface the screens already use, so
 * the UI does not know which one it has. Reads come from one snapshot endpoint
 * and are rehydrated into the engine's own `Ledger` and `BillingRegister` —
 * the objects the screens already render — and writes go to the API and then
 * refetch.
 *
 * Why rehydrate rather than render server JSON directly: every derived figure
 * in this application already comes from the engine (a document's status, a
 * member's position, the statements), and those functions take a ledger. Feed
 * them a ledger built from the server's postings and the whole of the existing
 * UI is server-driven without being rewritten — and it is the same arithmetic
 * on both sides, not two implementations that have to agree.
 *
 * What is deliberately not here: any local persistence. There is no
 * localStorage in this file. A write that the server refused did not happen,
 * and there is nothing kept on the device to disagree with it.
 */

import {
  BillingRegister, Ledger, memberLedgerPosition, periodLabel,
  type AccountingConfig, type Clock, type JournalEntry, type Paise, type RegisterView,
  type SourceInvoice,
} from '../accounting';
import { DEMO_CONFIG } from '../accounting/config';
import type { BooksSnapshot, BooksStore, VendorBillState } from './booksStore';
import type { ApiClient } from '../api/client';
import type { SnapshotResponse } from '../api/client';

export interface ServerStoreOptions {
  readonly client: ApiClient;
  readonly clock: Clock;
  /** Called with anything the server refused, so a screen can show it. */
  readonly onProblem?: (message: string) => void;
}

/** What the server reported, beyond what `BooksSnapshot` carries. */
export interface ServerContext {
  readonly societyName: string;
  readonly registrationNo: string | null;
  /** Null when the association has not recorded one. Shown as such. */
  readonly gstin: string | null;
  readonly scope: 'society' | 'own-flats';
  readonly email: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly flats: SnapshotResponse['flats'];
  readonly settings: SnapshotResponse['settings'];
  readonly rate: SnapshotResponse['rate'];
}

export interface ServerBooksStore extends BooksStore {
  /** Fetches the books. Called once at start-up and after every write. */
  refresh(): Promise<void>;
  /** The server-side facts the screens need that a local store has no notion of. */
  context(): ServerContext | null;
  /** True while a write is in flight, for a screen to disable a button. */
  readonly busy: boolean;
  /** A PDF of a document, from the server. */
  invoicePdf(proformaNo: string): Promise<Blob>;
  receiptPdf(receiptNo: string): Promise<Blob>;
}

const UNSUPPORTED =
  'Not available when the books are on the server: that is a local-demo action.';

export function createServerStore(options: ServerStoreOptions): ServerBooksStore {
  // The same configuration object the local store uses. It carries tax rates
  // and the sinking-fund treatment; the server is the authority on both and
  // sends its own in the snapshot, so this is only what the engine needs to
  // rebuild a ledger from postings that are already decided.
  const config: AccountingConfig = DEMO_CONFIG;
  let ledger = new Ledger();
  let register = new BillingRegister(ledger, config, options.clock);
  let vendorBills: VendorBillState[] = [];
  let context: ServerContext | null = null;
  let ready = false;
  let busy = false;
  let problems: string[] = [];
  let savedAt: string | null = null;
  let loadError: string | null = null;
  /** Document id per proforma number, so a write can name what the server wants. */
  const documentIds = new Map<string, string>();
  const paymentIds = new Map<string, string>();
  const flatIds = new Map<string, string>();

  const listeners = new Set<() => void>();
  const notify = (): void => { for (const listener of listeners) listener(); };

  const problem = (message: string): void => {
    problems = [message, ...problems].slice(0, 20);
    options.onProblem?.(message);
    notify();
  };

  const snapshot = (): BooksSnapshot => ({
    ledger,
    register,
    vendorBills,
    today: options.clock.today(),
    config,
    problems,
    ready,
    storageNote: context === null
      ? 'Connecting to the SocietyBooks server.'
      : `PostgreSQL, through the SocietyBooks API (${context.societyName}` +
        `${context.scope === 'own-flats' ? ', your flats only' : ''}).`,
    // Durable because the server wrote it to a database inside a transaction
    // before answering. Nothing here is waiting to be saved.
    durable: true,
    savedAt,
    saveError: loadError,
    mode: context?.settings === undefined ? 'production' : (contextMode()),
    migrationsApplied: [],
  });

  const contextMode = (): 'demo' | 'production' => serverMode;
  let serverMode: 'demo' | 'production' = 'production';

  async function refresh(): Promise<void> {
    try {
      const view = await options.client.get<SnapshotResponse>('/api/books/snapshot');

      // A fresh ledger and register every time. Restoring into the existing
      // ones would refuse — `restore` rejects an id it already holds, which is
      // the guard that stops a snapshot being loaded twice — and merging two
      // sets of documents is how a flat ends up with two live ones.
      const nextLedger = new Ledger();
      const nextRegister = new BillingRegister(nextLedger, config, options.clock);

      const rejected: string[] = [];
      for (const entry of view.entries as readonly JournalEntry[]) {
        try {
          nextLedger.restore(entry);
        } catch (err) {
          // Named, not swallowed. An entry the engine refuses is a real
          // disagreement between the server and the engine's rules, and a
          // silently shorter ledger would show wrong totals.
          rejected.push(err instanceof Error ? err.message : String(err));
        }
      }

      try {
        nextRegister.restoreDocuments(
          view.documents as Parameters<BillingRegister['restoreDocuments']>[0],
          view.taxInvoiceSequence,
        );
      } catch (err) {
        rejected.push(err instanceof Error ? err.message : String(err));
      }

      ledger = nextLedger;
      register = nextRegister;
      vendorBills = view.vendorBills.map(bill => ({
        id: bill.id,
        vendorId: bill.vendorId,
        vendorName: bill.vendorName,
        category: bill.category,
        grossRupees: bill.grossRupees,
        tdsRate: bill.tdsRate,
        date: bill.date,
        state: bill.state,
        ...(bill.approvedBy === undefined ? {} : { approvedBy: bill.approvedBy }),
        ...(bill.rejectedReason === undefined ? {} : { rejectedReason: bill.rejectedReason }),
        ...(bill.billNo === undefined ? {} : { billNo: bill.billNo }),
      }));
      serverMode = view.mode;
      context = {
        societyName: view.societyName,
        registrationNo: view.registrationNo,
        gstin: view.gstin,
        scope: view.scope,
        email: view.email,
        roles: view.roles,
        permissions: view.permissions,
        flats: view.flats,
        settings: view.settings,
        rate: view.rate,
      };

      flatIds.clear();
      for (const flat of view.flats) flatIds.set(flat.flatNo, flat.id);
      documentIds.clear();
      for (const document of view.documents as ReadonlyArray<{ proformaNo: string; id?: string }>) {
        if (typeof document.id === 'string') documentIds.set(document.proformaNo, document.id);
      }

      ready = true;
      savedAt = new Date().toISOString();
      loadError = null;
      if (rejected.length > 0) {
        problem(
          `The server sent ${rejected.length} ${rejected.length === 1 ? 'record' : 'records'} ` +
          `the accounting engine refused: ${rejected[0]}`,
        );
      }
      notify();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      ready = false;
      problem(`Could not read the books from the server: ${loadError}`);
    }
  }

  /** Looks up the server's id for a document, refreshing once if it is new. */
  async function documentId(proformaNo: string): Promise<string> {
    const known = documentIds.get(proformaNo);
    if (known !== undefined) return known;
    await refresh();
    const found = documentIds.get(proformaNo);
    if (found === undefined) {
      throw new Error(`The server does not have a document numbered ${proformaNo}.`);
    }
    return found;
  }

  /** Runs a write, keeps the busy flag honest, and refetches afterwards. */
  async function write<T>(what: string, body: () => Promise<T>): Promise<T> {
    busy = true;
    notify();
    try {
      const result = await body();
      await refresh();
      return result;
    } catch (err) {
      problem(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      busy = false;
      notify();
    }
  }

  /**
   * The documents endpoint, for the ids the snapshot does not carry.
   *
   * The snapshot is engine-shaped and the engine's documents have no server
   * id, so this fills the map from the listing. Called lazily, because most
   * sessions never write.
   */
  async function loadDocumentIds(): Promise<void> {
    const listing = await options.client.get<{
      documents: ReadonlyArray<{ id: string; proformaNo: string }>;
    }>('/api/billing/documents');
    for (const document of listing.documents) {
      documentIds.set(document.proformaNo, document.id);
    }
  }

  async function loadPaymentIds(): Promise<void> {
    const listing = await options.client.get<{
      payments: ReadonlyArray<{ id: string; receiptNo: string }>;
    }>('/api/payments');
    for (const payment of listing.payments) paymentIds.set(payment.receiptNo, payment.id);
  }

  const store: ServerBooksStore = {
    snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    get busy() { return busy; },

    context: () => context,

    refresh,

    // --- billing ----------------------------------------------------------

    runBillingFor(input) {
      // The server runs the billing cycle. The local engine's `runBilling`
      // return shape is what the screens read, so this returns the empty shape
      // and the figures arrive with the refresh — the alternative is computing
      // a preview here that might differ from what the server then does.
      void write('Billing run', async () => {
        const period = input.period;
        const issuedOn = input.issuedOn ?? options.clock.today();
        const result = await options.client.post<{
          issued: ReadonlyArray<{ flatNo: string; gross: number }>;
          skipped: ReadonlyArray<{ flatNo: string; why: string }>;
        }>('/api/billing/run', { period, issuedOn });
        for (const skipped of result.skipped) {
          problem(`${skipped.flatNo}: ${skipped.why}`);
        }
        await loadDocumentIds();
        return result;
      });
      return { period: input.period, documents: [], skipped: [], totals: { net: 0, tax: 0, gross: 0 } } as unknown as ReturnType<BooksStore['runBillingFor']>;
    },

    approveDocuments(proformaNos) {
      void write('Approval', async () => {
        for (const proformaNo of proformaNos) {
          const id = await documentId(proformaNo);
          await options.client.post(`/api/billing/documents/${id}/approve`, {
            on: options.clock.today(),
          });
        }
      });
      return { approved: proformaNos.length, refused: 0 };
    },

    releaseDocument(proformaNo) {
      void write('Release', async () => {
        const id = await documentId(proformaNo);
        const result = await options.client.post<{ delivered: boolean; note: string }>(
          `/api/billing/documents/${id}/release`,
          { channel: 'email' },
        );
        // The server says whether anything was actually sent. Surfaced either
        // way, because "released" and "delivered" are different claims.
        problem(result.note);
      });
    },

    convertDueDocuments() {
      void write('Conversion', async () => {
        const due = register.all().filter(
          document => (document.state === 'approved' || document.state === 'released')
            && document.dueOn <= options.clock.today(),
        );
        for (const document of due) {
          const id = await documentId(document.proformaNo);
          await options.client.post(`/api/billing/documents/${id}/convert`, {
            on: options.clock.today(),
            because: 'due-date-reached',
          });
        }
      });
      return { converted: 0, refused: 0 };
    },

    cancelDocument(proformaNo, _by, reason) {
      void write('Cancellation', async () => {
        const id = await documentId(proformaNo);
        await options.client.post(`/api/billing/documents/${id}/cancel`, {
          reason, on: options.clock.today(),
        });
      });
    },

    // --- receipts ---------------------------------------------------------

    recordMemberPayment(input) {
      void write('Receipt', async () => {
        const document = register.all().find(d => d.proformaNo === input.proformaNo);
        if (document === undefined) throw new Error(`No document ${input.proformaNo}.`);
        const flatId = flatIds.get(document.flatNo);
        if (flatId === undefined) throw new Error(`No flat ${document.flatNo} on the server.`);

        const documentServerId = await documentId(input.proformaNo);
        // Converted first where it has not been: a payment against a proforma
        // is what raises the tax invoice, and the server will not allocate to
        // a document that has no receivable.
        if (document.state !== 'tax-invoice') {
          await options.client.post(`/api/billing/documents/${documentServerId}/convert`, {
            on: options.clock.today(), because: 'payment-received',
          });
        }

        await options.client.post(
          '/api/payments',
          {
            flatId,
            amountPaise: Math.round(input.amountRupees * 100),
            receivedOn: options.clock.today(),
            method: methodFor(input.method),
            againstDocumentId: documentServerId,
          },
          // The receipt number the screen generated is the idempotency key, so
          // a double-submit of the same payment is one payment.
          { idempotencyKey: `ui-receipt-${input.receiptNo}` },
        );
      });
      return { appliedToDues: 0, heldAsAdvance: 0, outstandingAfter: 0, converted: false };
    },

    applyMemberAdvance() {
      problem(
        'Applying an advance by hand is not a server action: an advance is applied to the ' +
        'next invoice when it is raised.',
      );
      return 0 as Paise;
    },

    depositAdvance(input) {
      void write('Advance', async () => {
        const flatId = flatIds.get(input.flatNo);
        if (flatId === undefined) throw new Error(`No flat ${input.flatNo} on the server.`);
        await options.client.post(
          '/api/payments',
          {
            flatId,
            amountPaise: Math.round(input.amountRupees * 100),
            receivedOn: options.clock.today(),
            method: methodFor(input.method),
          },
          { idempotencyKey: `ui-advance-${input.receiptNo}` },
        );
      });
      return { appliedToDues: 0, heldAsAdvance: 0 };
    },

    // --- vendors ----------------------------------------------------------

    approveVendorBill(id) {
      void write('Vendor approval', () => options.client.post(`/api/vendor-bills/${id}/approve`));
    },

    rejectVendorBill(id, _by, reason) {
      // There is no reject endpoint: a bill is rejected by recording why, and
      // the server has no route for it yet. Said rather than pretended.
      problem(
        `Rejecting bill ${id} is not yet a server action (${reason}). Nothing was changed.`,
      );
    },

    bookApprovedVendorBill(id, _by, _expenseAccount) {
      void write('Vendor booking', () => options.client.post(`/api/vendor-bills/${id}/book`, {
        on: options.clock.today(),
      }));
    },

    payVendor(input) {
      void write('Vendor payment', () => options.client.post(
        `/api/vendor-bills/${input.id}/pay`,
        {
          amountPaise: Math.round(input.amountRupees * 100),
          paidOn: options.clock.today(),
          method: 'neft',
          paymentRef: input.paymentRef,
        },
        { idempotencyKey: `ui-vendor-${input.paymentRef}` },
      ));
    },

    remitWithheldTds(input) {
      void write('TDS remittance', () => options.client.post(
        `/api/tds/${quarterOf(options.clock.today())}/remit`,
        {
          section: input.section,
          challanNo: input.challanNo,
          challanDate: options.clock.today(),
        },
        { idempotencyKey: `ui-tds-${input.challanNo}` },
      ));
    },

    // --- persistence ------------------------------------------------------

    importSeedOnce(name) {
      // Demo seeds have no business in a production database, and the server
      // has no endpoint that would take them.
      return {
        imported: false,
        why: `"${name}" was not imported: the books are on the server, which does not take ` +
          'sample data.',
        entriesAdded: 0,
      };
    },

    persist() {
      // Nothing to do: the server wrote it before it answered.
    },

    resetToEmpty() {
      problem(UNSUPPORTED);
    },

    exportJson() {
      // The books as the engine's own snapshot, from what the server sent.
      // A read, not a write, so it is allowed — this is how a committee takes
      // a copy away with them.
      return JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          source: 'societybooks-api',
          society: context?.societyName ?? null,
          entries: ledger.all(),
          documents: register.rawDocuments(),
        },
        null,
        2,
      );
    },

    importJson() {
      problem(UNSUPPORTED);
      return { entriesRestored: 0, documentsRestored: 0 };
    },

    // --- reads ------------------------------------------------------------

    documentsFor(flatNo): readonly RegisterView[] {
      return register.forFlat(flatNo);
    },

    allDocuments(): readonly RegisterView[] {
      return register.all();
    },

    positionOf(flatNo) {
      return memberLedgerPosition(ledger, flatNo);
    },

    journal(): readonly JournalEntry[] {
      return ledger.all();
    },

    async invoicePdf(proformaNo: string): Promise<Blob> {
      const id = await documentId(proformaNo);
      return options.client.pdf(`/api/billing/documents/${id}/pdf`);
    },

    async receiptPdf(receiptNo: string): Promise<Blob> {
      if (paymentIds.size === 0) await loadPaymentIds();
      const id = paymentIds.get(receiptNo);
      if (id === undefined) throw new Error(`The server has no receipt ${receiptNo}.`);
      return options.client.pdf(`/api/payments/${id}/pdf`);
    },
  };

  return store;
}

/** The screens' method labels, in the words the API takes. */
function methodFor(method: string): string {
  const lowered = method.toLowerCase();
  if (lowered.includes('upi')) return 'upi';
  if (lowered.includes('neft')) return 'neft';
  if (lowered.includes('imps')) return 'imps';
  if (lowered.includes('nach')) return 'nach';
  if (lowered.includes('cheque')) return 'cheque';
  if (lowered.includes('cash')) return 'cash';
  if (lowered.includes('card')) return 'card';
  return 'upi';
}

/** 'Q2-FY26-27' for a date, matching the server's own quarters. */
export function quarterOf(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const fyStart = month >= 4 ? year : year - 1;
  const quarter = month >= 4 && month <= 6 ? 1
    : month >= 7 && month <= 9 ? 2
    : month >= 10 && month <= 12 ? 3
    : 4;
  const a = String(fyStart % 100).padStart(2, '0');
  const b = String((fyStart + 1) % 100).padStart(2, '0');
  return `Q${quarter}-FY${a}-${b}`;
}

export { periodLabel };
export type { SourceInvoice };
