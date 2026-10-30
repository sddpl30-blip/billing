import { useState } from 'react';
import { Upload } from 'lucide-react';
import type { ApiClient } from '../api/client';
import { formatRupees } from '../accounting';

/**
 * Many receipts at once, from a CSV. Server mode only.
 *
 * Check first, record second: the server reads every line and says what is
 * wrong before anything is written, and records the file only when every line
 * is clean, all of it in one go. One Idempotency-Key per file, so pressing
 * "Record" twice, or a retried request, cannot take the same money twice.
 */

interface Line {
  readonly line: number;
  readonly flatNo: string;
  readonly amountPaise: number | null;
  readonly receivedOn: string | null;
  readonly method: string | null;
  readonly reference: string | null;
  readonly problems: readonly string[];
}

interface Result {
  readonly checked: number;
  readonly problems: number;
  readonly totalPaise: number;
  readonly lines: readonly Line[];
  readonly recorded: ReadonlyArray<{ line: number; flatNo: string; receiptNo: string }> | null;
  readonly note: string;
}

const TEMPLATE =
  'flat_no,amount,received_on,method,reference\r\n' +
  'A-101,4500,05/11/2026,UPI,UTR123456789\r\n' +
  'A-102,5625,06/11/2026,Cheque,CHQ004512\r\n';

const newKey = (): string =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? `bulk-${crypto.randomUUID()}`
    : `bulk-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function BulkPaymentsUpload({ client, onRecorded, toast }: {
  client: ApiClient;
  onRecorded: () => Promise<void> | void;
  toast: (message: string, tone?: 'info' | 'error') => void;
}) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [key, setKey] = useState(newKey);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = async (file: File | null) => {
    setResult(null); setProblem(null);
    if (file === null) { setCsv(null); setFileName(''); return; }
    try {
      const text = await file.text();
      setCsv(text); setFileName(file.name); setKey(newKey());
      await check(text);
    } catch {
      setProblem('The file could not be read. Save it as CSV and try again.');
    }
  };

  const check = async (text: string) => {
    setBusy(true); setProblem(null);
    try {
      setResult(await client.post<Result>('/api/payments/import', { csv: text, confirm: false }));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The file could not be checked.');
    } finally {
      setBusy(false);
    }
  };

  const record = async () => {
    if (csv === null) return;
    setBusy(true); setProblem(null);
    try {
      const done = await client.post<Result>(
        '/api/payments/import', { csv, confirm: true }, { idempotencyKey: key },
      );
      setResult(done);
      toast(done.note);
      await onRecorded();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Nothing was recorded.');
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'payments-template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const ready = result !== null && result.recorded === null && result.problems === 0;

  return (
    <section className="mt-5 pt-5 border-t border-[var(--mv-border)] space-y-3 text-left" aria-labelledby="bulk-pay-title">
      <div className="flex items-center justify-between gap-2">
        <h4 id="bulk-pay-title" className="font-bold text-xs uppercase tracking-wider text-[var(--mv-ink)] flex items-center gap-1.5">
          <Upload className="w-3.5 h-3.5 text-[var(--mv-accent)]" aria-hidden="true" /> Upload many payments
        </h4>
        <button type="button" onClick={downloadTemplate} className="text-[10px] font-bold text-[var(--mv-accent)] underline">
          Download template
        </button>
      </div>
      <p className="text-[11px] text-[var(--mv-muted)] leading-snug">
        A CSV with flat number, amount, date, mode (UPI, NEFT, cheque, cash…) and reference. It is checked first;
        nothing is recorded until every line is right.
      </p>
      <label className="block">
        <span className="sr-only">Choose a payments CSV</span>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={e => { void pick(e.target.files?.[0] ?? null); }}
          className="block w-full text-[11px] text-[var(--mv-muted)] file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-[var(--mv-ink)] file:text-white file:text-[10px] file:font-bold file:uppercase"
        />
      </label>

      {busy && <p className="text-[11px] text-[var(--mv-muted)]">Working…</p>}
      {problem !== null && <p role="alert" className="text-[11px] text-red-700 bg-red-50 rounded-lg px-2.5 py-1.5">{problem}</p>}

      {result !== null && (
        <div className="space-y-2">
          <p className={`text-[11px] font-bold ${result.problems > 0 ? 'text-red-700' : 'text-[var(--mv-ink)]'}`}>
            {fileName}: {result.checked} line{result.checked === 1 ? '' : 's'}, {formatRupees(result.totalPaise)} in all. {result.note}
          </p>
          <div className="max-h-64 overflow-auto rounded-lg border border-[var(--mv-border)]">
            <table className="w-full text-[11px]">
              <thead className="bg-[var(--mv-page)] text-[var(--mv-muted)] uppercase text-[9px]">
                <tr><th className="p-1.5 text-left">Line</th><th className="p-1.5 text-left">Flat</th><th className="p-1.5 text-right">Amount</th><th className="p-1.5 text-left">Date</th><th className="p-1.5 text-left">Mode</th><th className="p-1.5 text-left">Result</th></tr>
              </thead>
              <tbody>
                {result.lines.map(l => {
                  const receipt = result.recorded?.find(r => r.line === l.line);
                  return (
                    <tr key={l.line} className={`border-t border-[var(--mv-border)] ${l.problems.length > 0 ? 'bg-red-50' : ''}`}>
                      <td className="p-1.5 whitespace-nowrap">{l.line}</td>
                      <td className="p-1.5 font-bold whitespace-nowrap">{l.flatNo}</td>
                      <td className="p-1.5 text-right font-mono whitespace-nowrap">{l.amountPaise === null ? '—' : formatRupees(l.amountPaise)}</td>
                      <td className="p-1.5 whitespace-nowrap">{l.receivedOn ?? '—'}</td>
                      <td className="p-1.5 uppercase">{l.method ?? '—'}</td>
                      <td className="p-1.5">
                        {l.problems.length > 0
                          ? <span className="text-red-700">{l.problems.join('; ')}</span>
                          : receipt !== undefined
                            ? <span className="text-[#166534] font-bold">{receipt.receiptNo}</span>
                            : <span className="text-[var(--mv-muted)]">ready</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {ready && (
            <button
              type="button"
              onClick={() => { void record(); }}
              disabled={busy}
              className="w-full py-2.5 bg-[var(--mv-accent)] text-white rounded-xl text-xs font-bold disabled:opacity-60"
            >
              Record {result.checked} receipt{result.checked === 1 ? '' : 's'} ({formatRupees(result.totalPaise)})
            </button>
          )}
          {result.problems > 0 && (
            <p className="text-[11px] text-[var(--mv-muted)]">Fix the red lines in the file and choose it again.</p>
          )}
        </div>
      )}
    </section>
  );
}
