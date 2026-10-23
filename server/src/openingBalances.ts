/**
 * Opening balances: the society's position on the day before it went live.
 *
 * Migration 010 explains the model; in short, the whole position is one
 * journal entry, a flat's opening due is a billing document of its own (so
 * receipts settle it oldest-first and the ageing report sees it like any
 * bill), an opening advance is a credit on the member-advance control account
 * (where every advance lives), and a vendor payable is a booked bill.
 *
 * Entry is maker-checker. The secretary (`settings.manage`) prepares a draft —
 * the per-flat part from a CSV, the society's balances account by account —
 * and the treasurer (`period.close`, the permission that already signs off a
 * month's books) approves it, which is what posts. One batch per society may
 * stand; a correction is a reversal by the treasurer and a fresh draft.
 */

import type { Queryable } from './pg';
import { HttpError, badRequest, conflict, notFound } from './http';
import { readCsvTable, rupeesToPaise } from './csv';
import { A, postEntry, reverseEntry, type Leg } from './posting';
import { lockFlatBalance } from './series';
import { audit } from './audit';
import { formatRupees } from '../../src/accounting/money';
import { isValidIsoDate, periodLabel } from '../../src/accounting/clock';

export const OPENING_CSV_COLUMNS = ['flat_no', 'opening_due', 'opening_advance', 'due_since'] as const;
export const OPENING_CSV_MAX_BYTES = 256 * 1024;
const MAX_ACCOUNT_LINES = 100;

/** Where the balancing figure goes: the accumulated surplus. */
export const BALANCING_ACCOUNT = A.GENERAL_RESERVE;

export interface FlatLineInput {
  readonly flatNo: string;
  readonly duePaise: number;
  readonly advancePaise: number;
  readonly dueSince?: string | null;
  /** The CSV line, where the line came from a file. */
  readonly line?: number;
}

export interface AccountLineInput {
  readonly accountCode: string;
  readonly debitPaise: number;
  readonly creditPaise: number;
  readonly vendorId?: string | null;
  readonly reference?: string | null;
  readonly expenseAccount?: string | null;
  readonly memo?: string | null;
}

export interface OpeningProblem {
  /** 'flats' for the per-flat part, 'accounts' for the society's balances, 'batch' for the whole. */
  readonly part: 'flats' | 'accounts' | 'batch';
  /** CSV line for a flat row from a file; 1-based position for anything else in a list. */
  readonly line?: number;
  readonly message: string;
}

interface ChartRow { code: string; name: string; class: string; control: string | null }

export interface PlannedFlatLine {
  readonly flatId: string;
  readonly flatNo: string;
  readonly duePaise: number;
  readonly advancePaise: number;
  readonly dueSince: string | null;
}

export interface PlannedAccountLine extends AccountLineInput {
  readonly accountName: string;
  readonly vendorName?: string;
  readonly isBalancing: boolean;
}

export interface OpeningPlan {
  readonly asAt: string;
  readonly autoBalance: boolean;
  readonly flats: readonly PlannedFlatLine[];
  readonly accounts: readonly PlannedAccountLine[];
  readonly totals: {
    readonly duePaise: number; readonly advancePaise: number;
    readonly debitPaise: number; readonly creditPaise: number;
    /** Debits less credits before any balancing figure. */
    readonly differencePaise: number;
  };
  /** Line-level mistakes: the batch cannot even be saved with these. */
  readonly errors: readonly OpeningProblem[];
  /** Reasons it can be saved but not posted yet. */
  readonly blockers: readonly string[];
}

// --- the per-flat CSV ------------------------------------------------------

/** Reads the per-flat CSV: flat_no, opening_due, opening_advance, and optionally due_since. */
export function parseOpeningCsv(csv: string): { lines: FlatLineInput[]; errors: OpeningProblem[] } {
  const table = readCsvTable(csv, {
    aliases: {
      flat_no: ['flat', 'flat_number', 'flatno', 'unit', 'unit_no'],
      opening_due: ['due', 'dues', 'opening_dues', 'arrears', 'outstanding', 'opening_arrears', 'balance_due'],
      opening_advance: ['advance', 'advances', 'opening_advances', 'credit', 'paid_in_advance'],
      due_since: ['due_date', 'oldest_due', 'oldest_due_date', 'arrears_since'],
    },
    required: ['flat_no'],
    maxRows: 5000,
    maxBytes: OPENING_CSV_MAX_BYTES,
  });
  if (!table.columns.includes('opening_due') && !table.columns.includes('opening_advance')) {
    throw badRequest('The header row needs an opening_due or an opening_advance column, or both.');
  }

  const lines: FlatLineInput[] = [];
  const errors: OpeningProblem[] = [];
  for (const { line, values } of table.rows) {
    const due = rupeesToPaise(values.opening_due ?? '');
    const advance = rupeesToPaise(values.opening_advance ?? '');
    const problems: string[] = [];
    if (due === null) problems.push(`opening_due "${values.opening_due}" is not an amount in rupees`);
    if (advance === null) problems.push(`opening_advance "${values.opening_advance}" is not an amount in rupees`);
    const since = (values.due_since ?? '').trim();
    const dueSince = since === '' ? null : toIsoDate(since);
    if (since !== '' && dueSince === null) problems.push(`due_since "${since}" is not a date (use YYYY-MM-DD or DD/MM/YYYY)`);
    if (problems.length > 0) {
      for (const message of problems) errors.push({ part: 'flats', line, message: `${values.flat_no ?? ''}: ${message}` });
      continue;
    }
    lines.push({
      flatNo: values.flat_no ?? '', duePaise: due as number, advancePaise: advance as number,
      dueSince, line,
    });
  }
  return { lines, errors };
}

