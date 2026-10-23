import { useId, useState, type FormEvent } from 'react';
import { Dialog } from '../../Dialog';
import type { OfficeContext } from '../types';
import { problemOf } from '../types';
import {
  REQUEST_MAX_BYTES, STATEMENT_MAX_CHARS, importStatement,
  type BankAccount, type ImportResult,
} from '../../../api/office/bank';
import { dialogPanel, errorBox, field, label, primaryButton, secondaryButton } from './ui';

type Format = 'csv' | 'mt940';

/** MT940 files arrive as .sta, .mt940 or plain .txt; everything else is tried as CSV. */
function formatFromName(name: string): Format {
  return /\.(sta|mt940|940|txt)$/i.test(name) ? 'mt940' : 'csv';
}

export function ImportDialog({ ctx, accounts, onClose, onImported }: {
  ctx: OfficeContext;
  accounts: readonly BankAccount[];
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const id = useId();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [format, setFormat] = useState<Format>('csv');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const pick = (chosen: File | null) => {
    setFile(chosen);
    setProblem(null);
    setResult(null);
    if (chosen !== null) setFormat(formatFromName(chosen.name));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (file === null || accountId === '') return;
    setProblem(null);
    setResult(null);

    // The size is checked here as well as on the server so that a too-large
    // file is refused before it is uploaded, with a message that says why.
    let content: string;
    try {
      content = await file.text();
    } catch {
      setProblem('The file could not be read.');
      return;
    }
    if (content.trim() === '') {
      setProblem('The file is empty.');
      return;
    }
    if (content.length > STATEMENT_MAX_CHARS) {
      setProblem(
        `The file is ${content.length.toLocaleString('en-IN')} characters; the server accepts at most ` +
        `${STATEMENT_MAX_CHARS.toLocaleString('en-IN')}. Split the statement into shorter periods.`,
      );
      return;
    }
    const input = { bankAccountId: accountId, format, filename: file.name.slice(0, 300), content };
    if (new Blob([JSON.stringify(input)]).size > REQUEST_MAX_BYTES) {
      setProblem('The file is too large to send in one request. Split the statement into shorter periods.');
      return;
    }

    setBusy(true);
    try {
      const outcome = await importStatement(ctx.client, input);
      setResult(outcome);
      ctx.toast(`Statement imported: ${outcome.inserted} new line${outcome.inserted === 1 ? '' : 's'}.`);
      await onImported();
    } catch (err) {
      const message = problemOf(err);
      setProblem(message);
      ctx.toast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog labelledBy={`${id}-title`} onClose={onClose} className={dialogPanel}>
      <h3 id={`${id}-title`} className="font-extrabold text-sm text-[var(--mv-ink)]">Import a bank statement</h3>
      <p className="text-[11px] text-[var(--mv-muted)] leading-snug">
        A CSV export or an MT940 file from the bank. Importing records the lines and posts nothing;
        a line already imported is skipped, and the same file twice is refused.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor={`${id}-account`} className={label}>Bank account</label>
          <select id={`${id}-account`} className={field} value={accountId} onChange={e => setAccountId(e.target.value)} required>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.label} · {a.bankName} ··{a.accountLast4}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-file`} className={label}>Statement file</label>
          <input
            id={`${id}-file`}
            type="file"
            accept=".csv,.txt,.sta,.mt940,.940,text/csv,text/plain"
            required
            data-autofocus
            onChange={e => pick(e.target.files?.[0] ?? null)}
            className={`${field} font-medium file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--mv-soft)] file:px-3 file:py-1 file:text-xs file:font-bold file:text-[var(--mv-ink)]`}
          />
        </div>
        <div>
          <label htmlFor={`${id}-format`} className={label}>Format</label>
          <select id={`${id}-format`} className={field} value={format} onChange={e => setFormat(e.target.value as Format)}>
            <option value="csv">CSV</option>
            <option value="mt940">MT940</option>
          </select>
        </div>

        {problem !== null && <p role="alert" className={errorBox}>{problem}</p>}

        {result !== null && (
          <div role="status" className="p-3 rounded-xl bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] text-[var(--mv-ink)] space-y-1">
            <p className="font-bold">
              {result.inserted} imported · {result.duplicate} already on file · {result.rejected.length} could not be read
            </p>
            <p className="text-[11px] text-[var(--mv-muted)]">{result.note}</p>
            {result.rejected.length > 0 && (
              <ul className="text-[11px] list-disc pl-4 space-y-0.5">
                {result.rejected.slice(0, 20).map(r => (
                  <li key={r.line}>Line {r.line}: {r.why}</li>
                ))}
                {result.rejected.length > 20 && <li>and {result.rejected.length - 20} more</li>}
              </ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={secondaryButton}>
            {result === null ? 'Cancel' : 'Done'}
          </button>
          <button type="submit" disabled={busy || file === null || accountId === ''} className={primaryButton}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
