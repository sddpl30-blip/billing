/**
 * Turns the ledger's statements into rupee-denominated rows the React screens
 * can render directly.
 *
 * This is the only boundary where paise become rupees. Keeping the conversion
 * here means the UI never does money arithmetic, which is what let the old
 * report compute its revenue on one basis and its surplus on another.
 */

import { Paise, formatRupees, toRupees } from './money';
import { AccountingConfig, DEMO_CONFIG, outstandingConfirmations } from './config';
import {
  balanceSheet, incomeAndExpenditure, receiptsAndPayments, reconcile, trialBalance,
} from './reports';
import { Ledger } from './journal';
import { SourceInvoice, SourceVendorInvoice, importDemoData } from './adapter';
import { DEMO_BUDGET, budgetVsActual } from './budget';

export interface StatementRow {
  readonly label: string;
  readonly amount: number;
  readonly formatted: string;
  /** True for a subtotal or total line, so the UI can weight it. */
  readonly emphasis?: boolean;
  /** True for an amount that should read as a deduction. */
  readonly negative?: boolean;
}

export interface StatementSection {
  readonly heading: string;
  readonly rows: readonly StatementRow[];
}

export interface Statements {
  readonly periodLabel: string;
  readonly incomeAndExpenditure: {
    readonly sections: readonly StatementSection[];
    readonly surplus: StatementRow;
    readonly basis: string;
  };
  readonly balanceSheet: {
    readonly sections: readonly StatementSection[];
    readonly totalAssets: StatementRow;
    readonly totalLiabilitiesAndFunds: StatementRow;
    readonly balanced: boolean;
    readonly difference: string;
  };
  readonly receiptsAndPayments: {
    readonly sections: readonly StatementSection[];
    readonly closing: StatementRow;
    readonly reconciles: boolean;
  };
  readonly trialBalance: {
    readonly rows: ReadonlyArray<{ code: string; name: string; debit: string; credit: string }>;
    readonly totalDebit: string;
    readonly totalCredit: string;
    readonly balanced: boolean;
  };
  readonly journal: ReadonlyArray<{
    readonly id: string;
    readonly date: string;
    readonly narration: string;
    readonly legs: ReadonlyArray<{ side: 'Dr' | 'Cr'; account: string; party?: string; amount: string }>;
  }>;
  /** Every cross-statement check, so a screen can show whether it ties. */
  readonly checks: ReadonlyArray<{ name: string; passed: boolean; detail: string }>;
  readonly allChecksPassed: boolean;
  /** Rows the import could not post. Shown rather than hidden. */
  readonly importProblems: ReadonlyArray<{ what: string; why: string }>;
  readonly pendingConfirmations: readonly string[];
  readonly counts: { invoices: number; receipts: number; vendorBills: number; entries: number };
  /**
   * Where the figures came from. `live-ledger` means the screens and the books
   * are reading the same postings; `imported-seed` means nothing has been
   * posted yet and the seed documents were imported to show something.
   */
  readonly source: 'live-ledger' | 'imported-seed';
  readonly budget: ReadonlyArray<{
    readonly head: string;
    readonly budgeted: string;
    readonly actual: string;
    readonly variance: string;
    /** Already formatted, e.g. "-16.00%", or null where the budget is zero. */
    readonly variancePercent: string | null;
    /** True when the variance is bad news, which depends on the head's direction. */
    readonly adverse: boolean;
    readonly kind: 'income' | 'expenditure' | 'mixed';
    /** Share of budget used, clamped to 0..100 for a progress bar. */
    readonly usedPercent: number;
  }>;
}

const row = (label: string, amount: Paise, opts: { emphasis?: boolean; negative?: boolean } = {}): StatementRow => ({
  label,
  amount: toRupees(amount),
  formatted: formatRupees(amount),
  ...opts,
});

/**
 * Builds every statement from the invoice and vendor arrays the screens hold.
 *
 * The arrays remain the write path for now; this is a read model over them, so
 * the statements are derived from real transactions without the UI's state
 * management having to change first. Moving the writes into the engine is the
 * next step, and nothing in the screens will need to know when it happens.
 */