function toIsoDate(text: string): string | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m !== null) return isValidIsoDate(text) ? text : null;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (m === null) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

// --- planning --------------------------------------------------------------

/**
 * Checks a proposed opening position against the books and works out what it
 * would post. Writes nothing.
 */
export async function planOpening(
  tx: Queryable,
  input: {
    societyId: string; asAt: string; autoBalance: boolean;
    flatLines: readonly FlatLineInput[]; accountLines: readonly AccountLineInput[];
    /** A batch being re-checked, whose own earlier entry does not count against it. */
    batchId?: string;
  },
): Promise<OpeningPlan> {
  const errors: OpeningProblem[] = [];
  const blockers: string[] = [];
  if (!isValidIsoDate(input.asAt)) throw badRequest('asAt must be a date, YYYY-MM-DD.');

  // --- flats
  const flatRows = await tx.query<{ id: string; flat_no: string }>(
    'SELECT id, flat_no FROM flats WHERE society_id = $1',
    [input.societyId],
  );
  const flatByNo = new Map(flatRows.rows.map(f => [f.flat_no.toLowerCase(), f]));
  const seenFlats = new Map<string, number | undefined>();
  const flats: PlannedFlatLine[] = [];
  input.flatLines.forEach((line, index) => {
    const where = line.line ?? index + 1;
    const flatNo = line.flatNo.trim();
    const say = (message: string): void => { errors.push({ part: 'flats', line: where, message: `${flatNo || '(no flat)'}: ${message}` }); };
    if (flatNo === '') { say('flat_no is empty'); return; }
    const flat = flatByNo.get(flatNo.toLowerCase());
    if (flat === undefined) { say('no such flat is on record; import the flats first'); return; }
    if (seenFlats.has(flat.id)) {
      const earlier = seenFlats.get(flat.id);
      say(`appears twice${earlier === undefined ? '' : ` (also line ${earlier})`}`);
      return;
    }
    seenFlats.set(flat.id, where);
    if (!Number.isSafeInteger(line.duePaise) || !Number.isSafeInteger(line.advancePaise)
        || line.duePaise < 0 || line.advancePaise < 0) {
      say('amounts must be whole paise and not negative'); return;
    }
    if (line.duePaise > 0 && line.advancePaise > 0) {
      say('has both a due and an advance; net them into one figure, as the trial balance would');
      return;
    }
    if (line.duePaise === 0 && line.advancePaise === 0) return; // nothing brought forward
    const dueSince = line.dueSince ?? null;
    if (dueSince !== null) {
      if (!isValidIsoDate(dueSince)) { say('due_since is not a date'); return; }
      if (line.duePaise === 0) { say('due_since is only meaningful with a due'); return; }
      if (dueSince > input.asAt) { say(`due_since ${dueSince} is after the as-at date ${input.asAt}`); return; }
    }
    flats.push({
      flatId: flat.id, flatNo: flat.flat_no, duePaise: line.duePaise,
      advancePaise: line.advancePaise, dueSince,
    });
  });
  flats.sort((a, b) => a.flatNo.localeCompare(b.flatNo, 'en', { numeric: true }));

  // --- accounts
  const chart = await tx.query<ChartRow>(
    'SELECT code, name, class, control FROM accounts WHERE society_id = $1',
    [input.societyId],
  );
  const accountByCode = new Map(chart.rows.map(a => [a.code, a]));
  if (input.accountLines.length > MAX_ACCOUNT_LINES) {
    throw badRequest(`At most ${MAX_ACCOUNT_LINES} account lines are accepted.`);
  }
  const vendorIds = [...new Set(input.accountLines.map(l => l.vendorId).filter((id): id is string => !!id))];
  const vendors = vendorIds.length === 0 ? [] : (await tx.query<{ id: string; name: string }>(
    `SELECT id, name FROM vendors WHERE society_id = $1 AND id = ANY($2::uuid[])`,
    [input.societyId, `{${vendorIds.join(',')}}`],
  )).rows;
  const vendorById = new Map(vendors.map(v => [v.id, v]));
  const seenBills = new Set<string>();

  const accounts: PlannedAccountLine[] = [];
  for (const [index, line] of input.accountLines.entries()) {
    const where = index + 1;
    const say = (message: string): void => { errors.push({ part: 'accounts', line: where, message: `${line.accountCode}: ${message}` }); };
    const account = accountByCode.get(line.accountCode);
    if (account === undefined) { say('no such account in the chart'); continue; }
    if (account.class === 'income' || account.class === 'expenditure') {
      say(
        `${account.name} is an ${account.class} account. An opening position is a balance sheet: ` +
        'the surplus of the months before cut-over belongs in the general reserve.',
      );
      continue;
    }
    if (account.control === 'resident') {
      say(`${account.name} is held per flat; enter it in the per-flat part instead`);
      continue;
    }
    const debit = line.debitPaise;
    const credit = line.creditPaise;
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit < 0 || credit < 0
        || (debit === 0) === (credit === 0)) {
      say('give an amount on one side only, debit or credit');
      continue;
    }
    let vendorName: string | undefined;
    if (account.control === 'vendor') {
      const vendor = line.vendorId ? vendorById.get(line.vendorId) : undefined;
      if (vendor === undefined) { say('a vendor payable must name the vendor'); continue; }
      const reference = (line.reference ?? '').trim();
      if (reference === '' || reference.length > 60) { say('a vendor payable needs the bill number it is owed on'); continue; }
      if (credit === 0) { say('a vendor payable is a credit; an advance to a vendor is not a payable'); continue; }
      const expense = accountByCode.get(line.expenseAccount ?? '');
      if (expense === undefined || expense.class !== 'expenditure') {
        say('say which expense account the bill was for');
        continue;
      }
      const key = `${vendor.id}:${reference.toLowerCase()}`;
      if (seenBills.has(key)) { say(`bill ${reference} for ${vendor.name} is entered twice`); continue; }
      seenBills.add(key);
      const existing = await tx.query(
        `SELECT 1 FROM vendor_bills WHERE society_id = $1 AND vendor_id = $2 AND bill_no = $3
            AND (opening_batch_id IS NULL OR opening_batch_id IS DISTINCT FROM $4::uuid)
            AND state <> 'rejected'`,
        [input.societyId, vendor.id, reference, input.batchId ?? null],
      );
      if (existing.rows.length > 0) { say(`${vendor.name} already has a bill numbered ${reference} on record`); continue; }
      vendorName = vendor.name;
    } else if (line.vendorId) {
      say('only the vendor payable account takes a vendor');
      continue;
    }
    accounts.push({
      accountCode: account.code,
      accountName: account.name,
      debitPaise: debit,
      creditPaise: credit,
      vendorId: account.control === 'vendor' ? (line.vendorId as string) : null,
      reference: account.control === 'vendor' ? (line.reference ?? '').trim() : (line.reference?.trim() || null),
      expenseAccount: account.control === 'vendor' ? (line.expenseAccount as string) : null,
      memo: line.memo?.trim() || null,
      ...(vendorName === undefined ? {} : { vendorName }),
      isBalancing: false,
    });
  }

  const duePaise = flats.reduce((s, f) => s + f.duePaise, 0);
  const advancePaise = flats.reduce((s, f) => s + f.advancePaise, 0);
  const debitPaise = duePaise + accounts.reduce((s, a) => s + a.debitPaise, 0);
  const creditPaise = advancePaise + accounts.reduce((s, a) => s + a.creditPaise, 0);
  const differencePaise = debitPaise - creditPaise;

  if (input.autoBalance && differencePaise !== 0) {
    const reserve = accountByCode.get(BALANCING_ACCOUNT);
    accounts.push({
      accountCode: BALANCING_ACCOUNT,
      accountName: reserve?.name ?? 'General reserve',
      debitPaise: differencePaise < 0 ? -differencePaise : 0,
      creditPaise: differencePaise > 0 ? differencePaise : 0,
      memo: 'Balancing figure: opening general fund',
      isBalancing: true,
    });
  }

  if (flats.length === 0 && accounts.length === 0) blockers.push('There is nothing to post yet.');
  if (!input.autoBalance && differencePaise !== 0) {
    blockers.push(
      `Debits are ${formatRupees(debitPaise)} and credits ${formatRupees(creditPaise)}: out by ` +
      `${formatRupees(Math.abs(differencePaise))}. Enter the general fund from the trial balance, ` +
      'or let the difference post to the general reserve as the balancing figure.',
    );
  }

  // The opening position has to be the first thing in the books. An entry
  // already dated on or before the as-at date would sit underneath it, and a
  // bill or receipt from before cut-over is already inside the figures being
  // brought forward — it would be counted twice.
  const earlier = await tx.query<{ n: string; first: string | null }>(
    `SELECT count(*)::text AS n, min(entry_date)::text AS first
       FROM journal_entries e
      WHERE e.society_id = $1 AND e.entry_date <= $2::date
        AND e.source_kind <> 'opening-balance'
        AND NOT (e.source_kind = 'reversal' AND EXISTS (
              SELECT 1 FROM journal_entries o
               WHERE o.id = e.reversal_of AND o.source_kind = 'opening-balance'))`,
    [input.societyId, input.asAt],
  );
  if (Number(earlier.rows[0]?.n ?? '0') > 0) {
    blockers.push(
      `${earlier.rows[0].n} journal ${earlier.rows[0].n === '1' ? 'entry is' : 'entries are'} already dated on or before ` +
      `${input.asAt} (the first on ${earlier.rows[0].first}). Opening balances must come first; choose the ` +
      'day before the first transaction in the books.',
    );
  }

  const closed = await tx.query<{ state: string }>(
    `SELECT state FROM financial_periods WHERE society_id = $1 AND period = to_char($2::date, 'YYYY-MM')`,
    [input.societyId, input.asAt],
  );
  if (closed.rows[0] !== undefined && ['closed', 'closing'].includes(closed.rows[0].state)) {
    blockers.push(`The period ${input.asAt.slice(0, 7)} is closed; reopen it to post opening balances dated ${input.asAt}.`);
  }

  return {
    asAt: input.asAt,
    autoBalance: input.autoBalance,
    flats,
    accounts,
    totals: { duePaise, advancePaise, debitPaise, creditPaise, differencePaise },
    errors,
    blockers,
  };
}

