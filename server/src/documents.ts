/**
 * Rendering a tax invoice and a receipt.
 *
 * Both are rendered from a payload that is stored alongside the file in
 * `generated_documents.render_payload`, so a reprint is byte-identical and a
 * later rate change cannot alter a document already issued. That is the whole
 * reason the payload exists: an invoice is a legal document, and regenerating
 * it from live data would quietly reissue it with today's figures.
 *
 * What is deliberately not on these documents: a GSTIN, a registration number
 * or a bank account, unless the society has actually recorded one. A tax
 * invoice carries legal assertions, and a placeholder GSTIN on one is a forged
 * assertion rather than a formatting detail.
 */

import { createHash } from 'node:crypto';
import { A4, PdfPage, buildPdf, money, textWidth } from './pdf';
import type { Queryable } from './pg';
import { badRequest, notFound } from './http';
import { allocateNumber } from './series';
import { gstTreatment } from './settings';
import { percentOf } from '../../src/accounting/money';

export interface InvoicePayload {
  readonly kind: 'tax-invoice' | 'proforma';
  readonly society: {
    readonly name: string;
    readonly registrationNo: string | null;
    readonly gstin: string | null;
    readonly stateCode: string | null;
    readonly mode: 'demo' | 'production';
  };
  readonly documentNo: string;
  readonly proformaNo: string;
  readonly period: string;
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly flatNo: string;
  readonly ownerName: string | null;
  readonly lines: ReadonlyArray<{ head: string; label: string; amount: number; taxable: boolean }>;
  readonly taxableValue: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly ratePercent: number;
  /**
   * Whether CGST and SGST were rounded to the rupee under the society's
   * `roundToRupee` treatment, so the document can say so beside two figures
   * that are not exactly 9% of the taxable value. Absent means to the paisa.
   */
  readonly taxRoundedToRupee?: boolean;
  readonly net: number;
  readonly gross: number;
  readonly outstanding: number;
  readonly state: string;
}

export interface ReceiptPayload {
  readonly society: InvoicePayload['society'];
  readonly receiptNo: string;
  readonly receivedOn: string;
  readonly flatNo: string;
  readonly ownerName: string | null;
  readonly amount: number;
  readonly method: string;
  readonly instrumentRef: string | null;
  readonly allocations: ReadonlyArray<{ taxInvoiceNo: string | null; amount: number }>;
  readonly heldAsAdvance: number;
}

const HEAD_LABEL: Record<string, string> = {
  maintenance: 'Maintenance charges',
  sinking: 'Sinking fund contribution',
  festival: 'Festival and event',
  rental: 'Common space rental',
  reimbursement: 'Reimbursable expenses',
  other: 'Other receipts',
};

function header(page: PdfPage, society: InvoicePayload['society'], title: string): void {
  const right = page.size.widthPt - page.margin;

  page.text(society.name, { size: 16, face: 'bold' });
  page.textRight(title, right, { size: 13, face: 'bold' });
  page.down(16);

  const identity: string[] = [];
  if (society.registrationNo !== null) identity.push(`Regn. ${society.registrationNo}`);
  if (society.gstin !== null) identity.push(`GSTIN ${society.gstin}`);
  // Said rather than left blank: a reader needs to know the omission is
  // deliberate and not a rendering fault.
  page.text(
    identity.length > 0 ? identity.join('   ') : 'No registration or GSTIN on record',
    { size: 8.5, grey: 0.45 },
  );

  if (society.mode === 'demo') {
    page.textRight('DEMONSTRATION DATA - NOT A VALID DOCUMENT', right, {
      size: 8.5, face: 'bold', grey: 0.35,
    });
  }
  page.down(10);
  page.rule(0.7);
  page.down(22);
}

function footer(page: PdfPage, note: string): void {
  const right = page.size.widthPt - page.margin;
  page.cursor = page.margin + 34;
  page.rule(0.85);
  page.down(12);
  page.text(note, { size: 7.5, grey: 0.5 });
  page.textRight('Computer generated', right, { size: 7.5, grey: 0.5 });
}

