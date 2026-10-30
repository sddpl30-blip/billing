/**
 * Many receipts at once, from a CSV the manager keeps or the bank exports.
 *
 * Two passes, the same as the flat import: a check that writes nothing and
 * says, line by line, what would be recorded and what is wrong; then the
 * recording, which happens only when every line passed. All or nothing: a
 * file half-recorded is a file nobody can safely upload again.
 *
 * Each receipt goes through exactly the path a single payment does (see
 * takePayment in routes.ts), so allocation to dues, advances and the
 * conversion of proformas behave the same however the money was entered.
 */

import type { Queryable } from './pg';
import { readCsvTable, rupeesToPaise } from './csv';
import { isValidIsoDate } from '../../src/accounting/clock';

export const BULK_PAYMENTS_MAX_BYTES = 512 * 1024;
export const BULK_PAYMENTS_MAX_ROWS = 1000;

export const PAYMENT_METHODS = ['upi', 'neft', 'imps', 'cheque', 'cash', 'nach', 'card'] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

/** How people write the method in a sheet, to the app's word for it. */
const METHOD_WORDS: Readonly<Record<string, PaymentMethod>> = {
  upi: 'upi', gpay: 'upi', 'google pay': 'upi', phonepe: 'upi', paytm: 'upi', bhim: 'upi',
  neft: 'neft', rtgs: 'neft', 'bank transfer': 'neft', transfer: 'neft', 'net banking': 'neft', netbanking: 'neft',
  imps: 'imps',
  cheque: 'cheque', check: 'cheque', chq: 'cheque', 'cheque deposit': 'cheque', dd: 'cheque', 'demand draft': 'cheque',
  cash: 'cash',
  nach: 'nach', 'auto debit': 'nach', ecs: 'nach',
  card: 'card', 'debit card': 'card', 'credit card': 'card',
};

export interface BulkPaymentLine {
  readonly line: number;
  readonly flatNo: string;
  readonly flatId: string | null;
  readonly amountPaise: number | null;
  readonly receivedOn: string | null;
  readonly method: PaymentMethod | null;
  readonly reference: string | null;
  /** Empty when the line can be recorded. */
  readonly problems: readonly string[];
}

function toIsoDate(text: string): string | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m !== null) return isValidIsoDate(text) ? text : null;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (m === null) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

/**
 * Reads the file and checks every line against the books. Writes nothing.
 *
 * A line is refused, not guessed at, when the flat is unknown, the amount or
 * date does not read, the date is in the future, or the method is not one the
 * books know. A line that repeats another in the file, or a receipt already on
 * the books with the same flat, date, amount and reference, is refused as a
 * likely double entry: taking one payment twice is the mistake bulk entry
 * makes easy.
 */
export async function checkBulkPayments(
  tx: Queryable,
  input: { societyId: string; csv: string; today: string },
): Promise<BulkPaymentLine[]> {
  const table = readCsvTable(input.csv, {
    aliases: {
      flat_no: ['flat', 'flat_number', 'flatno', 'unit', 'unit_no'],
      amount: ['amount_rs', 'amount_inr', 'rupees', 'paid', 'amount_paid'],
      received_on: ['date', 'paid_on', 'payment_date', 'received', 'date_received'],
      method: ['mode', 'payment_mode', 'payment_method', 'paid_by'],
      reference: ['ref', 'reference_no', 'utr', 'cheque_no', 'instrument', 'transaction_id', 'txn_id'],
    },
    required: ['flat_no', 'amount', 'received_on', 'method'],
    maxRows: BULK_PAYMENTS_MAX_ROWS,
    maxBytes: BULK_PAYMENTS_MAX_BYTES,
  });

  const flats = await tx.query<{ id: string; flat_no: string }>(
    'SELECT id, flat_no FROM flats WHERE society_id = $1',
    [input.societyId],
  );
  const flatByNo = new Map(flats.rows.map(f => [f.flat_no.trim().toUpperCase(), f]));

  const seen = new Map<string, number>();
  const lines: BulkPaymentLine[] = [];
  for (const { line, values } of table.rows) {
    const problems: string[] = [];
    const flatNo = (values.flat_no ?? '').trim();
    const flat = flatByNo.get(flatNo.toUpperCase()) ?? null;
    if (flatNo === '') problems.push('no flat number');
    else if (flat === null) problems.push(`no flat "${flatNo}" in the society`);

    const amount = rupeesToPaise(values.amount ?? '');
    if (amount === null) problems.push(`amount "${values.amount}" is not rupees`);
    else if (amount <= 0) problems.push('amount must be more than zero');

    const dateText = (values.received_on ?? '').trim();
    const receivedOn = toIsoDate(dateText);
    if (receivedOn === null) problems.push(`date "${dateText}" is not a date (use DD/MM/YYYY or YYYY-MM-DD)`);
    else if (receivedOn > input.today) problems.push(`date ${receivedOn} is in the future`);

    const methodText = (values.method ?? '').trim().toLowerCase();
    const method = METHOD_WORDS[methodText] ?? null;
    if (method === null) {
      problems.push(`payment mode "${values.method}" is not one of UPI, NEFT, IMPS, cheque, cash, NACH, card`);
    }

    const reference = (values.reference ?? '').trim() || null;
    if (reference !== null && reference.length > 100) problems.push('reference is longer than 100 characters');

    if (flat !== null && amount !== null && amount > 0 && receivedOn !== null) {
      const fingerprint = `${flat.id}|${receivedOn}|${amount}|${(reference ?? '').toUpperCase()}`;
      const earlier = seen.get(fingerprint);
      if (earlier !== undefined) {
        problems.push(`repeats line ${earlier} (same flat, date, amount and reference)`);
      } else {
        seen.set(fingerprint, line);
        const existing = await tx.query<{ receipt_no: string }>(
          `SELECT receipt_no FROM payments
            WHERE society_id = $1 AND flat_id = $2 AND received_on = $3 AND amount = $4
              AND COALESCE(upper(instrument_ref), '') = $5
            LIMIT 1`,
          [input.societyId, flat.id, receivedOn, amount, (reference ?? '').toUpperCase()],
        );
        if (existing.rows[0] !== undefined) {
          problems.push(`already recorded as receipt ${existing.rows[0].receipt_no}`);
        }
      }
    }

    lines.push({
      line,
      flatNo: flat?.flat_no ?? flatNo,
      flatId: flat?.id ?? null,
      amountPaise: amount !== null && amount > 0 ? amount : null,
      receivedOn,
      method,
      reference,
      problems,
    });
  }
  return lines;
}
