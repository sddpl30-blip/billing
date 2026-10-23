/**
 * The posting engine: journal entries, validation, the ledger, and reversals.
 *
 * Nothing here touches localStorage, React or the browser. A `Ledger` is an
 * in-memory list of entries plus the indexes needed to answer balance
 * questions; persisting it is somebody else's job, which is what lets the same
 * code run behind a Postgres-backed API later.
 */

import { Paise, assertInteger, formatRupees, sum } from './money';
import { Account, NORMAL_BALANCE, account, hasAccount } from './accounts';

export class PostingError extends Error {}

/** One leg of an entry. Exactly one of `debit`/`credit` is non-zero. */
export interface Posting {
  readonly accountCode: string;
  readonly debit: Paise;
  readonly credit: Paise;
  /** Which member or vendor this leg belongs to, for control-account subledgers. */
  readonly party?: string;
  /**
   * The document this leg settles or raises — an invoice number or a vendor
   * bill number. Without it a receipt can only be known to belong to a flat,
   * not to an invoice, so an invoice's status cannot be derived from the
   * ledger. Optional, so every posting written before this existed is
   * unaffected.
   */
  readonly docRef?: string;
  readonly memo?: string;
}

export type EntrySourceKind =
  | 'maintenance-billing'
  | 'member-receipt'
  | 'member-advance'
  | 'advance-adjustment'
  | 'vendor-bill'
  | 'vendor-payment'
  | 'tds-remittance'
  | 'gst-remittance'
  | 'fund-transfer'
  | 'fd-interest'
  | 'opening-balance'
  | 'reversal'
  | 'manual';

export interface JournalEntry {
  readonly id: string;
  /** ISO date, `YYYY-MM-DD`. Sorting and period filters rely on this format. */
  readonly date: string;
  readonly narration: string;
  readonly source: { readonly kind: EntrySourceKind; readonly ref?: string };
  readonly postings: readonly Posting[];
  /**
   * The natural key of the business event. Posting a second entry with the
   * same key is rejected, which is what makes a re-run of a monthly billing
   * job safe.
   */
  readonly idempotencyKey: string;
  /** Set on an entry that reverses another. */
  readonly reversalOf?: string;
  /** Set on an entry that has been reversed. Reversed entries are never deleted. */
  readonly reversedBy?: string;
  readonly postedBy: string;
  readonly postedAt: string;
}

export interface NewEntry {
  readonly date: string;
  readonly narration: string;
  readonly source: { readonly kind: EntrySourceKind; readonly ref?: string };
  readonly postings: readonly Posting[];
  readonly idempotencyKey: string;
  readonly postedBy: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function debit(
  accountCode: string, amount: Paise, party?: string, memo?: string, docRef?: string,
): Posting {
  return { accountCode, debit: amount, credit: 0, party, memo, docRef };
}

export function credit(
  accountCode: string, amount: Paise, party?: string, memo?: string, docRef?: string,
): Posting {
  return { accountCode, debit: 0, credit: amount, party, memo, docRef };
}

/**
 * Checks an entry without posting it. Returns the problems found, so a caller
 * can show them all rather than only the first.
 */
export function validateEntry(entry: NewEntry): string[] {
  const problems: string[] = [];

  if (!ISO_DATE.test(entry.date)) {
    problems.push(`Date must be YYYY-MM-DD, got "${entry.date}"`);
  } else if (Number.isNaN(Date.parse(entry.date + 'T00:00:00Z'))) {
    problems.push(`"${entry.date}" is not a real date`);
  }

  if (entry.narration.trim() === '') {
    problems.push('Narration must not be empty');
  }
  if (entry.idempotencyKey.trim() === '') {
    problems.push('Idempotency key must not be empty');
  }
  if (entry.postedBy.trim() === '') {
    problems.push('postedBy must name who posted the entry');
  }

  if (entry.postings.length < 2) {
    problems.push(`An entry needs at least two legs, got ${entry.postings.length}`);
  }

  for (const [i, p] of entry.postings.entries()) {
    const where = `leg ${i + 1} (${p.accountCode})`;
    if (!hasAccount(p.accountCode)) {
      problems.push(`${where}: no such account in the chart of accounts`);
      continue;
    }
    try {
      assertInteger(p.debit);
      assertInteger(p.credit);
    } catch {
      problems.push(`${where}: amounts must be whole paise`);
      continue;
    }
    if (p.debit < 0 || p.credit < 0) {
      problems.push(`${where}: amounts must not be negative — reverse the entry instead of posting a negative leg`);
    }
    if (p.debit === 0 && p.credit === 0) {
      problems.push(`${where}: a leg must move a non-zero amount`);
    }
    if (p.debit !== 0 && p.credit !== 0) {
      problems.push(`${where}: a leg is either a debit or a credit, not both`);
    }
    const acct = account(p.accountCode);
    if (acct.control && !p.party) {
      problems.push(`${where}: ${acct.name} is a control account, so the leg must name a party`);
    }
  }

  const debits = sum(entry.postings.map(p => p.debit));
  const credits = sum(entry.postings.map(p => p.credit));
  if (debits !== credits) {
    problems.push(
      `Entry does not balance: debits ${formatRupees(debits, { paise: true })} ` +
      `vs credits ${formatRupees(credits, { paise: true })} ` +
      `(out by ${formatRupees(debits - credits, { paise: true })})`,
    );
  }
  if (debits === 0) {
    problems.push('Entry moves nothing');
  }

  return problems;
}

export interface AccountBalance {
  readonly account: Account;
  readonly debit: Paise;
  readonly credit: Paise;
  /** Signed so that a positive figure sits on the account's normal side. */
  readonly balance: Paise;
  /** True when the balance sits on the side this account should not be on. */
  readonly contraNormal: boolean;
}

export class Ledger {
  private readonly entries: JournalEntry[] = [];
  private readonly byKey = new Map<string, string>();
  private readonly byId = new Map<string, JournalEntry>();
  private sequence = 0;

