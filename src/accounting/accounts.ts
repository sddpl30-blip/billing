/**
 * The chart of accounts.
 *
 * Every posting names an account by its code. A free-text account name, which
 * is what the demo used, lets a typo mint a new account silently; a code that
 * is not in this table is rejected at post time instead.
 */

export type AccountClass = 'asset' | 'liability' | 'fund' | 'income' | 'expenditure';

/** Which side of an account its ordinary balance sits on. */
export type NormalBalance = 'debit' | 'credit';

export interface Account {
  readonly code: string;
  readonly name: string;
  readonly cls: AccountClass;
  /** Groups accounts into the line a statement prints them on. */
  readonly group: string;
  /** True for bank and cash accounts, which Receipts & Payments is built from. */
  readonly isCash?: boolean;
  /** Set where the account is a control account fed by per-party subledgers. */
  readonly control?: 'resident' | 'vendor';
  readonly note?: string;
}

export const NORMAL_BALANCE: Record<AccountClass, NormalBalance> = {
  asset: 'debit',
  liability: 'credit',
  fund: 'credit',
  income: 'credit',
  expenditure: 'debit',
};

/**
 * Codes are referenced from transaction builders, so they are exported as
 * constants rather than written as string literals at each call site.
 */
export const A = {
  // --- Assets ---
  BANK_OPERATING: '1000',
  BANK_SINKING: '1010',
  CASH_ON_HAND: '1020',
  MAINTENANCE_RECEIVABLE: '1100',
  OTHER_RECEIVABLE: '1110',
  FD_SINKING: '1200',
  ACCRUED_FD_INTEREST: '1300',
  GST_INPUT_CREDIT: '1400',

  // --- Liabilities ---
  VENDOR_PAYABLE: '2000',
  TDS_PAYABLE_194C: '2100',
  TDS_PAYABLE_194J: '2101',
  TDS_PAYABLE_194I: '2102',
  CGST_OUTPUT: '2200',
  SGST_OUTPUT: '2201',
  MEMBER_ADVANCE: '2300',
  DEPOSITS_HELD: '2400',

  // --- Funds ---
  SINKING_FUND: '3000',
  FESTIVAL_FUND: '3010',
  GENERAL_RESERVE: '3020',

  // --- Income: one account per receipt head ---
  INC_MAINTENANCE: '4000',
  INC_SINKING_CONTRIBUTION: '4010',
  INC_FESTIVAL: '4020',
  INC_SPACE_RENTAL: '4030',
  INC_REIMBURSEMENT: '4040',
  INC_OTHER_RECEIPTS: '4050',
  INC_LATE_INTEREST: '4060',

  // --- Expenditure ---
  EXP_WATER: '5000',
  EXP_SECURITY: '5010',
  EXP_LIFT: '5020',
  EXP_REPAIRS: '5030',
  EXP_ELECTRICITY: '5040',
  EXP_HOUSEKEEPING: '5050',
  EXP_PROFESSIONAL: '5060',
  EXP_BANK_CHARGES: '5070',
  EXP_FESTIVAL: '5080',
  EXP_DEPRECIATION: '5090',
} as const;