export function renderInvoice(payload: InvoicePayload): Buffer {
  const page = new PdfPage(A4);
  const left = page.margin;
  const right = page.size.widthPt - page.margin;

  header(
    page,
    payload.society,
    payload.kind === 'tax-invoice' ? 'TAX INVOICE' : 'PROFORMA INVOICE',
  );

  // Two columns: who it is for, and what it is.
  const top = page.cursor;
  page.text('Billed to', { size: 8, grey: 0.45 });
  page.down(13);
  page.text(`Flat ${payload.flatNo}`, { size: 11, face: 'bold' });
  if (payload.ownerName !== null) {
    page.down(13);
    page.text(payload.ownerName, { size: 10 });
  }

  const labelX = right - 190;
  const valueX = right;
  let detailY = top;
  const detail = (label: string, value: string): void => {
    page.text(label, { x: labelX, y: detailY, size: 8.5, grey: 0.45 });
    page.textRight(value, valueX, { y: detailY, size: 9.5, face: 'bold' });
    detailY -= 14;
  };
  detail(payload.kind === 'tax-invoice' ? 'Invoice no.' : 'Proforma no.', payload.documentNo);
  if (payload.kind === 'tax-invoice') detail('Raised from', payload.proformaNo);
  detail('Period', payload.period);
  detail('Issued', payload.issuedOn);
  detail('Due', payload.dueOn);

  page.cursor = Math.min(page.cursor - 26, detailY - 12);

  // The table.
  const amountRight = right;
  const taxableX = right - 110;
  page.box(left, page.cursor - 4, right - left, 18);
  page.text('Particulars', { x: left + 6, size: 8.5, face: 'bold' });
  page.text('Taxable', { x: taxableX, size: 8.5, face: 'bold' });
  page.textRight('Amount', amountRight - 6, { size: 8.5, face: 'bold' });
  page.down(22);

  for (const line of payload.lines) {
    page.text(line.label, { x: left + 6, size: 10 });
    page.text(line.taxable ? 'yes' : 'no', { x: taxableX, size: 9, grey: 0.4 });
    page.textRight(money(line.amount), amountRight - 6, { size: 10, face: 'mono' });
    page.down(16);
  }

  page.down(2);
  page.rule(0.85);
  page.down(16);

  const total = (label: string, value: number, bold = false): void => {
    page.text(label, { x: taxableX - 90, size: bold ? 10.5 : 9.5, face: bold ? 'bold' : 'regular' });
    page.textRight(money(value), amountRight - 6, {
      size: bold ? 10.5 : 9.5, face: bold ? 'bold' : 'mono',
    });
    page.down(15);
  };

  total('Net charges', payload.net);
  if (payload.cgst > 0 || payload.sgst > 0) {
    // On a proforma the tax is the estimate the tax invoice will recompute.
    const estimate = payload.kind === 'proforma' ? ' (estimate)' : '';
    total(`CGST @ ${(payload.ratePercent / 2).toFixed(2)}%${estimate}`, payload.cgst);
    total(`SGST @ ${(payload.ratePercent / 2).toFixed(2)}%${estimate}`, payload.sgst);
    if (payload.taxRoundedToRupee === true) {
      page.text('CGST and SGST each rounded to the nearest rupee', {
        x: taxableX - 90, size: 8, grey: 0.45,
      });
      page.down(13);
    }
  } else {
    page.text('No GST charged on this document', {
      x: taxableX - 90, size: 8.5, grey: 0.45,
    });
    page.down(15);
  }
  page.down(2);
  page.line(taxableX - 92, page.cursor + 10, amountRight - 6, page.cursor + 10, 0.6);
  total('Total payable', payload.gross, true);

  if (payload.kind === 'tax-invoice') {
    page.down(8);
    page.text(
      payload.outstanding <= 0
        ? 'Settled in full. Nothing outstanding on this invoice.'
        : `Outstanding on this invoice: INR ${money(payload.outstanding)}`,
      { size: 9.5, face: payload.outstanding > 0 ? 'bold' : 'regular' },
    );
  } else {
    page.down(8);
    page.text(
      'A proforma invoice. It is not a tax invoice and raises no liability in the ' +
      'association’s books; a tax invoice is issued on payment or on the due date.',
      { size: 9, grey: 0.3 },
    );
  }

  footer(
    page,
    payload.society.mode === 'demo'
      ? 'Generated from demonstration data. Not a valid tax invoice.'
      : 'All amounts in Indian rupees.',
  );

  return buildPdf([page], {
    title: `${payload.kind === 'tax-invoice' ? 'Tax invoice' : 'Proforma'} ${payload.documentNo}`,
    author: payload.society.name,
    subject: `Flat ${payload.flatNo}, ${payload.period}`,
  });
}

