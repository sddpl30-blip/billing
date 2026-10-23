/**
 * Reports, all of them read from the same postings.
 *
 * This is the point of the whole exercise. In the demo each screen computed
 * its own figure from its own array, so the collection total, the balance
 * sheet and the ageing report could disagree and nothing would notice. Here
 * every number below is an aggregate over `journal_postings`, so two reports
 * can only disagree if the ledger disagrees with itself — and a deferred
 * trigger makes that impossible to write.
 *
 * The trial balance is the proof: it sums the same table from a different
 * direction, and `tiesOut` is false the moment anything has gone in crooked.
 */

import type { Queryable } from './pg';
import { A } from './posting';

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
  /** Derived, never asserted: the two totals, compared. */
  readonly tiesOut: boolean;
}

export async function trialBalance(
  tx: Queryable,
  input: { societyId: string; asAt: string; from?: string },
): Promise<TrialBalance> {
  const result = await tx.query<{
    code: string; name: string; class: string; debit: string; credit: string;
  }>(
    `SELECT a.code, a.name, a.class,
            COALESCE(SUM(p.debit), 0)::text AS debit,
            COALESCE(SUM(p.credit), 0)::text AS credit
       FROM accounts a
       LEFT JOIN journal_postings p
              ON p.society_id = a.society_id AND p.account_code = a.code
       LEFT JOIN journal_entries e
              ON e.id = p.entry_id
                 AND e.entry_date <= $2
                 AND ($3::date IS NULL OR e.entry_date >= $3::date)
      WHERE a.society_id = $1
        AND (p.id IS NULL OR e.id IS NOT NULL)
      GROUP BY a.code, a.name, a.class
      ORDER BY a.code`,
    [input.societyId, input.asAt, input.from ?? null],
  );

  const lines = result.rows.map(r => ({
    code: r.code,
    name: r.name,
    class: r.class,
    debit: Number(r.debit),
    credit: Number(r.credit),
  }));

  return { asAt: input.asAt, ...summariseTrialBalance(lines) };
}

/**
 * The totals and whether they tie, from lines alone.
 *
 * Separated from the query on purpose. On real data `tiesOut` is always true,
 * because a deferred trigger refuses anything else — so a test that reads it
 * from the database would pass just as happily if this returned a hardcoded
 * `true`. Pulling the arithmetic out gives a seam where the comparison can be
 * handed figures that do not tie, which is the only way to prove it is a
 * comparison at all.
 */
export function summariseTrialBalance(
  lines: readonly TrialBalanceLine[],
): { lines: readonly TrialBalanceLine[]; totalDebit: number; totalCredit: number; tiesOut: boolean } {
  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
  return {
    lines: lines.filter(l => l.debit !== 0 || l.credit !== 0),
    totalDebit,
    totalCredit,
    tiesOut: totalDebit === totalCredit,
  };
}

export interface BalanceSheet {
  readonly asAt: string;
  readonly assets: readonly TrialBalanceLine[];
  readonly liabilities: readonly TrialBalanceLine[];
  readonly funds: readonly TrialBalanceLine[];
  readonly totalAssets: number;
  readonly totalLiabilities: number;
  readonly totalFunds: number;
  /** Income less expenditure to date, which is what makes the two sides meet. */
  readonly surplus: number;
  readonly balances: boolean;
}

/**
 * The balance sheet, assembled from the trial balance.
 *
 * The surplus is computed rather than carried: income less expenditure for
 * every entry to date. That is why `balances` is a derived comparison and not
 * a plugged figure — there is no balancing entry anywhere in this codebase,
 * and if the two sides do not meet the report says so.
 */
export async function balanceSheet(
  tx: Queryable,
  input: { societyId: string; asAt: string },
): Promise<BalanceSheet> {
  const tb = await trialBalance(tx, { societyId: input.societyId, asAt: input.asAt });
  return assembleBalanceSheet(tb.lines, input.asAt);
}

/** The signed balance of a line, positive on its account's normal side. */
export function netOf(line: TrialBalanceLine): number {
  return line.class === 'asset' || line.class === 'expenditure'
    ? line.debit - line.credit
    : line.credit - line.debit;
}

/**
 * Assembles a balance sheet from trial balance lines.
 *
 * The same seam as `summariseTrialBalance`, for the same reason: on real data
 * `balances` is always true, so it has to be testable with figures that do not
 * balance or the comparison is unproven. The surplus is computed here from
 * income less expenditure — there is no balancing entry anywhere in this
 * codebase, and if the two sides do not meet the report says so.
 */
