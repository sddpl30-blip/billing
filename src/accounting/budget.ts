/**
 * Budget against actuals.
 *
 * A budget is genuinely an input — a figure a general body approves — so the
 * budgeted column is declared here rather than derived. The realised column is
 * not an input, and the old screen treated it as one: four literal amounts with
 * literal variance percentages, one of which was simply wrong (₹21,000 against
 * ₹25,000 was printed as −16.03% rather than −16.00%). Here the realised figure
 * comes from the ledger and the variance is computed, so it cannot disagree
 * with itself.
 */

import { Paise, fromRupees } from './money';
import { A, account } from './accounts';
import { Ledger } from './journal';
import { NORMAL_BALANCE } from './accounts';

export interface BudgetLine {
  readonly head: string;
  /** Accounts whose movement in the period is this head's actual. */
  readonly accounts: readonly string[];
  readonly budgeted: Paise;
}

export interface BudgetVsActualRow {
  readonly head: string;
  readonly budgeted: Paise;
  readonly actual: Paise;
  readonly variance: Paise;
  /** Percentage of budget, or null where the budget is zero and a ratio is undefined. */
  readonly variancePercent: number | null;
  /**
   * Whether the variance is good news. Collecting more income than budgeted is
   * favourable; spending more than budgeted is not. Without this the screen
   * marks a collection overshoot in red alongside a cost overrun.
   */
  readonly favourable: boolean;
  /** Whether the head's accounts are income or expenditure. */
  readonly kind: 'income' | 'expenditure' | 'mixed';
}

/**
 * DEMO VALUES. These are not an approved budget — they stand in for one until
 * the association supplies the figures its general body passed.
 */
export const DEMO_BUDGET: readonly BudgetLine[] = [
  { head: 'Maintenance charges', accounts: [A.INC_MAINTENANCE], budgeted: fromRupees(350000) },
  { head: 'Sinking fund contributions', accounts: [A.SINKING_FUND, A.INC_SINKING_CONTRIBUTION], budgeted: fromRupees(80000) },
  { head: 'Water supply', accounts: [A.EXP_WATER], budgeted: fromRupees(45000) },
  { head: 'Security services', accounts: [A.EXP_SECURITY], budgeted: fromRupees(140000) },
  { head: 'Repairs and maintenance', accounts: [A.EXP_REPAIRS, A.EXP_LIFT], budgeted: fromRupees(50000) },
];

/**
 * Actual movement on each head's accounts over the period, against budget.
 *
 * Variance is actual less budget as a percentage of budget, computed from the
 * two figures on the row, so it always agrees with them.
 */
export function budgetVsActual(
  ledger: Ledger,
  budget: readonly BudgetLine[],
  from: string,
  to: string,
): readonly BudgetVsActualRow[] {
  const movement = new Map<string, Paise>();
  for (const entry of ledger.inPeriod(from, to)) {
    for (const posting of entry.postings) {
      const acct = account(posting.accountCode);
      const delta = NORMAL_BALANCE[acct.cls] === 'debit'
        ? posting.debit - posting.credit
        : posting.credit - posting.debit;
      movement.set(acct.code, (movement.get(acct.code) ?? 0) + delta);
    }
  }

  return budget.map(line => {
    const actual = line.accounts.reduce((sum, code) => sum + (movement.get(code) ?? 0), 0);
    const variance = actual - line.budgeted;

    // A head's direction comes from the accounts behind it. A fund credit
    // counts as a receipt for this purpose, since that is what the budget line
    // is tracking.
    const classes = new Set(line.accounts.map(c => account(c).cls));
    const isReceipt = [...classes].every(c => c === 'income' || c === 'fund');
    const isSpend = [...classes].every(c => c === 'expenditure');
    const kind: 'income' | 'expenditure' | 'mixed' =
      isReceipt ? 'income' : isSpend ? 'expenditure' : 'mixed';

    return {
      head: line.head,
      budgeted: line.budgeted,
      actual,
      variance,
      variancePercent: line.budgeted === 0 ? null : (variance / line.budgeted) * 100,
      favourable: kind === 'income' ? variance >= 0 : variance <= 0,
      kind,
    };
  });
}