export function renderReceipt(payload: ReceiptPayload): Buffer {
  const page = new PdfPage(A4);
  const left = page.margin;
  const right = page.size.widthPt - page.margin;

  header(page, payload.society, 'RECEIPT');

  const top = page.cursor;
  page.text('Received from', { size: 8, grey: 0.45 });
  page.down(13);
  page.text(`Flat ${payload.flatNo}`, { size: 11, face: 'bold' });
  if (payload.ownerName !== null) {
    page.down(13);
    page.text(payload.ownerName, { size: 10 });
  }

  let detailY = top;
  const detail = (label: string, value: string): void => {
    page.text(label, { x: right - 190, y: detailY, size: 8.5, grey: 0.45 });
    page.textRight(value, right, { y: detailY, size: 9.5, face: 'bold' });
    detailY -= 14;
  };
  detail('Receipt no.', payload.receiptNo);
  detail('Received on', payload.receivedOn);
  detail('Method', payload.method.toUpperCase());
  if (payload.instrumentRef !== null) detail('Reference', payload.instrumentRef);

  page.cursor = Math.min(page.cursor - 30, detailY - 16);

  page.box(left, page.cursor - 6, right - left, 28);
  page.text('Amount received', { x: left + 8, size: 10 });
  page.textRight(`INR ${money(payload.amount)}`, right - 8, { size: 13, face: 'bold' });
  page.down(38);

  page.text('Applied to', { size: 8.5, grey: 0.45 });
  page.down(16);
  for (const allocation of payload.allocations) {
    page.text(allocation.taxInvoiceNo ?? 'Held on account', { x: left + 6, size: 10 });
    page.textRight(money(allocation.amount), right - 6, { size: 10, face: 'mono' });
    page.down(15);
  }
  if (payload.heldAsAdvance > 0) {
    page.down(4);
    page.text(
      `INR ${money(payload.heldAsAdvance)} is held as an advance on this flat’s account ` +
      'and will be applied to the next invoice raised.',
      { size: 9, grey: 0.3 },
    );
  }

  footer(
    page,
    payload.society.mode === 'demo'
      ? 'Generated from demonstration data. Not a valid receipt.'
      : 'This receipt acknowledges money received by the association.',
  );

  return buildPdf([page], {
    title: `Receipt ${payload.receiptNo}`,
    author: payload.society.name,
    subject: `Flat ${payload.flatNo}`,
  });
}

// --- building the payloads from the database --------------------------------

async function societyOf(tx: Queryable, societyId: string): Promise<InvoicePayload['society']> {
  const result = await tx.query<{
    name: string; registration_no: string | null; gstin: string | null;
    state_code: string | null; mode: string;
  }>(
    'SELECT name, registration_no, gstin, state_code, mode FROM societies WHERE id = $1',
    [societyId],
  );
  const row = result.rows[0];
  if (row === undefined) throw notFound('That society');
  return {
    name: row.name,
    registrationNo: row.registration_no,
    gstin: row.gstin,
    stateCode: row.state_code,
    mode: row.mode as 'demo' | 'production',
  };
}

