/**
 * Allocating the next number in a series, safely.
 *
 * Every document in this system carries a human-readable number from a
 * per-society series: journal entry references, proforma numbers, tax invoice
 * numbers, receipt numbers, credit and debit note numbers, ticket numbers. Each
 * was allocated with `MAX(...) + 1`, which is correct exactly as long as two
 * transactions never do it at the same time.
 *
 * They do. Under PostgreSQL's default READ COMMITTED, two concurrent
 * transactions both read the same maximum, both compute the same next number,
 * and the second one to commit loses on the unique index. Measured before this
 * existed: of eight concurrent payments for different flats, **one succeeded
 * and seven were refused** — and refused with "the database refused this
 * change", which tells an operator nothing about what to do. The same held for
 * concurrent tickets and concurrent invoice conversions.
 *
 * The fix is to serialise the allocation, not to retry it. A transaction-scoped
 * advisory lock on the series name means the second transaction waits for the
 * first to commit and then reads a maximum that includes it. The lock is
 * released at COMMIT or ROLLBACK by the database, so nothing can leak one, and
 * it is held only for the few milliseconds between reading the maximum and
 * inserting the row.
 *
 * Why not a sequence? Because these numbers must have no gaps: a tax invoice
 * series with 00007 missing is a question from an auditor, and a sequence does
 * not roll back when its transaction does. Gapless numbering and concurrency
 * can only be reconciled by serialising, which is what this does.
 *
 * ORDER MATTERS. A caller that allocates a document number and then posts an
 * entry takes two locks, and every caller must take them in the same order —
 * the document series first, then the entry reference — or two of them can
 * deadlock. `postEntry` takes the entry-reference lock last for that reason.
 * A flat's balance lock (`lockFlatBalance`), where one is needed, comes before
 * all of them.
 */

import type { Queryable } from './pg';

/** The series a number comes from, as a stable key. */
export type SeriesKind =
  | 'entry-ref'
  | 'proforma'
  | 'tax-invoice'
  | 'receipt'
  | 'note'
  | 'ticket'
  | 'vendor-payment'
  | 'flat-balance';

/**
 * Takes the lock for one series until the transaction ends.
 *
 * `scope` separates series that number independently — a year for tax
 * invoices, a month for receipts, a period for proformas — so billing July
 * does not wait behind billing August.
 *
 * Must be called inside a transaction. Outside one, a transaction-scoped
 * advisory lock is taken and released immediately by the implicit commit,
 * which looks like it worked and serialises nothing.
 */
export async function lockSeries(
  tx: Queryable,
  input: { societyId: string; kind: SeriesKind; scope?: string },
): Promise<void> {
  const key = `societybooks:${input.kind}:${input.societyId}:${input.scope ?? ''}`;
  // hashtext gives an int4; two different series keys that happen to collide
  // only cost each other a little waiting, never correctness.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [key]);
}

/**
 * Serialises everything that reads a flat's open balances and then writes
 * against them: receipts, credit notes, cancellations.
 *
 * The receipt-number lock did not do this. It is scoped to the month of the
 * receipt, so two receipts for the same flat dated in different months took
 * different locks, both read the same outstanding invoice, and both allocated
 * against it — leaving the receivable credit-side by the amount allocated
 * twice. This lock is scoped to the flat, whatever the date.
 *
 * Taken FIRST, before any series lock, by every caller; see the ordering note
 * at the top of this file.
 */
export async function lockFlatBalance(
  tx: Queryable,
  input: { societyId: string; flatId: string },
): Promise<void> {
  await lockSeries(tx, { societyId: input.societyId, kind: 'flat-balance', scope: input.flatId });
}

/**
 * The next number in a series, with the series locked first.
 *
 * `read` is given the lock and returns the number to use; it is expected to
 * compute it from what is already in the table, so a rolled-back transaction
 * leaves no gap.
 */
export async function allocateNumber(
  tx: Queryable,
  input: { societyId: string; kind: SeriesKind; scope?: string },
  read: () => Promise<string>,
): Promise<string> {
  await lockSeries(tx, input);
  return read();
}
