/**
 * Each report's server response, laid out as a `ReportView`.
 *
 * These only arrange what the server sent. The one sum done here is a column
 * total for display where the server gives none (gross TDS, the two sides of
 * the balance sheet), and every status line reads the server's own comparison
 * — `tiesOut`, `balances`, `agrees` — rather than re-deciding it.
 */

import type {
  Ageing, AuditEntry, BalanceSheet, Collections, GstReport, IncomeAndExpenditure,
  LedgerEntries, MemberStatement, TdsReport, TrialBalance, TrialBalanceLine,
} from '../../../api/office/reports';
import { LEDGER_ENTRY_LIMIT } from '../../../api/office/reports';
import {
  formatDate, formatInstant, formatMoney, formatMonth, money, type Cell, type ReportView, type TableSpec,
} from './format';
import { QUARTER_MONTHS } from './periods';

const asAtText = (asAt: string) => `As at ${formatDate(asAt)}`;
const rangeText = (from: string, to: string) => `${formatDate(from)} to ${formatDate(to)}`;

const CLASS_LABEL: Record<string, string> = {
  asset: 'Asset', liability: 'Liability', fund: 'Fund', income: 'Income', expenditure: 'Expenditure',
};

export function trialBalanceView(tb: TrialBalance): ReportView {
  const difference = tb.totalDebit - tb.totalCredit;
  return {
    title: 'Trial balance',
    period: asAtText(tb.asAt),
    fileStem: `trial-balance_${tb.asAt}`,
    status: [tb.tiesOut
      ? { tone: 'good', text: `Ties out: debits and credits are both ${formatMoney(tb.totalDebit)}.` }
      : { tone: 'bad', text: `Does not tie: debits exceed credits by ${formatMoney(difference)}.` }],
    tables: [{
      title: 'Trial balance',
      columns: [
        { label: 'Code' }, { label: 'Account' }, { label: 'Class' },
        { label: 'Debit', numeric: true }, { label: 'Credit', numeric: true },
      ],
      rows: tb.lines.map(l => [
        l.code, l.name, CLASS_LABEL[l.class] ?? l.class, money(l.debit, true), money(l.credit, true),
      ]),
      footer: [['', 'Total', '', money(tb.totalDebit), money(tb.totalCredit)]],
      empty: 'Nothing has been posted on or before this date.',
    }],
  };
}

/**
 * A line's balance on its account's normal side: debit for assets and
 * expenditure, credit for the rest. The same rule the server's `netOf` uses
 * to build its totals, so the lines add up to the server's figures.
 */
function normalBalance(line: TrialBalanceLine): number {
  return line.class === 'asset' || line.class === 'expenditure'
    ? line.debit - line.credit
    : line.credit - line.debit;
}

const accountColumns = [{ label: 'Code' }, { label: 'Account' }, { label: 'Amount', numeric: true }];
const accountRows = (lines: readonly TrialBalanceLine[]) =>
  lines.map(l => [l.code, l.name, money(normalBalance(l))] as Cell[]);

export function balanceSheetView(bs: BalanceSheet): ReportView {
  const otherSide = bs.totalLiabilities + bs.totalFunds + bs.surplus;
  return {
    title: 'Balance sheet',
    period: asAtText(bs.asAt),
    fileStem: `balance-sheet_${bs.asAt}`,
    status: [bs.balances
      ? { tone: 'good', text: `Balances: assets equal liabilities, funds and surplus at ${formatMoney(bs.totalAssets)}.` }
      : { tone: 'bad', text: `Does not balance: assets ${formatMoney(bs.totalAssets)}, liabilities, funds and surplus ${formatMoney(otherSide)}.` }],
    tables: [
      {
        title: 'Liabilities',
        columns: accountColumns,
        rows: accountRows(bs.liabilities),
        footer: [['', 'Total liabilities', money(bs.totalLiabilities)]],
        empty: 'No liabilities.',
      },
      {
        title: 'Funds and surplus',
        columns: accountColumns,
        rows: [...accountRows(bs.funds), ['', 'Surplus (income less expenditure to date)', money(bs.surplus)]],
        footer: [
          ['', 'Total funds (before surplus)', money(bs.totalFunds)],
          ['', 'Liabilities, funds and surplus', money(otherSide)],
        ],
      },
      {
        title: 'Assets',
        columns: accountColumns,
        rows: accountRows(bs.assets),
        footer: [['', 'Total assets', money(bs.totalAssets)]],
        empty: 'No assets.',
      },
    ],
  };
}