export function assembleBalanceSheet(
  lines: readonly TrialBalanceLine[],
  asAt: string,
): BalanceSheet {
  const byClass = (cls: string): TrialBalanceLine[] =>
    lines.filter(l => l.class === cls).map(l => ({ ...l }));

  const assets = byClass('asset');
  const liabilities = byClass('liability');
  const funds = byClass('fund');
  const income = byClass('income').reduce((s, l) => s + netOf(l), 0);
  const expenditure = byClass('expenditure').reduce((s, l) => s + netOf(l), 0);

  const totalAssets = assets.reduce((s, l) => s + netOf(l), 0);
  const totalLiabilities = liabilities.reduce((s, l) => s + netOf(l), 0);
  const totalFunds = funds.reduce((s, l) => s + netOf(l), 0);
  const surplus = income - expenditure;

  return {
    asAt,
    assets,
    liabilities,
    funds,
    totalAssets,
    totalLiabilities,
    totalFunds,
    surplus,
    balances: totalAssets === totalLiabilities + totalFunds + surplus,
  };
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

export async function incomeAndExpenditure(
  tx: Queryable,
  input: { societyId: string; from: string; to: string },
): Promise<IncomeAndExpenditure> {
  const tb = await trialBalance(tx, {
    societyId: input.societyId, asAt: input.to, from: input.from,
  });
  const income = tb.lines.filter(l => l.class === 'income');
  const expenditure = tb.lines.filter(l => l.class === 'expenditure');
  const totalIncome = income.reduce((s, l) => s + netOf(l), 0);
  const totalExpenditure = expenditure.reduce((s, l) => s + netOf(l), 0);
  return {
    from: input.from,
    to: input.to,
    income,
    expenditure,
    totalIncome,
    totalExpenditure,
    surplus: totalIncome - totalExpenditure,
  };
}

export interface AgeingBucket {
  readonly label: string;
  readonly amount: number;
  readonly count: number;
}

export interface AgeingRow {
  readonly flatNo: string;
  readonly flatId: string;
  readonly outstanding: number;
  readonly buckets: readonly AgeingBucket[];
}

/**
 * The ageing buckets, by days past the due date.
 *
 * "Not yet due" is its own bucket, as it is in the engine's `ageing`. It used
 * to share a "current" bucket with invoices up to 30 days overdue, so a bill
 * issued yesterday and one a month late were the same figure — and the one
 * figure a committee chasing arrears most needs, what is overdue at all, could
 * not be read off the report.
 */
const BUCKETS: ReadonlyArray<{ label: string; from: number | null; to: number | null }> = [
  { label: 'not-due', from: null, to: 0 },
  { label: '1-30', from: 1, to: 30 },
  { label: '31-60', from: 31, to: 60 },
  { label: '61-90', from: 61, to: 90 },
  { label: '90+', from: 91, to: null },
];

/**
 * Receivables ageing, bucketed by how long each invoice has been due.
 *
 * Per invoice rather than per flat total, which is what makes the buckets mean
 * anything: a flat that owes one old bill and has paid three new ones is a
 * different problem from one that is a month behind on everything.
 */
export async function ageing(
  tx: Queryable,
  input: { societyId: string; asAt: string; flatIds?: readonly string[] | null },
): Promise<{ asAt: string; rows: readonly AgeingRow[]; totals: readonly AgeingBucket[]; total: number }> {
  const params: Array<string | number | null> = [input.societyId, A.MAINTENANCE_RECEIVABLE, input.asAt];
  let flatFilter = '';
  if (input.flatIds !== undefined && input.flatIds !== null) {
    if (input.flatIds.length === 0) {
      return { asAt: input.asAt, rows: [], totals: [], total: 0 };
    }
    const placeholders = input.flatIds.map(id => {
      params.push(id);
      return `$${params.length}`;
    });
    flatFilter = ` AND d.flat_id IN (${placeholders.join(',')})`;
  }

  const result = await tx.query<{
    flat_id: string; flat_no: string; due_on: string; outstanding: string; days: string;
  }>(
    `SELECT d.flat_id, f.flat_no, d.due_on::text,
            COALESCE((
              SELECT SUM(p.debit - p.credit)
                FROM journal_postings p
                JOIN journal_entries e ON e.id = p.entry_id
               WHERE p.society_id = d.society_id
                 AND p.account_code = $2
                 AND p.doc_ref = d.tax_invoice_no
                 AND e.entry_date <= $3::date
            ), 0)::text AS outstanding,
            ($3::date - d.due_on)::text AS days
       FROM billing_documents d
       JOIN flats f ON f.id = d.flat_id
      WHERE d.society_id = $1
        AND d.state = 'tax-invoice'${flatFilter}
      ORDER BY f.flat_no, d.due_on`,
    params,
  );

  const perFlat = new Map<string, { flatNo: string; amounts: Map<string, { amount: number; count: number }> }>();
  const totals = new Map<string, { amount: number; count: number }>();

  for (const row of result.rows) {
    const outstanding = Number(row.outstanding);
    if (outstanding <= 0) continue;
    const days = Number(row.days);
    const bucket = BUCKETS.find(b =>
      (b.from === null || days >= b.from) && (b.to === null || days <= b.to)) ?? BUCKETS[0];

    const flat = perFlat.get(row.flat_id) ?? { flatNo: row.flat_no, amounts: new Map() };
    const slot = flat.amounts.get(bucket.label) ?? { amount: 0, count: 0 };
    flat.amounts.set(bucket.label, { amount: slot.amount + outstanding, count: slot.count + 1 });
    perFlat.set(row.flat_id, flat);

    const total = totals.get(bucket.label) ?? { amount: 0, count: 0 };
    totals.set(bucket.label, { amount: total.amount + outstanding, count: total.count + 1 });
  }

  const rows: AgeingRow[] = [...perFlat.entries()].map(([flatId, flat]) => ({
    flatId,
    flatNo: flat.flatNo,
    outstanding: [...flat.amounts.values()].reduce((s, b) => s + b.amount, 0),
    buckets: BUCKETS
      .filter(b => flat.amounts.has(b.label))
      .map(b => ({ label: b.label, ...(flat.amounts.get(b.label) as { amount: number; count: number }) })),
  }));

  return {
    asAt: input.asAt,
    rows,
    totals: BUCKETS
      .filter(b => totals.has(b.label))
      .map(b => ({ label: b.label, ...(totals.get(b.label) as { amount: number; count: number }) })),
    total: rows.reduce((s, r) => s + r.outstanding, 0),
  };
}

export interface CollectionSummary {
  readonly from: string;
  readonly to: string;
  readonly billed: number;
  readonly collected: number;
  readonly outstanding: number;
  readonly advances: number;
  /** Collected over billed, in basis points, so no float appears in a report. */
  readonly collectionRateBps: number;
  readonly invoices: number;
  readonly receipts: number;
}

/**
 * The collection summary, from the ledger rather than from a count of rows.
 *
 * `billed` is the receivable raised in the window and `collected` is what was
 * credited against it. The rate is their ratio — not a figure a screen can
 * nudge, which is what the demo's hardcoded collection percentage was.
 */
export async function collectionSummary(
  tx: Queryable,
  input: { societyId: string; from: string; to: string },
): Promise<CollectionSummary> {
  const result = await tx.query<{
    billed: string; collected: string; advances: string;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN p.account_code = $2 THEN p.debit ELSE 0 END), 0)::text AS billed,
       COALESCE(SUM(CASE WHEN p.account_code = $2 THEN p.credit ELSE 0 END), 0)::text AS collected,
       COALESCE(SUM(CASE WHEN p.account_code = $3 THEN p.credit - p.debit ELSE 0 END), 0)::text AS advances
       FROM journal_postings p
       JOIN journal_entries e ON e.id = p.entry_id
      WHERE p.society_id = $1
        AND e.entry_date >= $4::date AND e.entry_date <= $5::date`,
    [input.societyId, A.MAINTENANCE_RECEIVABLE, A.MEMBER_ADVANCE, input.from, input.to],
  );
  const row = result.rows[0];
  const billed = Number(row?.billed ?? '0');
  const collected = Number(row?.collected ?? '0');

  const counts = await tx.query<{ invoices: string; receipts: string }>(
    `SELECT
       (SELECT COUNT(*) FROM billing_documents
         WHERE society_id = $1 AND state = 'tax-invoice'
           AND converted_on >= $2::date AND converted_on <= $3::date)::text AS invoices,
       (SELECT COUNT(*) FROM payments
         WHERE society_id = $1 AND received_on >= $2::date AND received_on <= $3::date)::text AS receipts`,
    [input.societyId, input.from, input.to],
  );

  // Outstanding is the whole receivable as at the end of the window, not
  // billed-minus-collected for the window: an old invoice paid this month
  // would otherwise make the window look over-collected.
  const closing = await tx.query<{ balance: string }>(
    `SELECT COALESCE(SUM(p.debit - p.credit), 0)::text AS balance
       FROM journal_postings p
       JOIN journal_entries e ON e.id = p.entry_id
      WHERE p.society_id = $1 AND p.account_code = $2 AND e.entry_date <= $3::date`,
    [input.societyId, A.MAINTENANCE_RECEIVABLE, input.to],
  );

  return {
    from: input.from,
    to: input.to,
    billed,
    collected,
    outstanding: Number(closing.rows[0]?.balance ?? '0'),
    advances: Number(row?.advances ?? '0'),
    collectionRateBps: billed === 0 ? 0 : Math.round((collected * 10000) / billed),
    invoices: Number(counts.rows[0]?.invoices ?? '0'),
    receipts: Number(counts.rows[0]?.receipts ?? '0'),
  };
}

export interface GstSummary {
  readonly taxPeriod: string;
  readonly invoices: number;
  /** Credit and debit notes in the period, counted separately. */
  readonly creditNotes: number;
  readonly debitNotes: number;
  readonly taxableValue: number;
  /** Net of credit notes, which is the figure a return reports. */
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  /** The same figures from the ledger, for comparison with the register. */
  readonly ledgerCgst: number;
  readonly ledgerSgst: number;
  readonly agrees: boolean;
}

/**
 * The GST summary a GSTR-1 would be filed from, cross-checked.
 *
 * Two sources: the register, which is what a return is built from, and the
 * output-tax accounts in the ledger. `agrees` compares them. A return filed
 * from a register that has drifted from the books is the kind of thing nobody
 * finds until an assessment.
 *
 * It is a summary, not a filing. Nothing here is submitted anywhere: there is
 * no GSTN connection in this system and no credential for one.
 */
export async function gstSummary(
  tx: Queryable,
  input: { societyId: string; taxPeriod: string },
): Promise<GstSummary> {
  // Signed by kind: an invoice and a debit note add to the period's output
  // tax, a credit note reduces it. The rows themselves are positive — see
  // migration 006 — so the sign belongs here, once, rather than in the data.
  const reg = await tx.query<{
    invoices: string; credit_notes: string; debit_notes: string;
    taxable: string; cgst: string; sgst: string; igst: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE entry_kind = 'invoice')::text AS invoices,
       COUNT(*) FILTER (WHERE entry_kind = 'credit-note')::text AS credit_notes,
       COUNT(*) FILTER (WHERE entry_kind = 'debit-note')::text AS debit_notes,
       COALESCE(SUM(CASE WHEN entry_kind = 'credit-note' THEN -taxable_value
                         ELSE taxable_value END), 0)::text AS taxable,
       COALESCE(SUM(CASE WHEN entry_kind = 'credit-note' THEN -cgst ELSE cgst END), 0)::text AS cgst,
       COALESCE(SUM(CASE WHEN entry_kind = 'credit-note' THEN -sgst ELSE sgst END), 0)::text AS sgst,
       COALESCE(SUM(CASE WHEN entry_kind = 'credit-note' THEN -igst ELSE igst END), 0)::text AS igst
       FROM gst_register
      WHERE society_id = $1 AND tax_period = $2`,
    [input.societyId, input.taxPeriod],
  );

  const ledger = await tx.query<{ cgst: string; sgst: string }>(
    `SELECT
       COALESCE(SUM(CASE WHEN p.account_code = $2 THEN p.credit - p.debit ELSE 0 END), 0)::text AS cgst,
       COALESCE(SUM(CASE WHEN p.account_code = $3 THEN p.credit - p.debit ELSE 0 END), 0)::text AS sgst
       FROM journal_postings p
       JOIN journal_entries e ON e.id = p.entry_id
      WHERE p.society_id = $1 AND to_char(e.entry_date, 'YYYY-MM') = $4`,
    [input.societyId, A.CGST_OUTPUT, A.SGST_OUTPUT, input.taxPeriod],
  );

  const row = reg.rows[0];
  const cgst = Number(row?.cgst ?? '0');
  const sgst = Number(row?.sgst ?? '0');
  const ledgerCgst = Number(ledger.rows[0]?.cgst ?? '0');
  const ledgerSgst = Number(ledger.rows[0]?.sgst ?? '0');

  return {
    taxPeriod: input.taxPeriod,
    invoices: Number(row?.invoices ?? '0'),
    creditNotes: Number(row?.credit_notes ?? '0'),
    debitNotes: Number(row?.debit_notes ?? '0'),
    taxableValue: Number(row?.taxable ?? '0'),
    cgst,
    sgst,
    igst: Number(row?.igst ?? '0'),
    ledgerCgst,
    ledgerSgst,
    agrees: registerAgreesWithLedger(
      { cgst, sgst },
      { cgst: ledgerCgst, sgst: ledgerSgst },
    ),
  };
}

