/**
 * Public surface of the accounting engine.
 *
 * The engine has no dependency on React, localStorage, the DOM or `src/data.ts`
 * — `adapter.ts` is the only file that knows the demo's shapes, and nothing
 * here reaches for a browser global. Replacing the adapter with calls to a
 * Postgres-backed API is the whole of what a backend migration needs.
 */

export type { Paise } from './money';
export {
  MoneyError, allocate, formatRupees, fromRupees, percentOf, sum, toRupees,
} from './money';

export type { Account, AccountClass, NormalBalance, ReceiptHead, ReceiptHeadSpec } from './accounts';
export {
  A, CHART, NORMAL_BALANCE, RECEIPT_HEADS, UnknownAccountError,
  account, accountsOfClass, cashAccounts, hasAccount, receiptHead,
} from './accounts';

export type {
  AccountBalance, EntrySourceKind, JournalEntry, NewEntry, Posting,
} from './journal';
export { Ledger, PostingError, credit, debit, validateEntry } from './journal';

export type { AccountingConfig, TaxRate } from './config';
export {
  ConfigNotReviewedError, DEMO_CONFIG, assertConfigReviewed, financialYearOf,
  outstandingConfirmations,
} from './config';

export type {
  BalanceSheet, IncomeAndExpenditure, Reconciliation, ReceiptsAndPayments,
  StatementLine, TrialBalance, TrialBalanceRow,
} from './reports';
export {
  assembleBalanceSheet, balanceSheet, cashFlowCloses, debitsEqualCredits,
  incomeAndExpenditure, netBalances, receiptsAndPayments, reconcile, trialBalance,
} from './reports';

export type {
  Actor, BillLine, BillResult, MaintenanceBill, MemberPosition, ReceiptInput,
  ReceiptResult, TdsSection, VendorBillInput, VendorBillResult,
} from './transactions';
export {
  accrueFdInterest, applyAdvance, billMaintenance, bookVendorBill, memberPosition,
  payVendorBill, placeFixedDeposit, postOpeningBalances, receiveFromMember,
  remitGst, remitTds, transferToSinkingFundBank, vendorPosition,
} from './transactions';

export type { ImportReport, SourceInvoice, SourceVendorInvoice } from './adapter';
export { expenseAccountFor, importDemoData, isoFromDayMonthYear, isoFromPeriod } from './adapter';

export type { Statements, StatementRow, StatementSection } from './uiReports';
export { buildStatements } from './uiReports';

export type { BudgetLine, BudgetVsActualRow } from './budget';
export { DEMO_BUDGET, budgetVsActual } from './budget';

export type { AreaBasis, MaintenanceRate, RateSchedule, FlatForBilling, AreaChargeResult } from './rates';
export {
  AREA_BASIS_LABEL, MANI_VISTA_RATES, RateError, areaCharge, gstOn, rateOn, requireApprovedRate,
} from './rates';

export type { Clock } from './clock';
export {
  DateError, addDays, addMonths, dayMonthYearToIso, daysBetween, endOfMonth,
  fixedClock, isValidIsoDate, isoToDayMonthYear, periodLabel, periodToIso,
  requireIsoDate, startOfMonth, systemClock,
} from './clock';

export type {
  Allocation, AllocationPlan, AgeingBucket, DerivedStatus, MemberLedgerPosition,
  OutstandingInvoice,
} from './allocation';
export {
  AllocationError, ageing, deriveStatus, memberLedgerPosition, outstandingInvoices, planAllocation,
} from './allocation';

export type { BillingDocument, DispatchAttempt, DocumentState, RegisterView } from './documents';
export { BillingRegister, DocumentError } from './documents';

export type { BillingRunInput, BillingRunResult, FlatRecord } from './billingRun';
export { periodFor, runBilling } from './billingRun';

export type {
  BooksSnapshotData, RestoreResult, SerialisedDocument, SerialisedEntry, SerialisedPosting,
} from './snapshot';
export {
  SNAPSHOT_VERSION, SnapshotError, migrate, parseSnapshot, restoreSnapshot,
  validateSnapshot, writeSnapshot,
} from './snapshot';
