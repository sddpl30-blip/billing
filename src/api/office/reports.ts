/**
 * The report endpoints, typed as the server returns them.
 *
 * Every amount is integer paise, exactly as `server/src/reports.ts` computes
 * it. Nothing here adjusts a figure: these are the books, and a screen that
 * massaged them would be a second set.
 */

import type { ApiClient } from '../client';

export interface TrialBalanceLine {
  readonly code: string;
  readonly name: string;
  readonly class: string;
  readonly debit: number;
  readonly credit: number;
}

export interface TrialBalance {
  readonly asAt: string;
  readonly lines: readonly TrialBalanceLine[];
  readonly totalDebit: number;
  readonly totalCredit: number;
  readonly tiesOut: boolean;
}

export interface BalanceSheet {
  readonly asAt: string;
  readonly assets: readonly TrialBalanceLine[];
  readonly liabilities: readonly TrialBalanceLine[];
  readonly funds: readonly TrialBalanceLine[];
  readonly totalAssets: number;
  readonly totalLiabilities: number;
  readonly totalFunds: number;
  readonly surplus: number;
  readonly balances: boolean;
}

export interface IncomeAndExpenditure {
  readonly from: string;
  readonly to: string;
  readonly income: readonly TrialBalanceLine[];
  readonly expenditure: readonly TrialBalanceLine[];
  readonly totalIncome: number;
  readonly totalExpenditure: number;
  readonly surplus: number;
}

/** 'not-due', '1-30', '31-60', '61-90' or '90+'. */
export interface AgeingBucket {
  readonly label: string;
  readonly amount: number;
  readonly count: number;
}

export interface Ageing {
  readonly asAt: string;
  readonly rows: ReadonlyArray<{
    readonly flatNo: string;
    readonly flatId: string;
    readonly outstanding: number;
    readonly buckets: readonly AgeingBucket[];
  }>;
  readonly totals: readonly AgeingBucket[];
  readonly total: number;
}

export interface Collections {
  readonly from: string;
  readonly to: string;
  readonly billed: number;
  readonly collected: number;
  readonly outstanding: number;
  readonly advances: number;
  readonly collectionRateBps: number;
  readonly invoices: number;
  readonly receipts: number;
}

export interface GstReport {
  readonly taxPeriod: string;
  readonly invoices: number;
  readonly creditNotes: number;
  readonly debitNotes: number;
  readonly taxableValue: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  readonly ledgerCgst: number;
  readonly ledgerSgst: number;
  readonly agrees: boolean;
  readonly filed: false;
  readonly note: string;
}

export interface TdsReport {
  readonly quarter: string;
  readonly bySection: ReadonlyArray<{
    readonly section: string;
    readonly deductions: number;
    readonly gross: number;
    readonly tds: number;
    readonly unremitted: number;
  }>;
  readonly total: number;
  readonly unremitted: number;
}

export interface MemberStatement {
  readonly flatNo: string;
  readonly opening: number;
  readonly rows: ReadonlyArray<{
    readonly date: string;
    readonly particulars: string;
    readonly docRef: string | null;
    readonly debit: number;
    readonly credit: number;
    readonly balance: number;
  }>;
  readonly closing: number;
}

export interface LedgerLeg {
  readonly accountCode: string;
  readonly debit: number;
  readonly credit: number;
  readonly party: string | null;
  readonly docRef: string | null;
  readonly memo: string | null;
}

export interface LedgerEntry {
  readonly id: string;
  readonly entryRef: string;
  readonly date: string;
  readonly narration: string;
  readonly sourceKind: string;
  readonly sourceRef: string | null;
  readonly amountPaise: number;
  readonly reversalOf: string | null;
  readonly reversedBy: string | null;
  readonly postedBy: string;
  readonly legs: readonly LedgerLeg[];
}

export interface LedgerEntries {
  readonly from: string;
  readonly to: string;
  readonly entries: readonly LedgerEntry[];
}

/** The server caps the journal read at this many entries. */
export const LEDGER_ENTRY_LIMIT = 1000;

export interface AuditEntry {
  readonly at: string;
  readonly actorLabel: string;
  readonly action: string;
  readonly subjectTable: string | null;
  readonly subjectId: string | null;
  readonly detail: unknown;
  readonly requestId: string | null;
}

export interface FlatSummary {
  readonly id: string;
  readonly flatNo: string;
  readonly wing: string | null;
  readonly owner: string | null;
}

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export function reportsApi(client: ApiClient) {
  return {
    trialBalance: (asAt: string) =>
      client.get<TrialBalance>('/api/reports/trial-balance', { asAt }),
    balanceSheet: (asAt: string) =>
      client.get<BalanceSheet>('/api/reports/balance-sheet', { asAt }),
    incomeExpenditure: (range: DateRange) =>
      client.get<IncomeAndExpenditure>('/api/reports/income-expenditure', { ...range }),
    ageing: (asAt: string) =>
      client.get<Ageing>('/api/reports/ageing', { asAt }),
    collections: (range: DateRange) =>
      client.get<Collections>('/api/reports/collections', { ...range }),
    gst: (taxPeriod: string) =>
      client.get<GstReport>('/api/reports/gst', { taxPeriod }),
    tds: (quarter: string) =>
      client.get<TdsReport>('/api/reports/tds', { quarter }),
    statement: (flatId: string, range: DateRange) =>
      client.get<MemberStatement>(`/api/reports/statement/${encodeURIComponent(flatId)}`, { ...range }),
    ledger: (range: DateRange) =>
      client.get<LedgerEntries>('/api/ledger/entries', { ...range }),
    audit: (options: { limit: number; action?: string }) =>
      client.get<{ entries: readonly AuditEntry[] }>('/api/audit', {
        limit: options.limit,
        ...(options.action ? { action: options.action } : {}),
      }),
    flats: () => client.get<{ flats: readonly FlatSummary[] }>('/api/flats'),
  };
}

export type ReportsApi = ReturnType<typeof reportsApi>;