/**
 * Whether the GST register and the ledger say the same thing.
 *
 * A seam, again because on sound data this is always true. A return filed from
 * a register that has drifted from the books is exactly the failure this is
 * meant to catch, so the comparison has to be testable with two sides that
 * disagree.
 */
export function registerAgreesWithLedger(
  register: { cgst: number; sgst: number },
  ledger: { cgst: number; sgst: number },
): boolean {
  return register.cgst === ledger.cgst && register.sgst === ledger.sgst;
}

export interface TdsSummary {
  readonly quarter: string;
  readonly bySection: ReadonlyArray<{
    section: string; deductions: number; gross: number; tds: number; unremitted: number;
  }>;
  readonly total: number;
  readonly unremitted: number;
}

export async function tdsSummary(
  tx: Queryable,
  input: { societyId: string; quarter: string },
): Promise<TdsSummary> {
  const result = await tx.query<{
    section: string; deductions: string; gross: string; tds: string; unremitted: string;
  }>(
    `SELECT section,
            COUNT(*)::text AS deductions,
            SUM(gross)::text AS gross,
            SUM(tds_amount)::text AS tds,
            COALESCE(SUM(CASE WHEN challan_no IS NULL THEN tds_amount ELSE 0 END), 0)::text AS unremitted
       FROM tds_register
      WHERE society_id = $1 AND quarter = $2
      GROUP BY section
      ORDER BY section`,
    [input.societyId, input.quarter],
  );

  const bySection = result.rows.map(r => ({
    section: r.section,
    deductions: Number(r.deductions),
    gross: Number(r.gross),
    tds: Number(r.tds),
    unremitted: Number(r.unremitted),
  }));

  return {
    quarter: input.quarter,
    bySection,
    total: bySection.reduce((s, r) => s + r.tds, 0),
    unremitted: bySection.reduce((s, r) => s + r.unremitted, 0),
  };
}

