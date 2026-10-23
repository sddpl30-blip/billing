/**
 * The writes the screens make, as promises.
 *
 * `BooksStore`'s own write methods are synchronous, which is right for the
 * local engine — the answer is known before the method returns — and wrong
 * for the server, where the answer arrives a round trip later. The server
 * store used to paper over that by firing the request and returning a
 * made-up result straight away: "3 approved" before anything was approved, a
 * receipt number nobody issued, a "settled" modal for a payment the server
 * then refused.
 *
 * Here every write is awaited and resolves with what actually happened, or
 * rejects with why it did not. The demo implementation wraps the synchronous
 * store; the server implementation lives in serverStore.ts. The screens call
 * one or the other through the same interface.
 */

import type { Paise } from '../accounting';
import type { BooksStore } from './booksStore';

export interface BillingRunOutcome {
  readonly period: string;
  readonly raised: number;
  readonly skipped: ReadonlyArray<{ flatNo: string; why: string }>;
  readonly totalNet: Paise;
  readonly totalTax: Paise;
  readonly totalGross: Paise;
}

export interface BatchOutcome {
  readonly done: number;
  readonly refused: number;
  /** Why anything was refused, and anything else worth saying, such as a delivery note. */
  readonly notes: readonly string[];
}

export interface ReceiptOutcome {
  /** The number the books gave the receipt — the server's own on the server. */
  readonly receiptNo: string;
  readonly appliedToDues: Paise;
  readonly heldAsAdvance: Paise;
  /** What is still owed on the document paid against; null when not known. */
  readonly outstandingAfter: Paise | null;
  readonly note: string | null;
}

/** The methods a receipt can record, in the words the API takes. */
export type ReceiptMethod = 'upi' | 'neft' | 'imps' | 'cheque' | 'cash' | 'nach' | 'card';

export const RECEIPT_METHODS: ReadonlyArray<{ id: ReceiptMethod; label: string }> = [
  { id: 'upi', label: 'UPI' },
  { id: 'neft', label: 'NEFT' },
  { id: 'imps', label: 'IMPS' },
  { id: 'cheque', label: 'Cheque' },
  { id: 'cash', label: 'Cash' },
  { id: 'nach', label: 'NACH' },
  { id: 'card', label: 'Card' },
];

export interface RecordReceiptInput {
  readonly flatNo: string;
  readonly amountRupees: number;
  readonly receivedOn: string;
  readonly method: ReceiptMethod;
  /** UTR, cheque number or similar. */
  readonly reference?: string;
  readonly bankAccountId?: string;
  /** Settle this document rather than the oldest open ones. */
  readonly againstProformaNo?: string;
  readonly by: string;
}

export interface BankAccountOption {
  readonly id: string;
  readonly label: string;
}

export interface BooksActions {
  runBilling(input: Parameters<BooksStore['runBillingFor']>[0]): Promise<BillingRunOutcome>;
  approveDocuments(proformaNos: readonly string[], by: string): Promise<BatchOutcome>;
  releaseDocuments(proformaNos: readonly string[], by: string): Promise<BatchOutcome>;
  convertDueDocuments(by: string): Promise<BatchOutcome>;
  cancelDocument(proformaNo: string, by: string, reason: string): Promise<void>;

  /** A payment against one document, as the resident checkout takes it. */
  payDocument(input: {
    proformaNo: string; amountRupees: number; method: string; by: string;
  }): Promise<ReceiptOutcome>;
  /** A receipt the manager records for money already in the bank. */
  recordReceipt(input: RecordReceiptInput): Promise<ReceiptOutcome>;
  depositAdvance(input: {
    flatNo: string; amountRupees: number; method: string; by: string;
  }): Promise<ReceiptOutcome>;

  approveVendorBill(id: string, by: string): Promise<void>;
  bookVendorBill(id: string, by: string, expenseAccount: string): Promise<void>;
  rejectVendorBill(id: string, by: string, reason: string): Promise<void>;
  payVendor(input: { id: string; amountRupees: number; paymentRef: string; by: string }): Promise<void>;

  /** Accounts a receipt can be banked into. Empty when there is no choice to make. */
  bankAccounts(): Promise<readonly BankAccountOption[]>;
}

const unique = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/** The method label the local engine records, from the API's word for it. */
const methodLabel = (method: string): string =>
  RECEIPT_METHODS.find(m => m.id === method)?.label ?? method;

/**
 * The demonstration's writes, over the local store.
 *
 * The store already answers synchronously; this only turns a thrown refusal
 * into a rejected promise and fills in what the screens want to show.
 */
