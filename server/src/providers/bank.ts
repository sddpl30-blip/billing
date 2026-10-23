/**
 * Bank statement parsing and the future-API adapter.
 *
 * ── PARSERS: REAL. BANK API: NOT CONNECTED ──────────────────────────────────
 * The CSV and MT940 parsers below work and are tested. The `BankApiProvider`
 * interface is the seam a real bank integration plugs into, and there is no
 * implementation: no credentials, no sandbox, no agreement.
 *
 * There is deliberately no column anywhere in the schema for an
 * internet-banking password, customer id or API secret, and no parameter here
 * accepts one. A statement import needs a file; it does not need the ability
 * to log in as the society.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { sha256 } from '../security';
import { ProviderNotConfiguredError } from './otp';

export interface ParsedTransaction {
  /** ISO date. */
  readonly valueDate: string;
  readonly narration: string;
  readonly reference?: string;
  /** Signed paise: positive is money in. */
  readonly amount: number;
  readonly runningBalance?: number;
  /**
   * The deduplication key: the bank's own reference where it gives one, else a
   * hash of the fields that identify the line. Unique per account, so
   * re-importing an overlapping statement adds nothing.
   */
  readonly dedupeKey: string;
}

export interface ParseResult {
  readonly transactions: readonly ParsedTransaction[];
  /** Lines that could not be read, with why. Never silently dropped. */
  readonly rejected: ReadonlyArray<{ line: number; raw: string; why: string }>;
  readonly periodFrom?: string;
  readonly periodTo?: string;
}

export class StatementFormatError extends Error {}

/** Rupees as a bank writes them — "1,23,456.78" or "(500.00)" — to paise. */
function parseAmount(raw: string): number | null {
  const text = raw.trim().replace(/[₹\s,]/g, '');
  if (text === '') return null;
  // Parentheses are a debit in many Indian bank exports.
  const negative = /^\(.*\)$/.test(text) || text.startsWith('-');
  const digits = text.replace(/[()\-+]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(digits)) return null;
  const paise = Math.round(Number(digits) * 100);
  return negative ? -paise : paise;
}