export async function invoicePayload(
  tx: Queryable,
  input: { societyId: string; documentId: string; asAt: string },
): Promise<InvoicePayload> {
  const result = await tx.query<{
    proforma_no: string; tax_invoice_no: string | null; period: string; state: string;
    issued_on: string; due_on: string; gross: string; estimated_tax: string;
    flat_no: string; owner: string | null; outstanding: string;
    cgst: string; sgst: string; rate_bps: string | null; taxable_value: string | null;
  }>(
    `SELECT d.proforma_no, d.tax_invoice_no, d.period, d.state, d.issued_on::text,
            d.due_on::text, d.gross::text, d.estimated_tax::text, f.flat_no,
            (SELECT o.full_name FROM flat_ownership fo
               JOIN owners o ON o.id = fo.owner_id
              WHERE fo.flat_id = d.flat_id AND fo.role = 'owner' AND fo.held_until IS NULL
              LIMIT 1) AS owner,
            COALESCE((
              SELECT SUM(p.debit - p.credit)
                FROM journal_postings p
                JOIN journal_entries e ON e.id = p.entry_id
               WHERE p.society_id = d.society_id AND p.account_code = '1100'
                 AND p.doc_ref = d.tax_invoice_no AND e.entry_date <= $3::date
            ), 0)::text AS outstanding,
            COALESCE(g.cgst, 0)::text AS cgst,
            COALESCE(g.sgst, 0)::text AS sgst,
            g.rate_bps::text AS rate_bps,
            g.taxable_value::text AS taxable_value
       FROM billing_documents d
       JOIN flats f ON f.id = d.flat_id
       LEFT JOIN gst_register g ON g.document_id = d.id
      WHERE d.id = $1 AND d.society_id = $2`,
    [input.documentId, input.societyId, input.asAt],
  );
  const row = result.rows[0];
  if (row === undefined) throw notFound('That document');

  const lineRows = await tx.query<{ head: string; amount: string; taxable: string }>(
    `SELECT head, amount::text, taxable::text FROM billing_document_lines
      WHERE document_id = $1 ORDER BY position`,
    [input.documentId],
  );
  const lines = lineRows.rows.map(line => ({
    head: line.head,
    label: HEAD_LABEL[line.head] ?? line.head,
    amount: Number(line.amount),
    taxable: line.taxable === 't' || line.taxable === 'true',
  }));
  const net = lines.reduce((sum, line) => sum + line.amount, 0);

  const isTaxInvoice = row.state === 'tax-invoice' && row.tax_invoice_no !== null;
  const taxableValue = row.taxable_value === null
    ? lines.filter(l => l.taxable).reduce((sum, l) => sum + l.amount, 0)
    : Number(row.taxable_value);
  let cgst = Number(row.cgst);
  let sgst = Number(row.sgst);
  let ratePercent = row.rate_bps === null ? 0 : Number(row.rate_bps) / 100;
  let taxRoundedToRupee = false;
  if (isTaxInvoice) {
    // Read off the figures the register holds rather than today's setting, so
    // an invoice issued before the society changed its rounding still
    // describes itself truly: whole rupees that are not the paisa figure.
    taxRoundedToRupee = cgst > 0 && cgst % 100 === 0 && ratePercent > 0 &&
      cgst !== percentOf(taxableValue, ratePercent / 2);
  } else {
    // A proforma has no register row; its tax is the estimate made at issue
    // — two equal halves by construction — and it printed "No GST charged"
    // under a total that included it. Shown as the two halves at the rate
    // the society now charges, marked as an estimate.
    const estimated = Number(row.estimated_tax);
    if (estimated > 0) {
      const gst = await gstTreatment(tx, input.societyId);
      cgst = Math.floor(estimated / 2);
      sgst = estimated - cgst;
      ratePercent = gst.ratePercent;
      taxRoundedToRupee = gst.roundToRupee;
    }
  }

  return {
    kind: isTaxInvoice ? 'tax-invoice' : 'proforma',
    society: await societyOf(tx, input.societyId),
    documentNo: isTaxInvoice ? (row.tax_invoice_no as string) : row.proforma_no,
    proformaNo: row.proforma_no,
    period: row.period,
    issuedOn: row.issued_on,
    dueOn: row.due_on,
    flatNo: row.flat_no,
    ownerName: row.owner,
    lines,
    taxableValue,
    cgst,
    sgst,
    ratePercent,
    taxRoundedToRupee,
    net,
    // Before conversion the figure on the document is an estimate; after it,
    // the gross the ledger was posted with.
    gross: isTaxInvoice ? Number(row.gross) : net + Number(row.estimated_tax),
    outstanding: Number(row.outstanding),
    state: row.state,
  };
}

