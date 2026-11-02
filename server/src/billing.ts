/**
 * The billing run: proformas for a period.
 *
 * A proforma posts nothing. That is the whole point of the two-document
 * lifecycle — the receivable and the GST arise when it becomes a tax invoice,
 * which is `convertToTaxInvoice` in posting.ts, not here. What this module
 * does is work out what each flat owes, write the documents, and refuse
 * clearly when it cannot.
 *
 * It refuses rather than guesses in four places: no rate in force, a rate
 * nobody has signed off, a flat with no recorded area, and a flat whose area
 * basis is not the one the rate is expressed against. Each of those produced a
 * plausible wrong bill in the demo.
 */

import type { Queryable } from './pg';
import { badRequest } from './http';
import { computeBillTax, computeMaintenance, type BillLine } from './posting';
import { dueDays, gstTreatment, pendingBillingTerms, sinkingFundPercent } from './settings';
import { rateOnDate } from './settings';
import { percentOf } from '../../src/accounting/money';
import { allocateNumber } from './series';
import { RateError } from '../../src/accounting/rates';
import type { AreaBasis } from '../../src/accounting/rates';
import { canonicalPeriod, periodToIso } from '../../src/accounting/clock';

/**
 * 'Jul 2026' to the first and last day of that month, and to the period's one
 * canonical spelling.
 *
 * `period` is what a caller must store and compare: the duplicate guard is a
 * unique index over the text, so "Jul  2026" and "jul 2026" have to become
 * "Jul 2026" before they reach it. The rule is the engine's `canonicalPeriod`,
 * so the server and the browser register agree on what one month is called.
 */
export function periodBounds(period: string): {
  startsOn: string; endsOn: string; label: string; period: string;
} {
  const canonical = canonicalPeriod(period);
  if (canonical === null) throw badRequest(`"${period}" is not a period such as "Jul 2026".`);
  const startsOn = periodToIso(canonical) as string;
  const year = Number(startsOn.slice(0, 4));
  const monthIndex = Number(startsOn.slice(5, 7)) - 1;
  const month = String(monthIndex + 1).padStart(2, '0');
  // Day 0 of the next month is the last day of this one, which avoids a leap
  // year table.
  const last = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return {
    startsOn,
    endsOn: `${year}-${month}-${String(last).padStart(2, '0')}`,
    label: `${year}-${month}`,
    period: canonical,
  };
}

/** Whether a migration is recorded as applied, for code that must work either side of it. */
export async function migrationApplied(tx: Queryable, version: string): Promise<boolean> {
  const found = await tx.query<{ version: string }>(
    'SELECT version FROM schema_migrations WHERE version = $1', [version],
  );
  return found.rows.length > 0;
}

/** "Mani Vista Residents Association" to "MVRA": the first letter of each word. */
export function societyInitials(name: string): string {
  // "(demo)" or "(MVRA)" after the name is not part of it.
  const letters = name.replace(/\([^)]*\)/g, ' ').split(/[^A-Za-z0-9]+/).filter(w => w !== '').map(w => w[0].toUpperCase()).join('');
  return letters === '' ? 'SOC' : letters.slice(0, 8);
}

