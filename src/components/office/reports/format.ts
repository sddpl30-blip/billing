/**
 * Formatting and CSV for the reports.
 *
 * A report is described once, as a `ReportView` of plain cells, and both the
 * screen and the CSV are drawn from that description. That way the file a
 * treasurer downloads cannot show a different figure from the one on screen.
 */

import { formatRupees } from '../../../accounting/money';

/** An amount in paise, as the server sent it. */
export interface Money {
  readonly paise: number;
  /** Shown as a dash when nil, as a ledger column usually is. */
  readonly dashIfZero?: boolean;
}

export type Cell = string | number | Money | null;

export interface Column {
  readonly label: string;
  readonly numeric?: boolean;
}

export interface TableSpec {
  readonly title: string;
  readonly columns: readonly Column[];
  readonly rows: ReadonlyArray<readonly Cell[]>;
  /** Totals, drawn under a rule. */
  readonly footer?: ReadonlyArray<readonly Cell[]>;
  /** What to say when there are no rows. */
  readonly empty?: string;
}

export interface StatusLine {
  /** 'good' and 'bad' are a check passing or failing; 'info' is neither. */
  readonly tone: 'good' | 'bad' | 'info';
  readonly text: string;
}

export interface Tile {
  readonly label: string;
  readonly value: Cell;
}

export interface ReportView {
  readonly title: string;
  /** "As at 23 Oct 2026", "1 Apr 2026 to 23 Oct 2026", and so on. */
  readonly period: string;
  readonly status?: readonly StatusLine[];
  readonly tiles?: readonly Tile[];
  readonly notes?: readonly string[];
  readonly tables: readonly TableSpec[];
  /** The base of the CSV file name. */
  readonly fileStem: string;
}

export const money = (paise: number, dashIfZero = false): Money => ({ paise, dashIfZero });

function isMoney(cell: Cell): cell is Money {
  return typeof cell === 'object' && cell !== null;
}

/**
 * Rupees with Indian grouping and paise, negatives in brackets: (₹1,250.00).
 * Brackets rather than a minus sign because that is how a committee's
 * accountant reads a negative, and a minus is easy to miss in a column.
 */
export function formatMoney(paise: number): string {
  const text = formatRupees(Math.abs(paise), { paise: true });
  return paise < 0 ? `(${text})` : text;
}

export function displayCell(cell: Cell): string {
  if (cell === null) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return cell.toLocaleString('en-IN');
  if (cell.dashIfZero && cell.paise === 0) return '—';
  return formatMoney(cell.paise);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-10-23 → 23 Oct 2026. Anything else is returned as it came. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * A database timestamp ("2026-10-23 07:40:11.29+00") as India's clock reads
 * it, since that is the time the committee will remember the action at.
 */
export function formatInstant(text: string): string {
  const at = new Date(text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (Number.isNaN(at.getTime())) return text;
  const ist = new Date(at.getTime() + 330 * 60 * 1000).toISOString();
  return `${formatDate(ist.slice(0, 10))} ${ist.slice(11, 19)} IST`;
}

/** 2026-10 → Oct 2026. */
export function formatMonth(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : period;
}

// --- CSV ---------------------------------------------------------------------

/**
 * A cell as CSV text. Money goes out as plain rupees with two decimals and a
 * minus sign, because a spreadsheet must be able to add the column up; the
 * brackets and the ₹ are for reading, not for arithmetic.
 */
function csvCell(cell: Cell): string {
  let text: string;
  if (cell === null) text = '';
  else if (isMoney(cell)) text = (cell.paise / 100).toFixed(2);
  else if (typeof cell === 'number') text = String(cell);
  else {
    text = cell;
    // A narration that starts with = or @ would run as a formula when the
    // file is opened in a spreadsheet; a leading apostrophe keeps it text.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(view: ReportView): string {
  const lines: string[] = [];
  const row = (cells: readonly Cell[]) => lines.push(cells.map(csvCell).join(','));
  row([view.title]);
  row([view.period]);
  for (const s of view.status ?? []) row([s.text]);
  for (const t of view.tiles ?? []) row([t.label, t.value]);
  for (const table of view.tables) {
    lines.push('');
    if (view.tables.length > 1) row([table.title]);
    row(table.columns.map(c => c.label));
    for (const r of table.rows) row(r);
    for (const r of table.footer ?? []) row(r);
  }
  return lines.join('\r\n') + '\r\n';
}

export function downloadCsv(view: ReportView): void {
  // The byte-order mark is what makes Excel read the file as UTF-8, so a flat
  // owner's name or a ₹ in a narration survives the trip.
  const blob = new Blob(['﻿', toCsv(view)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${view.fileStem}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