// --- reading what is on record -------------------------------------------

export interface BatchView {
  readonly id: string;
  readonly batchNo: number;
  readonly asAt: string;
  readonly state: 'draft' | 'posted' | 'reversed' | 'discarded';
  readonly autoBalance: boolean;
  readonly note: string | null;
  readonly preparedBy: string;
  readonly preparedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly postedEntryId: string | null;
  readonly reversedBy: string | null;
  readonly reversedAt: string | null;
  readonly reversalReason: string | null;
}

async function batchRows(
  tx: Queryable, societyId: string, where: string, params: Array<string | number | null>,
): Promise<BatchView[]> {
  const result = await tx.query<{
    id: string; batch_no: string; as_at: string; state: BatchView['state']; auto_balance: string;
    note: string | null; prepared_by: string; prepared_at: string; approved_by: string | null;
    approved_at: string | null; posted_entry_id: string | null; reversed_by: string | null;
    reversed_at: string | null; reversal_reason: string | null;
  }>(
    `SELECT b.id, b.batch_no::text, b.as_at::text, b.state, b.auto_balance::text, b.note,
            p.email AS prepared_by, b.prepared_at::text, a.email AS approved_by, b.approved_at::text,
            b.posted_entry_id, r.email AS reversed_by, b.reversed_at::text, b.reversal_reason
       FROM opening_balance_batches b
       JOIN users p ON p.id = b.prepared_by
       LEFT JOIN users a ON a.id = b.approved_by
       LEFT JOIN users r ON r.id = b.reversed_by
      WHERE b.society_id = $1 ${where}
      ORDER BY b.batch_no DESC`,
    [societyId, ...params],
  );
  return result.rows.map(r => ({
    id: r.id,
    batchNo: Number(r.batch_no),
    asAt: r.as_at,
    state: r.state,
    autoBalance: r.auto_balance === 't' || r.auto_balance === 'true',
    note: r.note,
    preparedBy: r.prepared_by,
    preparedAt: r.prepared_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    postedEntryId: r.posted_entry_id,
    reversedBy: r.reversed_by,
    reversedAt: r.reversed_at,
    reversalReason: r.reversal_reason,
  }));
}