  /**
   * Posts an entry, or throws. A rejected entry changes nothing: validation
   * and the duplicate check both run before anything is appended.
   */
  post(entry: NewEntry): JournalEntry {
    const problems = validateEntry(entry);
    if (problems.length > 0) {
      throw new PostingError(
        `Refusing to post "${entry.narration}":\n  - ${problems.join('\n  - ')}`,
      );
    }
    const existing = this.byKey.get(entry.idempotencyKey);
    if (existing !== undefined) {
      throw new PostingError(
        `Duplicate transaction: "${entry.idempotencyKey}" was already posted as ${existing}`,
      );
    }

    this.sequence += 1;
    const posted: JournalEntry = {
      ...entry,
      id: `JE${this.sequence.toString().padStart(6, '0')}`,
      postings: entry.postings.map(p => ({ ...p })),
      postedAt: new Date().toISOString(),
    };
    this.entries.push(posted);
    this.byKey.set(posted.idempotencyKey, posted.id);
    this.byId.set(posted.id, posted);
    return posted;
  }

  /** True when this business event has already been posted. */
  hasPosted(idempotencyKey: string): boolean {
    return this.byKey.has(idempotencyKey);
  }

  /**
   * Puts a previously posted entry back, keeping its identity.
   *
   * Used only when restoring from a snapshot. `post` would assign a fresh id
   * and timestamp, which would renumber the whole ledger and break every
   * reversal link; this keeps what was written. The entry is validated exactly
   * as a new one is, so a corrupt snapshot is refused rather than loaded.
   */
  restore(entry: JournalEntry): JournalEntry {
    const problems = validateEntry(entry);
    if (problems.length > 0) {
      throw new PostingError(
        `Refusing to restore "${entry.id}":\n  - ${problems.join('\n  - ')}`,
      );
    }
    if (this.byId.has(entry.id)) {
      throw new PostingError(`Entry ${entry.id} is already in this ledger`);
    }
    const clash = this.byKey.get(entry.idempotencyKey);
    if (clash !== undefined) {
      throw new PostingError(
        `Snapshot has two entries with the key "${entry.idempotencyKey}" ` +
        `(${clash} and ${entry.id}), which means the same business event was ` +
        `recorded twice.`,
      );
    }

    const copy: JournalEntry = { ...entry, postings: entry.postings.map(p => ({ ...p })) };
    this.entries.push(copy);
    this.byKey.set(copy.idempotencyKey, copy.id);
    this.byId.set(copy.id, copy);

    // Keep the sequence ahead of any restored id, so the next `post` does not
    // reuse a number already in the ledger.
    const numeric = /^JE(\d+)$/.exec(copy.id);
    if (numeric !== null) {
      this.sequence = Math.max(this.sequence, Number(numeric[1]));
    }
    return copy;
  }