/** The financial year (April to March) of an ISO date, as "2026-27". */
export function financialYearLabel(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const start = Number(isoDate.slice(5, 7)) >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

async function proformaSeries(
  tx: Queryable, societyId: string, issuedOn: string,
): Promise<{ prefix: string; scope: string }> {
  const found = await tx.query<{ name: string }>('SELECT name FROM societies WHERE id = $1', [societyId]);
  const fy = financialYearLabel(issuedOn);
  return {
    prefix: `${societyInitials(found.rows[0]?.name ?? '')}/PI/${fy}/`,
    scope: `PI ${fy}`,
  };
}

/**
 * When a proforma goes out, the flat's unpaid arrears (opening dues brought
 * forward) fall due the society's days-to-pay after that day: the
 * association's notes give a member ten days from receiving the bill. Opening
 * dues were imported with the date they were first due, which made every flat
 * overdue before any bill had been sent. The proforma keeps its own due date
 * (its issue date plus the days to pay). A due date moves only later, never
 * earlier, and only on arrears still owed; nothing is posted, so no figure
 * changes.
 */
export async function alignDueDatesOnRelease(
  tx: Queryable,
  input: { societyId: string; documentId: string; releasedOn: string },
): Promise<{ dueOn: string; openingMoved: number }> {
  const dueOn = addDays(input.releasedOn, await dueDays(tx, input.societyId));
  const flat = (await tx.query<{ flat_id: string }>(
    'SELECT flat_id FROM billing_documents WHERE id = $1 AND society_id = $2',
    [input.documentId, input.societyId],
  )).rows[0]?.flat_id;
  if (flat === undefined) return { dueOn, openingMoved: 0 };
  const opening = await tx.query<{ id: string }>(
    `UPDATE billing_documents d SET due_on = $3::date
      WHERE d.society_id = $1 AND d.flat_id = $2 AND d.opening_batch_id IS NOT NULL
        AND d.state <> 'cancelled' AND d.due_on < $3::date
        AND COALESCE((SELECT SUM(p.debit - p.credit) FROM journal_postings p
                       WHERE p.society_id = d.society_id AND p.account_code = '1100'
                         AND p.doc_ref = d.tax_invoice_no), 0) > 0
      RETURNING d.id`,
    [input.societyId, flat, dueOn],
  );
  return { dueOn, openingMoved: opening.rows.length };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface BillingRunInput {
  readonly societyId: string;
  readonly period: string;
  readonly issuedOn: string;
  /**
   * Who asked for this run. Not nullable: it is the maker in maker-checker,
   * and the approvals row the database checks against needs a real user.
   */
  readonly requestedBy: string;
  /** Limits the run to these flats. Absent means every billable flat. */
  readonly flatIds?: readonly string[];
}

export interface BillingRunResult {
  readonly period: string;
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly rate: { ratePerSqFt: number; basis: AreaBasis; effectiveFrom: string; authority: string };
  readonly issued: ReadonlyArray<{
    documentId: string; proformaNo: string; flatNo: string; net: number;
    estimatedTax: number; gross: number;
  }>;
  /** Flats not billed, each with the reason. Never silently dropped. */
  readonly skipped: ReadonlyArray<{ flatNo: string; why: string }>;
  readonly totals: { net: number; estimatedTax: number; gross: number };
}

/**
 * Issues one period's proformas.
 *
 * Runs in the caller's transaction, so a failure part-way through leaves no
 * documents at all rather than a half-billed period that a second run would
 * then refuse to complete.
 */
export async function runBilling(
  tx: Queryable,
  input: BillingRunInput,
): Promise<BillingRunResult> {
  const bounds = periodBounds(input.period);
  // From here on the canonical spelling, never the caller's. The scheduled
  // job hands its payload's period straight to this function without going
  // through the request validator, so this is the line that has to hold.
  const period = bounds.period;

  // The rate in force during the month being billed, not the rate in force on
  // the day the run happens. They are the same for a run made in its own
  // month and different for a back-dated one: billing July in September, with
  // a new rate approved from August, must charge July's rate. The charge is
  // for that month's service.
  const rate = await rateOnDate(tx, { societyId: input.societyId, on: bounds.startsOn });
  if (rate === null) {
    // A rate that starts later is the usual reason, and saying so saves a
    // search for a rate that is plainly on the Rates screen.
    const later = await tx.query<{ effective_from: string }>(
      `SELECT effective_from::text FROM maintenance_rates
        WHERE society_id = $1 AND effective_from > $2::date ORDER BY effective_from LIMIT 1`,
      [input.societyId, bounds.startsOn],
    );
    const startsLater = later.rows[0]?.effective_from;
    throw badRequest(
      startsLater === undefined
        ? `No maintenance rate is on record as effective on or before ${bounds.startsOn}, the ` +
          `start of ${period}. Record the rate the committee approved before running a ` +
          `billing cycle.`
        : `The maintenance rate on record starts on ${startsLater}, after the start of ` +
          `${period} (${bounds.startsOn}), so ${period} cannot be billed at it. If the rate ` +
          `applies from ${period}, record it again effective ${bounds.startsOn} and have the ` +
          `treasurer approve it.`,
    );
  }
  if (rate.approvedBy === undefined || rate.approvedOn === undefined) {
    throw badRequest(
      `The rate effective ${rate.effectiveFrom} (${rate.authority}) has not been approved, ` +
      `so it cannot be billed from. Approve it first.`,
    );
  }

  const pendingTerms = await pendingBillingTerms(tx, input.societyId);
  if (pendingTerms.length > 0) {
    throw badRequest(
      `The payment terms are pending verification, so ${period} cannot be billed: ` +
      `${pendingTerms.join('; ')}. Enter the figures the committee fixed and have them approved.`,
    );
  }

  const gst = await gstTreatment(tx, input.societyId);
  const sinkingPercent = await sinkingFundPercent(tx, input.societyId);
  const dueOn = addDays(input.issuedOn, await dueDays(tx, input.societyId));

  const params: Array<string | number | null> = [input.societyId];
  let flatFilter = '';
  if (input.flatIds !== undefined) {
    if (input.flatIds.length === 0) throw badRequest('No flats were named for this run.');
    flatFilter = ` AND f.id IN (${input.flatIds.map(id => {
      params.push(id);
      return `$${params.length}`;
    }).join(',')})`;
  }

  // The proforma series, with the series locked for this society and period so
  // two runs cannot take the same number. Scoped to the period, so billing
  // July does not wait behind billing August.
  //
  // Taken BEFORE the query below that looks for an existing live document,
  // not after it. With the lock second, two concurrent runs for one period
  // both read "nothing billed yet", the second then waited on the lock, and
  // on waking inserted a duplicate that the unique index refused — as a raw
  // "the database refused this change" rather than the "already billed" the
  // flat deserved. Locked first, the second run reads the first run's
  // committed documents and skips those flats, saying why.
  // Numbered MVRA/PI/2026-27/001: the society's initials, PI, the financial
  // year of the invoice date, and a serial that runs through the year — the
  // association's own format. The series is locked per year, so two runs in
  // one year (for different months) cannot take the same number.
  const series = await proformaSeries(tx, input.societyId, input.issuedOn);
  const firstNumber = await allocateNumber(
    tx,
    { societyId: input.societyId, kind: 'proforma', scope: series.scope },
    async () => {
      const next = await tx.query<{ next: string }>(
        `SELECT COALESCE(MAX(NULLIF(regexp_replace(proforma_no, '^.*/', ''), '')::int), 0) + 1 AS next
           FROM billing_documents
          WHERE society_id = $1 AND proforma_no LIKE $2`,
        [input.societyId, `${series.prefix}%`],
      );
      return String(next.rows[0]?.next ?? '1');
    },
  );
  let sequence = Number(firstNumber);
  const openingExempt = await migrationApplied(tx, '012_opening_dues_and_pi_details.sql');

  const flats = await tx.query<{
    id: string; flat_no: string; billing_area_sqft: string | null; area_basis: string | null;
    live_document: string | null; opening_document: string | null;
  }>(
    `SELECT f.id, f.flat_no, f.billing_area_sqft::text, f.area_basis,
            (SELECT d.proforma_no FROM billing_documents d
              WHERE d.society_id = f.society_id AND d.flat_id = f.id
                AND d.period = $${params.length + 1} AND d.state <> 'cancelled'
                AND d.opening_batch_id IS NULL
              LIMIT 1) AS live_document,
            (SELECT d.proforma_no FROM billing_documents d
              WHERE d.society_id = f.society_id AND d.flat_id = f.id
                AND d.period = $${params.length + 1} AND d.state <> 'cancelled'
                AND d.opening_batch_id IS NOT NULL
              LIMIT 1) AS opening_document
       FROM flats f
      WHERE f.society_id = $1${flatFilter}
      ORDER BY f.flat_no`,
    [...params, period],
  );

  const issued: Array<{
    documentId: string; proformaNo: string; flatNo: string; net: number;
    estimatedTax: number; gross: number;
  }> = [];
  const skipped: Array<{ flatNo: string; why: string }> = [];

  for (const flat of flats.rows) {
    if (flat.live_document !== null) {
      skipped.push({
        flatNo: flat.flat_no,
        why: `already billed for ${period} as ${flat.live_document}`,
      });
      continue;
    }
    if (flat.opening_document !== null && !openingExempt) {
      // Before migration 012 the database counts an opening due as the
      // month's bill and would refuse this proforma.
      skipped.push({
        flatNo: flat.flat_no,
        why: `its opening dues (${flat.opening_document}) are filed under ${period}, and the ` +
          'database still counts them as that month\'s bill. Apply docs/neon/012-apply.sql ' +
          'in Neon, then run this month again.',
      });
      continue;
    }
    if (flat.billing_area_sqft === null || flat.area_basis === null) {
      skipped.push({
        flatNo: flat.flat_no,
        why: 'no billing area and basis on record, so an area-based charge cannot be computed',
      });
      continue;
    }

    let maintenance: number;
    try {
      maintenance = computeMaintenance(
        {
          flatNo: flat.flat_no,
          billingAreaSqFt: Number(flat.billing_area_sqft),
          areaBasis: flat.area_basis as AreaBasis,
        },
        rate,
      );
    } catch (err) {
      if (err instanceof RateError) {
        skipped.push({ flatNo: flat.flat_no, why: err.message });
        continue;
      }
      throw err;
    }

    const lines: BillLine[] = [{ head: 'maintenance', amount: maintenance, taxable: true }];
    if (sinkingPercent > 0) {
      const sinking = percentOf(maintenance, sinkingPercent);
      if (sinking > 0) {
        // A sinking fund contribution is a corpus collection, not a service,
        // so it is not taxable — unless the society's GST treatment says it
        // is (`sinkingFundTaxable`). Then the line is taxable, carries GST at
        // the maintenance rate, and counts towards the per-member threshold,
        // both here and when conversion recomputes from the stored lines.
        lines.push({ head: 'sinking', amount: sinking, taxable: gst.sinkingFundTaxable });
      }
    }

    const net = lines.reduce((sum, l) => sum + l.amount, 0);
    // An estimate on the proforma, and nothing is posted from it. The figure
    // that reaches the ledger is recomputed at conversion from the lines as
    // they then stand.
    const estimatedTax = computeBillTax(lines, gst).total;
    const proformaNo = `${series.prefix}${String(sequence).padStart(3, '0')}`;
    sequence += 1;

    const document = await tx.query<{ id: string }>(
      `INSERT INTO billing_documents
         (society_id, proforma_no, flat_id, period, estimated_tax, gross,
          issued_on, due_on, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft')
       RETURNING id`,
      [
        input.societyId, proformaNo, flat.id, period, estimatedTax,
        net + estimatedTax, input.issuedOn, dueOn,
      ],
    );
    const documentId = document.rows[0].id;

    for (const [position, line] of lines.entries()) {
      await tx.query(
        `INSERT INTO billing_document_lines (document_id, head, amount, taxable, position)
         VALUES ($1,$2,$3,$4,$5)`,
        [documentId, line.head, line.amount, line.taxable, position],
      );
    }

    // The maker-checker pair, recorded at the database. The approve endpoint
    // fills in decided_by, and a CHECK refuses a decider who is the requester
    // — so one person cannot both raise and approve a bill even if they hold
    // both permissions by some later misconfiguration.
    await tx.query(
      `INSERT INTO approvals (society_id, subject_table, subject_id, requested_by)
       VALUES ($1, 'billing_documents', $2, $3)`,
      [input.societyId, documentId, input.requestedBy],
    );

    issued.push({
      documentId,
      proformaNo,
      flatNo: flat.flat_no,
      net,
      estimatedTax,
      gross: net + estimatedTax,
    });
  }

  return {
    period,
    issuedOn: input.issuedOn,
    dueOn,
    rate: {
      ratePerSqFt: rate.ratePerSqFt,
      basis: rate.basis,
      effectiveFrom: rate.effectiveFrom,
      authority: rate.authority,
    },
    issued,
    skipped,
    totals: {
      net: issued.reduce((s, d) => s + d.net, 0),
      estimatedTax: issued.reduce((s, d) => s + d.estimatedTax, 0),
      gross: issued.reduce((s, d) => s + d.gross, 0),
    },
  };
}

export interface DocumentSummary {
  readonly id: string;
  readonly proformaNo: string;
  readonly taxInvoiceNo: string | null;
  readonly flatId: string;
  readonly flatNo: string;
  readonly period: string;
  readonly gross: number;
  readonly estimatedTax: number;
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly state: string;
  readonly approvedBy: string | null;
  readonly outstanding: number;
  /** Derived from what has been allocated against it, never stored. */
  readonly paymentStatus: 'Not raised' | 'Pending' | 'Partly paid' | 'Paid' | 'Overdue' | 'Cancelled';
  readonly lines: ReadonlyArray<{ head: string; amount: number; taxable: boolean }>;
  readonly dispatch: ReadonlyArray<{ at: string; channel: string; delivered: boolean; note: string }>;
}

/**
 * The payment status of a document, derived.
 *
 * Never a stored column. In the demo it was one, which is how an invoice could
 * read "Paid" with nothing allocated against it.
 */
export function paymentStatus(
  doc: { state: string; gross: number; outstanding: number; dueOn: string },
  asAt: string,
): DocumentSummary['paymentStatus'] {
  if (doc.state === 'cancelled') return 'Cancelled';
  if (doc.state !== 'tax-invoice') return 'Not raised';
  if (doc.outstanding <= 0) return 'Paid';
  if (doc.outstanding < doc.gross) return 'Partly paid';
  return asAt > doc.dueOn ? 'Overdue' : 'Pending';
}

export async function listDocuments(
  tx: Queryable,
  input: {
    societyId: string; asAt: string; period?: string;
    flatIds?: readonly string[] | null; state?: string; limit?: number;
  },
): Promise<DocumentSummary[]> {
  const params: Array<string | number | null> = [input.societyId, '1100', input.asAt];
  const conditions = ['d.society_id = $1'];

  if (input.period !== undefined) {
    // Read with the same spelling it was stored with, so "?period=jul 2026"
    // finds July rather than nothing.
    params.push(canonicalPeriod(input.period) ?? input.period);
    conditions.push(`d.period = $${params.length}`);
  }
  if (input.state !== undefined) {
    params.push(input.state);
    conditions.push(`d.state = $${params.length}`);
  }
  if (input.flatIds !== undefined && input.flatIds !== null) {
    if (input.flatIds.length === 0) return [];
    conditions.push(`d.flat_id IN (${input.flatIds.map(id => {
      params.push(id);
      return `$${params.length}`;
    }).join(',')})`);
  }
  params.push(input.limit ?? 500);

  const result = await tx.query<{
    id: string; proforma_no: string; tax_invoice_no: string | null; flat_id: string;
    flat_no: string; period: string; gross: string; estimated_tax: string;
    issued_on: string; due_on: string; state: string; approved_by: string | null;
    outstanding: string; lines: string; dispatch: string;
  }>(
    `SELECT d.id, d.proforma_no, d.tax_invoice_no, d.flat_id, f.flat_no, d.period,
            d.gross::text, d.estimated_tax::text, d.issued_on::text, d.due_on::text,
            d.state, d.approved_by,
            COALESCE((
              SELECT SUM(p.debit - p.credit)
                FROM journal_postings p
                JOIN journal_entries e ON e.id = p.entry_id
               WHERE p.society_id = d.society_id
                 AND p.account_code = $2
                 AND p.doc_ref = d.tax_invoice_no
                 AND e.entry_date <= $3::date
            ), 0)::text AS outstanding,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'head', l.head, 'amount', l.amount, 'taxable', l.taxable)
                     ORDER BY l.position)
                FROM billing_document_lines l WHERE l.document_id = d.id
            ), '[]'::json)::text AS lines,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'at', a.attempted_at, 'channel', a.channel,
                       'delivered', a.delivered, 'note', a.note)
                     ORDER BY a.attempted_at)
                FROM dispatch_attempts a WHERE a.document_id = d.id
            ), '[]'::json)::text AS dispatch
       FROM billing_documents d
       JOIN flats f ON f.id = d.flat_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.period DESC, f.flat_no
      LIMIT $${params.length}`,
    params,
  );

  return result.rows.map(r => {
    const gross = Number(r.gross);
    const outstanding = Number(r.outstanding);
    return {
      id: r.id,
      proformaNo: r.proforma_no,
      taxInvoiceNo: r.tax_invoice_no,
      flatId: r.flat_id,
      flatNo: r.flat_no,
      period: r.period,
      gross,
      estimatedTax: Number(r.estimated_tax),
      issuedOn: r.issued_on,
      dueOn: r.due_on,
      state: r.state,
      approvedBy: r.approved_by,
      outstanding,
      paymentStatus: paymentStatus(
        { state: r.state, gross, outstanding, dueOn: r.due_on },
        input.asAt,
      ),
      lines: JSON.parse(r.lines) as ReadonlyArray<{ head: string; amount: number; taxable: boolean }>,
      dispatch: JSON.parse(r.dispatch) as ReadonlyArray<{
        at: string; channel: string; delivered: boolean; note: string;
      }>,
    };
  });
}