/** The lines stored on a batch, as inputs again (balancing figure excluded). */
async function storedInputs(
  tx: Queryable, batchId: string,
): Promise<{ flatLines: FlatLineInput[]; accountLines: AccountLineInput[] }> {
  const flats = await tx.query<{ flat_no: string; due: string; advance: string; due_since: string | null }>(
    `SELECT f.flat_no, l.due::text, l.advance::text, l.due_since::text
       FROM opening_balance_flat_lines l JOIN flats f ON f.id = l.flat_id
      WHERE l.batch_id = $1 ORDER BY l.id`,
    [batchId],
  );
  const accounts = await tx.query<{
    account_code: string; debit: string; credit: string; vendor_id: string | null;
    reference: string | null; expense_account: string | null; memo: string | null;
  }>(
    `SELECT account_code, debit::text, credit::text, vendor_id, reference, expense_account, memo
       FROM opening_balance_account_lines WHERE batch_id = $1 AND NOT is_balancing ORDER BY id`,
    [batchId],
  );
  return {
    flatLines: flats.rows.map(r => ({
      flatNo: r.flat_no, duePaise: Number(r.due), advancePaise: Number(r.advance), dueSince: r.due_since,
    })),
    accountLines: accounts.rows.map(r => ({
      accountCode: r.account_code, debitPaise: Number(r.debit), creditPaise: Number(r.credit),
      vendorId: r.vendor_id, reference: r.reference, expenseAccount: r.expense_account, memo: r.memo,
    })),
  };
}

