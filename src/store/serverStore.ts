/**
 * The books, read from the server.
 *
 * This implements the same `BooksStore` interface the screens already use, so
 * the UI does not know which one it has. Reads come from one snapshot endpoint
 * and are rehydrated into the engine's own `Ledger` and `BillingRegister` —
 * the objects the screens already render — and writes go to the API, are
 * awaited, and then refetch once.
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
import type { BooksReader, BooksSnapshot, VendorBillState } from './booksStore';
import type { BankAccountOption, BatchOutcome, BooksActions, ReceiptOutcome } from './actions';
import type { ApiClient, SnapshotResponse } from '../api/client';

export interface ServerStoreOptions {
  readonly client: ApiClient;
  readonly clock: Clock;
  /**
   * Called with a problem nobody asked about — a refresh that failed, a record
   * the engine refused — so a screen can show it. A write's own failure is not
   * sent here: it rejects the promise the screen is awaiting, and the screen
   * says so where the action was taken.
   */
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

export interface ServerBooksStore extends BooksReader {
  /** Fetches the books. Called once at start-up and after every write. */
  refresh(): Promise<void>;
  /** The server-side facts the screens need that a local store has no notion of. */
  context(): ServerContext | null;
  /**
   * The snapshot response the books were last rebuilt from, for the screens
   * that map it onto their own shapes. Read from here rather than fetched
   * again: one snapshot per change, not one per screen.
   */
  lastView(): SnapshotResponse | null;
  /** True while a write is in flight, for a screen to disable a button. */
  readonly busy: boolean;
  /** Every write, awaited. */
  readonly actions: BooksActions;
  /** A PDF of a document, from the server. */
  invoicePdf(proformaNo: string): Promise<Blob>;
  receiptPdf(receiptNo: string): Promise<Blob>;
}

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
  let view: SnapshotResponse | null = null;
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

  /** Kept on the list the screens can read, without interrupting anyone. */
  const note = (message: string): void => {
    problems = [message, ...problems].slice(0, 20);
  };

  /** Kept, and passed to whoever is showing problems. */
  const problem = (message: string): void => {
    note(message);
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
      const next = await options.client.get<SnapshotResponse>('/api/books/snapshot');

      // A fresh ledger and register every time. Restoring into the existing
      // ones would refuse — `restore` rejects an id it already holds, which is
      // the guard that stops a snapshot being loaded twice — and merging two
      // sets of documents is how a flat ends up with two live ones.
      const nextLedger = new Ledger();
      const nextRegister = new BillingRegister(nextLedger, config, options.clock);

      const rejected: string[] = [];
      for (const entry of next.entries as readonly JournalEntry[]) {
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
          next.documents as Parameters<BillingRegister['restoreDocuments']>[0],
          next.taxInvoiceSequence,
        );
      } catch (err) {
        rejected.push(err instanceof Error ? err.message : String(err));
      }

      ledger = nextLedger;
      register = nextRegister;
      view = next;
      vendorBills = next.vendorBills.map(bill => ({
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
      serverMode = next.mode;
      context = {
        societyName: next.societyName,
        registrationNo: next.registrationNo,
        gstin: next.gstin,
        scope: next.scope,
        email: next.email,
        roles: next.roles,
        permissions: next.permissions,
        flats: next.flats,
        settings: next.settings,
        rate: next.rate,
      };

      flatIds.clear();
      for (const flat of next.flats) flatIds.set(flat.flatNo, flat.id);
      // The snapshot carries each document's id. Added to rather than cleared:
      // a server that predates the id leaves the map as the listing filled it,
      // instead of emptying it on every refresh — which is what used to make
      // every write after the first fail with "no document numbered".
      for (const document of next.documents as ReadonlyArray<{ proformaNo: string; id?: string }>) {
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

  /**
   * The documents endpoint, for an id the snapshot did not carry — a server
   * older than the snapshot's `id` field, or a document raised since.
   */
  async function loadDocumentIds(): Promise<void> {
    const listing = await options.client.get<{
      documents: ReadonlyArray<{ id: string; proformaNo: string }>;
    }>('/api/billing/documents');
    for (const document of listing.documents) {
      documentIds.set(document.proformaNo, document.id);
    }
  }

  /** Looks up the server's id for a document, asking the listing once if it is new. */
  async function documentId(proformaNo: string): Promise<string> {
    const known = documentIds.get(proformaNo);
    if (known !== undefined) return known;
    await loadDocumentIds();
    const found = documentIds.get(proformaNo);
    if (found === undefined) {
      throw new Error(`The server does not have a document numbered ${proformaNo}.`);
    }
    return found;
  }

  async function loadPaymentIds(): Promise<void> {
    const listing = await options.client.get<{
      payments: ReadonlyArray<{ id: string; receiptNo: string }>;
    }>('/api/payments');
    for (const payment of listing.payments) paymentIds.set(payment.receiptNo, payment.id);
  }

  /**
   * Runs a write: marks the store busy, awaits the server, refetches once —
   * even after a failure, because part of a batch may have landed — and
   * hands the caller the server's answer or its refusal.
   */
  async function write<T>(what: string, body: () => Promise<T>): Promise<T> {
    busy = true;
    notify();
    try {
      return await body();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      note(`${what}: ${message}`);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      await refresh();
      busy = false;
      notify();
    }
  }

  const flatIdFor = (flatNo: string): string => {
    const id = flatIds.get(flatNo);
    if (id === undefined) throw new Error(`The server has no flat ${flatNo} on record.`);
    return id;
  };

  /** A key per request, so a retried request is one payment and not two. */
  const idempotencyKey = (prefix: string): string =>
    `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

  interface PaymentAnswer {
    paymentId: string; receiptNo: string; appliedToDues: number; heldAsAdvance: number;
    note?: string;
  }

  const receiptFrom = (answer: PaymentAnswer, outstandingAfter: Paise | null): ReceiptOutcome => {
    paymentIds.set(answer.receiptNo, answer.paymentId);
    return {
      receiptNo: answer.receiptNo,
      appliedToDues: answer.appliedToDues as Paise,
      heldAsAdvance: answer.heldAsAdvance as Paise,
      outstandingAfter,
      note: answer.note ?? null,
    };
  };

  /** What is still owed on a document, read from the refreshed register. */
  const outstandingOn = (proformaNo: string): Paise | null => {
    const document = register.all().find(d => d.proformaNo === proformaNo);
    return document === undefined ? null : document.outstanding;
  };

  /** Each document in turn, with refusals counted rather than ending the batch. */
  async function eachDocument(
    proformaNos: readonly string[],
    send: (id: string, proformaNo: string) => Promise<string | void>,
  ): Promise<BatchOutcome> {
    let done = 0;
    let refused = 0;
    const notes: string[] = [];
    for (const proformaNo of proformaNos) {
      try {
        const said = await send(await documentId(proformaNo), proformaNo);
        if (typeof said === 'string' && !notes.includes(said)) notes.push(said);
        done++;
      } catch (err) {
        refused++;
        notes.push(`${proformaNo}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { done, refused, notes };
  }

  const actions: BooksActions = {
    runBilling: input => write('Billing run', async () => {
      // The server runs the cycle with its own approved rate and settings;
      // the screen's figures are not sent, because the server would not use
      // them. What comes back is what was actually raised.
      const result = await options.client.post<{
        period: string;
        issued: ReadonlyArray<{ flatNo: string; documentId?: string }>;
        skipped: ReadonlyArray<{ flatNo: string; why: string }>;
        totals: { net: number; estimatedTax: number; gross: number };
      }>('/api/billing/run', {
        period: input.period,
        issuedOn: input.issuedOn ?? options.clock.today(),
      });
      return {
        period: input.period,
        raised: result.issued.length,
        skipped: result.skipped,
        totalNet: result.totals.net as Paise,
        totalTax: result.totals.estimatedTax as Paise,
        totalGross: result.totals.gross as Paise,
      };
    }),

    approveDocuments: proformaNos => write('Approval', () =>
      eachDocument(proformaNos, async id => {
        await options.client.post(`/api/billing/documents/${id}/approve`, {
          on: options.clock.today(),
        });
      })),

    releaseDocuments: proformaNos => write('Release', () =>
      eachDocument(proformaNos, async id => {
        const result = await options.client.post<{ delivered: boolean; note: string }>(
          `/api/billing/documents/${id}/release`,
          { channel: 'email' },
        );
        // The server says whether anything was actually sent. Passed on either
        // way, because "released" and "delivered" are different claims.
        return result.note;
      })),

    convertDueDocuments: () => write('Conversion', () => {
      const today = options.clock.today();
      const due = register.all().filter(
        document => (document.state === 'approved' || document.state === 'released')
          && document.dueOn <= today,
      );
      return eachDocument(due.map(d => d.proformaNo), async id => {
        await options.client.post(`/api/billing/documents/${id}/convert`, {
          on: today,
          because: 'due-date-reached',
        });
      });
    }),

    cancelDocument: (proformaNo, _by, reason) => write('Cancellation', async () => {
      const id = await documentId(proformaNo);
      await options.client.post(`/api/billing/documents/${id}/cancel`, {
        reason, on: options.clock.today(),
      });
    }),

    payDocument: input => write('Receipt', async () => {
      const document = register.all().find(d => d.proformaNo === input.proformaNo);
      if (document === undefined) throw new Error(`No document ${input.proformaNo}.`);
      const flatId = flatIdFor(document.flatNo);
      const documentServerId = await documentId(input.proformaNo);
      // Converted first where it has not been: a payment against a proforma
      // is what raises the tax invoice, and the server will not allocate to
      // a document that has no receivable.
      if (document.state !== 'tax-invoice') {
        await options.client.post(`/api/billing/documents/${documentServerId}/convert`, {
          on: options.clock.today(), because: 'payment-received',
        });
      }
      const answer = await options.client.post<PaymentAnswer>(
        '/api/payments',
        {
          flatId,
          amountPaise: Math.round(input.amountRupees * 100),
          receivedOn: options.clock.today(),
          method: methodFor(input.method),
          againstDocumentId: documentServerId,
        },
        { idempotencyKey: idempotencyKey('ui-receipt') },
      );
      return answer;
    }).then(answer => receiptFrom(answer, outstandingOn(input.proformaNo))),

    recordReceipt: input => write('Receipt', async () => {
      const flatId = flatIdFor(input.flatNo);
      const against = input.againstProformaNo === undefined
        ? undefined
        : await documentId(input.againstProformaNo);
      return options.client.post<PaymentAnswer>(
        '/api/payments',
        {
          flatId,
          amountPaise: Math.round(input.amountRupees * 100),
          receivedOn: input.receivedOn,
          method: input.method,
          ...(input.reference === undefined || input.reference === ''
            ? {} : { instrumentRef: input.reference }),
          ...(input.bankAccountId === undefined || input.bankAccountId === ''
            ? {} : { bankAccountId: input.bankAccountId }),
          ...(against === undefined ? {} : { againstDocumentId: against }),
        },
        { idempotencyKey: idempotencyKey('ui-receipt') },
      );
    }).then(answer => receiptFrom(
      answer,
      input.againstProformaNo === undefined ? null : outstandingOn(input.againstProformaNo),
    )),

    depositAdvance: input => write('Advance', async () => options.client.post<PaymentAnswer>(
      '/api/payments',
      {
        flatId: flatIdFor(input.flatNo),
        amountPaise: Math.round(input.amountRupees * 100),
        receivedOn: options.clock.today(),
        method: methodFor(input.method),
      },
      { idempotencyKey: idempotencyKey('ui-advance') },
    )).then(answer => receiptFrom(answer, null)),

    approveVendorBill: id => write('Vendor approval', async () => {
      await options.client.post(`/api/vendor-bills/${id}/approve`);
    }),

    bookVendorBill: id => write('Vendor booking', async () => {
      await options.client.post(`/api/vendor-bills/${id}/book`, { on: options.clock.today() });
    }),

    rejectVendorBill: id => Promise.reject(new Error(
      // There is no reject endpoint yet. Said rather than pretended.
      `Rejecting bill ${id} is not yet a server action. Nothing was changed.`,
    )),

    payVendor: input => write('Vendor payment', async () => {
      await options.client.post(
        `/api/vendor-bills/${input.id}/pay`,
        {
          amountPaise: Math.round(input.amountRupees * 100),
          paidOn: options.clock.today(),
          method: 'neft',
          paymentRef: input.paymentRef,
        },
        { idempotencyKey: `ui-vendor-${input.paymentRef}` },
      );
    }),

    async bankAccounts(): Promise<readonly BankAccountOption[]> {
      const listing = await options.client.get<{
        accounts: ReadonlyArray<{
          id: string; label: string; bankName: string; accountLast4: string; active: boolean;
        }>;
      }>('/api/bank-accounts');
      return listing.accounts
        .filter(account => account.active)
        .map(account => ({
          id: account.id,
          label: `${account.label} · ${account.bankName} ••${account.accountLast4}`,
        }));
    },
  };

  const store: ServerBooksStore = {
    snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    get busy() { return busy; },

    context: () => context,

    lastView: () => view,

    refresh,

    actions,

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
      // Refetched on a miss: a receipt recorded after the first lookup is not
      // in the map yet, and "no such receipt" would be wrong.
      if (!paymentIds.has(receiptNo)) await loadPaymentIds();
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
