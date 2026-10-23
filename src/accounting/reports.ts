/**
 * Trial balance and the three statements.
 *
 * Every figure here is read out of the ledger. There is no literal amount in
 * this file and no balancing or difference line: if a statement does not tie,
 * that is reported as a failure rather than plugged.
 */

import { Paise, sum } from './money';
import {
  Account, AccountClass, CHART, NORMAL_BALANCE, account, cashAccounts,
} from './accounts';
import { Ledger, Posting, JournalEntry } from './journal';

export interface TrialBalanceRow {
  readonly account: Account;
  /** Gross movements, which is what reconciling against vouchers needs. */
  readonly debit: Paise;
  readonly credit: Paise;
  /** The net balance, on the one side it actually falls. Conventional presentation. */
  readonly netDebit: Paise;
  readonly netCredit: Paise;
}

export interface TrialBalance {
  readonly asAt: string;
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebit: Paise;
  readonly totalCredit: Paise;
  /** Net sides, which must also agree. */
  readonly totalNetDebit: Paise;
  readonly totalNetCredit: Paise;
  readonly balanced: boolean;
  /** Accounts sitting on the side they should not be — a real signal, not an error. */
  readonly contraNormal: readonly Account[];
}

function legsUpTo(ledger: Ledger, asAt: string): Array<{ entry: JournalEntry; posting: Posting }> {
  const out: Array<{ entry: JournalEntry; posting: Posting }> = [];
  for (const entry of ledger.all()) {
    if (entry.date > asAt) continue;
    for (const posting of entry.postings) out.push({ entry, posting });
  }
  return out;
}

/** True when gross debits equal gross credits. Exported so it can be tested
 *  against figures that do not tie — on real ledger data it is always true,
 *  which would let a hardcoded `true` pass every other test. */
export function debitsEqualCredits(totals: { totalDebit: Paise; totalCredit: Paise }): boolean {
  return totals.totalDebit === totals.totalCredit;
}

/** Gross debits and credits per account, which is what an auditor asks for. */
export function trialBalance(ledger: Ledger, asAt: string): TrialBalance {
  const debits = new Map<string, Paise>();
  const credits = new Map<string, Paise>();

  for (const { posting } of legsUpTo(ledger, asAt)) {
    debits.set(posting.accountCode, (debits.get(posting.accountCode) ?? 0) + posting.debit);
    credits.set(posting.accountCode, (credits.get(posting.accountCode) ?? 0) + posting.credit);
  }

  const rows: TrialBalanceRow[] = [];
  const contraNormal: Account[] = [];
  for (const acct of CHART) {
    const d = debits.get(acct.code) ?? 0;
    const c = credits.get(acct.code) ?? 0;
    if (d === 0 && c === 0) continue;
    rows.push({
      account: acct,
      debit: d,
      credit: c,
      netDebit: d > c ? d - c : 0,
      netCredit: c > d ? c - d : 0,
    });

    const net = NORMAL_BALANCE[acct.cls] === 'debit' ? d - c : c - d;
    if (net < 0) contraNormal.push(acct);
  }

  const totalDebit = sum(rows.map(r => r.debit));
  const totalCredit = sum(rows.map(r => r.credit));
  return {
    asAt,
    rows,
    totalNetDebit: sum(rows.map(r => r.netDebit)),
    totalNetCredit: sum(rows.map(r => r.netCredit)),
    totalDebit,
    totalCredit,
    balanced: debitsEqualCredits({ totalDebit, totalCredit }),
    contraNormal,
  };
}

/** Net balance per account, positive on its normal side. */
export function netBalances(ledger: Ledger, asAt: string): Map<string, Paise> {
  const out = new Map<string, Paise>();
  for (const { posting } of legsUpTo(ledger, asAt)) {
    const acct = account(posting.accountCode);
    const movement = NORMAL_BALANCE[acct.cls] === 'debit'
      ? posting.debit - posting.credit
      : posting.credit - posting.debit;
    out.set(acct.code, (out.get(acct.code) ?? 0) + movement);
  }
  return out;
}

