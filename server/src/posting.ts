/**
 * Posting to the ledger, in the database.
 *
 * The accounting engine in src/accounting is reused, not reimplemented: the
 * rupee arithmetic, the GST split, the per-square-foot charge and the
 * allocation rules all come from it. What is different here is where the
 * result goes — one atomic database transaction instead of an in-memory
 * ledger — and where outstanding balances are read from, which has to be SQL
 * because the engine's `Ledger` holds everything in memory and a server cannot.
 *
 * What that reuse buys, concretely: `gstOnContribution` applies the per-member
 * threshold and computes CGST and SGST as equal halves; `percentOf` rounds
 * half-up to the paisa; `areaCharge` refuses an unapproved rate and a basis
 * mismatch. None of that is rewritten below, and the checks covering it in
 * the engine's suites still apply.
 */

import { formatRupees } from '../../src/accounting/money';
import { areaCharge, type AreaBasis, type MaintenanceRate } from '../../src/accounting/rates';
import { gstOnContribution } from '../../src/accounting/transactions';
import type { Queryable } from './pg';
import { allocateNumber } from './series';
import { HttpError, badRequest, conflict } from './http';
import { fundTreatment } from './settings';

/** Account codes, matching the engine's chart. */
export const A = {
  BANK_OPERATING: '1000',
  MAINTENANCE_RECEIVABLE: '1100',
  VENDOR_PAYABLE: '2000',
  TDS_194C: '2100',
  TDS_194J: '2101',
  TDS_194I: '2102',
  CGST_OUTPUT: '2200',
  SGST_OUTPUT: '2201',
  MEMBER_ADVANCE: '2300',
  SINKING_FUND: '3000',
  FESTIVAL_FUND: '3010',
  GENERAL_RESERVE: '3020',
  INC_MAINTENANCE: '4000',
  INC_SINKING_CONTRIBUTION: '4010',
  INC_FESTIVAL: '4020',
  INC_RENTAL: '4030',
  INC_REIMBURSEMENT: '4040',
  INC_OTHER: '4050',
  INC_LATE_INTEREST: '4060',
} as const;

export interface Leg {
  readonly accountCode: string;
  readonly debit: number;
  readonly credit: number;
  readonly party?: string;
  readonly docRef?: string;
  readonly memo?: string;
}

export interface EntryInput {
  readonly societyId: string;
  readonly entryDate: string;
  readonly narration: string;
  readonly sourceKind: string;
  readonly sourceRef?: string;
  readonly idempotencyKey: string;
  readonly postedBy: string | null;
  readonly postedByLabel: string;
  readonly legs: readonly Leg[];
}

export class PostingError extends Error {}

/**
 * Writes one journal entry and its legs.
 *
 * Checks the entry balances before going near the database so the caller gets
 * a clear message, and the database checks it again at COMMIT through a
 * deferred trigger — which is the check that matters, because it also catches
 * anything that bypasses this function.
 *
 * Returns null when the idempotency key has already been used, rather than
 * throwing: a retried request should be a no-op, not an error.
 */