export function incomeExpenditureView(ie: IncomeAndExpenditure): ReportView {
  return {
    title: 'Income & expenditure',
    period: rangeText(ie.from, ie.to),
    fileStem: `income-expenditure_${ie.from}_${ie.to}`,
    tiles: [
      { label: 'Income', value: money(ie.totalIncome) },
      { label: 'Expenditure', value: money(ie.totalExpenditure) },
      { label: ie.surplus < 0 ? 'Deficit' : 'Surplus', value: money(ie.surplus) },
    ],
    tables: [
      {
        title: 'Income',
        columns: accountColumns,
        rows: accountRows(ie.income),
        footer: [['', 'Total income', money(ie.totalIncome)]],
        empty: 'No income in this period.',
      },
      {
        title: 'Expenditure',
        columns: accountColumns,
        rows: accountRows(ie.expenditure),
        footer: [
          ['', 'Total expenditure', money(ie.totalExpenditure)],
          ['', ie.surplus < 0 ? 'Deficit for the period' : 'Surplus for the period', money(ie.surplus)],
        ],
        empty: 'No expenditure in this period.',
      },
    ],
  };
}

/** The server's bucket labels, in its order, with how a committee says them. */
const AGEING_BUCKETS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'not-due', label: 'Not yet due' },
  { key: '1-30', label: '1–30 days' },
  { key: '31-60', label: '31–60 days' },
  { key: '61-90', label: '61–90 days' },
  { key: '90+', label: 'Over 90 days' },
];

export function ageingView(ag: Ageing): ReportView {
  const amountIn = (buckets: Ageing['totals'], key: string) =>
    money(buckets.find(b => b.label === key)?.amount ?? 0, true);
  const totalOf = (key: string) => ag.totals.find(b => b.label === key);
  const overdue = AGEING_BUCKETS.slice(1)
    .reduce((s, b) => s + (totalOf(b.key)?.amount ?? 0), 0);
  return {
    title: 'Receivables ageing',
    period: asAtText(ag.asAt),
    fileStem: `ageing_${ag.asAt}`,
    tiles: [
      { label: 'Outstanding', value: money(ag.total) },
      { label: 'Of which overdue', value: money(overdue) },
      { label: 'Flats owing', value: ag.rows.length },
    ],
    tables: [{
      title: 'Ageing by flat',
      columns: [
        { label: 'Flat' },
        ...AGEING_BUCKETS.map(b => ({ label: b.label, numeric: true })),
        { label: 'Outstanding', numeric: true },
      ],
      rows: ag.rows.map(r => [
        r.flatNo, ...AGEING_BUCKETS.map(b => amountIn(r.buckets, b.key)), money(r.outstanding),
      ]),
      footer: [
        ['Total', ...AGEING_BUCKETS.map(b => amountIn(ag.totals, b.key)), money(ag.total)],
        ['Invoices', ...AGEING_BUCKETS.map(b => totalOf(b.key)?.count ?? 0), ag.totals.reduce((s, b) => s + b.count, 0)],
      ],
      empty: 'No flat owes anything on this date.',
    }],
  };
}

export function collectionsView(c: Collections): ReportView {
  const rate = `${(c.collectionRateBps / 100).toFixed(2)}%`;
  return {
    title: 'Collections',
    period: rangeText(c.from, c.to),
    fileStem: `collections_${c.from}_${c.to}`,
    tiles: [
      { label: 'Billed', value: money(c.billed) },
      { label: 'Collected', value: money(c.collected) },
      { label: 'Collection rate', value: rate },
    ],
    tables: [{
      title: 'Collections',
      columns: [{ label: 'Measure' }, { label: 'Figure', numeric: true }],
      rows: [
        ['Billed (receivable raised in the period)', money(c.billed)],
        ['Collected against it', money(c.collected)],
        ['Collection rate', rate],
        [`Outstanding receivable at ${formatDate(c.to)}`, money(c.outstanding)],
        ['Advances received in the period', money(c.advances)],
        ['Tax invoices issued', c.invoices],
        ['Receipts recorded', c.receipts],
      ],
    }],
  };
}