function classTotal(balances: Map<string, Paise>, cls: AccountClass): Paise {
  let total = 0;
  for (const [code, amount] of balances) {
    if (account(code).cls === cls) total += amount;
  }
  return total;
}

export interface StatementLine {
  readonly group: string;
  readonly accounts: ReadonlyArray<{ account: Account; amount: Paise }>;
  readonly total: Paise;
}

function linesFor(
  balances: Map<string, Paise>,
  cls: AccountClass,
  opts: { includeZero?: boolean } = {},
): StatementLine[] {
  const byGroup = new Map<string, Array<{ account: Account; amount: Paise }>>();
  for (const acct of CHART) {
    if (acct.cls !== cls) continue;
    const amount = balances.get(acct.code) ?? 0;
    if (amount === 0 && !opts.includeZero) continue;
    const list = byGroup.get(acct.group) ?? [];
    list.push({ account: acct, amount });
    byGroup.set(acct.group, list);
  }
  return [...byGroup].map(([group, accounts]) => ({
    group,
    accounts,
    total: sum(accounts.map(a => a.amount)),
  }));
}

// --- Income & Expenditure -------------------------------------------------

export interface IncomeAndExpenditure {
  readonly from: string;
  readonly to: string;
  readonly income: readonly StatementLine[];
  readonly expenditure: readonly StatementLine[];
  readonly totalIncome: Paise;
  readonly totalExpenditure: Paise;
  /** Income less expenditure. Negative means a deficit. */
  readonly surplus: Paise;
}

/**
 * Accrual basis: every income and expenditure account movement in the period,
 * whether or not cash moved. Billing raised but unpaid is income here; that is
 * the whole difference from Receipts & Payments below.
 */
export function incomeAndExpenditure(ledger: Ledger, from: string, to: string): IncomeAndExpenditure {
  const period = new Map<string, Paise>();
  for (const entry of ledger.inPeriod(from, to)) {
    for (const posting of entry.postings) {
      const acct = account(posting.accountCode);
      if (acct.cls !== 'income' && acct.cls !== 'expenditure') continue;
      const movement = NORMAL_BALANCE[acct.cls] === 'debit'
        ? posting.debit - posting.credit
        : posting.credit - posting.debit;
      period.set(acct.code, (period.get(acct.code) ?? 0) + movement);
    }
  }

  const income = linesFor(period, 'income');
  const expenditure = linesFor(period, 'expenditure');
  const totalIncome = sum(income.map(l => l.total));
  const totalExpenditure = sum(expenditure.map(l => l.total));

  return {
    from, to, income, expenditure, totalIncome, totalExpenditure,
    surplus: totalIncome - totalExpenditure,
  };
}

// --- Receipts & Payments --------------------------------------------------

/** True when opening plus receipts less payments equals closing cash. Exported
 *  for the same reason as `debitsEqualCredits`. */
export function cashFlowCloses(figures: {
  openingCash: Paise; totalReceipts: Paise; totalPayments: Paise; closingCash: Paise;
}): boolean {
  return figures.openingCash + figures.totalReceipts - figures.totalPayments === figures.closingCash;
}

export interface ReceiptsAndPayments {
  readonly from: string;
  readonly to: string;
  readonly openingCash: Paise;
  readonly receipts: ReadonlyArray<{ label: string; amount: Paise }>;
  readonly payments: ReadonlyArray<{ label: string; amount: Paise }>;
  readonly totalReceipts: Paise;
  readonly totalPayments: Paise;
  readonly closingCash: Paise;
  /** Opening + receipts − payments must equal the closing cash balance. */
  readonly reconciles: boolean;
}

/**
 * Cash basis: what actually moved through bank and cash in the period, grouped
 * by the account on the other side of each cash leg. Opening and closing are
 * the real cash balances from the ledger, so the statement reconciles against
 * the balance sheet by construction or reports that it does not.
 */