export const CHART: readonly Account[] = [
  { code: A.BANK_OPERATING, name: 'Bank — operating account', cls: 'asset', group: 'Cash and bank', isCash: true },
  { code: A.BANK_SINKING, name: 'Bank — sinking fund account', cls: 'asset', group: 'Cash and bank', isCash: true },
  { code: A.CASH_ON_HAND, name: 'Cash on hand', cls: 'asset', group: 'Cash and bank', isCash: true },
  { code: A.MAINTENANCE_RECEIVABLE, name: 'Maintenance receivable from members', cls: 'asset', group: 'Receivables', control: 'resident' },
  { code: A.OTHER_RECEIVABLE, name: 'Other receivables', cls: 'asset', group: 'Receivables' },
  { code: A.FD_SINKING, name: 'Fixed deposits — sinking fund', cls: 'asset', group: 'Investments' },
  { code: A.ACCRUED_FD_INTEREST, name: 'Accrued interest on deposits', cls: 'asset', group: 'Receivables' },
  { code: A.GST_INPUT_CREDIT, name: 'GST input tax credit', cls: 'asset', group: 'Statutory', note: 'ITC eligibility is a CA determination; the engine only holds the balance.' },

  { code: A.VENDOR_PAYABLE, name: 'Sundry creditors — vendors', cls: 'liability', group: 'Payables', control: 'vendor' },
  { code: A.TDS_PAYABLE_194C, name: 'TDS payable — 194C contractors', cls: 'liability', group: 'Statutory' },
  { code: A.TDS_PAYABLE_194J, name: 'TDS payable — 194J professional', cls: 'liability', group: 'Statutory' },
  { code: A.TDS_PAYABLE_194I, name: 'TDS payable — 194I rent', cls: 'liability', group: 'Statutory' },
  { code: A.CGST_OUTPUT, name: 'CGST output payable', cls: 'liability', group: 'Statutory' },
  { code: A.SGST_OUTPUT, name: 'SGST output payable', cls: 'liability', group: 'Statutory' },
  { code: A.MEMBER_ADVANCE, name: 'Advances received from members', cls: 'liability', group: 'Payables', control: 'resident' },
  { code: A.DEPOSITS_HELD, name: 'Deposits held', cls: 'liability', group: 'Payables' },

  { code: A.SINKING_FUND, name: 'Sinking fund', cls: 'fund', group: 'Funds' },
  { code: A.FESTIVAL_FUND, name: 'Festival and event fund', cls: 'fund', group: 'Funds' },
  { code: A.GENERAL_RESERVE, name: 'General reserve (accumulated surplus)', cls: 'fund', group: 'Funds' },

  { code: A.INC_MAINTENANCE, name: 'Maintenance charges', cls: 'income', group: 'Maintenance charges' },
  { code: A.INC_SINKING_CONTRIBUTION, name: 'Sinking fund contributions', cls: 'income', group: 'Sinking fund', note: 'Only used when config.sinkingFundThroughIncome is true — see config.ts.' },
  { code: A.INC_FESTIVAL, name: 'Festival and event collections', cls: 'income', group: 'Festival and event' },
  { code: A.INC_SPACE_RENTAL, name: 'Common space rental', cls: 'income', group: 'Common space rental' },
  { code: A.INC_REIMBURSEMENT, name: 'Reimbursable expense recoveries', cls: 'income', group: 'Reimbursable expenses' },
  { code: A.INC_OTHER_RECEIPTS, name: 'Other receipts', cls: 'income', group: 'Other receipts' },
  { code: A.INC_LATE_INTEREST, name: 'Late payment interest', cls: 'income', group: 'Maintenance charges' },

  { code: A.EXP_WATER, name: 'Water supply', cls: 'expenditure', group: 'Utilities' },
  { code: A.EXP_SECURITY, name: 'Security services', cls: 'expenditure', group: 'Establishment' },
  { code: A.EXP_LIFT, name: 'Lift maintenance', cls: 'expenditure', group: 'Repairs and maintenance' },
  { code: A.EXP_REPAIRS, name: 'Repairs and maintenance', cls: 'expenditure', group: 'Repairs and maintenance' },
  { code: A.EXP_ELECTRICITY, name: 'Electricity — common area', cls: 'expenditure', group: 'Utilities' },
  { code: A.EXP_HOUSEKEEPING, name: 'Housekeeping', cls: 'expenditure', group: 'Establishment' },
  { code: A.EXP_PROFESSIONAL, name: 'Audit and professional fees', cls: 'expenditure', group: 'Administrative' },
  { code: A.EXP_BANK_CHARGES, name: 'Bank charges', cls: 'expenditure', group: 'Administrative' },
  { code: A.EXP_FESTIVAL, name: 'Festival and event expenses', cls: 'expenditure', group: 'Festival and event' },
  { code: A.EXP_DEPRECIATION, name: 'Depreciation', cls: 'expenditure', group: 'Administrative' },
];

const BY_CODE: ReadonlyMap<string, Account> = new Map(CHART.map(a => [a.code, a]));

export class UnknownAccountError extends Error {
  constructor(code: string) {
    super(`No account with code "${code}" in the chart of accounts`);
  }
}

export function account(code: string): Account {
  const found = BY_CODE.get(code);
  if (!found) throw new UnknownAccountError(code);
  return found;
}

export function hasAccount(code: string): boolean {
  return BY_CODE.has(code);
}

export function accountsOfClass(cls: AccountClass): readonly Account[] {
  return CHART.filter(a => a.cls === cls);
}

export function cashAccounts(): readonly Account[] {
  return CHART.filter(a => a.isCash === true);
}

/** The six receipt heads the association reports collections under. */
export interface ReceiptHeadSpec {
  readonly key: string;
  readonly label: string;
  /** Income account the head is credited to. */
  readonly income: string;
  /** Set where the head also has a fund the contribution may be credited to. */
  readonly fund?: string;
}

export const RECEIPT_HEADS: readonly ReceiptHeadSpec[] = [
  { key: 'maintenance', label: 'Maintenance charges', income: A.INC_MAINTENANCE },
  { key: 'sinking', label: 'Sinking fund', income: A.INC_SINKING_CONTRIBUTION, fund: A.SINKING_FUND },
  { key: 'festival', label: 'Festival and event', income: A.INC_FESTIVAL, fund: A.FESTIVAL_FUND },
  { key: 'rental', label: 'Common space rental', income: A.INC_SPACE_RENTAL },
  { key: 'reimbursement', label: 'Reimbursable expenses', income: A.INC_REIMBURSEMENT },
  { key: 'other', label: 'Other receipts', income: A.INC_OTHER_RECEIPTS },
];

/**
 * Late-payment interest and penalties, as a bill line.
 *
 * Not one of the six collection heads above — those are what the association
 * reports collections under and what the server's receipt_heads table mirrors —
 * but a line a bill can carry. It credits 4060, which the chart always had and
 * nothing used: the import booked penalties to "Other receipts" instead, so
 * the income statement showed no penalty income at all and an "other" figure
 * nobody could explain.
 */
export const LATE_INTEREST_HEAD: ReceiptHeadSpec = {
  key: 'late-interest',
  label: 'Late payment interest',
  income: A.INC_LATE_INTEREST,
};

/** Keys of the bill-line heads, as a union so a typo will not typecheck. */
export type ReceiptHead =
  | 'maintenance' | 'sinking' | 'festival' | 'rental' | 'reimbursement' | 'other'
  | 'late-interest';

export function receiptHead(key: ReceiptHead): ReceiptHeadSpec {
  if (key === LATE_INTEREST_HEAD.key) return LATE_INTEREST_HEAD;
  const found = RECEIPT_HEADS.find(h => h.key === key);
  if (!found) throw new Error(`Unknown receipt head "${key}"`);
  return found;
}