/** The live batch (draft or posted) with its plan, every earlier batch, and the accounts on offer. */
export async function readOpening(tx: Queryable, societyId: string): Promise<{
  current: (BatchView & { plan: OpeningPlan }) | null;
  history: BatchView[];
  accounts: ChartRow[];
  balancingAccount: string;
}> {
  const history = await batchRows(tx, societyId, '', []);
  const live = history.find(b => b.state === 'draft' || b.state === 'posted') ?? null;
  let current: (BatchView & { plan: OpeningPlan }) | null = null;
  if (live !== null) {
    const stored = await storedInputs(tx, live.id);
    const plan = await planOpening(tx, {
      societyId, asAt: live.asAt, autoBalance: live.autoBalance, batchId: live.id, ...stored,
    });
    // Once posted, the books have moved on and the "must come first" check no
    // longer describes anything to fix.
    current = { ...live, plan: live.state === 'posted' ? { ...plan, blockers: [] } : plan };
  }
  const accounts = await tx.query<ChartRow>(
    `SELECT code, name, class, control FROM accounts
      WHERE society_id = $1 AND class IN ('asset','liability','fund')
        AND (control IS NULL OR control = 'vendor')
      ORDER BY code`,
    [societyId],
  );
  return { current, history, accounts: accounts.rows, balancingAccount: BALANCING_ACCOUNT };
}

// --- the maker's step ------------------------------------------------------

export async function saveDraft(
  tx: Queryable,
  input: {
    societyId: string; userId: string; userLabel: string; requestId: string;
    asAt: string; autoBalance: boolean; note: string | null;
    flatLines: readonly FlatLineInput[]; accountLines: readonly AccountLineInput[];
    parseErrors: readonly OpeningProblem[]; dryRun: boolean;
  },
): Promise<{ batchId: string | null; plan: OpeningPlan }> {
  // Serialises two people saving at once: the second waits, then sees the
  // first one's draft and replaces it rather than colliding with it.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`societybooks:opening:${input.societyId}`]);

  const live = await tx.query<{ id: string; state: string; batch_no: string }>(
    `SELECT id, state, batch_no::text FROM opening_balance_batches
      WHERE society_id = $1 AND state IN ('draft','posted')`,
    [input.societyId],
  );
  const existing = live.rows[0];
  if (existing?.state === 'posted') {
    throw conflict(
      `Opening balances were already posted (batch ${existing.batch_no}). They are entered once; to ` +
      'correct them the treasurer reverses that batch, and a new one is entered.',
    );
  }

  const planned = await planOpening(tx, { ...input, ...(existing ? { batchId: existing.id } : {}) });
  const plan = { ...planned, errors: [...input.parseErrors, ...planned.errors] };
  if (input.dryRun) return { batchId: existing?.id ?? null, plan };
  if (plan.errors.length > 0) {
    throw new HttpError(
      400,
      `Nothing was saved: ${plan.errors.length} ${plan.errors.length === 1 ? 'line has a problem' : 'lines have problems'}.`,
      { plan },
    );
  }

  let batchId: string;
  if (existing !== undefined) {
    batchId = existing.id;
    await tx.query('DELETE FROM opening_balance_flat_lines WHERE batch_id = $1', [batchId]);
    await tx.query('DELETE FROM opening_balance_account_lines WHERE batch_id = $1', [batchId]);
    // Whoever saves the draft last is its maker, so they cannot also approve it.
    await tx.query(
      `UPDATE opening_balance_batches
          SET as_at = $2, auto_balance = $3, note = $4, prepared_by = $5, prepared_at = now()
        WHERE id = $1`,
      [batchId, input.asAt, input.autoBalance, input.note, input.userId],
    );
  } else {
    const next = await tx.query<{ n: string }>(
      'SELECT (COALESCE(MAX(batch_no), 0) + 1)::text AS n FROM opening_balance_batches WHERE society_id = $1',
      [input.societyId],
    );
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO opening_balance_batches (society_id, batch_no, as_at, auto_balance, note, prepared_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.societyId, Number(next.rows[0].n), input.asAt, input.autoBalance, input.note, input.userId],
    );
    batchId = inserted.rows[0].id;
  }

  await insertLines(tx, input.societyId, batchId, plan);

  await audit(tx, {
    societyId: input.societyId,
    actorUser: input.userId,
    actorLabel: input.userLabel,
    action: 'opening.prepare',
    subjectTable: 'opening_balance_batches',
    subjectId: batchId,
    detail: {
      asAt: input.asAt,
      flats: plan.flats.length,
      duePaise: plan.totals.duePaise,
      advancePaise: plan.totals.advancePaise,
      accountLines: plan.accounts.length,
      debitPaise: plan.totals.debitPaise,
      creditPaise: plan.totals.creditPaise,
      autoBalance: input.autoBalance,
    },
    requestId: input.requestId,
  });

  return { batchId, plan };
}