export function receiptsAndPayments(ledger: Ledger, from: string, to: string): ReceiptsAndPayments {
  const cashCodes = new Set(cashAccounts().map(a => a.code));

  const dayBefore = (iso: string): string => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };

  const cashAt = (asAt: string): Paise => {
    const balances = netBalances(ledger, asAt);
    let total = 0;
    for (const code of cashCodes) total += balances.get(code) ?? 0;
    return total;
  };

  // Cash the opening entry establishes belongs in the opening figure even when
  // the period contains that entry — a Receipts & Payments statement that
  // listed opening capital as a receipt of the month would be misleading, and
  // the identity below still holds because the same amount is excluded from
  // the receipt lines.
  const openingWithinPeriod = sum(
    ledger.inPeriod(from, to)
      .filter(e => e.source.kind === 'opening-balance')
      .flatMap(e => e.postings
        .filter(p => cashCodes.has(p.accountCode))
        .map(p => p.debit - p.credit)),
  );
  const openingCash = cashAt(dayBefore(from)) + openingWithinPeriod;
  const closingCash = cashAt(to);

  const receiptsByLabel = new Map<string, Paise>();
  const paymentsByLabel = new Map<string, Paise>();

  for (const entry of ledger.inPeriod(from, to)) {
    if (entry.source.kind === 'opening-balance') continue; // counted as opening cash
    const cashLegs = entry.postings.filter(p => cashCodes.has(p.accountCode));
    if (cashLegs.length === 0) continue;
    const otherLegs = entry.postings.filter(p => !cashCodes.has(p.accountCode));

    const cashIn = sum(cashLegs.map(p => p.debit)) - sum(cashLegs.map(p => p.credit));
    if (cashIn === 0) continue; // a transfer between two cash accounts

    // Attribute the movement to the non-cash side of the same entry. Where an
    // entry has several non-cash legs, each is attributed its own share, so
    // nothing is lumped into an "other" bucket.
    const weightOf = (p: Posting) => Math.abs(p.debit - p.credit);
    const totalWeight = sum(otherLegs.map(weightOf));
    for (const leg of otherLegs) {
      const share = totalWeight === 0 ? 0 : Math.round((cashIn * weightOf(leg)) / totalWeight);
      if (share === 0) continue;
      const label = account(leg.accountCode).name;
      const target = share > 0 ? receiptsByLabel : paymentsByLabel;
      target.set(label, (target.get(label) ?? 0) + Math.abs(share));
    }
  }

  const receipts = [...receiptsByLabel].map(([label, amount]) => ({ label, amount }));
  const payments = [...paymentsByLabel].map(([label, amount]) => ({ label, amount }));
  const totalReceipts = sum(receipts.map(r => r.amount));
  const totalPayments = sum(payments.map(p => p.amount));

  return {
    from, to, openingCash, receipts, payments, totalReceipts, totalPayments, closingCash,
    reconciles: cashFlowCloses({ openingCash, totalReceipts, totalPayments, closingCash }),
  };
}

// --- Balance sheet --------------------------------------------------------

export interface BalanceSheet {
  readonly asAt: string;
  readonly assets: readonly StatementLine[];
  readonly liabilities: readonly StatementLine[];
  readonly funds: readonly StatementLine[];
  readonly totalAssets: Paise;
  readonly totalLiabilities: Paise;
  readonly totalFunds: Paise;
  /** Surplus for the year, carried in rather than posted to a reserve yet. */
  readonly surplusForPeriod: Paise;
  readonly totalLiabilitiesAndFunds: Paise;
  readonly balanced: boolean;
  /** Assets less liabilities, funds and surplus. Zero when it balances. */
  readonly difference: Paise;
}

/**
 * Assets against liabilities, funds and the surplus not yet appropriated.
 *
 * The surplus is computed from the income and expenditure accounts rather than
 * assumed, which is what makes the identity hold: every entry balances, so
 * assets − liabilities − funds − (income − expenditure) is zero. `difference`
 * is reported rather than hidden; if it is ever non-zero something upstream is
 * wrong and the statement says so.
 */
export function balanceSheet(ledger: Ledger, asAt: string): BalanceSheet {
  return assembleBalanceSheet(netBalances(ledger, asAt), asAt);
}

