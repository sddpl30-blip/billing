/**
 * Typed calls for the banking routes (server/src/routes.ts, "banking").
 *
 * Amounts are paise on the wire and stay paise here; only the screen turns
 * them into rupees. Statement lines are signed: positive is money in.
 */

import type { ApiClient } from '../client';

export interface BankAccount {
  readonly id: string;
  readonly label: string;
  readonly bankName: string;
  readonly accountLast4: string;
  readonly ifsc: string;
  readonly ledgerAccount: string;
  readonly purpose: string;
  readonly active: boolean;
  /** The ledger's balance on the account's code today, in paise. */
  readonly ledgerBalancePaise: number;
}

export type BankLineState = 'unmatched' | 'suggested' | 'matched' | 'suspense' | 'ignored';

export interface BankLineSuggestion {
  readonly paymentId: string;
  readonly receiptNo: string | null;
}

export interface BankLine {
  readonly id: string;
  readonly valueDate: string;
  readonly narration: string;
  readonly reference: string | null;
  /** Signed paise: positive is money in. */
  readonly amountPaise: number;
  readonly state: BankLineState;
  /** Receipts of the same amount within three days. A human confirms one. */
  readonly suggestions: readonly BankLineSuggestion[];
}

interface RawBankLine {
  readonly id: string;
  readonly valueDate: string;
  readonly narration: string;
  readonly reference: string | null;
  readonly amountPaise: number;
  readonly state: BankLineState;
  readonly suggestedPaymentId: string | null;
  readonly suggestedReceiptNo: string | null;
}

export interface ImportResult {
  readonly importId: string;
  readonly inserted: number;
  readonly duplicate: number;
  readonly rejected: ReadonlyArray<{ line: number; raw: string; why: string }>;
  readonly posted: false;
  readonly note: string;
}

export interface ReconcileResult {
  readonly asAt: string;
  readonly statementBalancePaise: number;
  readonly ledgerBalancePaise: number;
  readonly differencePaise: number;
  readonly unmatchedCount: number;
  readonly signedOff: boolean;
}

/** A member receipt, as much of it as matching needs. */
export interface ReceiptSummary {
  readonly id: string;
  readonly receiptNo: string;
  readonly flatNo: string;
  readonly receivedOn: string;
  readonly amountPaise: number;
  readonly method: string;
  readonly instrumentRef: string | null;
}

export type MatchTarget =
  | { readonly paymentId: string }
  | { readonly vendorPaymentId: string }
  | { readonly suspenseReason: string };

/** The server's caps on an import: the content field and the whole body. */
export const STATEMENT_MAX_CHARS = 900_000;
export const REQUEST_MAX_BYTES = 1_000_000;

export async function listBankAccounts(client: ApiClient): Promise<BankAccount[]> {
  const body = await client.get<{ accounts: BankAccount[] }>('/api/bank-accounts');
  return body.accounts;
}

export async function listBankLines(client: ApiClient, state: BankLineState): Promise<BankLine[]> {
  const body = await client.get<{ transactions: RawBankLine[] }>('/api/bank/transactions', { state });
  // The server joins each line to every receipt that could be it, so a line
  // with two candidates arrives twice. Folded back into one line here.
  const byId = new Map<string, { line: RawBankLine; suggestions: BankLineSuggestion[] }>();
  for (const row of body.transactions) {
    let entry = byId.get(row.id);
    if (entry === undefined) {
      entry = { line: row, suggestions: [] };
      byId.set(row.id, entry);
    }
    if (row.suggestedPaymentId !== null
      && !entry.suggestions.some(s => s.paymentId === row.suggestedPaymentId)) {
      entry.suggestions.push({ paymentId: row.suggestedPaymentId, receiptNo: row.suggestedReceiptNo });
    }
  }
  return [...byId.values()].map(({ line, suggestions }) => ({
    id: line.id,
    valueDate: line.valueDate,
    narration: line.narration,
    reference: line.reference,
    amountPaise: line.amountPaise,
    state: line.state,
    suggestions,
  }));
}

export function importStatement(
  client: ApiClient,
  input: { bankAccountId: string; format: 'csv' | 'mt940'; filename: string; content: string },
): Promise<ImportResult> {
  return client.post<ImportResult>('/api/bank/imports', input);
}

export function matchBankLine(
  client: ApiClient, lineId: string, target: MatchTarget,
): Promise<{ id: string; matched: boolean }> {
  return client.post(`/api/bank/transactions/${encodeURIComponent(lineId)}/match`, target);
}

export function reconcile(
  client: ApiClient,
  input: { bankAccountId: string; asAt: string; statementBalancePaise: number },
): Promise<ReconcileResult> {
  return client.post<ReconcileResult>('/api/bank/reconciliations', input);
}

export async function listReceipts(client: ApiClient, limit = 200): Promise<ReceiptSummary[]> {
  const body = await client.get<{ payments: ReceiptSummary[] }>('/api/payments', { limit });
  return body.payments;
}