async function insertLines(tx: Queryable, societyId: string, batchId: string, plan: OpeningPlan): Promise<void> {
  for (const f of plan.flats) {
    await tx.query(
      `INSERT INTO opening_balance_flat_lines (batch_id, flat_id, due, advance, due_since)
       VALUES ($1,$2,$3,$4,$5)`,
      [batchId, f.flatId, f.duePaise, f.advancePaise, f.dueSince],
    );
  }
  for (const a of plan.accounts) {
    await tx.query(
      `INSERT INTO opening_balance_account_lines
         (batch_id, society_id, account_code, debit, credit, vendor_id, reference, expense_account, memo, is_balancing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        batchId, societyId, a.accountCode, a.debitPaise, a.creditPaise, a.vendorId ?? null,
        a.reference ?? null, a.expenseAccount ?? null, a.memo ?? null, a.isBalancing,
      ],
    );
  }
}

export async function discardDraft(
  tx: Queryable,
  input: { societyId: string; batchId: string; userId: string; userLabel: string; requestId: string },
): Promise<void> {
  const updated = await tx.query(
    `UPDATE opening_balance_batches SET state = 'discarded'
      WHERE id = $1 AND society_id = $2 AND state = 'draft'`,
    [input.batchId, input.societyId],
  );
  if (updated.rowCount === 0) throw conflict('That is not a draft, so there is nothing to discard.');
  await audit(tx, {
    societyId: input.societyId, actorUser: input.userId, actorLabel: input.userLabel,
    action: 'opening.discard', subjectTable: 'opening_balance_batches', subjectId: input.batchId,
    requestId: input.requestId,
  });
}

// --- the checker's step: posting -------------------------------------------

export async function approveAndPost(
  tx: Queryable,
  input: { societyId: string; batchId: string; userId: string; userLabel: string; requestId: string },
): Promise<{ entryId: string; documents: number; vendorBills: number; totalPaise: number }> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`societybooks:opening:${input.societyId}`]);
  const found = await tx.query<{
    id: string; batch_no: string; as_at: string; state: string; auto_balance: string; prepared_by: string;
  }>(
    `SELECT id, batch_no::text, as_at::text, state, auto_balance::text, prepared_by
       FROM opening_balance_batches WHERE id = $1 AND society_id = $2 FOR UPDATE`,
    [input.batchId, input.societyId],
  );
  const batch = found.rows[0];
  if (batch === undefined) throw notFound('That batch of opening balances');
  if (batch.state !== 'draft') throw conflict(`That batch is ${batch.state}; only a draft can be approved.`);
  if (batch.prepared_by === input.userId) {
    throw conflict(
      'You prepared these opening balances, so you cannot also approve them. Another office-bearer ' +
      'with the right to close the books must check and post them.',
    );
  }

  const stored = await storedInputs(tx, batch.id);
  const plan = await planOpening(tx, {
    societyId: input.societyId, asAt: batch.as_at,
    autoBalance: batch.auto_balance === 't' || batch.auto_balance === 'true',
    batchId: batch.id, ...stored,
  });
  if (plan.errors.length > 0) {
    throw new HttpError(409, 'The draft no longer checks out against the books; open it, correct it and save it again.', { plan });
  }
  if (plan.blockers.length > 0) throw conflict(plan.blockers.join(' '));

  // The balancing figure is recomputed rather than trusted from the draft.
  await tx.query('DELETE FROM opening_balance_account_lines WHERE batch_id = $1 AND is_balancing', [batch.id]);
  const balancing = plan.accounts.find(a => a.isBalancing);
  if (balancing !== undefined) {
    await tx.query(
      `INSERT INTO opening_balance_account_lines (batch_id, society_id, account_code, debit, credit, memo, is_balancing)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [batch.id, input.societyId, balancing.accountCode, balancing.debitPaise, balancing.creditPaise, balancing.memo ?? null],
    );
  }

  // Each flat's balance lock, before the entry-reference lock postEntry takes,
  // in the order series.ts sets out; a receipt for one of these flats waits
  // until its opening due exists.
  for (const f of plan.flats) await lockFlatBalance(tx, { societyId: input.societyId, flatId: f.flatId });

  const batchRef = `OB/${batch.batch_no}`;
  const period = periodLabel(batch.as_at);
  const numbered = plan.flats.map((f, i) => ({
    ...f,
    documentNo: f.duePaise > 0 ? `${batchRef}/${String(i + 1).padStart(5, '0')}` : null,
  }));

  const legs: Leg[] = [];
  for (const f of numbered) {
    if (f.documentNo !== null) {
      legs.push({
        accountCode: A.MAINTENANCE_RECEIVABLE, debit: f.duePaise, credit: 0, party: f.flatNo,
        docRef: f.documentNo, memo: `Opening due brought forward at ${batch.as_at}`,
      });
    } else {
      legs.push({
        accountCode: A.MEMBER_ADVANCE, debit: 0, credit: f.advancePaise, party: f.flatNo,
        docRef: batchRef, memo: `Opening advance brought forward at ${batch.as_at}`,
      });
    }
  }
  for (const a of plan.accounts) {
    legs.push({
      accountCode: a.accountCode, debit: a.debitPaise, credit: a.creditPaise,
      ...(a.vendorId ? { party: a.vendorId } : {}),
      ...(a.vendorId ? { docRef: a.reference as string } : { docRef: batchRef }),
      memo: a.memo ?? (a.vendorId ? `Opening payable, bill ${a.reference}` : 'Opening balance'),
    });
  }
  const total = legs.reduce((s, l) => s + l.debit, 0);

  const entryId = await postEntry(tx, {
    societyId: input.societyId,
    entryDate: batch.as_at,
    narration: `Opening balances as at ${batch.as_at} (batch ${batch.batch_no})`,
    sourceKind: 'opening-balance',
    sourceRef: batchRef,
    idempotencyKey: `opening-balance:${batch.id}`,
    postedBy: input.userId,
    postedByLabel: input.userLabel,
    legs,
  });
  if (entryId === null) throw conflict('These opening balances have already been posted.');

  let documents = 0;
  for (const f of numbered) {
    if (f.documentNo === null) continue;
    const issuedOn = f.dueSince ?? batch.as_at;
    const doc = await tx.query<{ id: string }>(
      `INSERT INTO billing_documents
         (society_id, proforma_no, tax_invoice_no, flat_id, period, estimated_tax, gross,
          issued_on, due_on, state, approved_by, approved_on, converted_on, converted_because,
          posted_entry_id, opening_batch_id)
       VALUES ($1,$2,$2,$3,$4,0,$5,$6,$6,'tax-invoice',$7,$8,$8,'manual',$9,$10)
       RETURNING id`,
      [
        input.societyId, f.documentNo, f.flatId, period, f.duePaise, issuedOn,
        input.userId, batch.as_at, entryId, batch.id,
      ],
    );
    // One untaxed line, so anything that reads a document's composition finds
    // its total there.
    await tx.query(
      `INSERT INTO billing_document_lines (document_id, head, amount, taxable, position)
       VALUES ($1,'other',$2,false,1)`,
      [doc.rows[0].id, f.duePaise],
    );
    await tx.query(
      'UPDATE opening_balance_flat_lines SET document_id = $1 WHERE batch_id = $2 AND flat_id = $3',
      [doc.rows[0].id, batch.id, f.flatId],
    );
    documents += 1;
  }

  let vendorBills = 0;
  for (const a of plan.accounts) {
    if (!a.vendorId) continue;
    const bill = await tx.query<{ id: string }>(
      `INSERT INTO vendor_bills
         (society_id, vendor_id, bill_no, bill_date, expense_account, gross, input_gst,
          tds_section, tds_rate_bps, tds_amount, net_payable, state, approved_by,
          posted_entry_id, opening_batch_id)
       VALUES ($1,$2,$3,$4,$5,$6,0,'none',0,0,$6,'booked',$7,$8,$9)
       RETURNING id`,
      [
        input.societyId, a.vendorId, a.reference ?? null, batch.as_at, a.expenseAccount ?? null,
        a.creditPaise, input.userId, entryId, batch.id,
      ],
    );
    await tx.query(
      `UPDATE opening_balance_account_lines SET vendor_bill_id = $1
        WHERE batch_id = $2 AND vendor_id = $3 AND reference = $4`,
      [bill.rows[0].id, batch.id, a.vendorId, a.reference ?? null],
    );
    vendorBills += 1;
  }

  await tx.query(
    `UPDATE opening_balance_batches
        SET state = 'posted', approved_by = $2, approved_at = now(), posted_entry_id = $3,
            total_debit = $4, total_credit = $4
      WHERE id = $1`,
    [batch.id, input.userId, entryId, total],
  );
  // The committee's approval register, where every maker-checker decision is
  // kept; its own constraint refuses the preparer as the approver too.
  await tx.query(
    `INSERT INTO approvals (society_id, subject_table, subject_id, requested_by, decided_by, decided_at, decision)
     VALUES ($1, 'opening_balance_batches', $2, $3, $4, now(), 'approved')`,
    [input.societyId, batch.id, batch.prepared_by, input.userId],
  );

  await audit(tx, {
    societyId: input.societyId,
    actorUser: input.userId,
    actorLabel: input.userLabel,
    action: 'opening.post',
    subjectTable: 'opening_balance_batches',
    subjectId: batch.id,
    detail: {
      asAt: batch.as_at, entryId, totalPaise: total, documents, vendorBills,
      balancingPaise: balancing === undefined ? 0 : balancing.creditPaise - balancing.debitPaise,
    },
    requestId: input.requestId,
  });

  return { entryId, documents, vendorBills, totalPaise: total };
}

