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
import { A4, PdfPage, buildPdf, money, textWidth, wrapText } from './pdf';
import { societyLogo } from './societyLogo';
import { migrationApplied, periodBounds, societyInitials } from './billing';
import { billPeriodLabel, isOpeningDocument } from '../../src/accounting/billLabel';
import type { Queryable } from './pg';
import { badRequest, notFound } from './http';
import { allocateNumber } from './series';
import { dueDays, gstTreatment, rateOnDate } from './settings';
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
  /**
   * Set for an opening due brought forward (OB/…): the period as it should
   * read, e.g. "Arrears upto Sep 2026". Such a document is not a tax
   * invoice, carries no GST and is not in the GST register, and its PDF says
   * so rather than "TAX INVOICE".
   */
  readonly openingLabel?: string;
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
  /**
   * What the association's own proforma format prints beyond the above: its
   * letterhead, the billing period's dates, the pay-in bank account, the area
   * and rate behind the maintenance line, and the flat's previous
   * outstanding. Present on proformas generated since that format; an older
   * stored copy, without it, keeps rendering in the layout it was issued in.
   */
  readonly pi?: ProformaDetails;
}

export interface ProformaDetails {
  readonly societyName: string;
  readonly pan: string | null;
  readonly tan: string | null;
  readonly contactEmail: string | null;
  readonly bank: { name: string; branch: string | null; accountNo: string; ifsc: string } | null;
  readonly invoiceDate: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly areaSqft: number | null;
  readonly ratePerSqFt: number | null;
  /** The flat's dues from earlier bills and arrears, less any advance held. Negative is a credit. */
  readonly previousOutstanding: number;
  readonly daysToPay: number;
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

export function renderInvoice(stored: InvoicePayload): Buffer {
  if (stored.kind === 'proforma' && stored.pi !== undefined && stored.openingLabel === undefined) {
    return renderProformaInvoice(stored, stored.pi);
  }
  return renderStandardInvoice(stored);
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 === 0 ? '' : ` ${ONES[n % 10]}`}`;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds > 0 ? `${ONES[hundreds]} Hundred` : '', rest > 0 ? belowHundred(rest) : '']
    .filter(p => p !== '').join(' ');
}

/** Paise in words, Indian style: "Rupees Nine Thousand Two Hundred Ninety Three Only". */
export function rupeesInWords(paise: number): string {
  const negative = paise < 0;
  const absolute = Math.abs(Math.round(paise));
  let rupees = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  if (rupees === 0 && fraction === 0) return 'Rupees Zero Only';
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000); rupees %= 10_000_000;
  const lakh = Math.floor(rupees / 100_000); rupees %= 100_000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore > 0) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh > 0) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rupees > 0) parts.push(belowThousand(rupees));
  const words = parts.join(' ');
  return `${negative ? 'Minus ' : ''}Rupees ${words === '' ? 'Zero' : words}` +
    `${fraction > 0 ? ` and ${belowHundred(fraction)} Paise` : ''} Only`;
}

/** 2026-10-01 as 01.10.2026, as the association writes dates. */
const dotted = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Whole areas with Indian grouping: 1,808. */
function groupedWhole(n: number): string {
  const digits = String(Math.round(n));
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d\d)+(?!\d))/g, ',');
  return `${head},${digits.slice(-3)}`;
}

/**
 * A proforma in the association's own format, from its Word template: the
 * letterhead with its PAN, GSTIN, TAN and e-mail; PI number, invoice date and
 * billing period; bill-to and the bank to pay into; the service lines with
 * SAC codes; taxable value, CGST, SGST and previous outstanding; the total in
 * words; payment details and notes.
 */
function renderProformaInvoice(payload: InvoicePayload, pi: ProformaDetails): Buffer {
  const page = new PdfPage(A4, 40);
  const left = page.margin;
  const right = page.size.widthPt - page.margin;
  const width = right - left;
  const logo = societyLogo(pi.societyName);

  page.textRight('PROFORMA INVOICE', left + width / 2 + textWidth('PROFORMA INVOICE', 14, 'bold') / 2, { size: 14, face: 'bold' });
  page.down(14);
  if (payload.society.mode === 'demo') {
    page.textRight('DEMONSTRATION DATA - NOT A VALID DOCUMENT', right, { size: 8, face: 'bold', grey: 0.35 });
    page.down(10);
  }

  // Letterhead.
  const headTop = page.cursor;
  const headHeight = 92;
  page.frame(left, headTop - headHeight, width, headHeight);
  const textX = logo === null ? left + 10 : left + 96;
  if (logo !== null) page.image('Logo', left + 8, headTop - headHeight + 6, 80, 80);
  let y = headTop - 18;
  const heading = pi.societyName.includes('(')
    ? pi.societyName.toUpperCase()
    : `${pi.societyName.toUpperCase()} (${societyInitials(pi.societyName)})`;
  page.text(heading, { x: textX, y, size: 12, face: 'bold' });
  const idLines = [
    pi.pan === null ? null : `PAN: ${pi.pan}`,
    payload.society.gstin === null ? null : `GSTIN: ${payload.society.gstin}`,
    `TAN: ${pi.tan ?? 'Application in process'}`,
    pi.contactEmail === null ? null : `Official Email: ${pi.contactEmail}`,
  ].filter((l): l is string => l !== null);
  for (const line of idLines) {
    y -= 14;
    page.text(line, { x: textX, y, size: 9.5 });
  }
  page.cursor = headTop - headHeight - 12;

  // PI number, date and period.
  const thirds = width / 3;
  const rowTop = page.cursor;
  page.frame(left, rowTop - 34, width, 34);
  page.line(left + thirds, rowTop, left + thirds, rowTop - 34, 0.55, 0.6);
  page.line(left + 2 * thirds, rowTop, left + 2 * thirds, rowTop - 34, 0.55, 0.6);
  const cell = (i: number, label: string, value: string): void => {
    page.text(label, { x: left + i * thirds + 6, y: rowTop - 12, size: 8, grey: 0.4 });
    page.text(value, { x: left + i * thirds + 6, y: rowTop - 26, size: 9.5, face: 'bold' });
  };
  cell(0, 'PI No.', payload.documentNo);
  cell(1, 'Invoice Date', dotted(pi.invoiceDate));
  cell(2, 'Billing Period', `${dotted(pi.periodFrom)} to ${dotted(pi.periodTo)}`);
  page.cursor = rowTop - 34 - 12;

  // Bill to, and where to pay.
  const half = width / 2;
  const boxTop = page.cursor;
  const boxHeight = 74;
  page.frame(left, boxTop - boxHeight, width, boxHeight);
  page.line(left + half, boxTop, left + half, boxTop - boxHeight, 0.55, 0.6);
  page.box(left + 0.5, boxTop - 16, width - 1, 15.5, 0.92);
  page.text('BILL TO', { x: left + 6, y: boxTop - 12, size: 8.5, face: 'bold' });
  page.text('ASSOCIATION BANK DETAILS', { x: left + half + 6, y: boxTop - 12, size: 8.5, face: 'bold' });
  page.text(payload.ownerName ?? 'Owner not on record', { x: left + 6, y: boxTop - 32, size: 10, face: 'bold' });
  page.text(`Unit No.: ${payload.flatNo}`, { x: left + 6, y: boxTop - 47, size: 9.5 });
  if (pi.bank === null) {
    page.text('Not yet entered in the society profile.', { x: left + half + 6, y: boxTop - 32, size: 9, grey: 0.4 });
  } else {
    const bankLines = [
      `Bank: ${pi.bank.name}`,
      ...(pi.bank.branch === null ? [] : [`Branch: ${pi.bank.branch}`]),
      `Account No.: ${pi.bank.accountNo}`,
      `IFSC: ${pi.bank.ifsc}`,
    ];
    bankLines.forEach((line, i) => page.text(line, { x: left + half + 6, y: boxTop - 30 - i * 12.5, size: 9 }));
  }
  page.cursor = boxTop - boxHeight - 14;

  // The service lines.
  const cols = { sno: left + 6, desc: left + 40, sac: left + 255, qty: left + 310, rateRight: left + 425, amountRight: right - 6 };
  const tableTop = page.cursor;
  page.box(left, tableTop - 20, width, 20, 0.92);
  page.text('S. No.', { x: cols.sno, y: tableTop - 13, size: 8, face: 'bold' });
  page.text('Description of Service', { x: cols.desc, y: tableTop - 13, size: 8, face: 'bold' });
  page.text('SAC', { x: cols.sac, y: tableTop - 13, size: 8, face: 'bold' });
  page.text('Qty./Area', { x: cols.qty, y: tableTop - 13, size: 8, face: 'bold' });
  page.textRight('Rate (INR)', cols.rateRight, { y: tableTop - 13, size: 8, face: 'bold' });
  page.textRight('Amount (INR)', cols.amountRight, { y: tableTop - 13, size: 8, face: 'bold' });
  let rowY = tableTop - 20;
  let serial = 0;
  for (const line of payload.lines) {
    serial += 1;
    const isCam = line.head === 'maintenance';
    const description = isCam ? ['Common Area Maintenance (CAM)', `Charges (Unit No. ${payload.flatNo})`] : [line.label];
    const height = 8 + description.length * 12;
    page.text(String(serial), { x: cols.sno, y: rowY - 13, size: 9 });
    description.forEach((d, i) => page.text(d, { x: cols.desc, y: rowY - 13 - i * 12, size: 9 }));
    if (isCam) {
      page.text('998599', { x: cols.sac, y: rowY - 13, size: 9 });
      if (pi.areaSqft !== null) page.text(`${groupedWhole(pi.areaSqft)} sq. ft.`, { x: cols.qty, y: rowY - 13, size: 9 });
      if (pi.ratePerSqFt !== null) page.textRight(pi.ratePerSqFt.toFixed(2), cols.rateRight, { y: rowY - 13, size: 9 });
    }
    page.textRight(money(line.amount), cols.amountRight, { y: rowY - 13, size: 9, face: 'mono' });
    rowY -= height;
    page.line(left, rowY, right, rowY, 0.8);
  }
  page.frame(left, rowY, width, tableTop - rowY);
  page.cursor = rowY - 8;

  // The figures.
  const labelX = left + width * 0.45;
  const sumTop = page.cursor;
  const sums: Array<[string, number, boolean]> = [];
  const nonTaxable = payload.net - payload.taxableValue;
  sums.push(['Taxable Value', payload.taxableValue, false]);
  if (payload.cgst > 0 || payload.sgst > 0) {
    const half = String(Number((payload.ratePercent / 2).toFixed(2)));
    sums.push([`Add: CGST @ ${half}%`, payload.cgst, false]);
    sums.push([`Add: SGST @ ${half}%`, payload.sgst, false]);
  } else {
    sums.push(['GST: not applicable on this bill', 0, false]);
  }
  if (nonTaxable > 0) sums.push(['Add: Charges not subject to GST', nonTaxable, false]);
  // This bill on its own, before what was owed already, when the two differ.
  if (pi.previousOutstanding !== 0) sums.push(['Current Bill Value', payload.gross, false]);
  sums.push([pi.previousOutstanding < 0 ? 'Less: Advance held' : 'Previous Outstanding', pi.previousOutstanding, false]);
  const totalValue = payload.gross + pi.previousOutstanding;
  sums.push(['Total Invoice Value', totalValue, true]);
  let sy = sumTop;
  for (const [label, value, bold] of sums) {
    if (bold) page.box(labelX, sy - 18, right - labelX, 18, 0.92);
    page.text(label, { x: labelX + 6, y: sy - 13, size: 9.5, face: bold ? 'bold' : 'regular' });
    page.textRight(money(value), cols.amountRight, { y: sy - 13, size: 9.5, face: bold ? 'bold' : 'mono' });
    sy -= 18;
    page.line(labelX, sy, right, sy, 0.8);
  }
  page.frame(labelX, sy, right - labelX, sumTop - sy);
  page.cursor = sy - 18;

  page.text('Total Value (in words):', { size: 9.5, face: 'bold' });
  const words = wrapText(rupeesInWords(totalValue), width - 120, 9.5);
  words.forEach((w, i) => page.text(w, { x: left + 118, y: page.cursor - i * 12, size: 9.5 }));
  page.down(12 * words.length + 12);

  const paragraph = (text: string, size = 9): void => {
    for (const line of wrapText(text, width, size)) {
      page.text(line, { size });
      page.down(size + 3);
    }
  };
  page.text('PAYMENT DETAILS', { size: 9.5, face: 'bold' });
  page.down(13);
  paragraph(
    'Please remit payment to the association bank account mentioned above. Kindly quote the PI number and unit ' +
    'number in the payment narration and share the transaction reference with the Association' +
    (pi.contactEmail === null ? '.' : ` at ${pi.contactEmail}.`),
  );
  page.down(6);
  page.text('NOTES', { size: 9.5, face: 'bold' });
  page.down(13);
  const notes = [
    'All figures are in Rupees unless otherwise mentioned/not applicable.',
    `Kindly settle your outstanding amount payment within ${pi.daysToPay} days (if any) to avoid disruption of services.`,
    `Kindly pay by Cheque/DD/or Pay Order in favor of ${pi.societyName.toUpperCase()}.`,
    'Late payments shall attract delay penalty/interest at the rate 18% p.a.',
    'Cheque bouncing charges of rupees 1000+GST will apply in case of dishonored of cheques.',
    'This is computer generated statement and does not require signature.',
  ];
  for (const note of notes) {
    const lines = wrapText(note, width - 14, 8.5);
    lines.forEach((line, i) => {
      if (i === 0) page.text('\u2022', { size: 8.5 });
      page.text(line, { x: left + 12, size: 8.5 });
      page.down(11);
    });
  }

  return buildPdf([page], {
    title: `Proforma invoice ${payload.documentNo}`,
    author: pi.societyName,
    subject: `Unit ${payload.flatNo}, ${dotted(pi.periodFrom)} to ${dotted(pi.periodTo)}`,
  }, logo === null ? {} : { Logo: logo });
}

function renderStandardInvoice(stored: InvoicePayload): Buffer {
  // A copy printed before opening dues had their own label is re-rendered
  // from its saved payload; its OB/ number is enough to label it correctly.
  const payload: InvoicePayload = stored.openingLabel === undefined && isOpeningDocument(stored.documentNo)
    ? { ...stored, openingLabel: billPeriodLabel(stored.period, stored.documentNo) }
    : stored;
  const page = new PdfPage(A4);
  const left = page.margin;
  const right = page.size.widthPt - page.margin;

  header(
    page,
    payload.society,
    payload.openingLabel !== undefined
      ? 'STATEMENT OF ARREARS'
      : payload.kind === 'tax-invoice' ? 'TAX INVOICE' : 'PROFORMA INVOICE',
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
  if (payload.openingLabel !== undefined) {
    detail('Reference', payload.documentNo);
    detail('For', payload.openingLabel);
  } else {
    detail(payload.kind === 'tax-invoice' ? 'Invoice no.' : 'Proforma no.', payload.documentNo);
    if (payload.kind === 'tax-invoice') detail('Raised from', payload.proformaNo);
    detail('Period', payload.period);
  }
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

  if (payload.openingLabel !== undefined) {
    page.down(8);
    page.text(
      payload.outstanding <= 0
        ? 'Settled in full. Nothing outstanding.'
        : `Outstanding: INR ${money(payload.outstanding)}`,
      { size: 9.5, face: payload.outstanding > 0 ? 'bold' : 'regular' },
    );
    page.down(14);
    page.text(
      'What this flat owed when the association\u2019s accounts moved to this portal. It is not a ' +
      'tax invoice and carries no GST; any tax was accounted for when the original bills were raised.',
      { size: 9, grey: 0.3 },
    );
  } else if (payload.kind === 'tax-invoice') {
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
    title: `${payload.openingLabel !== undefined ? 'Arrears' : payload.kind === 'tax-invoice' ? 'Tax invoice' : 'Proforma'} ${payload.documentNo}`,
    author: payload.society.name,
    subject: `Flat ${payload.flatNo}, ${payload.openingLabel ?? payload.period}`,
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
    opening_as_at: string | null;
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
            g.taxable_value::text AS taxable_value,
            (SELECT b.as_at::text FROM opening_balance_batches b WHERE b.id = d.opening_batch_id) AS opening_as_at
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

  const society = await societyOf(tx, input.societyId);
  const pi = !isTaxInvoice && row.opening_as_at === null
    ? await proformaDetails(tx, {
        societyId: input.societyId, documentId: input.documentId, period: row.period,
        issuedOn: row.issued_on, asAt: input.asAt, gstin: society.gstin,
      })
    : undefined;

  return {
    kind: isTaxInvoice ? 'tax-invoice' : 'proforma',
    society,
    documentNo: isTaxInvoice ? (row.tax_invoice_no as string) : row.proforma_no,
    proformaNo: row.proforma_no,
    period: row.period,
    ...(row.opening_as_at === null
      ? {}
      : { openingLabel: billPeriodLabel(row.period, row.proforma_no, row.opening_as_at) }),
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
    ...(pi === undefined ? {} : { pi }),
  };
}

/** What the association's proforma format prints beyond the bill itself. */
async function proformaDetails(
  tx: Queryable,
  input: { societyId: string; documentId: string; period: string; issuedOn: string; asAt: string; gstin: string | null },
): Promise<ProformaDetails> {
  const withBank = await migrationApplied(tx, '012_opening_dues_and_pi_details.sql');
  const found = await tx.query<{
    name: string; tan: string | null; contact_email: string | null;
    pay_bank_name: string | null; pay_branch: string | null; pay_account_no: string | null; pay_ifsc: string | null;
  }>(
    `SELECT name, tan, contact_email, ${withBank
      ? 'pay_bank_name, pay_branch, pay_account_no, pay_ifsc'
      : 'NULL AS pay_bank_name, NULL AS pay_branch, NULL AS pay_account_no, NULL AS pay_ifsc'}
       FROM societies WHERE id = $1`,
    [input.societyId],
  );
  const soc = found.rows[0];
  if (soc === undefined) throw notFound('That society');

  const flat = await tx.query<{ flat_id: string; flat_no: string; area: string | null }>(
    `SELECT d.flat_id, f.flat_no, f.billing_area_sqft::text AS area
       FROM billing_documents d JOIN flats f ON f.id = d.flat_id WHERE d.id = $1`,
    [input.documentId],
  );
  const f = flat.rows[0];
  if (f === undefined) throw notFound('That document');

  // Earlier bills and arrears still owed, less any advance held: what the
  // member owes besides this bill, as at the day it is printed.
  const balances = await tx.query<{ owed: string; advance: string }>(
    `SELECT COALESCE((
              SELECT SUM(p.debit - p.credit)
                FROM journal_postings p
                JOIN journal_entries e ON e.id = p.entry_id
                JOIN billing_documents d ON d.society_id = p.society_id AND d.tax_invoice_no = p.doc_ref
               WHERE p.society_id = $1 AND p.account_code = '1100' AND d.flat_id = $2
                 AND d.id <> $3 AND e.entry_date <= $4::date
            ), 0)::text AS owed,
            COALESCE((
              SELECT SUM(p.credit - p.debit)
                FROM journal_postings p
                JOIN journal_entries e ON e.id = p.entry_id
               WHERE p.society_id = $1 AND p.account_code = '2300' AND p.party = $5
                 AND e.entry_date <= $4::date
            ), 0)::text AS advance`,
    [input.societyId, f.flat_id, input.documentId, input.asAt, f.flat_no],
  );
  const owed = Number(balances.rows[0]?.owed ?? '0');
  const advance = Number(balances.rows[0]?.advance ?? '0');

  const bounds = periodBounds(input.period);
  const rate = await rateOnDate(tx, { societyId: input.societyId, on: bounds.startsOn });
  const bank = soc.pay_bank_name !== null && soc.pay_account_no !== null && soc.pay_ifsc !== null
    ? { name: soc.pay_bank_name, branch: soc.pay_branch, accountNo: soc.pay_account_no, ifsc: soc.pay_ifsc }
    : null;

  return {
    societyName: soc.name,
    // The PAN is characters 3 to 12 of the GSTIN, so it is printed only from one.
    pan: input.gstin === null ? null : input.gstin.slice(2, 12),
    tan: soc.tan,
    contactEmail: soc.contact_email,
    bank,
    invoiceDate: input.issuedOn,
    periodFrom: bounds.startsOn,
    periodTo: bounds.endsOn,
    areaSqft: f.area === null ? null : Number(f.area),
    ratePerSqFt: rate === null ? null : rate.ratePerSqFt,
    previousOutstanding: owed - advance,
    daysToPay: await dueDays(tx, input.societyId),
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
