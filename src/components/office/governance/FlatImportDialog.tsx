/**
 * Importing the member list from a CSV: pick a file, see what it would do,
 * then commit it.
 *
 * The preview is the server's own dry run, not a parse in the browser, so the
 * counts and the per-row problems shown are exactly what the commit would
 * meet. A file with any problem cannot be committed: the server writes all of
 * it or none of it.
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { Dialog } from '../../Dialog';
import { FLAT_IMPORT_COLUMNS, importFlats, type FlatImportReport } from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import { Badge, Button, inputClass, labelClass, refusalOf } from './ui';
import { ApiError } from '../../../api/client';

/** The largest file the server accepts. */
const MAX_BYTES = 512 * 1024;

/**
 * A CSV with the header row only, saved by the browser.
 *
 * No example row: a sample flat with a made-up owner, email and PAN is one
 * forgotten line away from being imported as a real member. What each column
 * takes is described in the dialog instead.
 */
export function downloadFlatTemplate(): void {
  const text = `${FLAT_IMPORT_COLUMNS.join(',')}\r\n`;
  // The byte-order mark is what makes Excel read the file as UTF-8.
  const blob = new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'flats-and-owners-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Step =
  | { kind: 'pick' }
  | { kind: 'preview'; csv: string; filename: string; report: FlatImportReport }
  | { kind: 'done'; report: FlatImportReport };

export function FlatImportDialog({ ctx, onClose, onImported }: {
  ctx: OfficeContext; onClose: () => void; onImported: () => Promise<void>;
}) {
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const preview = async (file: File): Promise<void> => {
    setProblem(null);
    if (file.size > MAX_BYTES) { setProblem('That file is larger than 512 KB.'); return; }
    setBusy(true);
    try {
      const csv = await file.text();
      const report = await importFlats(ctx.client, csv, true, file.name);
      setStep({ kind: 'preview', csv, filename: file.name, report });
    } catch (err) {
      setProblem(refusalOf(err));
    } finally {
      setBusy(false);
    }
  };

  const commit = async (): Promise<void> => {
    if (step.kind !== 'preview') return;
    setBusy(true);
    setProblem(null);
    try {
      const report = await importFlats(ctx.client, step.csv, false, step.filename);
      setStep({ kind: 'done', report });
      ctx.toast(`Imported: ${report.flats.new} new, ${report.flats.updated} updated, ${report.flats.unchanged} unchanged.`);
      await onImported();
    } catch (err) {
      // The books moved between the preview and the commit; show the fresh
      // report so the user sees why.
      if (err instanceof ApiError && err.detail !== null && typeof err.detail === 'object' && 'errors' in err.detail) {
        setStep({ ...step, report: err.detail as FlatImportReport });
      }
      setProblem(refusalOf(err));
    } finally {
      setBusy(false);
    }
  };

  const report = step.kind === 'pick' ? null : step.report;
  const hasErrors = report !== null && report.errors.length > 0;

  return (
    <Dialog
      labelledBy="gov-import-title"
      onClose={onClose}
      className="bg-[var(--mv-surface)] w-full max-w-2xl rounded-3xl shadow-2xl border border-[var(--mv-border)] max-h-[90vh] overflow-y-auto outline-none animate-scale-up"
    >
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h2 id="gov-import-title" className="text-base font-bold text-[var(--mv-ink)]">Import flats and owners from CSV</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-lg text-[var(--mv-muted)] hover:text-[var(--mv-ink)]">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {step.kind === 'pick' && (
          <>
            <p className="text-xs text-[var(--mv-muted)] leading-relaxed">
              One row per flat, with a header row naming the columns:{' '}
              <code className="break-all text-[11px]">{FLAT_IMPORT_COLUMNS.join(', ')}</code>.
              Flat number, area, owner name and owner email are required. Each owner gets an account
              that signs in by an emailed code. You will see what the file would change before anything is saved.
            </p>
            <div>
              <label htmlFor="gov-import-file" className={labelClass}>CSV file</label>
              <input
                id="gov-import-file"
                data-autofocus
                type="file"
                accept=".csv,text/csv"
                className={inputClass}
                disabled={busy}
                onChange={e => { const f = e.target.files?.[0]; if (f !== undefined) void preview(f); }}
              />
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <Button onClick={downloadFlatTemplate}>Download template</Button>
              <Button onClick={onClose}>Cancel</Button>
            </div>
            {busy && <p className="text-sm text-[var(--mv-muted)]" role="status">Checking the file…</p>}
          </>
        )}

        {report !== null && (
          <div className="space-y-3">
            <p className="text-xs text-[var(--mv-muted)]">
              {step.kind === 'done' ? 'Imported' : `Preview of ${step.kind === 'preview' ? step.filename : ''}`}:{' '}
              {report.rows} {report.rows === 1 ? 'row' : 'rows'}.{' '}
              {report.defaultAreaBasis !== null
                ? <>Rows without an area basis take <strong>{report.defaultAreaBasis}</strong>, the basis of the approved rate.</>
                : <>No rate is approved yet, so rows without an area basis keep it <strong>pending verification</strong>; billing skips those flats until it is recorded.</>}
            </p>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2" aria-label="What the import does">
              <Count label="New flats" value={report.flats.new} />
              <Count label="Updated" value={report.flats.updated} />
              <Count label="Unchanged" value={report.flats.unchanged} />
              <Count label="New sign-ins" value={report.accounts.created} />
            </dl>
            {report.ignoredColumns.length > 0 && (
              <p className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-xl p-2">
                Columns not recognised and ignored: {report.ignoredColumns.join(', ')}.
              </p>
            )}
            {hasErrors && (
              <div role="alert" className="space-y-2">
                <p className="text-sm font-bold text-red-800">
                  {report.errors.length} {report.errors.length === 1 ? 'problem' : 'problems'} — nothing can be imported until the file is corrected.
                </p>
                <ul className="max-h-60 overflow-y-auto text-xs border border-red-200 bg-red-50 rounded-xl divide-y divide-red-100">
                  {report.errors.map((e, i) => (
                    <li key={i} className="px-3 py-1.5 text-red-900 break-words">
                      <span className="font-mono font-bold">Line {e.line}</span>
                      {e.flatNo ? <span className="font-bold"> · {e.flatNo}</span> : null}: {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!hasErrors && report.flats.updated > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer font-bold text-[var(--mv-ink)]">Flats that change ({report.flats.updated})</summary>
                <ul className="mt-2 max-h-48 overflow-y-auto space-y-1">
                  {report.changes.filter(c => c.action === 'updated').map(c => (
                    <li key={c.line} className="break-words">
                      <Badge tone="warn">{c.flatNo}</Badge> <span className="text-[var(--mv-muted)]">{c.what.join(', ')}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}

        {step.kind === 'preview' && (
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button onClick={() => { setStep({ kind: 'pick' }); setProblem(null); }}>Choose another file</Button>
            <Button tone="primary" disabled={busy || hasErrors} onClick={() => void commit()}>
              {busy ? 'Importing…' : `Import ${report?.rows ?? 0} ${report?.rows === 1 ? 'row' : 'rows'}`}
            </Button>
          </div>
        )}
        {step.kind === 'done' && (
          <div className="flex justify-end pt-2">
            <Button tone="primary" onClick={onClose}>Done</Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[var(--mv-border)] bg-[var(--mv-soft)] p-2">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)]">{label}</dt>
      <dd className="text-lg font-bold text-[var(--mv-ink)] tabular-nums">{value.toLocaleString('en-IN')}</dd>
    </div>
  );
}
