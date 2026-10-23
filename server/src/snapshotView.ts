/**
 * The books, in the shape the client's accounting engine already understands.
 *
 * This is what lets the React screens run against the database without being
 * rewritten. The engine's `Ledger.restore` and `BillingRegister.restoreDocuments`
 * exist for snapshots; this endpoint emits exactly those shapes from SQL, so
 * the browser rebuilds the same in-memory objects it used to build from
 * localStorage — and every figure in them came from the server.
 *
 * It is not a dump. What a caller gets is scoped to what they may see:
 *
 *  · With `invoice.read.any` — a manager, treasurer, secretary or auditor —
 *    the whole society.
 *  · Without it, only the caller's own flats: their documents, and the entries
 *    that touch them. A resident gets the whole of each of their own entries,
 *    including its bank and income legs, because those legs are the
 *    composition of their own invoice or their own receipt. They get nothing
 *    about another flat, and nothing about a vendor.
 *
 * The scope is `invoice.read.any` rather than `ledger.read` on purpose. Every
 * figure the screens show — what a flat owes, what has been collected — is
 * derived from these postings, so an account that may see every invoice has to
 * be given the postings behind them or its screens show zeroes. `ledger.read`
 * is what gates browsing the journal itself, at /api/ledger/entries, which is
 * a different thing: narrations, both legs, and every vendor and bank
 * movement in one list.
 *
 * The entry has to arrive whole or not at all: the engine refuses to restore
 * an entry whose legs do not balance, so filtering legs within an entry would
 * produce a snapshot the client would reject.
 */

import type { Queryable } from './pg';
import { hasPermission, type Principal } from './rbac';

export interface EngineLeg {
  readonly accountCode: string;
  readonly debit: number;
  readonly credit: number;
  readonly party?: string;
  readonly docRef?: string;
  readonly memo?: string;
}

export interface EngineEntry {
  readonly id: string;
  readonly date: string;
  readonly narration: string;
  readonly source: { readonly kind: string; readonly ref?: string };
  readonly postings: readonly EngineLeg[];
  readonly idempotencyKey: string;
  readonly reversalOf?: string;
  readonly reversedBy?: string;
  readonly postedBy: string;
  readonly postedAt: string;
}

export interface EngineDocument {
  /**
   * The server's id for the document. The engine does not need it and keeps
   * it untouched; the browser needs it to name the document in a write
   * (approve, release, convert, cancel, a receipt, the PDF).
   */
  readonly id: string;
  readonly proformaNo: string;
  readonly taxInvoiceNo?: string;
  readonly flatNo: string;
  readonly period: string;
  readonly lines: ReadonlyArray<{ head: string; amount: number; taxable: boolean }>;
  readonly estimatedTax: number;
  readonly gross: number;
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly state: string;
  readonly approvedBy?: string;
  readonly approvedOn?: string;
  readonly dispatch?: ReadonlyArray<{
    at: string; by: string; channel: string; delivered: boolean; note: string;
  }>;
  readonly convertedOn?: string;
  readonly convertedBecause?: 'payment-received' | 'due-date-reached' | 'manual';
  readonly postedEntryId?: string;
  readonly cancelledBy?: string;
  readonly cancelledReason?: string;
}

export interface EngineVendorBill {
  readonly id: string;
  readonly vendorId: string;
  readonly vendorName: string;
  readonly category: string;
  readonly grossRupees: number;
  readonly tdsRate: number;
  readonly date: string;
  readonly state: 'awaiting-approval' | 'approved' | 'booked' | 'rejected';
  readonly approvedBy?: string;
  readonly rejectedReason?: string;
  readonly billNo?: string;
}

export interface BooksSnapshotView {
  readonly societyId: string;
  readonly societyName: string;
  /**
   * Null until the association records its own. Never a placeholder: the
   * screens print this next to the words "Society GSTIN", and a made-up
   * registration number there is a false legal assertion rather than a
   * formatting detail.
   */
  readonly registrationNo: string | null;
  readonly gstin: string | null;
  readonly stateCode: string | null;
  readonly mode: 'demo' | 'production';
  readonly today: string;
  readonly scope: 'society' | 'own-flats';
  readonly flats: ReadonlyArray<{
    readonly id: string;
    readonly flatNo: string;
    readonly name: string;
    readonly billingAreaSqFt?: number;
    readonly areaBasis?: 'carpet' | 'built-up' | 'super-built-up';
    readonly nonOccupied?: boolean;
  }>;
  readonly entries: readonly EngineEntry[];
  readonly documents: readonly EngineDocument[];
  readonly taxInvoiceSequence: number;
  readonly vendorBills: readonly EngineVendorBill[];
  /** Settings the screens need, rather than every setting. */
  readonly settings: {
    readonly gst: { chargeGst: boolean; ratePercent: number; approved: boolean };
    readonly invoicePrefix: string;
    readonly dueDays: number;
    readonly sinkingFundPercent: number;
  };
  readonly rate: {
    readonly ratePerSqFt: number;
    readonly basis: string;
    readonly effectiveFrom: string;
    readonly authority: string;
    readonly approved: boolean;
  } | null;
}