export function buildStatements(
  invoices: readonly SourceInvoice[],
  vendorInvoices: readonly SourceVendorInvoice[],
  opts: {
    from?: string;
    to?: string;
    config?: AccountingConfig;
    /**
     * A live ledger to report on. When it has entries it is used as-is, which
     * is how the screens report on what the store has actually posted rather
     * than on a ledger rebuilt from the document arrays. An empty one falls
     * back to importing the seed, so a fresh load is not a blank set of books.
     */
    ledger?: Ledger;
  } = {},
): Statements {
  const config = opts.config ?? DEMO_CONFIG;
  const live = opts.ledger;
  const useLive = live !== undefined && live.all().length > 0;
  const imported = useLive
    ? { ledger: live, invoicesPosted: 0, receiptsPosted: 0, vendorBillsPosted: 0, skipped: [] }
    : importDemoData(invoices, vendorInvoices, config);
  const ledger = imported.ledger;

  const dates = ledger.all().map(e => e.date).sort();
  const from = opts.from ?? (dates[0] ?? '2026-01-01');
  const to = opts.to ?? (dates[dates.length - 1] ?? '2026-12-31');

  const ie = incomeAndExpenditure(ledger, from, to);
  const bs = balanceSheet(ledger, to);
  const rp = receiptsAndPayments(ledger, from, to);
  const tb = trialBalance(ledger, to);
  const rec = reconcile(ledger, from, to);

  return {
    periodLabel: `${from} to ${to}`,
    incomeAndExpenditure: {
      basis: 'Accrual — billing raised in the period, whether or not it has been collected.',
      sections: [
        {
          heading: 'Income',
          rows: [
            ...ie.income.map(l => row(l.group, l.total)),
            row('Total income', ie.totalIncome, { emphasis: true }),
          ],
        },
        {
          heading: 'Expenditure',
          rows: [
            ...ie.expenditure.map(l => row(l.group, l.total, { negative: true })),
            row('Total expenditure', ie.totalExpenditure, { emphasis: true, negative: true }),
          ],
        },
      ],
      surplus: row(ie.surplus >= 0 ? 'Surplus for the period' : 'Deficit for the period', ie.surplus, { emphasis: true }),
    },
    balanceSheet: {
      sections: [
        {
          heading: 'Assets',
          rows: [
            ...bs.assets.flatMap(l => l.accounts.map(a => row(a.account.name, a.amount))),
            row('Total assets', bs.totalAssets, { emphasis: true }),
          ],
        },
        {
          heading: 'Liabilities',
          rows: [
            ...bs.liabilities.flatMap(l => l.accounts.map(a => row(a.account.name, a.amount))),
            row('Total liabilities', bs.totalLiabilities, { emphasis: true }),
          ],
        },
        {
          heading: 'Funds and surplus',
          rows: [
            ...bs.funds.flatMap(l => l.accounts.map(a => row(a.account.name, a.amount))),
            row('Surplus for the period', bs.surplusForPeriod),
            row('Total funds and surplus', bs.totalFunds + bs.surplusForPeriod, { emphasis: true }),
          ],
        },
      ],
      totalAssets: row('Total assets', bs.totalAssets, { emphasis: true }),
      totalLiabilitiesAndFunds: row('Total liabilities, funds and surplus', bs.totalLiabilitiesAndFunds, { emphasis: true }),
      balanced: bs.balanced,
      difference: formatRupees(bs.difference, { paise: true }),
    },
    receiptsAndPayments: {
      sections: [
        { heading: 'Opening', rows: [row('Opening cash and bank', rp.openingCash)] },
        {
          heading: 'Receipts',
          rows: [
            ...rp.receipts.map(r => row(r.label, r.amount)),
            row('Total receipts', rp.totalReceipts, { emphasis: true }),
          ],
        },
        {
          heading: 'Payments',
          rows: [
            ...rp.payments.map(p => row(p.label, p.amount, { negative: true })),
            row('Total payments', rp.totalPayments, { emphasis: true, negative: true }),
          ],
        },
      ],
      closing: row('Closing cash and bank', rp.closingCash, { emphasis: true }),
      reconciles: rp.reconciles,
    },
    trialBalance: {
      rows: tb.rows.map(r => ({
        code: r.account.code,
        name: r.account.name,
        debit: r.netDebit === 0 ? '' : formatRupees(r.netDebit),
        credit: r.netCredit === 0 ? '' : formatRupees(r.netCredit),
      })),
      totalDebit: formatRupees(tb.totalNetDebit),
      totalCredit: formatRupees(tb.totalNetCredit),
      balanced: tb.totalNetDebit === tb.totalNetCredit,
    },
    journal: ledger.all().map(e => ({
      id: e.id,
      date: e.date,
      narration: e.narration,
      legs: e.postings.map(p => ({
        side: (p.debit > 0 ? 'Dr' : 'Cr') as 'Dr' | 'Cr',
        account: p.accountCode,
        party: p.party,
        amount: formatRupees(p.debit > 0 ? p.debit : p.credit),
      })),
    })),
    checks: rec.checks.map(c => ({ name: c.name, passed: c.passed, detail: c.detail })),
    allChecksPassed: rec.allPassed,
    importProblems: imported.skipped,
    pendingConfirmations: outstandingConfirmations(config),
    budget: budgetVsActual(ledger, DEMO_BUDGET, from, to).map(b => ({
      head: b.head,
      budgeted: formatRupees(b.budgeted),
      actual: formatRupees(b.actual),
      variance: formatRupees(b.variance),
      variancePercent: b.variancePercent === null
        ? null
        : `${b.variancePercent >= 0 ? '+' : ''}${b.variancePercent.toFixed(2)}%`,
      adverse: !b.favourable && b.variance !== 0,
      kind: b.kind,
      usedPercent: b.budgeted === 0 ? 0 : Math.min(100, Math.max(0, (b.actual / b.budgeted) * 100)),
    })),
    counts: {
      invoices: imported.invoicesPosted,
      receipts: imported.receiptsPosted,
      vendorBills: imported.vendorBillsPosted,
      entries: ledger.all().length,
    },
    source: useLive ? 'live-ledger' : 'imported-seed',
  };
}