export async function receiptPayload(
  tx: Queryable,
  input: { societyId: string; paymentId: string },
): Promise<ReceiptPayload> {
  const result = await tx.query<{
    receipt_no: string; received_on: string; amount: string; method: string;
    instrument_ref: string | null; flat_no: string; owner: string | null;
  }>(
    `SELECT p.receipt_no, p.received_on::text, p.amount::text, p.method, p.instrument_ref,
            f.flat_no,
            (SELECT o.full_name FROM flat_ownership fo
               JOIN owners o ON o.id = fo.owner_id
              WHERE fo.flat_id = p.flat_id AND fo.role = 'owner' AND fo.held_until IS NULL
              LIMIT 1) AS owner
       FROM payments p JOIN flats f ON f.id = p.flat_id
      WHERE p.id = $1 AND p.society_id = $2`,
    [input.paymentId, input.societyId],
  );
  const row = result.rows[0];
  if (row === undefined) throw notFound('That payment');

  const allocationRows = await tx.query<{ tax_invoice_no: string | null; amount: string }>(
    `SELECT d.tax_invoice_no, a.amount::text
       FROM receipt_allocations a
       LEFT JOIN billing_documents d ON d.id = a.document_id
      WHERE a.payment_id = $1
      ORDER BY a.id`,
    [input.paymentId],
  );

  const allocations = allocationRows.rows.map(a => ({
    taxInvoiceNo: a.tax_invoice_no,
    amount: Number(a.amount),
  }));

  return {
    society: await societyOf(tx, input.societyId),
    receiptNo: row.receipt_no,
    receivedOn: row.received_on,
    flatNo: row.flat_no,
    ownerName: row.owner,
    amount: Number(row.amount),
    method: row.method,
    instrumentRef: row.instrument_ref,
    allocations,
    heldAsAdvance: allocations
      .filter(a => a.taxInvoiceNo === null)
      .reduce((sum, a) => sum + a.amount, 0),
  };
}

export type GeneratedKind = 'tax-invoice' | 'proforma' | 'receipt';

/**
 * Renders and records a document.
 *
 * The payload is stored, so the same call later reproduces the same bytes
 * rather than re-deriving them from data that may have moved. A second call
 * for the same document returns the stored payload's rendering, which is why
 * `reprint` exists and why it is the default.
 */