export function gstView(g: GstReport): ReportView {
  return {
    title: 'GST summary',
    period: `Tax period ${formatMonth(g.taxPeriod)}`,
    fileStem: `gst_${g.taxPeriod}`,
    status: [
      g.agrees
        ? { tone: 'good', text: 'The GST register agrees with the output-tax accounts in the ledger.' }
        : { tone: 'bad', text: 'The GST register does not agree with the ledger. Resolve this before filing.' },
      { tone: 'info', text: 'Not filed. There is no GSTN connection in this system.' },
    ],
    notes: [g.note],
    tables: [
      {
        title: 'Register',
        columns: [{ label: 'Measure' }, { label: 'Figure', numeric: true }],
        rows: [
          ['Tax invoices', g.invoices],
          ['Credit notes', g.creditNotes],
          ['Debit notes', g.debitNotes],
          ['Taxable value (net of credit notes)', money(g.taxableValue)],
          ['CGST', money(g.cgst)],
          ['SGST', money(g.sgst)],
          ['IGST', money(g.igst)],
        ],
      },
      {
        title: 'Register against ledger',
        columns: [
          { label: 'Tax' }, { label: 'Register', numeric: true }, { label: 'Ledger', numeric: true },
        ],
        rows: [
          ['CGST', money(g.cgst), money(g.ledgerCgst)],
          ['SGST', money(g.sgst), money(g.ledgerSgst)],
        ],
      },
    ],
  };
}

export function tdsView(t: TdsReport): ReportView {
  const quarter = /^Q(\d)/.exec(t.quarter)?.[1];
  const gross = t.bySection.reduce((s, r) => s + r.gross, 0);
  const deductions = t.bySection.reduce((s, r) => s + r.deductions, 0);
  return {
    title: 'TDS summary',
    period: `${t.quarter}${quarter ? ` (${QUARTER_MONTHS[Number(quarter)]})` : ''}`,
    fileStem: `tds_${t.quarter}`,
    status: t.unremitted === 0
      ? [{ tone: 'good', text: 'All tax deducted in this quarter has been remitted.' }]
      : [{ tone: 'info', text: `${formatMoney(t.unremitted)} deducted but not yet remitted.` }],
    tables: [{
      title: 'By section',
      columns: [
        { label: 'Section' }, { label: 'Deductions', numeric: true }, { label: 'Gross', numeric: true },
        { label: 'TDS', numeric: true }, { label: 'Unremitted', numeric: true },
      ],
      rows: t.bySection.map(r => [r.section, r.deductions, money(r.gross), money(r.tds), money(r.unremitted, true)]),
      footer: [['Total', deductions, money(gross), money(t.total), money(t.unremitted, true)]],
      empty: 'No tax was deducted in this quarter.',
    }],
  };
}

export function statementView(s: MemberStatement, from: string, to: string): ReportView {
  return {
    title: `Statement of account — flat ${s.flatNo}`,
    period: rangeText(from, to),
    fileStem: `statement_${s.flatNo}_${from}_${to}`,
    tiles: [
      { label: 'Opening balance', value: money(s.opening) },
      { label: 'Closing balance', value: money(s.closing) },
    ],
    notes: ['A positive balance is owed by the flat; a bracketed one is an advance held for it.'],
    tables: [{
      title: 'Statement',
      columns: [
        { label: 'Date' }, { label: 'Particulars' }, { label: 'Document' },
        { label: 'Debit', numeric: true }, { label: 'Credit', numeric: true }, { label: 'Balance', numeric: true },
      ],
      rows: [
        [formatDate(from), 'Opening balance', '', null, null, money(s.opening)],
        ...s.rows.map(r => [
          formatDate(r.date), r.particulars, r.docRef ?? '', money(r.debit, true), money(r.credit, true), money(r.balance),
        ] as Cell[]),
      ],
      footer: [['', 'Closing balance', '', null, null, money(s.closing)]],
    }],
  };
}