/**
 * The balance sheet's arithmetic, over a set of account balances.
 *
 * Separated from the ledger so the imbalance detection can be tested against
 * balances that do not tie. Every entry the engine posts balances, so a real
 * ledger can never produce a non-zero difference — which means a `balanced`
 * flag that was simply hardcoded true would pass every test run against real
 * data. This seam is how that is caught.
 */
export function assembleBalanceSheet(
  balances: Map<string, Paise>,
  asAt: string,
): BalanceSheet {
  const assets = linesFor(balances, 'asset');
  const liabilities = linesFor(balances, 'liability');
  const funds = linesFor(balances, 'fund');

  const totalAssets = sum(assets.map(l => l.total));
  const totalLiabilities = sum(liabilities.map(l => l.total));
  const totalFunds = sum(funds.map(l => l.total));

  const surplusForPeriod =
    classTotal(balances, 'income') - classTotal(balances, 'expenditure');

  const totalLiabilitiesAndFunds = totalLiabilities + totalFunds + surplusForPeriod;
  const difference = totalAssets - totalLiabilitiesAndFunds;

  return {
    asAt,
    assets, liabilities, funds,
    totalAssets, totalLiabilities, totalFunds,
    surplusForPeriod,
    totalLiabilitiesAndFunds,
    balanced: difference === 0,
    difference,
  };
}

// --- Cross-statement reconciliation ---------------------------------------

export interface Reconciliation {
  readonly checks: ReadonlyArray<{ name: string; passed: boolean; detail: string }>;
  readonly allPassed: boolean;
}

/**
 * Checks the three statements against each other and against the ledger. This
 * is what the UI should call before showing a statement as final.
 */
export function reconcile(ledger: Ledger, from: string, to: string): Reconciliation {
  const tb = trialBalance(ledger, to);
  const bs = balanceSheet(ledger, to);
  const ie = incomeAndExpenditure(ledger, from, to);
  const rp = receiptsAndPayments(ledger, from, to);

  const cashOnBalanceSheet = sum(
    bs.assets
      .flatMap(l => l.accounts)
      .filter(a => a.account.isCash === true)
      .map(a => a.amount),
  );

  const checks = [
    {
      name: 'Trial balance',
      passed: tb.balanced,
      detail: `debits ${tb.totalDebit} vs credits ${tb.totalCredit} paise`,
    },
    {
      name: 'Balance sheet identity',
      passed: bs.balanced,
      detail: `assets ${bs.totalAssets} vs liabilities + funds + surplus ${bs.totalLiabilitiesAndFunds} paise`,
    },
    {
      name: 'Receipts & Payments closes to cash',
      passed: rp.reconciles,
      detail: `opening ${rp.openingCash} + receipts ${rp.totalReceipts} − payments ${rp.totalPayments} vs closing ${rp.closingCash} paise`,
    },
    {
      name: 'R&P closing cash equals balance sheet cash',
      passed: rp.closingCash === cashOnBalanceSheet,
      detail: `R&P ${rp.closingCash} vs balance sheet ${cashOnBalanceSheet} paise`,
    },
    {
      name: 'Every entry balances individually',
      passed: ledger.all().every(
        e => sum(e.postings.map(p => p.debit)) === sum(e.postings.map(p => p.credit)),
      ),
      detail: `${ledger.all().length} entries checked`,
    },
  ];

  // The period surplus on the balance sheet includes everything to date, so it
  // only equals the period I&E when the period starts from the first entry.
  const firstEntryDate = ledger.all().reduce<string | null>(
    (min, e) => (min === null || e.date < min ? e.date : min), null,
  );
  if (firstEntryDate !== null && from <= firstEntryDate) {
    checks.push({
      name: 'I&E surplus equals balance sheet surplus',
      passed: ie.surplus === bs.surplusForPeriod,
      detail: `I&E ${ie.surplus} vs balance sheet ${bs.surplusForPeriod} paise`,
    });
  }

  return { checks, allPassed: checks.every(c => c.passed) };
}