export async function generateDocument(
  tx: Queryable,
  input: {
    societyId: string; kind: GeneratedKind; documentId?: string; paymentId?: string;
    asAt: string; reprint?: boolean;
  },
): Promise<{ pdf: Buffer; payload: unknown; generatedId: string; reprinted: boolean }> {
  const column = input.kind === 'receipt' ? 'payment_id' : 'document_id';
  const subjectId = input.kind === 'receipt' ? input.paymentId : input.documentId;
  if (subjectId === undefined) throw badRequest('Nothing was named to generate.');

  if (input.reprint !== false) {
    const existing = await tx.query<{ id: string; render_payload: string }>(
      `SELECT id, render_payload::text FROM generated_documents
        WHERE society_id = $1 AND kind = $2 AND ${column} = $3
        ORDER BY generated_at DESC LIMIT 1`,
      [input.societyId, input.kind, subjectId],
    );
    const row = existing.rows[0];
    if (row !== undefined) {
      const payload = JSON.parse(row.render_payload) as unknown;
      const pdf = input.kind === 'receipt'
        ? renderReceipt(payload as ReceiptPayload)
        : renderInvoice(payload as InvoicePayload);
      return { pdf, payload, generatedId: row.id, reprinted: true };
    }
  }

  const payload = input.kind === 'receipt'
    ? await receiptPayload(tx, { societyId: input.societyId, paymentId: subjectId })
    : await invoicePayload(tx, {
        societyId: input.societyId, documentId: subjectId, asAt: input.asAt,
      });

  // A proforma is not recorded as a generated document: it has no number worth
  // reprinting byte-for-byte and it is superseded the moment it converts.
  const kind = input.kind === 'proforma'
    ? ((payload as InvoicePayload).kind === 'tax-invoice' ? 'tax-invoice' : 'proforma')
    : input.kind;

  const pdf = input.kind === 'receipt'
    ? renderReceipt(payload as ReceiptPayload)
    : renderInvoice(payload as InvoicePayload);

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO generated_documents
       (society_id, kind, document_id, payment_id, byte_size, sha256, render_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     RETURNING id`,
    [
      input.societyId,
      kind,
      input.kind === 'receipt' ? null : subjectId,
      input.kind === 'receipt' ? subjectId : null,
      pdf.length,
      createHash('sha256').update(pdf).digest('hex'),
      JSON.stringify(payload),
    ],
  );

  return { pdf, payload, generatedId: inserted.rows[0].id, reprinted: false };
}

export { textWidth };

/**
 * The credit note a cancellation raises, for an invoice that was issued.
 *
 * Cancelling a posted tax invoice reverses it in the ledger. The GST register
 * has to follow: a register row for an invoice that no longer exists in the
 * books overstates the period's output tax by exactly that invoice, and a
 * return filed from it would be wrong. In GST terms the cancellation of an
 * issued invoice is a credit note, so this writes one — for the whole invoice,
 * posted by the reversal entry rather than by a second posting of its own.
 *
 * Returns the note's number, or null when the invoice carried no register
 * entry (no tax was charged, so there is nothing to take back out).
 */
export async function cancellationCreditNote(
  tx: Queryable,
  input: {
    societyId: string; documentId: string; reversalEntryId: string;
    on: string; reason: string; by: string;
  },
): Promise<string | null> {
  const found = await tx.query<{
    tax_invoice_no: string | null; flat_no: string; net: string;
    cgst: string | null; sgst: string | null; taxable_value: string | null;
    rate_bps: string | null; already: string | null;
  }>(
    `SELECT d.tax_invoice_no, f.flat_no,
            COALESCE((SELECT SUM(l.amount) FROM billing_document_lines l
                       WHERE l.document_id = d.id), 0)::text AS net,
            g.cgst::text, g.sgst::text, g.taxable_value::text, g.rate_bps::text,
            (SELECT a.note_no FROM invoice_adjustments a
              WHERE a.document_id = d.id AND a.kind = 'credit'
                AND a.reason LIKE 'Cancelled:%' LIMIT 1) AS already
       FROM billing_documents d
       JOIN flats f ON f.id = d.flat_id
       LEFT JOIN gst_register g ON g.document_id = d.id AND g.entry_kind = 'invoice'
      WHERE d.id = $1 AND d.society_id = $2`,
    [input.documentId, input.societyId],
  );
  const document = found.rows[0];
  if (document === undefined) throw notFound('That document');

  // Cancelling twice is refused by the caller; this makes the note idempotent
  // anyway, so a retry cannot raise a second one.
  if (document.already !== null) return document.already;

  const net = Number(document.net);
  const cgst = Number(document.cgst ?? '0');
  const sgst = Number(document.sgst ?? '0');
  if (net <= 0) return null;

  const noteNo = await allocateNumber(
    tx,
    { societyId: input.societyId, kind: 'note', scope: 'credit' },
    async () => {
      const series = await tx.query<{ next: string }>(
        `SELECT COALESCE(MAX(NULLIF(regexp_replace(note_no, '^.*/', ''), '')::int), 0) + 1 AS next
           FROM invoice_adjustments WHERE society_id = $1 AND kind = 'credit'`,
        [input.societyId],
      );
      return `CN/${input.on.slice(0, 4)}/${String(series.rows[0].next).padStart(4, '0')}`;
    },
  );

  await tx.query(
    `INSERT INTO invoice_adjustments
       (society_id, document_id, note_no, kind, reason, amount, tax_amount,
        issued_on, approved_by, posted_entry_id)
     VALUES ($1,$2,$3,'credit',$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      input.societyId, input.documentId, noteNo,
      `Cancelled: ${input.reason}`.slice(0, 500),
      net, cgst + sgst, input.on, input.by, input.reversalEntryId,
    ],
  );

  // Only where tax was charged. An invoice that carried none has nothing to
  // take out of the register, and a zero row would just be noise in a return.
  if (cgst > 0 || sgst > 0) {
    const adjustment = await tx.query<{ id: string }>(
      'SELECT id FROM invoice_adjustments WHERE society_id = $1 AND note_no = $2',
      [input.societyId, noteNo],
    );
    await tx.query(
      `INSERT INTO gst_register
         (society_id, adjustment_id, entry_kind, tax_period, invoice_no, invoice_date,
          counterparty, supply_type, taxable_value, cgst, sgst, rate_bps)
       VALUES ($1,$2,'credit-note',$3,$4,$5,$6,'B2C',$7,$8,$9,$10)`,
      [
        input.societyId, adjustment.rows[0].id, input.on.slice(0, 7), noteNo, input.on,
        document.flat_no,
        Number(document.taxable_value ?? '0'),
        cgst, sgst, Number(document.rate_bps ?? '0'),
      ],
    );
  }

  return noteNo;
}