export async function postEntry(tx: Queryable, input: EntryInput): Promise<string | null> {
  if (input.legs.length < 2) {
    throw new PostingError(
      `"${input.narration}" has ${input.legs.length} leg(s); a double-entry transaction needs two.`,
    );
  }

  let debits = 0;
  let credits = 0;
  for (const leg of input.legs) {
    if (!Number.isInteger(leg.debit) || !Number.isInteger(leg.credit)) {
      throw new PostingError('Amounts must be whole paise.');
    }
    if (leg.debit < 0 || leg.credit < 0) {
      throw new PostingError('A leg cannot be negative; reverse the entry instead.');
    }
    if ((leg.debit === 0) === (leg.credit === 0)) {
      throw new PostingError('A leg is either a debit or a credit, and must move something.');
    }
    debits += leg.debit;
    credits += leg.credit;
  }
  if (debits !== credits) {
    throw new PostingError(
      `"${input.narration}" does not balance: ${debits} debit against ${credits} credit ` +
      `(out by ${debits - credits} paise).`,
    );
  }

  // The idempotency check and the insert are in the caller's transaction, so
  // two concurrent requests cannot both pass it: the unique index decides, and
  // the loser's whole transaction rolls back.
  const existing = await tx.query<{ id: string }>(
    'SELECT id FROM journal_entries WHERE society_id = $1 AND idempotency_key = $2',
    [input.societyId, input.idempotencyKey],
  );
  if (existing.rows[0] !== undefined) return null;

  // The entry reference. Locked first, because two transactions that both
  // count the entries get the same number and the second loses on the unique
  // index — which is what happened to seven of eight concurrent payments
  // before this existed. Taken last of any locks a caller holds; see series.ts
  // on the ordering.
  const ref = await allocateNumber(
    tx,
    { societyId: input.societyId, kind: 'entry-ref' },
    async () => {
      const result = await tx.query<{ next: string }>(
        `SELECT 'JE' || lpad((count(*) + 1)::text, 8, '0') AS next
           FROM journal_entries WHERE society_id = $1`,
        [input.societyId],
      );
      return result.rows[0].next;
    },
  );

  const entry = await tx.query<{ id: string }>(
    `INSERT INTO journal_entries
       (society_id, entry_ref, entry_date, narration, source_kind, source_ref,
        idempotency_key, posted_by, posted_by_label, total_debit, total_credit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     RETURNING id`,
    [
      input.societyId, ref, input.entryDate, input.narration,
      input.sourceKind, input.sourceRef ?? null, input.idempotencyKey,
      input.postedBy, input.postedByLabel, debits,
    ],
  );
  const entryId = entry.rows[0].id;

  for (const leg of input.legs) {
    await tx.query(
      `INSERT INTO journal_postings
         (entry_id, society_id, account_code, debit, credit, party, doc_ref, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        entryId, input.societyId, leg.accountCode, leg.debit, leg.credit,
        leg.party ?? null, leg.docRef ?? null, leg.memo ?? null,
      ],
    );
  }

  return entryId;
}

/** Reverses an entry by posting its mirror. The original is never removed. */
export async function reverseEntry(
  tx: Queryable,
  input: {
    societyId: string; entryId: string; date: string; reason: string;
    postedBy: string | null; postedByLabel: string;
  },
): Promise<string> {
  const original = await tx.query<{ id: string; narration: string; reversed_by: string | null }>(
    'SELECT id, narration, reversed_by FROM journal_entries WHERE id = $1 AND society_id = $2',
    [input.entryId, input.societyId],
  );
  const row = original.rows[0];
  if (row === undefined) throw badRequest(`No journal entry ${input.entryId}.`);
  if (row.reversed_by !== null) {
    throw conflict(`That entry was already reversed by ${row.reversed_by}.`);
  }

  const legs = await tx.query<{
    account_code: string; debit: string; credit: string;
    party: string | null; doc_ref: string | null; memo: string | null;
  }>(
    'SELECT account_code, debit, credit, party, doc_ref, memo FROM journal_postings WHERE entry_id = $1',
    [input.entryId],
  );

  const mirrored: Leg[] = legs.rows.map(l => ({
    accountCode: l.account_code,
    debit: Number(l.credit),
    credit: Number(l.debit),
    ...(l.party !== null ? { party: l.party } : {}),
    ...(l.doc_ref !== null ? { docRef: l.doc_ref } : {}),
    ...(l.memo !== null ? { memo: l.memo } : {}),
  }));

  const reversalId = await postEntry(tx, {
    societyId: input.societyId,
    entryDate: input.date,
    narration: `Reversal of ${row.narration}: ${input.reason}`,
    sourceKind: 'reversal',
    sourceRef: input.entryId,
    idempotencyKey: `reversal:${input.entryId}`,
    postedBy: input.postedBy,
    postedByLabel: input.postedByLabel,
    legs: mirrored,
  });
  if (reversalId === null) throw conflict('A reversal for that entry already exists.');

  await tx.query('UPDATE journal_entries SET reversed_by = $1 WHERE id = $2', [reversalId, input.entryId]);
  await tx.query('UPDATE journal_entries SET reversal_of = $1 WHERE id = $2', [input.entryId, reversalId]);
  return reversalId;
}

// --- reading balances ------------------------------------------------------

/** The signed balance of an account, positive on its normal side. */
export async function accountBalance(
  tx: Queryable,
  input: { societyId: string; code: string; party?: string; docRef?: string; asAt?: string },
): Promise<number> {
  const conditions = ['p.society_id = $1', 'p.account_code = $2'];
  const params: Array<string | number | null> = [input.societyId, input.code];
  if (input.party !== undefined) {
    params.push(input.party);
    conditions.push(`p.party = $${params.length}`);
  }
  if (input.docRef !== undefined) {
    params.push(input.docRef);
    conditions.push(`p.doc_ref = $${params.length}`);
  }
  if (input.asAt !== undefined) {
    params.push(input.asAt);
    conditions.push(`e.entry_date <= $${params.length}`);
  }

  // The sign follows the account's class, so a caller never has to remember
  // which way round a liability goes.
  const result = await tx.query<{ balance: string | null }>(
    `SELECT COALESCE(SUM(
              CASE WHEN a.class IN ('asset','expenditure')
                   THEN p.debit - p.credit
                   ELSE p.credit - p.debit END
            ), 0) AS balance
       FROM journal_postings p
       JOIN journal_entries e ON e.id = p.entry_id
       JOIN accounts a ON a.society_id = p.society_id AND a.code = p.account_code
      WHERE ${conditions.join(' AND ')}`,
    params,
  );
  return Number(result.rows[0]?.balance ?? '0');
}

export interface OutstandingDocument {
  readonly documentId: string;
  readonly taxInvoiceNo: string;
  readonly outstanding: number;
  readonly gross: number;
  readonly issuedOn: string;
  readonly dueOn: string;
}

/**
 * A flat's open invoices, oldest first.
 *
 * This is the part the engine cannot supply from a database: its allocation
 * planner reads an in-memory ledger. The ordering rule is the engine's —
 * oldest raised first — and the arithmetic below is a sum, not a
 * reimplementation of allocation.
 */
export async function outstandingDocuments(
  tx: Queryable,
  input: { societyId: string; flatId: string; asAt?: string },
): Promise<OutstandingDocument[]> {
  const result = await tx.query<{
    id: string; tax_invoice_no: string; gross: string; issued_on: string;
    due_on: string; outstanding: string;
  }>(
    `SELECT d.id, d.tax_invoice_no, d.gross::text, d.issued_on::text, d.due_on::text,
            COALESCE((
              SELECT SUM(p.debit - p.credit)
                FROM journal_postings p
                JOIN journal_entries e ON e.id = p.entry_id
               WHERE p.society_id = d.society_id
                 AND p.account_code = $3
                 AND p.doc_ref = d.tax_invoice_no
                 AND ($4::date IS NULL OR e.entry_date <= $4::date)
            ), 0)::text AS outstanding
       FROM billing_documents d
      WHERE d.society_id = $1
        AND d.flat_id = $2
        AND d.state = 'tax-invoice'
      ORDER BY d.issued_on, d.proforma_no`,
    [input.societyId, input.flatId, A.MAINTENANCE_RECEIVABLE, input.asAt ?? null],
  );

  return result.rows
    .map(r => ({
      documentId: r.id,
      taxInvoiceNo: r.tax_invoice_no,
      outstanding: Number(r.outstanding),
      gross: Number(r.gross),
      issuedOn: r.issued_on,
      dueOn: r.due_on,
    }))
    .filter(d => d.outstanding > 0);
}

// --- business transactions -------------------------------------------------

export interface BillLine {
  readonly head: 'maintenance' | 'sinking' | 'festival' | 'rental' | 'reimbursement' | 'other';
  readonly amount: number;
  readonly taxable: boolean;
}

/**
 * The account a bill line is credited to.
 *
 * The two fund heads follow the society's treatment, exactly as the engine's
 * `billMaintenance` follows `sinkingFundThroughIncome`: credited to the fund
 * directly (3000, 3010) by default, or to income (4010, 4020) to be
 * appropriated later when the society has chosen that. The server used to
 * hard-code the sinking fund to the fund and festival collections to income
 * — the one combination the engine never produces — so the same bill gave a
 * different surplus depending on which side of the application posted it.
 */
export function creditAccountForHead(head: BillLine['head'], throughIncome: boolean): string {
  switch (head) {
    case 'maintenance': return A.INC_MAINTENANCE;
    case 'sinking': return throughIncome ? A.INC_SINKING_CONTRIBUTION : A.SINKING_FUND;
    case 'festival': return throughIncome ? A.INC_FESTIVAL : A.FESTIVAL_FUND;
    case 'rental': return A.INC_RENTAL;
    case 'reimbursement': return A.INC_REIMBURSEMENT;
    case 'other': return A.INC_OTHER;
  }
}

export interface GstTreatment {
  readonly chargeGst: boolean;
  readonly ratePercent: number;
  /** Whether a CA has signed the treatment off. Unapproved refuses to post. */
  readonly approved: boolean;
  /**
   * The per-member monthly exemption, in paise: a member whose taxable
   * contribution for the month is at or below it is not charged GST at all.
   */
  readonly memberThresholdPaise: number;
  /**
   * Whether the sinking-fund line carries GST at the maintenance rate. Read
   * when a proforma's lines are built — the line's own `taxable` flag is what
   * conversion taxes — and the threshold then applies to maintenance plus
   * sinking fund, because both are taxable lines. False unless set.
   */
  readonly sinkingFundTaxable: boolean;
  /**
   * Whether CGST and SGST are each rounded to the nearest rupee, half up, per
   * invoice (and per credit or debit note). False unless set: to the paisa.
   */
  readonly roundToRupee: boolean;
}

/**
 * Computes a bill's tax using the engine's own rule.
 *
 * `gstOnContribution` is the one place both engines apply the per-member
 * threshold — nothing at or below it, the whole taxable value above it — and
 * compute CGST and SGST as equal halves at half the rate each, so an invoice
 * printing "CGST @ 9%" and "SGST @ 9%" never shows two amounts a paisa apart.
 */
export function computeBillTax(
  lines: readonly BillLine[],
  gst: GstTreatment,
): { taxableValue: number; cgst: number; sgst: number; total: number } {
  if (!gst.chargeGst) return { taxableValue: 0, cgst: 0, sgst: 0, total: 0 };
  const taxable = lines.filter(l => l.taxable).reduce((sum, l) => sum + l.amount, 0);
  return gstOnContribution(taxable, {
    ratePercent: gst.ratePercent,
    thresholdPaise: gst.memberThresholdPaise,
    roundToRupee: gst.roundToRupee,
  });
}

/**
 * The year a date's Indian financial year starts in: 2026 for any date from
 * 1 April 2026 to 31 March 2027.
 */
export function financialYearStart(isoDate: string): number {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  return month >= 4 ? year : year - 1;
}

/** The maintenance charge for a flat, from the engine's `areaCharge`. */
export function computeMaintenance(
  flat: { flatNo: string; billingAreaSqFt: number; areaBasis: AreaBasis },
  rate: MaintenanceRate,
): number {
  return areaCharge(flat, rate).amount;
}

export interface ConvertResult {
  readonly taxInvoiceNo: string;
  readonly entryId: string;
  readonly gross: number;
  readonly cgst: number;
  readonly sgst: number;
}

/**
 * Converts a proforma to a tax invoice and posts it.
 *
 * This is where the receivable and the GST arise. Everything happens in the
 * caller's transaction, so a failure anywhere leaves neither a document in the
 * wrong state nor a half-written entry.
 */
export async function convertToTaxInvoice(
  tx: Queryable,
  input: {
    societyId: string; documentId: string; on: string;
    because: 'payment-received' | 'due-date-reached' | 'manual';
    postedBy: string | null; postedByLabel: string;
    gst: GstTreatment; invoicePrefix: string;
  },
): Promise<ConvertResult> {
  const found = await tx.query<{
    id: string; proforma_no: string; flat_id: string; flat_no: string; period: string;
    state: string; issued_on: string; approved_by: string | null;
  }>(
    `SELECT d.id, d.proforma_no, d.flat_id, f.flat_no, d.period, d.state,
            d.issued_on::text, d.approved_by
       FROM billing_documents d
       JOIN flats f ON f.id = d.flat_id
      WHERE d.id = $1 AND d.society_id = $2`,
    [input.documentId, input.societyId],
  );
  const doc = found.rows[0];
  if (doc === undefined) throw badRequest('No such billing document.');
  if (doc.state === 'tax-invoice') throw conflict('That document is already a tax invoice.');
  if (doc.state === 'cancelled') throw conflict('That document was cancelled.');
  if (doc.approved_by === null) {
    throw conflict(
      'That proforma has not been approved. A tax invoice cannot be issued from an ' +
      'unapproved document.',
    );
  }
  if (input.on < doc.issued_on) {
    throw badRequest(`A tax invoice cannot be dated ${input.on}, before the proforma's ${doc.issued_on}.`);
  }
  if (!input.gst.approved && input.gst.chargeGst) {
    throw conflict(
      'The GST treatment for this society has not been confirmed, so an invoice charging ' +
      'GST cannot be issued. Record the CA sign-off against the setting first.',
    );
  }

  const lineRows = await tx.query<{ head: string; amount: string; taxable: string }>(
    'SELECT head, amount::text, taxable::text FROM billing_document_lines WHERE document_id = $1 ORDER BY position',
    [input.documentId],
  );
  if (lineRows.rows.length === 0) throw badRequest('That document has no lines.');

  const lines: BillLine[] = lineRows.rows.map(r => ({
    head: r.head as BillLine['head'],
    amount: Number(r.amount),
    taxable: r.taxable === 't' || r.taxable === 'true',
  }));

  const tax = computeBillTax(lines, input.gst);
  const net = lines.reduce((sum, l) => sum + l.amount, 0);
  const gross = net + tax.total;
  const throughIncome = await fundTreatment(tx, input.societyId);

  // The series is per financial year and allocated inside the transaction, so
  // two concurrent conversions cannot take the same number: the unique index
  // on (society, tax_invoice_no) is the backstop.
  //
  // The FINANCIAL year — April to March — named by the year it starts in.
  // This was the calendar year of the invoice date, so the series restarted at
  // 00001 every 1 January, three months into the year a return covers, and an
  // invoice dated February 2027 sat in a "2027" series alongside nothing else
  // from its own financial year.
  const year = String(financialYearStart(input.on));
  // Locked for this society and year, so two conversions cannot take the same
  // number. Gapless numbering is the requirement — a tax invoice series with
  // 00007 missing is a question from an auditor — so this serialises rather
  // than using a sequence, which would not roll back.
  const taxInvoiceNo = await allocateNumber(
    tx,
    { societyId: input.societyId, kind: 'tax-invoice', scope: year },
    async () => {
      const sequence = await tx.query<{ next: string }>(
        `SELECT COALESCE(MAX(
                  NULLIF(regexp_replace(tax_invoice_no, '^.*/', ''), '')::int
                ), 0) + 1 AS next
           FROM billing_documents
          WHERE society_id = $1 AND tax_invoice_no LIKE $2`,
        [input.societyId, `${input.invoicePrefix}/${year}/%`],
      );
      return `${input.invoicePrefix}/${year}/${String(sequence.rows[0].next).padStart(5, '0')}`;
    },
  );

  const legs: Leg[] = [
    {
      accountCode: A.MAINTENANCE_RECEIVABLE,
      debit: gross,
      credit: 0,
      party: doc.flat_no,
      docRef: taxInvoiceNo,
      memo: `${taxInvoiceNo} ${doc.period}`,
    },
  ];
  for (const line of lines) {
    legs.push({
      accountCode: creditAccountForHead(line.head, throughIncome),
      debit: 0,
      credit: line.amount,
      docRef: taxInvoiceNo,
      memo: line.head,
    });
  }
  if (tax.cgst > 0) legs.push({ accountCode: A.CGST_OUTPUT, debit: 0, credit: tax.cgst, docRef: taxInvoiceNo });
  if (tax.sgst > 0) legs.push({ accountCode: A.SGST_OUTPUT, debit: 0, credit: tax.sgst, docRef: taxInvoiceNo });

  const entryId = await postEntry(tx, {
    societyId: input.societyId,
    entryDate: input.on,
    narration: `Tax invoice ${taxInvoiceNo} — flat ${doc.flat_no}, ${doc.period}`,
    sourceKind: 'maintenance-billing',
    sourceRef: taxInvoiceNo,
    // Keyed on the document, not on the flat and period. A cancelled
    // invoice's entry is reversed but its idempotency key stays used for
    // ever, so a flat-and-period key meant a cancelled July invoice could
    // never be replaced: the new document's conversion was refused as a
    // duplicate of the one that had been reversed. One live document per flat
    // and period is the unique index's job, and it frees the slot on
    // cancellation; this key only has to stop one document posting twice.
    idempotencyKey: `bill:doc:${doc.id}`,
    postedBy: input.postedBy,
    postedByLabel: input.postedByLabel,
    legs,
  });
  if (entryId === null) {
    throw conflict(`A billing entry already exists for ${doc.proforma_no} (flat ${doc.flat_no}, ${doc.period}).`);
  }

  await tx.query(
    `UPDATE billing_documents
        SET state = 'tax-invoice', tax_invoice_no = $1, converted_on = $2,
            converted_because = $3, posted_entry_id = $4, gross = $5, estimated_tax = $6
      WHERE id = $7`,
    [taxInvoiceNo, input.on, input.because, entryId, gross, tax.total, input.documentId],
  );

  // The GST register, which GSTR-1 is built from. B2C unless the member has
  // supplied a GSTIN, which this schema does not yet capture per flat.
  if (tax.total > 0) {
    await tx.query(
      `INSERT INTO gst_register
         (society_id, document_id, tax_period, invoice_no, invoice_date, counterparty,
          supply_type, taxable_value, cgst, sgst, rate_bps)
       VALUES ($1,$2,$3,$4,$5,$6,'B2C',$7,$8,$9,$10)`,
      [
        input.societyId, input.documentId, input.on.slice(0, 7), taxInvoiceNo,
        input.on, doc.flat_no, tax.taxableValue, tax.cgst, tax.sgst,
        Math.round(input.gst.ratePercent * 100),
      ],
    );
  }

  return { taxInvoiceNo, entryId, gross, cgst: tax.cgst, sgst: tax.sgst };
}

export interface ReceiptResult {
  readonly paymentId: string;
  readonly receiptNo: string;
  readonly entryId: string;
  readonly appliedToDues: number;
  readonly heldAsAdvance: number;
  readonly allocations: ReadonlyArray<{ documentId: string; taxInvoiceNo: string; amount: number }>;
  /** Proformas this payment turned into tax invoices before it was allocated. */
  readonly converted: ReadonlyArray<{ documentId: string; taxInvoiceNo: string; gross: number }>;
}

/**
 * Records a member receipt, allocated oldest invoice first.
 *
 * Anything beyond the outstanding dues is credited to member advances rather
 * than left to push the receivable credit-side. The allocation rows and the
 * journal entry go in together, and a deferred trigger checks at COMMIT that
 * the allocations add up to the payment.
 *
 * A payment for a bill still at proforma stage converts that proforma first,
 * as the browser's register does: the member has paid for the supply, so the
 * tax invoice is due (GST's time of supply is the earlier of payment and the
 * due date), and only a tax invoice carries a receivable to allocate against.
 * Before this, the whole payment went to advances and stayed there — the
 * proforma later converted on its due date and read as unpaid and overdue
 * while the member's money sat beside it. With `againstDocumentId` that one
 * document is converted (and refused clearly if it is not approved); without
 * it, approved proformas issued on or before the receipt are converted
 * oldest first, for as long as the payment exceeds what is already due.
 *
 * The caller must hold the flat's balance lock (`lockFlatBalance`) before
 * calling: the allocation is computed from balances read here, and two
 * receipts for one flat reading them at once both spend the same dues.
 */
export async function recordReceipt(
  tx: Queryable,
  input: {
    societyId: string; flatId: string; flatNo: string; amount: number;
    receivedOn: string; method: string; receiptNo: string; idempotencyKey: string;
    bankAccountId: string | null; instrumentRef: string | null;
    postedBy: string | null; postedByLabel: string;
    /** Settle one named invoice rather than the oldest open ones. */
    againstDocumentId?: string;
    /**
     * What converting a proforma needs. Absent, nothing is converted and the
     * receipt is allocated against tax invoices only.
     */
    conversion?: { gst: GstTreatment; invoicePrefix: string };
  },
): Promise<ReceiptResult> {
  const already = await tx.query<{ id: string; receipt_no: string }>(
    'SELECT id, receipt_no FROM payments WHERE society_id = $1 AND idempotency_key = $2',
    [input.societyId, input.idempotencyKey],
  );
  if (already.rows[0] !== undefined) {
    throw conflict(
      `That payment was already recorded as receipt ${already.rows[0].receipt_no}. ` +
      `Re-sending the same Idempotency-Key does not take the money twice.`,
    );
  }

  const converted: Array<{ documentId: string; taxInvoiceNo: string; gross: number }> = [];
  if (input.conversion !== undefined) {
    const due = (await outstandingDocuments(tx, {
      societyId: input.societyId, flatId: input.flatId, asAt: input.receivedOn,
    })).reduce((sum, d) => sum + d.outstanding, 0);
    let spare = input.amount - due;

    const candidates = await tx.query<{ id: string; state: string; issued_on: string }>(
      `SELECT id, state, issued_on::text FROM billing_documents
        WHERE society_id = $1 AND flat_id = $2
          AND state IN ('draft', 'approved', 'released')
          AND ($3::uuid IS NULL OR id = $3::uuid)
        ORDER BY issued_on, proforma_no`,
      [input.societyId, input.flatId, input.againstDocumentId ?? null],
    );
    for (const candidate of candidates.rows) {
      if (input.againstDocumentId === undefined) {
        if (spare <= 0) break;
        // Unprompted, only what could be converted anyway: an approved
        // proforma already issued. A draft stays a draft and the money waits
        // as an advance, which is visible, rather than a tax invoice being
        // issued from a bill nobody has approved.
        if (candidate.state === 'draft' || candidate.issued_on > input.receivedOn) continue;
      }
      // Named explicitly, a draft or a future-dated proforma is refused here
      // by convertToTaxInvoice with its own reason, which is the answer the
      // person recording the payment needs.
      const result = await convertToTaxInvoice(tx, {
        societyId: input.societyId,
        documentId: candidate.id,
        on: input.receivedOn,
        because: 'payment-received',
        postedBy: input.postedBy,
        postedByLabel: input.postedByLabel,
        gst: input.conversion.gst,
        invoicePrefix: input.conversion.invoicePrefix,
      });
      converted.push({ documentId: candidate.id, taxInvoiceNo: result.taxInvoiceNo, gross: result.gross });
      spare -= result.gross;
    }
  }

  let open = await outstandingDocuments(tx, {
    societyId: input.societyId, flatId: input.flatId, asAt: input.receivedOn,
  });
  if (input.againstDocumentId !== undefined) {
    open = open.filter(d => d.documentId === input.againstDocumentId);
    if (open.length === 0) {
      throw badRequest('That invoice has nothing outstanding against it.');
    }
  }

  const allocations: Array<{ documentId: string; taxInvoiceNo: string; amount: number }> = [];
  let left = input.amount;
  for (const doc of open) {
    if (left === 0) break;
    const applied = Math.min(doc.outstanding, left);
    if (applied > 0) {
      allocations.push({ documentId: doc.documentId, taxInvoiceNo: doc.taxInvoiceNo, amount: applied });
      left -= applied;
    }
  }
  const appliedToDues = allocations.reduce((sum, a) => sum + a.amount, 0);
  const heldAsAdvance = left;

  const bank = input.bankAccountId === null
    ? A.BANK_OPERATING
    : (await tx.query<{ ledger_account: string }>(
        'SELECT ledger_account FROM bank_accounts WHERE id = $1 AND society_id = $2',
        [input.bankAccountId, input.societyId],
      )).rows[0]?.ledger_account ?? A.BANK_OPERATING;

  const legs: Leg[] = [
    { accountCode: bank, debit: input.amount, credit: 0, docRef: input.receiptNo, memo: input.method },
  ];
  for (const a of allocations) {
    legs.push({
      accountCode: A.MAINTENANCE_RECEIVABLE,
      debit: 0,
      credit: a.amount,
      party: input.flatNo,
      docRef: a.taxInvoiceNo,
      memo: `${input.receiptNo} against ${a.taxInvoiceNo}`,
    });
  }
  if (heldAsAdvance > 0) {
    legs.push({
      accountCode: A.MEMBER_ADVANCE,
      debit: 0,
      credit: heldAsAdvance,
      party: input.flatNo,
      docRef: input.receiptNo,
      memo: `Advance on ${input.receiptNo}`,
    });
  }

  const entryId = await postEntry(tx, {
    societyId: input.societyId,
    entryDate: input.receivedOn,
    narration:
      `Receipt ${input.receiptNo} — flat ${input.flatNo} via ${input.method}` +
      (allocations.length > 0 ? ` against ${allocations.map(a => a.taxInvoiceNo).join(', ')}` : '') +
      (heldAsAdvance > 0 ? ` (${formatRupees(heldAsAdvance)} held as advance)` : ''),
    sourceKind: 'member-receipt',
    sourceRef: input.receiptNo,
    idempotencyKey: `receipt:${input.receiptNo}`,
    postedBy: input.postedBy,
    postedByLabel: input.postedByLabel,
    legs,
  });
  if (entryId === null) throw conflict(`Receipt ${input.receiptNo} has already been posted.`);

  const payment = await tx.query<{ id: string }>(
    `INSERT INTO payments
       (society_id, receipt_no, flat_id, received_on, amount, method, instrument_ref,
        bank_account_id, posted_entry_id, idempotency_key, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      input.societyId, input.receiptNo, input.flatId, input.receivedOn, input.amount,
      input.method, input.instrumentRef, input.bankAccountId, entryId,
      input.idempotencyKey, input.postedBy,
    ],
  );
  const paymentId = payment.rows[0].id;

  for (const a of allocations) {
    await tx.query(
      'INSERT INTO receipt_allocations (payment_id, document_id, amount, head) VALUES ($1,$2,$3,$4)',
      [paymentId, a.documentId, a.amount, 'maintenance'],
    );
  }
  if (heldAsAdvance > 0) {
    // A null document is the advance slice. The deferred trigger requires the
    // allocations to add up to the payment, so this row is not optional.
    await tx.query(
      'INSERT INTO receipt_allocations (payment_id, document_id, amount) VALUES ($1, NULL, $2)',
      [paymentId, heldAsAdvance],
    );
  }

  return {
    paymentId, receiptNo: input.receiptNo, entryId, appliedToDues, heldAsAdvance, allocations,
    converted,
  };
}

const TDS_ACCOUNT: Record<string, string> = {
  '194C': A.TDS_194C, '194J': A.TDS_194J, '194I': A.TDS_194I,
};

/**
 * Books a vendor bill: expense at gross, payable net of tax, TDS withheld.
 *
 * Does not touch the bank. Paying is a separate call, which is the separation
 * the earlier demo collapsed.
 */
export async function bookVendorBill(
  tx: Queryable,
  input: {
    societyId: string; billId: string; postedBy: string | null; postedByLabel: string;
    on: string;
  },
): Promise<string> {
  const found = await tx.query<{
    id: string; vendor_id: string; vendor_name: string; bill_no: string;
    expense_account: string; gross: string; input_gst: string;
    tds_section: string; tds_amount: string; tds_rate_bps: string; net_payable: string;
    state: string; approved_by: string | null;
  }>(
    `SELECT b.id, b.vendor_id, v.name AS vendor_name, b.bill_no, b.expense_account,
            b.gross::text, b.input_gst::text, b.tds_section, b.tds_amount::text,
            b.tds_rate_bps::text, b.net_payable::text, b.state, b.approved_by
       FROM vendor_bills b JOIN vendors v ON v.id = b.vendor_id
      WHERE b.id = $1 AND b.society_id = $2`,
    [input.billId, input.societyId],
  );
  const bill = found.rows[0];
  if (bill === undefined) throw badRequest('No such vendor bill.');
  if (bill.state === 'booked') throw conflict('That bill is already booked.');
  if (bill.state === 'rejected') throw conflict('That bill was rejected.');
  if (bill.approved_by === null) throw conflict('That bill has not been approved.');

  const gross = Number(bill.gross);
  const inputGst = Number(bill.input_gst);
  const tds = Number(bill.tds_amount);
  const net = Number(bill.net_payable);

  const legs: Leg[] = [
    {
      accountCode: bill.expense_account,
      debit: gross - inputGst,
      credit: 0,
      docRef: bill.bill_no,
      memo: bill.bill_no,
    },
  ];
  if (inputGst > 0) {
    legs.push({ accountCode: '1400', debit: inputGst, credit: 0, docRef: bill.bill_no });
  }
  legs.push({
    accountCode: A.VENDOR_PAYABLE,
    debit: 0,
    credit: net,
    party: bill.vendor_id,
    docRef: bill.bill_no,
  });
  if (tds > 0) {
    const account = TDS_ACCOUNT[bill.tds_section];
    if (account === undefined) {
      throw badRequest(`TDS section ${bill.tds_section} has no liability account.`);
    }
    legs.push({
      accountCode: account,
      debit: 0,
      credit: tds,
      docRef: bill.bill_no,
      memo: `${bill.tds_section} on ${bill.bill_no}`,
    });
  }

  const entryId = await postEntry(tx, {
    societyId: input.societyId,
    entryDate: input.on,
    narration: `Vendor bill ${bill.bill_no} — ${bill.vendor_name}`,
    sourceKind: 'vendor-bill',
    sourceRef: bill.bill_no,
    idempotencyKey: `vendor-bill:${bill.vendor_id}:${bill.bill_no}`,
    postedBy: input.postedBy,
    postedByLabel: input.postedByLabel,
    legs,
  });
  if (entryId === null) throw conflict('That bill has already been posted.');

  await tx.query(
    `UPDATE vendor_bills SET state = 'booked', posted_entry_id = $1 WHERE id = $2`,
    [entryId, input.billId],
  );

  if (tds > 0) {
    const quarter = tdsQuarter(input.on);
    await tx.query(
      `INSERT INTO tds_register
         (society_id, bill_id, vendor_id, section, quarter, deducted_on, gross, rate_bps, tds_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        // The rate the bill was raised at, not a ratio recomputed from the
        // amounts: deriving it back out of tds/gross produces a fractional
        // basis-point figure whenever the deduction was rounded.
        //
        // The amount the deduction was made on, which is the bill less its
        // GST — what Form 26Q reports as paid or credited, and what tds/rate
        // has to agree with.
        input.societyId, input.billId, bill.vendor_id, bill.tds_section, quarter,
        input.on, gross - inputGst, Number(bill.tds_rate_bps), tds,
      ],
    );
  }

  return entryId;
}

