/**
 * Serialising and restoring the ledger and the billing register.
 *
 * Phase 2 kept both in memory, so a browser refresh lost every posting made in
 * that session. This module turns them into plain JSON and back, with a schema
 * version on the wire so an older saved file can be migrated rather than
 * silently misread.
 *
 * Restoring is not a replay of the business transactions: it rebuilds the
 * ledger from the entries as they were posted. Replaying would re-derive
 * amounts from today's config and could change a figure a member was already
 * billed. What was posted is what comes back.
 */

import { Paise, assertInteger } from './money';
import { hasAccount } from './accounts';
import {
  EntrySourceKind, JournalEntry, Ledger, Posting, PostingError,
} from './journal';
import { BillingDocument, BillingRegister, DocumentState } from './documents';
import { AccountingConfig } from './config';
import { Clock, isValidIsoDate } from './clock';

/** Bumped whenever the shape below changes. `migrate` handles older values. */
export const SNAPSHOT_VERSION = 3;

export class SnapshotError extends Error {}

export interface SerialisedPosting {
  readonly a: string;          // accountCode
  readonly d: Paise;           // debit
  readonly c: Paise;           // credit
  readonly p?: string;         // party
  readonly r?: string;         // docRef
  readonly m?: string;         // memo
}

export interface SerialisedEntry {
  readonly id: string;
  readonly date: string;
  readonly narration: string;
  readonly sourceKind: EntrySourceKind;
  readonly sourceRef?: string;
  readonly postings: readonly SerialisedPosting[];
  readonly idempotencyKey: string;
  readonly reversalOf?: string;
  readonly reversedBy?: string;
  readonly postedBy: string;
  readonly postedAt: string;
}

export interface SerialisedDocument {
  readonly proformaNo: string;
  readonly taxInvoiceNo?: string;
  readonly flatNo: string;
  readonly period: string;
  readonly lines: ReadonlyArray<{ head: string; amount: Paise; taxable: boolean }>;
  readonly estimatedTax: Paise;
  readonly gross: Paise;
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly state: DocumentState;
  readonly approvedBy?: string;
  readonly approvedOn?: string;
  readonly dispatch?: ReadonlyArray<{
    at: string; by: string; channel: string; delivered: boolean; note: string;
  }>;
  readonly convertedOn?: string;
  readonly convertedBecause?: BillingDocument['convertedBecause'];
  readonly postedEntryId?: string;
  readonly cancelledBy?: string;
  readonly cancelledReason?: string;
}

export interface BooksSnapshotData {
  readonly version: number;
  /** When it was written, for the restore banner and for support. */
  readonly savedAt: string;
  /** Which mode wrote it, so demo data never loads over production records. */
  readonly mode: 'demo' | 'production';
  readonly entries: readonly SerialisedEntry[];
  readonly documents: readonly SerialisedDocument[];
  readonly taxInvoiceSequence: number;
  /**
   * The seeds already imported, by name, so a second load does not import
   * them again. This is the duplicate guard across reloads.
   */
  readonly migrationsApplied: readonly string[];
}

// --- writing ---------------------------------------------------------------

function serialisePosting(p: Posting): SerialisedPosting {
  return {
    a: p.accountCode,
    d: p.debit,
    c: p.credit,
    ...(p.party !== undefined ? { p: p.party } : {}),
    ...(p.docRef !== undefined ? { r: p.docRef } : {}),
    ...(p.memo !== undefined ? { m: p.memo } : {}),
  };
}

function serialiseEntry(e: JournalEntry): SerialisedEntry {
  return {
    id: e.id,
    date: e.date,
    narration: e.narration,
    sourceKind: e.source.kind,
    ...(e.source.ref !== undefined ? { sourceRef: e.source.ref } : {}),
    postings: e.postings.map(serialisePosting),
    idempotencyKey: e.idempotencyKey,
    ...(e.reversalOf !== undefined ? { reversalOf: e.reversalOf } : {}),
    ...(e.reversedBy !== undefined ? { reversedBy: e.reversedBy } : {}),
    postedBy: e.postedBy,
    postedAt: e.postedAt,
  };
}