export function localActions(store: BooksStore): BooksActions {
  const attempt = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };

  /**
   * Problems the store recorded during `fn`, oldest first. The list is kept
   * newest first and capped, so what is new is everything above the entry
   * that was on top before.
   */
  const withNotes = <T>(fn: () => T): { value: T; notes: string[] } => {
    const top = store.snapshot().problems[0];
    const value = fn();
    const fresh: string[] = [];
    for (const problem of store.snapshot().problems) {
      if (problem === top) break;
      fresh.push(problem);
    }
    return { value, notes: fresh.reverse() };
  };

  const vendorState = (id: string): string | undefined =>
    store.snapshot().vendorBills.find(v => v.id === id)?.state;

  return {
    runBilling: input => attempt(() => {
      const result = store.runBillingFor(input);
      return {
        period: result.period,
        raised: result.documents.length,
        skipped: result.skipped,
        totalNet: result.totalNet,
        totalTax: result.totalTax,
        totalGross: result.totalGross,
      };
    }),

    approveDocuments: (proformaNos, by) => attempt(() => {
      const { value, notes } = withNotes(() => store.approveDocuments(proformaNos, by));
      return { done: value.approved, refused: value.refused, notes };
    }),

    releaseDocuments: (proformaNos, by) => attempt(() => {
      const notes: string[] = [];
      let done = 0;
      for (const proformaNo of proformaNos) {
        try {
          store.releaseDocument(proformaNo, by);
          done++;
        } catch (err) {
          notes.push(`${proformaNo}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return {
        done,
        refused: proformaNos.length - done,
        notes: [
          ...notes,
          'No email or messaging provider is configured, so nothing was sent to any member.',
        ],
      };
    }),

    convertDueDocuments: by => attempt(() => {
      const { value, notes } = withNotes(() => store.convertDueDocuments(by));
      return { done: value.converted, refused: value.refused, notes };
    }),

    cancelDocument: (proformaNo, by, reason) =>
      attempt(() => store.cancelDocument(proformaNo, by, reason)),

    payDocument: input => attempt(() => {
      const receiptNo = unique(`RCT-${input.proformaNo}`);
      const result = store.recordMemberPayment({ ...input, method: methodLabel(input.method), receiptNo });
      return {
        receiptNo,
        appliedToDues: result.appliedToDues,
        heldAsAdvance: result.heldAsAdvance,
        outstandingAfter: result.outstandingAfter,
        note: 'Demonstration: recorded in this browser only. No bank or gateway was contacted.',
      };
    }),

    recordReceipt: input => attempt(() => {
      const receiptNo = unique('RCT');
      if (input.againstProformaNo !== undefined) {
        const result = store.recordMemberPayment({
          proformaNo: input.againstProformaNo,
          amountRupees: input.amountRupees,
          receiptNo,
          method: methodLabel(input.method),
          by: input.by,
        });
        return {
          receiptNo,
          appliedToDues: result.appliedToDues,
          heldAsAdvance: result.heldAsAdvance,
          outstandingAfter: result.outstandingAfter,
          note: null,
        };
      }
      // No document named: oldest open first, the rest on account — which is
      // what an advance deposit already does in the engine.
      const result = store.depositAdvance({
        flatNo: input.flatNo,
        amountRupees: input.amountRupees,
        receiptNo,
        method: methodLabel(input.method),
        by: input.by,
      });
      return {
        receiptNo,
        appliedToDues: result.appliedToDues,
        heldAsAdvance: result.heldAsAdvance,
        outstandingAfter: null,
        note: null,
      };
    }),

    depositAdvance: input => attempt(() => {
      const receiptNo = unique('ADV');
      const result = store.depositAdvance({ ...input, method: methodLabel(input.method), receiptNo });
      return {
        receiptNo,
        appliedToDues: result.appliedToDues,
        heldAsAdvance: result.heldAsAdvance,
        outstandingAfter: null,
        note: null,
      };
    }),

    // The local vendor methods record a refusal on `problems` and return
    // rather than throw, so the state afterwards is what says whether it worked.
    approveVendorBill: (id, by) => attempt(() => {
      store.approveVendorBill(id, by);
      if (vendorState(id) !== 'approved') {
        throw new Error(store.snapshot().problems[0] ?? `Vendor bill ${id} was not approved.`);
      }
    }),

    bookVendorBill: (id, by, expenseAccount) => attempt(() => {
      store.bookApprovedVendorBill(id, by, expenseAccount);
      if (vendorState(id) !== 'booked') {
        throw new Error(store.snapshot().problems[0] ?? `Vendor bill ${id} could not be booked.`);
      }
    }),

    rejectVendorBill: (id, by, reason) => attempt(() => {
      store.rejectVendorBill(id, by, reason);
      if (vendorState(id) !== 'rejected') {
        throw new Error(store.snapshot().problems[0] ?? `Vendor bill ${id} was not rejected.`);
      }
    }),

    payVendor: input => attempt(() => {
      const before = store.snapshot().ledger.all().length;
      store.payVendor(input);
      if (store.snapshot().ledger.all().length === before) {
        throw new Error(store.snapshot().problems[0] ?? `Vendor bill ${input.id} was not paid.`);
      }
    }),

    // The demonstration keeps one bank account, so there is nothing to choose.
    bankAccounts: () => Promise.resolve([]),
  };
}