/** 'Q2-FY26-27' for a date in the Indian financial year. */
export function tdsQuarter(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const fyStart = month >= 4 ? year : year - 1;
  const quarter = month >= 4 && month <= 6 ? 1
    : month >= 7 && month <= 9 ? 2
    : month >= 10 && month <= 12 ? 3
    : 4;
  const a = String(fyStart % 100).padStart(2, '0');
  const b = String((fyStart + 1) % 100).padStart(2, '0');
  return `Q${quarter}-FY${a}-${b}`;
}

/** Pays a booked vendor bill. The only call that moves the bank. */
export async function payVendor(
  tx: Queryable,
  input: {
    societyId: string; billId: string; amount: number; paidOn: string; method: string;
    paymentRef: string; idempotencyKey: string; bankAccountId: string | null;
    postedBy: string | null; postedByLabel: string;
  },
): Promise<string> {
  const already = await tx.query<{ payment_ref: string }>(
    'SELECT payment_ref FROM vendor_payments WHERE society_id = $1 AND idempotency_key = $2',
    [input.societyId, input.idempotencyKey],
  );
  if (already.rows[0] !== undefined) {
    throw conflict(`That payment was already recorded as ${already.rows[0].payment_ref}.`);
  }

  const found = await tx.query<{
    vendor_id: string; vendor_name: string; bill_no: string; state: string;
  }>(
    `SELECT b.vendor_id, v.name AS vendor_name, b.bill_no, b.state
       FROM vendor_bills b JOIN vendors v ON v.id = b.vendor_id
      WHERE b.id = $1 AND b.society_id = $2`,
    [input.billId, input.societyId],
  );
  const bill = found.rows[0];
  if (bill === undefined) throw badRequest('No such vendor bill.');
  if (bill.state !== 'booked') {
    throw conflict(
      `That bill is ${bill.state}. It has to be booked before it can be paid, because until ` +
      `then there is no payable to settle.`,
    );
  }

  const outstanding = await accountBalance(tx, {
    societyId: input.societyId, code: A.VENDOR_PAYABLE,
    party: bill.vendor_id, docRef: bill.bill_no,
  });
  if (input.amount > outstanding) {
    throw badRequest(
      `That payment of ${formatRupees(input.amount)} exceeds the ${formatRupees(outstanding)} outstanding on ` +
      `bill ${bill.bill_no}.`,
    );
  }

  const bank = input.bankAccountId === null
    ? A.BANK_OPERATING
    : (await tx.query<{ ledger_account: string }>(
        'SELECT ledger_account FROM bank_accounts WHERE id = $1 AND society_id = $2',
        [input.bankAccountId, input.societyId],
      )).rows[0]?.ledger_account ?? A.BANK_OPERATING;

  const entryId = await postEntry(tx, {
    societyId: input.societyId,
    entryDate: input.paidOn,
    narration: `Payment ${input.paymentRef} to ${bill.vendor_name} against ${bill.bill_no}`,
    sourceKind: 'vendor-payment',
    sourceRef: input.paymentRef,
    idempotencyKey: `vendor-payment:${input.paymentRef}`,
    postedBy: input.postedBy,
    postedByLabel: input.postedByLabel,
    legs: [
      {
        accountCode: A.VENDOR_PAYABLE, debit: input.amount, credit: 0,
        party: bill.vendor_id, docRef: bill.bill_no,
      },
      { accountCode: bank, debit: 0, credit: input.amount, docRef: input.paymentRef },
    ],
  });
  if (entryId === null) throw conflict('That payment reference has already been posted.');

  await tx.query(
    `INSERT INTO vendor_payments
       (society_id, vendor_id, bill_id, payment_ref, paid_on, amount, method,
        bank_account_id, posted_entry_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.societyId, bill.vendor_id, input.billId, input.paymentRef, input.paidOn,
      input.amount, input.method, input.bankAccountId, entryId, input.idempotencyKey,
    ],
  );
  return entryId;
}

void HttpError;

export interface TdsRemittance {
  readonly entryId: string;
  readonly section: string;
  readonly quarter: string;
  readonly amount: number;
  readonly deductions: number;
  readonly challanNo: string;
}

/**
 * Records a TDS remittance against a challan.
 *
 * Clears the withholding liability and moves the bank. The challan number is
 * the caller's — it comes from the bank's counterfoil after the payment has
 * actually been made. Nothing here reaches the income-tax portal: there is no
 * connection to one in this system, so this records a remittance that happened
 * elsewhere rather than performing one.
 */
export async function remitTds(
  tx: Queryable,
  input: {
    societyId: string; section: '194C' | '194J' | '194I'; quarter: string;
    challanNo: string; challanDate: string; idempotencyKey: string;
    bankAccountId: string | null;
    postedBy: string | null; postedByLabel: string;
  },
): Promise<TdsRemittance> {
  const open = await tx.query<{ id: string; tds_amount: string }>(
    `SELECT id, tds_amount::text FROM tds_register
      WHERE society_id = $1 AND section = $2 AND quarter = $3 AND challan_no IS NULL
      ORDER BY id
      FOR UPDATE`,
    [input.societyId, input.section, input.quarter],
  );
  if (open.rows.length === 0) {
    throw conflict(
      `Nothing is outstanding under ${input.section} for ${input.quarter}. ` +
      `Either it has been remitted already or nothing was deducted.`,
    );
  }

  const amount = open.rows.reduce((sum, r) => sum + Number(r.tds_amount), 0);
  const bank = input.bankAccountId === null
    ? A.BANK_OPERATING
    : (await tx.query<{ ledger_account: string }>(
        'SELECT ledger_account FROM bank_accounts WHERE id = $1 AND society_id = $2',
        [input.bankAccountId, input.societyId],
      )).rows[0]?.ledger_account ?? A.BANK_OPERATING;

  const liability = TDS_ACCOUNT[input.section];
  if (liability === undefined) throw badRequest(`No ledger account for section ${input.section}.`);

  const entryId = await postEntry(tx, {
    societyId: input.societyId,
    entryDate: input.challanDate,
    narration:
      `TDS ${input.section} remitted for ${input.quarter} — challan ${input.challanNo} ` +
      `(${open.rows.length} ${open.rows.length === 1 ? 'deduction' : 'deductions'})`,
    sourceKind: 'tds-remittance',
    sourceRef: input.challanNo,
    idempotencyKey: input.idempotencyKey,
    postedBy: input.postedBy,
    postedByLabel: input.postedByLabel,
    legs: [
      { accountCode: liability, debit: amount, credit: 0, docRef: input.challanNo },
      { accountCode: bank, debit: 0, credit: amount, docRef: input.challanNo },
    ],
  });
  if (entryId === null) {
    throw conflict(`That remittance has already been recorded.`);
  }

  await tx.query(
    `UPDATE tds_register
        SET challan_no = $1, challan_date = $2, remittance_entry_id = $3
      WHERE id = ANY($4::bigint[])`,
    [input.challanNo, input.challanDate, entryId, `{${open.rows.map(r => r.id).join(',')}}`],
  );

  return {
    entryId,
    section: input.section,
    quarter: input.quarter,
    amount,
    deductions: open.rows.length,
    challanNo: input.challanNo,
  };
}