function serialiseDocument(d: BillingDocument): SerialisedDocument {
  return {
    proformaNo: d.proformaNo,
    ...(d.taxInvoiceNo !== undefined ? { taxInvoiceNo: d.taxInvoiceNo } : {}),
    flatNo: d.flatNo,
    period: d.period,
    lines: d.lines.map(l => ({ head: l.head as string, amount: l.amount, taxable: l.taxable })),
    estimatedTax: d.estimatedTax,
    gross: d.gross,
    issuedOn: d.issuedOn,
    dueOn: d.dueOn,
    state: d.state,
    ...(d.approvedBy !== undefined ? { approvedBy: d.approvedBy } : {}),
    ...(d.approvedOn !== undefined ? { approvedOn: d.approvedOn } : {}),
    ...(d.dispatch !== undefined ? { dispatch: d.dispatch.map(a => ({ ...a })) } : {}),
    ...(d.convertedOn !== undefined ? { convertedOn: d.convertedOn } : {}),
    ...(d.convertedBecause !== undefined ? { convertedBecause: d.convertedBecause } : {}),
    ...(d.postedEntryId !== undefined ? { postedEntryId: d.postedEntryId } : {}),
    ...(d.cancelledBy !== undefined ? { cancelledBy: d.cancelledBy } : {}),
    ...(d.cancelledReason !== undefined ? { cancelledReason: d.cancelledReason } : {}),
  };
}

export function writeSnapshot(input: {
  ledger: Ledger;
  register: BillingRegister;
  mode: 'demo' | 'production';
  savedAt: string;
  migrationsApplied: readonly string[];
}): BooksSnapshotData {
  return {
    version: SNAPSHOT_VERSION,
    savedAt: input.savedAt,
    mode: input.mode,
    entries: input.ledger.all().map(serialiseEntry),
    documents: input.register.rawDocuments().map(serialiseDocument),
    taxInvoiceSequence: input.register.taxInvoiceSequenceValue(),
    migrationsApplied: [...input.migrationsApplied],
  };
}

// --- reading ---------------------------------------------------------------

/**
 * Checks a parsed snapshot. Returns every problem, so a corrupt file reports
 * what is wrong with it rather than throwing on the first field.
 */
export function validateSnapshot(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return ['Snapshot is not an object'];
  }
  const s = value as Partial<BooksSnapshotData>;

  if (typeof s.version !== 'number' || !Number.isInteger(s.version) || s.version < 1) {
    problems.push(`version must be a positive integer, got ${JSON.stringify(s.version)}`);
  }
  if (s.version !== undefined && s.version > SNAPSHOT_VERSION) {
    problems.push(
      `snapshot version ${s.version} is newer than this build understands ` +
      `(${SNAPSHOT_VERSION}). Refusing rather than guessing at fields it does not know.`,
    );
  }
  if (s.mode !== 'demo' && s.mode !== 'production') {
    problems.push(`mode must be "demo" or "production", got ${JSON.stringify(s.mode)}`);
  }
  if (!Array.isArray(s.entries)) problems.push('entries must be an array');
  if (!Array.isArray(s.documents)) problems.push('documents must be an array');
  if (!Array.isArray(s.migrationsApplied)) problems.push('migrationsApplied must be an array');

  if (Array.isArray(s.entries)) {
    for (const [i, raw] of s.entries.entries()) {
      const e = raw as Partial<SerialisedEntry>;
      const where = `entry ${i}${typeof e.id === 'string' ? ` (${e.id})` : ''}`;
      if (typeof e.id !== 'string' || e.id === '') problems.push(`${where}: missing id`);
      if (typeof e.date !== 'string' || !isValidIsoDate(e.date)) {
        problems.push(`${where}: date "${String(e.date)}" is not a real date`);
      }
      if (typeof e.idempotencyKey !== 'string' || e.idempotencyKey === '') {
        problems.push(`${where}: missing idempotencyKey`);
      }
      if (!Array.isArray(e.postings) || e.postings.length < 2) {
        problems.push(`${where}: needs at least two postings`);
        continue;
      }
      let debits = 0;
      let credits = 0;
      for (const [j, rawP] of e.postings.entries()) {
        const p = rawP as Partial<SerialisedPosting>;
        if (typeof p.a !== 'string' || !hasAccount(p.a)) {
          problems.push(`${where} leg ${j}: unknown account "${String(p.a)}"`);
          continue;
        }
        if (!Number.isInteger(p.d) || !Number.isInteger(p.c)) {
          problems.push(`${where} leg ${j}: amounts must be whole paise`);
          continue;
        }
        debits += p.d as number;
        credits += p.c as number;
      }
      if (debits !== credits) {
        problems.push(
          `${where}: does not balance — ${debits} debits against ${credits} credits. ` +
          `A snapshot that does not balance is corrupt, not something to load and fix later.`,
        );
      }
    }
  }
  return problems;
}

/** Migrates an older snapshot forward. Throws on a version it cannot handle. */
export function migrate(raw: BooksSnapshotData): BooksSnapshotData {
  let s = raw;
  // Version 1 had no `mode`; everything written then was demo data.
  if (s.version < 2) {
    s = { ...s, version: 2, mode: s.mode ?? 'demo' };
  }
  // Version 2 had no `migrationsApplied`; nothing had been imported through
  // the named-seed mechanism, so the list starts empty.
  if (s.version < 3) {
    s = { ...s, version: 3, migrationsApplied: s.migrationsApplied ?? [] };
  }
  if (s.version !== SNAPSHOT_VERSION) {
    throw new SnapshotError(
      `No migration path from snapshot version ${s.version} to ${SNAPSHOT_VERSION}.`,
    );
  }
  return s;
}