  /**
   * Reverses an entry by posting its mirror image. The original stays in the
   * ledger — an audit trail that can lose a row is not an audit trail — and
   * both entries point at each other.
   */
  reverse(entryId: string, opts: { date: string; postedBy: string; reason: string }): JournalEntry {
    const original = this.byId.get(entryId);
    if (!original) {
      throw new PostingError(`Cannot reverse ${entryId}: no such entry`);
    }
    if (original.reversedBy) {
      throw new PostingError(
        `${entryId} was already reversed by ${original.reversedBy}`,
      );
    }
    if (original.reversalOf) {
      throw new PostingError(
        `${entryId} is itself a reversal of ${original.reversalOf}; reverse the original instead`,
      );
    }

    const mirrored = original.postings.map(p => ({
      accountCode: p.accountCode,
      debit: p.credit,
      credit: p.debit,
      party: p.party,
      memo: p.memo,
    }));

    const reversal = this.post({
      date: opts.date,
      narration: `Reversal of ${original.id}: ${opts.reason}`,
      source: { kind: 'reversal', ref: original.id },
      postings: mirrored,
      idempotencyKey: `reversal:${original.id}`,
      postedBy: opts.postedBy,
    });

    // Record the back-reference on the original.
    const index = this.entries.findIndex(e => e.id === original.id);
    const updated: JournalEntry = { ...original, reversedBy: reversal.id };
    this.entries[index] = updated;
    this.byId.set(original.id, updated);

    const withOrigin: JournalEntry = { ...reversal, reversalOf: original.id };
    const rIndex = this.entries.findIndex(e => e.id === reversal.id);
    this.entries[rIndex] = withOrigin;
    this.byId.set(reversal.id, withOrigin);
    return withOrigin;
  }

  all(): readonly JournalEntry[] {
    return this.entries;
  }

  get(id: string): JournalEntry | undefined {
    return this.byId.get(id);
  }

  /** Entries dated within `[from, to]` inclusive, both ISO dates. */
  inPeriod(from: string, to: string): readonly JournalEntry[] {
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      throw new PostingError(`Period bounds must be YYYY-MM-DD, got "${from}".."${to}"`);
    }
    if (from > to) {
      throw new PostingError(`Period starts after it ends: "${from}".."${to}"`);
    }
    return this.entries.filter(e => e.date >= from && e.date <= to);
  }

  /** Every leg touching `accountCode`, oldest first — the general ledger. */
  generalLedger(
    accountCode: string,
    opts: { from?: string; to?: string; party?: string; docRef?: string } = {},
  ): Array<{ entry: JournalEntry; posting: Posting; runningBalance: Paise }> {
    account(accountCode); // throws on an unknown code
    const normal = NORMAL_BALANCE[account(accountCode).cls];
    const rows: Array<{ entry: JournalEntry; posting: Posting; runningBalance: Paise }> = [];
    let running = 0;

    const scoped = [...this.entries]
      .filter(e => (opts.from === undefined || e.date >= opts.from))
      .filter(e => (opts.to === undefined || e.date <= opts.to))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));

    for (const entry of scoped) {
      for (const posting of entry.postings) {
        if (posting.accountCode !== accountCode) continue;
        if (opts.party !== undefined && posting.party !== opts.party) continue;
        if (opts.docRef !== undefined && posting.docRef !== opts.docRef) continue;
        const movement = normal === 'debit'
          ? posting.debit - posting.credit
          : posting.credit - posting.debit;
        running += movement;
        rows.push({ entry, posting, runningBalance: running });
      }
    }
    return rows;
  }

  /** The signed balance of one account, positive on its normal side. */
  balanceOf(
    accountCode: string,
    opts: { to?: string; party?: string; docRef?: string } = {},
  ): Paise {
    const rows = this.generalLedger(accountCode, opts);
    return rows.length === 0 ? 0 : rows[rows.length - 1].runningBalance;
  }

  /**
   * Balances per document on a control account.
   *
   * The per-party subledger says what a flat owes in total; this says what each
   * invoice still owes, which is what an invoice's status has to come from.
   */
  docLedger(accountCode: string, opts: { to?: string; party?: string } = {}): Map<string, Paise> {
    const acct = account(accountCode);
    const normal = NORMAL_BALANCE[acct.cls];
    const balances = new Map<string, Paise>();
    for (const entry of this.entries) {
      if (opts.to !== undefined && entry.date > opts.to) continue;
      for (const p of entry.postings) {
        if (p.accountCode !== accountCode || !p.docRef) continue;
        if (opts.party !== undefined && p.party !== opts.party) continue;
        const movement = normal === 'debit' ? p.debit - p.credit : p.credit - p.debit;
        balances.set(p.docRef, (balances.get(p.docRef) ?? 0) + movement);
      }
    }
    return balances;
  }

  /** Balances per party for a control account — the subledger. */
  subledger(accountCode: string, opts: { to?: string } = {}): Map<string, Paise> {
    const acct = account(accountCode);
    if (!acct.control) {
      throw new PostingError(`${acct.name} is not a control account, so it has no subledger`);
    }
    const normal = NORMAL_BALANCE[acct.cls];
    const balances = new Map<string, Paise>();
    for (const entry of this.entries) {
      if (opts.to !== undefined && entry.date > opts.to) continue;
      for (const p of entry.postings) {
        if (p.accountCode !== accountCode || !p.party) continue;
        const movement = normal === 'debit' ? p.debit - p.credit : p.credit - p.debit;
        balances.set(p.party, (balances.get(p.party) ?? 0) + movement);
      }
    }
    return balances;
  }
}