export interface MemberStatementRow {
  readonly date: string;
  readonly particulars: string;
  readonly docRef: string | null;
  readonly debit: number;
  readonly credit: number;
  readonly balance: number;
}

/**
 * One flat's statement of account: every posting that touched its receivable
 * or its advance, with a running balance.
 */
export async function memberStatement(
  tx: Queryable,
  input: { societyId: string; flatNo: string; from?: string; to: string },
): Promise<{ flatNo: string; opening: number; rows: readonly MemberStatementRow[]; closing: number }> {
  const opening = input.from === undefined ? 0 : Number(
    (await tx.query<{ balance: string }>(
      `SELECT COALESCE(SUM(p.debit - p.credit), 0)::text AS balance
         FROM journal_postings p
         JOIN journal_entries e ON e.id = p.entry_id
        WHERE p.society_id = $1 AND p.party = $2
          AND p.account_code IN ($3, $4)
          AND e.entry_date < $5::date`,
      [input.societyId, input.flatNo, A.MAINTENANCE_RECEIVABLE, A.MEMBER_ADVANCE, input.from],
    )).rows[0]?.balance ?? '0',
  );

  const result = await tx.query<{
    entry_date: string; narration: string; doc_ref: string | null;
    debit: string; credit: string;
  }>(
    `SELECT e.entry_date::text, e.narration, p.doc_ref, p.debit::text, p.credit::text
       FROM journal_postings p
       JOIN journal_entries e ON e.id = p.entry_id
      WHERE p.society_id = $1 AND p.party = $2
        AND p.account_code IN ($3, $4)
        AND ($5::date IS NULL OR e.entry_date >= $5::date)
        AND e.entry_date <= $6::date
      ORDER BY e.entry_date, e.posted_at, p.id`,
    [
      input.societyId, input.flatNo, A.MAINTENANCE_RECEIVABLE, A.MEMBER_ADVANCE,
      input.from ?? null, input.to,
    ],
  );

  let balance = opening;
  const rows = result.rows.map(r => {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    balance += debit - credit;
    return {
      date: r.entry_date,
      particulars: r.narration,
      docRef: r.doc_ref,
      debit,
      credit,
      balance,
    };
  });

  return { flatNo: input.flatNo, opening, rows, closing: balance };
}