export interface RestoreResult {
  readonly ledger: Ledger;
  readonly register: BillingRegister;
  readonly entriesRestored: number;
  readonly documentsRestored: number;
  readonly savedAt: string;
  readonly mode: 'demo' | 'production';
  readonly migrationsApplied: readonly string[];
}

/**
 * Rebuilds a ledger and register from a snapshot.
 *
 * Posts each entry back through `Ledger.restore`, which keeps the original id,
 * idempotency key and timestamps. Using `post` instead would renumber every
 * entry and break the reversal links.
 */
export function restoreSnapshot(
  data: BooksSnapshotData,
  config: AccountingConfig,
  clock: Clock,
): RestoreResult {
  const problems = validateSnapshot(data);
  if (problems.length > 0) {
    throw new SnapshotError(
      `Refusing to restore a snapshot with ${problems.length} problem(s):\n  - ` +
      problems.slice(0, 10).join('\n  - '),
    );
  }

  const ledger = new Ledger();
  for (const e of data.entries) {
    const postings: Posting[] = e.postings.map(p => {
      assertInteger(p.d);
      assertInteger(p.c);
      return {
        accountCode: p.a,
        debit: p.d,
        credit: p.c,
        ...(p.p !== undefined ? { party: p.p } : {}),
        ...(p.r !== undefined ? { docRef: p.r } : {}),
        ...(p.m !== undefined ? { memo: p.m } : {}),
      };
    });
    try {
      ledger.restore({
        id: e.id,
        date: e.date,
        narration: e.narration,
        source: {
          kind: e.sourceKind,
          ...(e.sourceRef !== undefined ? { ref: e.sourceRef } : {}),
        },
        postings,
        idempotencyKey: e.idempotencyKey,
        ...(e.reversalOf !== undefined ? { reversalOf: e.reversalOf } : {}),
        ...(e.reversedBy !== undefined ? { reversedBy: e.reversedBy } : {}),
        postedBy: e.postedBy,
        postedAt: e.postedAt,
      });
    } catch (err) {
      throw new SnapshotError(
        `Entry ${e.id} could not be restored: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const register = new BillingRegister(ledger, config, clock);
  register.restoreDocuments(
    data.documents.map(d => ({
      proformaNo: d.proformaNo,
      ...(d.taxInvoiceNo !== undefined ? { taxInvoiceNo: d.taxInvoiceNo } : {}),
      flatNo: d.flatNo,
      period: d.period,
      lines: d.lines.map(l => ({
        head: l.head as BillingDocument['lines'][number]['head'],
        amount: l.amount,
        taxable: l.taxable,
      })),
      estimatedTax: d.estimatedTax,
      gross: d.gross,
      issuedOn: d.issuedOn,
      dueOn: d.dueOn,
      state: d.state,
      ...(d.approvedBy !== undefined ? { approvedBy: d.approvedBy } : {}),
      ...(d.approvedOn !== undefined ? { approvedOn: d.approvedOn } : {}),
      ...(d.dispatch !== undefined ? { dispatch: d.dispatch.map(a => ({ ...a })) } : {}),
      ...(d.convertedOn !== undefined ? { convertedOn: d.convertedOn } : {}),
      ...(d.convertedBecause !== undefined ? { convertedBecause: d.convertedBecause } : {}),
      ...(d.postedEntryId !== undefined ? { postedEntryId: d.postedEntryId } : {}),
      ...(d.cancelledBy !== undefined ? { cancelledBy: d.cancelledBy } : {}),
      ...(d.cancelledReason !== undefined ? { cancelledReason: d.cancelledReason } : {}),
    })),
    data.taxInvoiceSequence,
  );

  return {
    ledger,
    register,
    entriesRestored: data.entries.length,
    documentsRestored: data.documents.length,
    savedAt: data.savedAt,
    mode: data.mode,
    migrationsApplied: data.migrationsApplied,
  };
}

/** Parses JSON text into a validated, migrated snapshot. */
export function parseSnapshot(text: string): BooksSnapshotData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SnapshotError(
      `Saved books are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const problems = validateSnapshot(parsed);
  // Version problems are fatal before migration; the rest are checked again
  // after it, because a migration may supply a missing field.
  const fatal = problems.filter(p => /^version |newer than this build/.test(p));
  if (fatal.length > 0) throw new SnapshotError(fatal.join('; '));
  return migrate(parsed as BooksSnapshotData);
}

void PostingError;