const bool = (value: string | null): boolean => value === 't' || value === 'true';

export async function buildSnapshot(
  tx: Queryable,
  input: { principal: Principal; today: string },
): Promise<BooksSnapshotView> {
  const societyId = input.principal.societyId;
  const wholeSociety = hasPermission(input.principal, 'invoice.read.any');
  const ownFlats = input.principal.flatIds;

  const society = await tx.query<{
    name: string; mode: string; registration_no: string | null;
    gstin: string | null; state_code: string | null;
  }>(
    'SELECT name, mode, registration_no, gstin, state_code FROM societies WHERE id = $1',
    [societyId],
  );
  const found = society.rows[0];
  if (found === undefined) throw new Error(`no society ${societyId}`);

  // Flat numbers, needed both for the engine's FlatRecord list and to decide
  // which entries a resident may see.
  const flatRows = await tx.query<{
    id: string; flat_no: string; owner: string | null; billing_area_sqft: string | null;
    area_basis: string | null; non_occupied: string;
  }>(
    `SELECT f.id, f.flat_no, f.billing_area_sqft::text, f.area_basis, f.non_occupied::text,
            (SELECT o.full_name FROM flat_ownership fo
               JOIN owners o ON o.id = fo.owner_id
              WHERE fo.flat_id = f.id AND fo.role = 'owner' AND fo.held_until IS NULL
              LIMIT 1) AS owner
       FROM flats f
      WHERE f.society_id = $1
      ORDER BY f.flat_no`,
    [societyId],
  );

  const visibleFlatRows = wholeSociety
    ? flatRows.rows
    : flatRows.rows.filter(f => ownFlats.includes(f.id));
  const visibleFlatNos = visibleFlatRows.map(f => f.flat_no);

  const flats = visibleFlatRows.map(f => ({
    id: f.id,
    flatNo: f.flat_no,
    // The engine's FlatRecord wants a name. A flat with no current owner on
    // record gets its own number rather than an invented resident.
    name: f.owner ?? f.flat_no,
    ...(f.billing_area_sqft === null ? {} : { billingAreaSqFt: Number(f.billing_area_sqft) }),
    ...(f.area_basis === null
      ? {}
      : { areaBasis: f.area_basis as 'carpet' | 'built-up' | 'super-built-up' }),
    nonOccupied: bool(f.non_occupied),
  }));

  // --- entries ------------------------------------------------------------

  const entryParams: Array<string | number> = [societyId];
  let entryFilter = '';
  if (!wholeSociety) {
    if (visibleFlatNos.length === 0) {
      entryFilter = ' AND false';
    } else {
      const placeholders = visibleFlatNos.map(flatNo => {
        entryParams.push(flatNo);
        return `$${entryParams.length}`;
      }).join(',');
      // Whole entries, selected by whether any leg names one of this caller's
      // flats as its party. The control accounts are the ones that carry a
      // party, so this is "entries about my flat" and nothing else.
      entryFilter = ` AND EXISTS (
        SELECT 1 FROM journal_postings p
         WHERE p.entry_id = e.id AND p.party IN (${placeholders}))`;
    }
  }

  const entryRows = await tx.query<{
    id: string; entry_date: string; narration: string; source_kind: string;
    source_ref: string | null; idempotency_key: string; reversal_of: string | null;
    reversed_by: string | null; posted_by_label: string; posted_at: string; legs: string;
  }>(
    `SELECT e.id, e.entry_date::text, e.narration, e.source_kind, e.source_ref,
            e.idempotency_key, e.reversal_of, e.reversed_by, e.posted_by_label,
            e.posted_at::text,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'accountCode', p.account_code,
                       'debit', p.debit, 'credit', p.credit,
                       'party', p.party, 'docRef', p.doc_ref, 'memo', p.memo)
                     ORDER BY p.id)
                FROM journal_postings p WHERE p.entry_id = e.id
            ), '[]'::json)::text AS legs
       FROM journal_entries e
      WHERE e.society_id = $1${entryFilter}
      ORDER BY e.entry_date, e.posted_at, e.entry_ref`,
    entryParams,
  );

  const entries: EngineEntry[] = entryRows.rows.map(r => {
    const legs = (JSON.parse(r.legs) as Array<{
      accountCode: string; debit: number; credit: number;
      party: string | null; docRef: string | null; memo: string | null;
    }>).map(leg => ({
      accountCode: leg.accountCode,
      debit: Number(leg.debit),
      credit: Number(leg.credit),
      ...(leg.party === null ? {} : { party: leg.party }),
      ...(leg.docRef === null ? {} : { docRef: leg.docRef }),
      ...(leg.memo === null ? {} : { memo: leg.memo }),
    }));
    return {
      id: r.id,
      date: r.entry_date,
      narration: r.narration,
      source: {
        kind: r.source_kind,
        ...(r.source_ref === null ? {} : { ref: r.source_ref }),
      },
      postings: legs,
      idempotencyKey: r.idempotency_key,
      ...(r.reversal_of === null ? {} : { reversalOf: r.reversal_of }),
      ...(r.reversed_by === null ? {} : { reversedBy: r.reversed_by }),
      postedBy: r.posted_by_label,
      postedAt: r.posted_at,
    };
  });

  // --- documents ----------------------------------------------------------

  const documentParams: Array<string | number> = [societyId];
  let documentFilter = '';
  if (!wholeSociety) {
    if (ownFlats.length === 0) {
      documentFilter = ' AND false';
    } else {
      const placeholders = ownFlats.map(id => {
        documentParams.push(id);
        return `$${documentParams.length}`;
      }).join(',');
      documentFilter = ` AND d.flat_id IN (${placeholders})`;
    }
  }

  const documentRows = await tx.query<{
    id: string; proforma_no: string; tax_invoice_no: string | null; flat_no: string; period: string;
    estimated_tax: string; gross: string; issued_on: string; due_on: string; state: string;
    approved_by: string | null; approved_on: string | null; converted_on: string | null;
    converted_because: string | null; posted_entry_id: string | null;
    cancelled_by: string | null; cancelled_reason: string | null;
    lines: string; dispatch: string;
  }>(
    `SELECT d.id, d.proforma_no, d.tax_invoice_no, f.flat_no, d.period, d.estimated_tax::text,
            d.gross::text, d.issued_on::text, d.due_on::text, d.state,
            approver.email AS approved_by, d.approved_on::text, d.converted_on::text,
            d.converted_because, d.posted_entry_id,
            canceller.email AS cancelled_by, d.cancelled_reason,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'head', l.head, 'amount', l.amount, 'taxable', l.taxable)
                     ORDER BY l.position)
                FROM billing_document_lines l WHERE l.document_id = d.id
            ), '[]'::json)::text AS lines,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'at', a.attempted_at, 'by', COALESCE(u.email, 'system'),
                       'channel', a.channel, 'delivered', a.delivered, 'note', a.note)
                     ORDER BY a.attempted_at)
                FROM dispatch_attempts a
                LEFT JOIN users u ON u.id = a.by_user
               WHERE a.document_id = d.id
            ), '[]'::json)::text AS dispatch
       FROM billing_documents d
       JOIN flats f ON f.id = d.flat_id
       LEFT JOIN users approver ON approver.id = d.approved_by
       LEFT JOIN users canceller ON canceller.id = d.cancelled_by
      WHERE d.society_id = $1${documentFilter}
      ORDER BY d.proforma_no`,
    documentParams,
  );

  const documents: EngineDocument[] = documentRows.rows.map(r => ({
    id: r.id,
    proformaNo: r.proforma_no,
    ...(r.tax_invoice_no === null ? {} : { taxInvoiceNo: r.tax_invoice_no }),
    flatNo: r.flat_no,
    period: r.period,
    lines: (JSON.parse(r.lines) as Array<{ head: string; amount: number; taxable: boolean }>)
      .map(l => ({ head: l.head, amount: Number(l.amount), taxable: l.taxable === true })),
    estimatedTax: Number(r.estimated_tax),
    gross: Number(r.gross),
    issuedOn: r.issued_on,
    dueOn: r.due_on,
    state: r.state,
    ...(r.approved_by === null ? {} : { approvedBy: r.approved_by }),
    ...(r.approved_on === null ? {} : { approvedOn: r.approved_on }),
    dispatch: (JSON.parse(r.dispatch) as Array<{
      at: string; by: string; channel: string; delivered: boolean; note: string;
    }>).map(a => ({ ...a, delivered: a.delivered === true })),
    ...(r.converted_on === null ? {} : { convertedOn: r.converted_on }),
    ...(r.converted_because === null
      ? {}
      : { convertedBecause: r.converted_because as EngineDocument['convertedBecause'] }),
    ...(r.posted_entry_id === null ? {} : { postedEntryId: r.posted_entry_id }),
    ...(r.cancelled_by === null ? {} : { cancelledBy: r.cancelled_by }),
    ...(r.cancelled_reason === null ? {} : { cancelledReason: r.cancelled_reason }),
  }));

  // The series the register must continue from. Read off the issued numbers
  // rather than kept in a counter, so it cannot fall behind the documents.
  const sequence = await tx.query<{ highest: string | null }>(
    `SELECT MAX(NULLIF(regexp_replace(tax_invoice_no, '^.*/', ''), '')::int)::text AS highest
       FROM billing_documents
      WHERE society_id = $1 AND tax_invoice_no IS NOT NULL`,
    [societyId],
  );

  // --- vendor bills -------------------------------------------------------

  const vendorBills: EngineVendorBill[] = hasPermission(input.principal, 'report.read')
    ? (await tx.query<{
        id: string; vendor_id: string; vendor_name: string; category: string;
        gross: string; tds_rate_bps: string; bill_date: string; state: string;
        approved_by: string | null; rejected_reason: string | null; bill_no: string;
        posted_entry_id: string | null;
      }>(
        `SELECT b.id, b.vendor_id, v.name AS vendor_name, v.category, b.gross::text,
                b.tds_rate_bps::text, b.bill_date::text, b.state,
                u.email AS approved_by, b.rejected_reason, b.bill_no, b.posted_entry_id
           FROM vendor_bills b
           JOIN vendors v ON v.id = b.vendor_id
           LEFT JOIN users u ON u.id = b.approved_by
          WHERE b.society_id = $1
          ORDER BY b.bill_date DESC, b.bill_no`,
        [societyId],
      )).rows.map(r => ({
        id: r.id,
        vendorId: r.vendor_id,
        vendorName: r.vendor_name,
        category: r.category,
        // Rupees, because that is what the screen's VendorBillState holds. The
        // ledger keeps the paise; this is a display figure.
        grossRupees: Number(r.gross) / 100,
        tdsRate: Number(r.tds_rate_bps) / 100,
        date: r.bill_date,
        state: r.state as EngineVendorBill['state'],
        ...(r.approved_by === null ? {} : { approvedBy: r.approved_by }),
        ...(r.rejected_reason === null ? {} : { rejectedReason: r.rejected_reason }),
        ...(r.posted_entry_id === null ? {} : { billNo: r.bill_no }),
      }))
    : [];

  // --- settings and the rate ----------------------------------------------

  const settingRows = await tx.query<{ key: string; value: string; approved_by: string | null }>(
    'SELECT key, value::text, approved_by FROM society_settings WHERE society_id = $1',
    [societyId],
  );
  const setting = (key: string): { value: unknown; approved: boolean } | undefined => {
    const row = settingRows.rows.find(r => r.key === key);
    return row === undefined
      ? undefined
      : { value: JSON.parse(row.value), approved: row.approved_by !== null };
  };

  const gstRow = setting('gst.treatment');
  const gstValue = (gstRow?.value ?? {}) as { chargeGst?: unknown; ratePercent?: unknown };
  const numberSetting = (key: string, fallback: number): number => {
    const value = setting(key)?.value;
    return typeof value === 'number' ? value : fallback;
  };
  const prefix = setting('billing.invoicePrefix')?.value;

  const rateRow = await tx.query<{
    rate_paise_per_sqft: string; area_basis: string; effective_from: string;
    authority: string; approved_by: string | null;
  }>(
    `SELECT rate_paise_per_sqft::text, area_basis, effective_from::text, authority, approved_by
       FROM maintenance_rates
      WHERE society_id = $1 AND effective_from <= $2::date
      ORDER BY effective_from DESC
      LIMIT 1`,
    [societyId, input.today],
  );
  const rate = rateRow.rows[0];

  return {
    societyId,
    societyName: found.name,
    registrationNo: found.registration_no,
    gstin: found.gstin,
    stateCode: found.state_code,
    mode: found.mode as 'demo' | 'production',
    today: input.today,
    scope: wholeSociety ? 'society' : 'own-flats',
    flats,
    entries,
    documents,
    taxInvoiceSequence: Number(sequence.rows[0]?.highest ?? '0'),
    vendorBills,
    settings: {
      gst: {
        chargeGst: gstValue.chargeGst === true,
        ratePercent: typeof gstValue.ratePercent === 'number' ? gstValue.ratePercent : 0,
        approved: gstRow?.approved ?? false,
      },
      invoicePrefix: typeof prefix === 'string' ? prefix : 'INV',
      dueDays: numberSetting('billing.dueDays', 15),
      sinkingFundPercent: numberSetting('billing.sinkingFundPercent', 0),
    },
    rate: rate === undefined
      ? null
      : {
          ratePerSqFt: Number(rate.rate_paise_per_sqft) / 100,
          basis: rate.area_basis,
          effectiveFrom: rate.effective_from,
          authority: rate.authority,
          approved: rate.approved_by !== null,
        },
  };
}