export function ledgerView(
  data: LedgerEntries,
  account: { code: string; name: string } | null,
): ReportView {
  const refOf = new Map(data.entries.map(e => [e.id, e.entryRef]));
  const flags = (e: LedgerEntries['entries'][number]) => [
    e.reversalOf ? `reverses ${refOf.get(e.reversalOf) ?? 'an earlier entry'}` : '',
    e.reversedBy ? `reversed by ${refOf.get(e.reversedBy) ?? 'a later entry'}` : '',
  ].filter(Boolean).join('; ');

  const rows: Cell[][] = [];
  let debit = 0;
  let credit = 0;
  for (const e of data.entries) {
    const flag = flags(e);
    const narration = flag ? `${e.narration} (${flag})` : e.narration;
    for (const leg of e.legs) {
      if (account !== null && leg.accountCode !== account.code) continue;
      debit += leg.debit;
      credit += leg.credit;
      const party = [leg.party, leg.docRef].filter(Boolean).join(' · ');
      rows.push(account === null
        ? [formatDate(e.date), e.entryRef, narration, leg.accountCode, party, money(leg.debit, true), money(leg.credit, true)]
        : [formatDate(e.date), e.entryRef, narration, party, money(leg.debit, true), money(leg.credit, true)]);
    }
  }

  const truncated = data.entries.length >= LEDGER_ENTRY_LIMIT;
  const columns = account === null
    ? [{ label: 'Date' }, { label: 'Entry' }, { label: 'Narration' }, { label: 'Account' }, { label: 'Party / document' },
      { label: 'Debit', numeric: true }, { label: 'Credit', numeric: true }]
    : [{ label: 'Date' }, { label: 'Entry' }, { label: 'Narration' }, { label: 'Party / document' },
      { label: 'Debit', numeric: true }, { label: 'Credit', numeric: true }];
  const pad = account === null ? ['', '', '', '', 'Total'] : ['', '', '', 'Total'];

  return {
    title: account === null ? 'Journal' : `General ledger — ${account.code} ${account.name}`,
    period: rangeText(data.from, data.to),
    fileStem: account === null ? `journal_${data.from}_${data.to}` : `ledger-${account.code}_${data.from}_${data.to}`,
    ...(truncated ? {
      status: [{
        tone: 'info',
        text: `The server returns at most ${LEDGER_ENTRY_LIMIT} entries and this range reached that limit. Narrow the dates to see the rest.`,
      }],
    } : {}),
    notes: account === null
      ? []
      : ['Movements in the period only. The opening balance is the account’s line on the trial balance as at the day before.'],
    tables: [{
      title: account === null ? 'Journal' : 'Ledger',
      columns,
      rows,
      footer: [[...pad, money(debit), money(credit)]],
      empty: 'No postings in this period.',
    }],
  };
}

/** The detail as "key: value" pairs, which reads and wraps better than raw JSON. */
function detailText(detail: unknown): string {
  if (detail === null || detail === undefined) return '';
  if (typeof detail !== 'object' || Array.isArray(detail)) return JSON.stringify(detail);
  return Object.entries(detail as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
}

export function auditView(entries: readonly AuditEntry[], limit: number, action: string): ReportView {
  const table: TableSpec = {
    title: 'Audit trail',
    columns: [
      { label: 'When' }, { label: 'Who' }, { label: 'Action' }, { label: 'Subject' },
      { label: 'Detail' }, { label: 'Request' },
    ],
    rows: entries.map(e => [
      formatInstant(e.at),
      e.actorLabel,
      e.action,
      [e.subjectTable, e.subjectId].filter(Boolean).join(' '),
      detailText(e.detail),
      e.requestId ?? '',
    ]),
    empty: action ? `No audit entries for “${action}”.` : 'No audit entries.',
  };
  return {
    title: 'Audit trail',
    period: `Latest ${entries.length.toLocaleString('en-IN')} entr${entries.length === 1 ? 'y' : 'ies'}${action ? ` for “${action}”` : ''}, newest first`,
    fileStem: `audit-trail${action ? `-${action.replace(/[^a-z0-9.-]+/gi, '_')}` : ''}`,
    ...(entries.length >= limit ? {
      notes: [`Showing the newest ${limit}. Raise the limit or filter by action to see earlier entries.`],
    } : {}),
    tables: [table],
  };
}
