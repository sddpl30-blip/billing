/**
 * Applying what a member paid ahead against what they now owe.
 *
 * An advance sits as a credit on the member-advance control account — from an
 * overpaid receipt, a credit note beyond what was outstanding, or an opening
 * advance brought forward at cut-over. When a bill is raised it is set against
 * that bill here, oldest invoice first, by the same rule the browser engine's
 * `applyAdvance` follows: debit the advance, credit the receivable per
 * invoice, so the invoice reads as paid by the same derivation a receipt
 * leaves.
 */

import type { Queryable } from './pg';
import { A, accountBalance, outstandingDocuments, postEntry, type Leg } from './posting';
import { lockFlatBalance } from './series';

export interface AdvanceApplication {
  readonly flatNo: string;
  readonly appliedPaise: number;
  readonly entryId: string | null;
  readonly allocations: ReadonlyArray<{ taxInvoiceNo: string; amount: number }>;
}

/**
 * Applies one flat's advance, as at `on`, to its open invoices. Takes the
 * flat's balance lock itself, so a receipt cannot spend the same dues at the
 * same moment. Returns a zero application when there is nothing to do.
 */
export async function applyAdvance(
  tx: Queryable,
  input: {
    societyId: string; flatId: string; flatNo: string; on: string;
    postedBy: string | null; postedByLabel: string;
  },
): Promise<AdvanceApplication> {
  await lockFlatBalance(tx, { societyId: input.societyId, flatId: input.flatId });
  const advance = await accountBalance(tx, {
    societyId: input.societyId, code: A.MEMBER_ADVANCE, party: input.flatNo, asAt: input.on,
  });
  const none = { flatNo: input.flatNo, appliedPaise: 0, entryId: null, allocations: [] };
  if (advance <= 0) return none;

  const open = await outstandingDocuments(tx, {
    societyId: input.societyId, flatId: input.flatId, asAt: input.on,
  });
  const allocations: Array<{ taxInvoiceNo: string; amount: number }> = [];
  let left = advance;
  for (const doc of open) {
    if (left === 0) break;
    const amount = Math.min(doc.outstanding, left);
    allocations.push({ taxInvoiceNo: doc.taxInvoiceNo, amount });
    left -= amount;
  }
  const applied = advance - left;
  if (applied === 0) return none;

  // Keyed on what was settled and the day, so repeating the call the same day
  // after nothing has changed is refused by the idempotency key rather than
  // applying twice — and once something has changed, the key changes too.
  const ref = `ADV/${input.flatNo}/${input.on}/${allocations.map(a => `${a.taxInvoiceNo}:${a.amount}`).join('+')}`;
  const legs: Leg[] = [
    {
      accountCode: A.MEMBER_ADVANCE, debit: applied, credit: 0, party: input.flatNo,
      docRef: allocations[0].taxInvoiceNo, memo: 'Advance applied',
    },
    ...allocations.map(a => ({
      accountCode: A.MAINTENANCE_RECEIVABLE, debit: 0, credit: a.amount, party: input.flatNo,
      docRef: a.taxInvoiceNo, memo: `Advance applied against ${a.taxInvoiceNo}`,
    })),
  ];
  const entryId = await postEntry(tx, {
    societyId: input.societyId,
    entryDate: input.on,
    narration:
      `Advance applied — flat ${input.flatNo} against ${allocations.map(a => a.taxInvoiceNo).join(', ')}`,
    sourceKind: 'advance-adjustment',
    sourceRef: allocations.map(a => a.taxInvoiceNo).join(','),
    idempotencyKey: `advance-apply:${ref}`.slice(0, 500),
    postedBy: input.postedBy,
    postedByLabel: input.postedByLabel,
    legs,
  });
  if (entryId === null) return none;
  return { flatNo: input.flatNo, appliedPaise: applied, entryId, allocations };
}

/** Every flat holding an advance as at `on`, for applying them all at once. */
export async function flatsWithAdvances(
  tx: Queryable, societyId: string, on: string,
): Promise<Array<{ flatId: string; flatNo: string }>> {
  const result = await tx.query<{ id: string; flat_no: string }>(
    `SELECT f.id, f.flat_no
       FROM flats f
      WHERE f.society_id = $1
        AND (SELECT COALESCE(SUM(p.credit - p.debit), 0)
               FROM journal_postings p JOIN journal_entries e ON e.id = p.entry_id
              WHERE p.society_id = f.society_id AND p.account_code = $2 AND p.party = f.flat_no
                AND e.entry_date <= $3::date) > 0
      ORDER BY f.flat_no`,
    [societyId, A.MEMBER_ADVANCE, on],
  );
  return result.rows.map(r => ({ flatId: r.id, flatNo: r.flat_no }));
}
