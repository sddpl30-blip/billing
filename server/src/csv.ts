/**
 * Reading a CSV file that a committee member made in a spreadsheet.
 *
 * Used by the imports that take a sheet of flats or of opening balances. The
 * bank statement parser has its own line splitter because a statement never
 * holds a quoted line break; an address or a name in a members' sheet can, so
 * this one reads the file as a whole rather than line by line.
 *
 * Every row keeps the line number it started on, because a per-row error the
 * user cannot find in their sheet is not much use to them.
 */

import { badRequest } from './http';

export interface CsvRow {
  /** The 1-based line in the file where this row starts. */
  readonly line: number;
  /** Values keyed by the canonical column name. */
  readonly values: Readonly<Record<string, string>>;
}

export interface CsvTable {
  /** Canonical names of the columns that were recognised, in file order. */
  readonly columns: readonly string[];
  /** Headers that matched no known column; reported, not fatal. */
  readonly ignored: readonly string[];
  readonly rows: readonly CsvRow[];
}

/** Splits text into records of cells, honouring quotes, with each record's starting line. */
export function parseCsvRecords(text: string): Array<{ line: number; cells: string[] }> {
  const records: Array<{ line: number; cells: string[] }> = [];
  // A UTF-8 byte-order mark is what Excel puts at the front of "CSV UTF-8".
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let touched = false;

  const endRecord = (): void => {
    cells.push(cell);
    // A blank line, or one holding only separators, is not a row.
    if (cells.some(c => c.trim() !== '')) records.push({ line: recordLine, cells });
    cells = [];
    cell = '';
    touched = false;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === '') { quoted = true; cell = ''; touched = true; continue; }
    if (ch === ',') { cells.push(cell); cell = ''; touched = true; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      endRecord();
      line++;
      recordLine = line;
      continue;
    }
    cell += ch;
    touched = true;
  }
  if (quoted) throw badRequest(`A quoted value starting on line ${recordLine} is never closed.`);
  if (touched || cell !== '' || cells.length > 0) endRecord();
  return records;
}

/** "Owner E-mail" → "owner_e_mail": lower case, anything else an underscore. */
export function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Parses a CSV with a header row into rows keyed by canonical column name.
 *
 * `aliases` maps each canonical name to the header spellings accepted for it
 * (already normalised). A header used for two columns, or a required column
 * that is missing, refuses the whole file: guessing which column is which is
 * how an owner's mobile number ends up as a flat's area.
 */
export function readCsvTable(
  text: string,
  options: {
    aliases: Readonly<Record<string, readonly string[]>>;
    required: readonly string[];
    maxRows: number;
    maxBytes: number;
  },
): CsvTable {
  if (Buffer.byteLength(text, 'utf8') > options.maxBytes) {
    throw badRequest(`The file is larger than ${Math.round(options.maxBytes / 1024)} KB.`);
  }
  const records = parseCsvRecords(text);
  if (records.length === 0) throw badRequest('The file is empty.');

  const lookup = new Map<string, string>();
  for (const [canonical, spellings] of Object.entries(options.aliases)) {
    lookup.set(canonical, canonical);
    for (const spelling of spellings) lookup.set(spelling, canonical);
  }

  const header = records[0].cells.map(normaliseHeader);
  const positions = new Map<string, number>();
  const ignored: string[] = [];
  header.forEach((name, index) => {
    const canonical = lookup.get(name);
    if (canonical === undefined) {
      if (name !== '') ignored.push(records[0].cells[index].trim());
      return;
    }
    if (positions.has(canonical)) {
      throw badRequest(`Two columns in the header both read as "${canonical}". Keep one.`);
    }
    positions.set(canonical, index);
  });

  const missing = options.required.filter(c => !positions.has(c));
  if (missing.length > 0) {
    throw badRequest(
      `The header row has no ${missing.join(', ')} column. The first line of the file must name ` +
      `the columns; download the template to see them.`,
    );
  }

  const body = records.slice(1);
  if (body.length === 0) throw badRequest('The file has a header row and no data rows.');
  if (body.length > options.maxRows) {
    throw badRequest(`The file has ${body.length} rows; at most ${options.maxRows} are accepted at once.`);
  }

  const columns = [...positions.keys()];
  const rows = body.map(record => {
    const values: Record<string, string> = {};
    for (const [canonical, index] of positions) values[canonical] = (record.cells[index] ?? '').trim();
    return { line: record.line, values };
  });
  return { columns, ignored, rows };
}

/**
 * Rupees as typed in a sheet — "1,23,456.50", "₹ 500", "0" — to whole paise.
 *
 * Exact: the digits are split at the point rather than multiplied as a float,
 * so 0.29 is 29 paise and not 28.999… Returns null for anything that is not a
 * non-negative amount with at most two decimals.
 */
export function rupeesToPaise(raw: string): number | null {
  const text = raw.trim().replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  if (text === '') return 0;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (m === null) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}