// --- correcting: reversal --------------------------------------------------

export async function reverseOpening(
  tx: Queryable,
  input: { societyId: string; batchId: string; reason: string; userId: string; userLabel: string; requestId: string },
): Promise<{ reversalEntryId: string }> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`societybooks:opening:${input.societyId}`]);
  const found = await tx.query<{ id: string; batch_no: string; as_at: string; state: string; posted_entry_id: string | null }>(
    `SELECT id, batch_no::text, as_at::text, state, posted_entry_id
       FROM opening_balance_batches WHERE id = $1 AND society_id = $2 FOR UPDATE`,
    [input.batchId, input.societyId],
  );
  const batch = found.rows[0];
  if (batch === undefined) throw notFound('That batch of opening balances');
  if (batch.state !== 'posted' || batch.posted_entry_id === null) {
    throw conflict(`That batch is ${batch.state}; only posted opening balances are reversed.`);
  }

  const flats = await tx.query<{ flat_id: string; flat_no: string; advance: string }>(
    `SELECT l.flat_id, f.flat_no, l.advance::text FROM opening_balance_flat_lines l
       JOIN flats f ON f.id = l.flat_id WHERE l.batch_id = $1`,
    [batch.id],
  );
  for (const f of flats.rows) await lockFlatBalance(tx, { societyId: input.societyId, flatId: f.flat_id });

  // Nothing may have been settled against an opening item. Reversing a due a
  // receipt has already paid, or an advance already applied to a bill, would
  // leave the receivable below zero — the same reason a part-paid invoice
  // cannot be cancelled.
  const touched = await tx.query<{ doc_ref: string }>(
    `SELECT DISTINCT p.doc_ref
       FROM journal_postings p
       JOIN billing_documents d ON d.society_id = p.society_id AND d.tax_invoice_no = p.doc_ref
      WHERE p.society_id = $1 AND p.account_code = $2 AND d.opening_batch_id = $3
        AND p.entry_id <> $4
      LIMIT 5`,
    [input.societyId, A.MAINTENANCE_RECEIVABLE, batch.id, batch.posted_entry_id],
  );
  if (touched.rows.length > 0) {
    throw conflict(
      `Receipts or notes have already been set against opening dues (${touched.rows.map(r => r.doc_ref).join(', ')}). ` +
      'Reverse those first; reversing the opening balances now would leave those flats below zero.',
    );
  }
  const advanceFlats = flats.rows.filter(f => Number(f.advance) > 0).map(f => f.flat_no);
  if (advanceFlats.length > 0) {
    const used = await tx.query<{ party: string }>(
      `SELECT DISTINCT p.party FROM journal_postings p
        WHERE p.society_id = $1 AND p.account_code = $2 AND p.debit > 0
          AND p.party = ANY($3::text[]) AND p.entry_id <> $4
        LIMIT 5`,
      [input.societyId, A.MEMBER_ADVANCE, `{${advanceFlats.map(n => `"${n.replace(/["\\]/g, '')}"`).join(',')}}`, batch.posted_entry_id],
    );
    if (used.rows.length > 0) {
      throw conflict(
        `Advances for ${used.rows.map(r => r.party).join(', ')} have already been applied or refunded. ` +
        'Reverse that first; the opening advance it drew on cannot be taken back while it is spent.',
      );
    }
  }
  const paid = await tx.query<{ bill_no: string }>(
    `SELECT b.bill_no FROM vendor_payments p JOIN vendor_bills b ON b.id = p.bill_id
      WHERE b.opening_batch_id = $1 LIMIT 5`,
    [batch.id],
  );
  if (paid.rows.length > 0) {
    throw conflict(
      `Opening vendor bills have already been paid (${paid.rows.map(r => r.bill_no).join(', ')}). ` +
      'Those payments stand; correct the opening balances with a journal adjustment instead.',
    );
  }

  // Dated the same day as the entry it reverses, so the trial balance at the
  // as-at date nets to nothing and the corrected batch takes its place.
  const reversalEntryId = await reverseEntry(tx, {
    societyId: input.societyId,
    entryId: batch.posted_entry_id,
    date: batch.as_at,
    reason: input.reason,
    postedBy: input.userId,
    postedByLabel: input.userLabel,
  });

  // The batch first: the trigger on billing_documents lets an opening due be
  // cancelled only once its batch reads as reversed.
  await tx.query(
    `UPDATE opening_balance_batches
        SET state = 'reversed', reversed_by = $2, reversed_at = now(),
            reversal_entry_id = $3, reversal_reason = $4
      WHERE id = $1`,
    [batch.id, input.userId, reversalEntryId, input.reason],
  );
  await tx.query(
    `UPDATE billing_documents
        SET state = 'cancelled', cancelled_by = $2, cancelled_reason = $3
      WHERE opening_batch_id = $1 AND state <> 'cancelled'`,
    [batch.id, input.userId, `Opening balances reversed: ${input.reason}`],
  );
  // The bill number is suffixed so the corrected batch can book the same bill
  // again; the ledger keeps the original number on both entries' legs.
  await tx.query(
    `UPDATE vendor_bills
        SET state = 'rejected', rejected_reason = $2, bill_no = bill_no || ' (reversed ' || $3 || ')'
      WHERE opening_batch_id = $1`,
    [batch.id, `Opening balances reversed: ${input.reason}`, `OB/${batch.batch_no}`],
  );

  await audit(tx, {
    societyId: input.societyId,
    actorUser: input.userId,
    actorLabel: input.userLabel,
    action: 'opening.reverse',
    subjectTable: 'opening_balance_batches',
    subjectId: batch.id,
    detail: { reason: input.reason, reversalEntryId, originalEntryId: batch.posted_entry_id },
    requestId: input.requestId,
  });

  return { reversalEntryId };
}