/** A date as banks write it, to ISO. Day-first, which is the Indian convention. */
function parseDate(raw: string): string | null {
  const text = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m !== null) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (m !== null) {
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})$/.exec(text);
  if (m !== null) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const index = months.indexOf(m[2].toLowerCase());
    if (index === -1) return null;
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${String(index + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/** Splits one CSV line, honouring quotes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; } else { quoted = false; }
      } else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(current); current = ''; }
    else current += ch;
  }
  out.push(current);
  return out;
}

/**
 * Parses a CSV statement.
 *
 * Column names vary by bank, so headers are matched by what they contain
 * rather than by exact string. A file whose header cannot be understood is an
 * error — guessing which column is the amount is not a risk worth taking.
 */
export function parseCsvStatement(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) {
    throw new StatementFormatError('The file has no data rows.');
  }

  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  // A short needle like 'dr' or 'cr' is matched as a word, not a substring:
  // as a substring 'cr' finds "Description", and a statement whose narration
  // column came before its deposit column read the narration as the credit.
  const matches = (h: string, n: string): boolean =>
    n.length <= 2 ? new RegExp(`(^|[^a-z])${n}([^a-z]|$)`).test(h) : h.includes(n);
  const find = (...needles: string[]): number =>
    header.findIndex(h => needles.some(n => matches(h, n)));

  const dateAt = find('value date', 'txn date', 'transaction date', 'date');
  const narrationAt = find('narration', 'description', 'particulars', 'remarks');
  const refAt = find('ref no', 'reference', 'cheque', 'utr');
  const debitAt = find('withdrawal', 'debit', 'dr');
  const creditAt = find('deposit', 'credit', 'cr');
  const amountAt = find('amount');
  const balanceAt = find('balance');

  if (dateAt === -1) {
    throw new StatementFormatError(
      `No date column found. Headers were: ${header.join(', ')}`,
    );
  }
  if (debitAt === -1 && creditAt === -1 && amountAt === -1) {
    throw new StatementFormatError(
      `No amount column found. Headers were: ${header.join(', ')}`,
    );
  }

  const transactions: ParsedTransaction[] = [];
  const rejected: Array<{ line: number; raw: string; why: string }> = [];

  for (const [index, raw] of lines.slice(1).entries()) {
    const lineNo = index + 2;
    const cells = splitCsvLine(raw);
    const valueDate = parseDate(cells[dateAt] ?? '');
    if (valueDate === null) {
      rejected.push({ line: lineNo, raw, why: `"${cells[dateAt] ?? ''}" is not a date` });
      continue;
    }

    let amount: number | null = null;
    if (debitAt !== -1 || creditAt !== -1) {
      const debit = debitAt === -1 ? null : parseAmount(cells[debitAt] ?? '');
      const credit = creditAt === -1 ? null : parseAmount(cells[creditAt] ?? '');
      if (debit !== null && debit !== 0) amount = -Math.abs(debit);
      else if (credit !== null && credit !== 0) amount = Math.abs(credit);
    } else {
      amount = parseAmount(cells[amountAt] ?? '');
    }

    if (amount === null || amount === 0) {
      rejected.push({ line: lineNo, raw, why: 'no usable amount on this row' });
      continue;
    }

    const narration = (narrationAt === -1 ? '' : (cells[narrationAt] ?? '')).trim() || '(no narration)';
    const reference = refAt === -1 ? '' : (cells[refAt] ?? '').trim();
    const balance = balanceAt === -1 ? null : parseAmount(cells[balanceAt] ?? '');

    transactions.push({
      valueDate,
      narration,
      ...(reference !== '' ? { reference } : {}),
      amount,
      ...(balance !== null ? { runningBalance: balance } : {}),
      // The bank's reference is the best key; without one, the fields that
      // identify the line. Two genuinely identical lines on one day collapse
      // into one, which is the lesser error against importing one twice.
      dedupeKey: reference !== ''
        ? `ref:${reference}`
        : `hash:${sha256(`${valueDate}|${amount}|${narration}`).slice(0, 32)}`,
    });
  }

  const dates = transactions.map(t => t.valueDate).sort();
  return {
    transactions,
    rejected,
    ...(dates.length > 0 ? { periodFrom: dates[0], periodTo: dates[dates.length - 1] } : {}),
  };
}

/**
 * Parses an MT940 statement.
 *
 * Handles the tags that carry the transactions: :20: reference, :25: account,
 * :60F:/:62F: opening and closing balance, :61: the statement line and :86:
 * its narration. Other tags are ignored rather than rejected — an MT940 from a
 * bank nobody has seen yet should import its transactions, not fail wholesale.
 */
export function parseMt940Statement(text: string): ParseResult {
  const transactions: ParsedTransaction[] = [];
  const rejected: Array<{ line: number; raw: string; why: string }> = [];

  // Tags start at the beginning of a line; a field can continue onto the next.
  const normalised = text.replace(/\r\n/g, '\n');
  const chunks = normalised.split(/\n(?=:\d{2}[A-Z]?:)/);

  let pending: ParsedTransaction | null = null;
  let periodFrom: string | undefined;
  let periodTo: string | undefined;

  const flush = (): void => {
    if (pending !== null) {
      transactions.push(pending);
      pending = null;
    }
  };

  for (const [index, chunk] of chunks.entries()) {
    const tagMatch = /^:(\d{2}[A-Z]?):([\s\S]*)$/.exec(chunk.trim());
    if (tagMatch === null) continue;
    const [, tag, value] = tagMatch;
    const body = value.replace(/\n/g, ' ').trim();

    if (tag === '60F' || tag === '62F') {
      // 60F:C230701INR1234,56 — mark, yymmdd, currency, amount with a comma.
      const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)$/.exec(body);
      if (m !== null) {
        const iso = `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}`;
        if (tag === '60F') periodFrom = iso; else periodTo = iso;
      }
      continue;
    }

    if (tag === '61') {
      flush();
      // 61:2307010701CN1234,56NTRFref//bankref
      const m = /^(\d{6})(\d{4})?([CD])([DR])?([\d,]+)([A-Z][A-Z0-9]{3})(.*)$/.exec(body);
      if (m === null) {
        rejected.push({ line: index + 1, raw: chunk.trim(), why: 'the :61: line could not be read' });
        continue;
      }
      const iso = `20${m[1].slice(0, 2)}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`;
      const magnitude = Math.round(Number(m[5].replace(',', '.')) * 100);
      if (!Number.isFinite(magnitude) || magnitude === 0) {
        rejected.push({ line: index + 1, raw: chunk.trim(), why: 'no usable amount' });
        continue;
      }
      const amount = m[3] === 'C' ? magnitude : -magnitude;
      const refs = (m[7] ?? '').split('//');
      const reference = (refs[1] ?? refs[0] ?? '').trim();

      pending = {
        valueDate: iso,
        narration: '(awaiting :86:)',
        ...(reference !== '' ? { reference } : {}),
        amount,
        dedupeKey: reference !== ''
          ? `ref:${reference}`
          : `hash:${sha256(`${iso}|${amount}|${body}`).slice(0, 32)}`,
      };
      continue;
    }

    if (tag === '86' && pending !== null) {
      pending = { ...pending, narration: body === '' ? '(no narration)' : body };
      continue;
    }
  }
  flush();

  if (transactions.length === 0 && rejected.length === 0) {
    throw new StatementFormatError('No :61: statement lines were found; is this an MT940 file?');
  }

  return {
    transactions,
    rejected,
    ...(periodFrom !== undefined ? { periodFrom } : {}),
    ...(periodTo !== undefined ? { periodTo } : {}),
  };
}

export function parseStatement(format: 'csv' | 'xlsx' | 'mt940', text: string): ParseResult {
  if (format === 'csv') return parseCsvStatement(text);
  if (format === 'mt940') return parseMt940Statement(text);
  throw new StatementFormatError(
    'xlsx is not parsed here. Export the sheet as CSV and import that: reading the ' +
    'binary format needs a spreadsheet library, and none is vendored.',
  );
}

// --- the future bank API ---------------------------------------------------

export interface BankApiProvider {
  readonly name: string;
  fetchTransactions(input: {
    accountRef: string; from: string; to: string;
  }): Promise<readonly ParsedTransaction[]>;
  /** Allocates a per-flat virtual account, where the bank supports it. */
  createVirtualAccount(input: { flatNo: string }): Promise<{ virtualRef: string; upiId?: string }>;
}

/**
 * NOT CONNECTED. Every method refuses.
 *
 * Present so the call sites exist and are typed, and so nothing has to be
 * restructured when a bank agreement is in place. It refuses rather than
 * returning empty results, because an empty statement looks like a quiet day.
 */
export function unconfiguredBankApi(): BankApiProvider {
  return {
    name: 'none',
    async fetchTransactions() {
      throw new ProviderNotConfiguredError('bank API');
    },
    async createVirtualAccount() {
      throw new ProviderNotConfiguredError('virtual account');
    },
  };
}
