/**
 * The small pieces every section of the Approvals & admin panel shares: a
 * loader, a write runner that reports the server's refusal verbatim, and the
 * card, button, badge and form-dialog styling.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ApiError } from '../../../api/client';
import { Dialog } from '../../Dialog';
import { problemOf, type OfficeContext } from '../types';
import { isoDateInIndia } from '../../../accounting/clock';

/** Today in India, which is the date an approval is recorded against. */
export const todayInIndia = (): string => isoDateInIndia();

/**
 * The message for a failed call. A 400 from the validator says only "the
 * request is not valid" and puts the reasons in its detail, so those are
 * added; every other refusal already says what was refused and why.
 */
export function refusalOf(err: unknown): string {
  if (err instanceof ApiError && Array.isArray(err.detail)) {
    const issues = (err.detail as Array<{ path?: unknown; message?: unknown }>)
      .map(i => [i.path, i.message].filter(p => typeof p === 'string' && p !== '').join(' '))
      .filter(s => s !== '');
    if (issues.length > 0) return `${err.message} ${issues.join('; ')}`;
  }
  return problemOf(err);
}

export interface Loaded<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  refresh(): Promise<void>;
}

/** Loads on mount and on `refresh`; a stale response never overwrites a newer one. */
export function useLoad<T>(load: () => Promise<T>, deps: React.DependencyList): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const run = useCallback(load, deps);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const result = await run();
      if (mine === seq.current) { setData(result); setError(null); }
    } catch (err) {
      if (mine === seq.current) setError(refusalOf(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [run]);

  useEffect(() => { void refresh(); }, [refresh]);
  return { data, error, loading, refresh };
}

/**
 * Runs a write. On success it toasts, re-reads the books so the rest of the
 * app agrees, and refetches the section; on a refusal it toasts the server's
 * own message and leaves the form open so the user can correct it.
 */
export function useWrite(ctx: OfficeContext, refetch: () => Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (
    tag: string,
    write: () => Promise<unknown>,
    success: string | ((result: unknown) => string),
  ): Promise<boolean> => {
    setBusy(tag);
    let result: unknown;
    try {
      result = await write();
    } catch (err) {
      ctx.toast(refusalOf(err), 'error');
      setBusy(null);
      return false;
    }
    ctx.toast(typeof success === 'function' ? success(result) : success, 'info');
    try {
      await Promise.all([ctx.reload(), refetch()]);
    } catch (err) {
      // The write stood; only the re-read failed, so it must not read as a refusal.
      ctx.toast(`Saved, but the screen could not refresh: ${refusalOf(err)}`, 'error');
    } finally {
      setBusy(null);
    }
    return true;
  }, [ctx, refetch]);
  return { busy, run };
}

// --- presentation --------------------------------------------------------

export const inputClass =
  'w-full px-3 py-2 rounded-xl border border-[var(--mv-border)] bg-[var(--mv-surface)] ' +
  'text-sm text-[var(--mv-ink)] focus:outline-none focus:border-[var(--mv-accent)]';

export const labelClass =
  'block text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)] mb-1';

export function Card({ title, actions, children }: {
  title: string; actions?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 sm:p-6 shadow-xs space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-[var(--mv-ink)]">{title}</h3>
        {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Button({ tone = 'secondary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'primary' | 'secondary';
}) {
  const look = tone === 'primary'
    ? 'bg-[var(--mv-accent)] text-white border-[var(--mv-accent)] hover:opacity-90'
    : 'bg-[var(--mv-surface)] text-[var(--mv-ink)] border-[var(--mv-border)] hover:border-[var(--mv-accent)]';
  return (
    <button
      type="button"
      {...props}
      className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${look} ${className}`}
    />
  );
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: React.ReactNode }) {
  const look = tone === 'ok'
    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
    : tone === 'warn'
      ? 'bg-amber-50 text-amber-900 border-amber-300'
      : 'bg-[var(--mv-soft)] text-[var(--mv-muted)] border-[var(--mv-border)]';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider whitespace-nowrap ${look}`}>
      {children}
    </span>
  );
}

/** Loading, a load failure, or an empty list, said in one consistent way. */
export function LoadState({ loaded, empty, isEmpty }: {
  loaded: Loaded<unknown>; empty: string; isEmpty: boolean;
}) {
  if (loaded.error !== null) {
    return (
      <div role="alert" className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-xl p-3 flex flex-wrap items-center gap-2">
        <span className="flex-1 min-w-0">{loaded.error}</span>
        <Button onClick={() => void loaded.refresh()}>Retry</Button>
      </div>
    );
  }
  if (loaded.data === null) return <p className="text-sm text-[var(--mv-muted)]">Loading…</p>;
  if (isEmpty) return <p className="text-sm text-[var(--mv-muted)]">{empty}</p>;
  return null;
}

/** A form in the shared Dialog: a title, the fields, Cancel and a submit. */
export function FormDialog({ id, title, intro, submitLabel, busy, onClose, onSubmit, children }: {
  id: string;
  title: string;
  intro?: React.ReactNode;
  submitLabel: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      labelledBy={`${id}-title`}
      onClose={onClose}
      className="bg-[var(--mv-surface)] w-full max-w-md rounded-3xl shadow-2xl border border-[var(--mv-border)] max-h-[90vh] overflow-y-auto outline-none animate-scale-up"
    >
      <form
        onSubmit={event => { event.preventDefault(); if (!busy) onSubmit(); }}
        className="p-5 space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={`${id}-title`} className="text-base font-bold text-[var(--mv-ink)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-lg text-[var(--mv-muted)] hover:text-[var(--mv-ink)]"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        {intro !== undefined && <div className="text-xs text-[var(--mv-muted)] leading-relaxed">{intro}</div>}
        {children}
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" disabled={busy}>{busy ? 'Working…' : submitLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A table that scrolls inside its card at phone width rather than the page. */
export function Table({ head, children }: { head: readonly string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto -mx-4 sm:mx-0">
      <table className="w-full text-xs text-left text-[var(--mv-ink)] min-w-[560px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-[var(--mv-muted)] border-b border-[var(--mv-border)]">
            {head.map(h => <th key={h} scope="col" className="py-2 px-4 sm:px-2 font-bold">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--mv-border)]">{children}</tbody>
      </table>
    </div>
  );
}

export const cellClass = 'py-2 px-4 sm:px-2 align-top';
