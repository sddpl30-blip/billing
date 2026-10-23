/**
 * The small pieces the Vendors & notes sections share: the card, the form
 * field, the dialog frame, and the conversions at the edge of a form.
 */

import React, { useState } from 'react';
import { X } from 'lucide-react';
import { Dialog } from '../../Dialog';
import { fromRupees, type Paise } from '../../../accounting';
import { problemOf, type OfficeContext } from '../types';

export const labelClass = 'text-[10px] text-[var(--mv-muted)] font-bold block mb-1 uppercase tracking-wider';
export const inputClass =
  'w-full bg-[var(--mv-page)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold text-xs ' +
  'text-[var(--mv-ink)] outline-none focus:border-[var(--mv-accent)]';
export const primaryButton =
  'px-4 py-2 rounded-xl text-xs font-bold bg-[var(--mv-accent)] text-white border border-[var(--mv-accent)] ' +
  'hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity';
export const secondaryButton =
  'px-3 py-1.5 rounded-lg text-[11px] font-bold bg-[var(--mv-surface)] text-[var(--mv-ink)] ' +
  'border border-[var(--mv-border)] hover:border-[var(--mv-accent)] disabled:opacity-50 disabled:cursor-not-allowed';
export const thClass = 'px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)] whitespace-nowrap';
export const tdClass = 'px-3 py-2 text-xs text-[var(--mv-ink)] whitespace-nowrap';
export const numClass = `${tdClass} text-right tabular-nums`;

/** Today in the browser's own calendar, not UTC, which is a day behind before 5:30 IST. */
export function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A typed rupee amount to paise, or null when it is not one. */
export function parseRupees(text: string): Paise | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  try {
    return fromRupees(Number(trimmed));
  } catch {
    return null;
  }
}

export function Card({ title, action, children }: {
  title: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 sm:p-5 shadow-xs space-y-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--mv-border)] pb-2">
        <h3 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-wider">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A table that scrolls sideways inside its card, so a phone never scrolls the page. */
export function TableScroll({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto -mx-1" role="region" aria-label={label} tabIndex={0}>
      <table className="min-w-full border-collapse">{children}</table>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-[var(--mv-muted)] py-2">{children}</p>;
}

export function Field({ id, label, hint, children }: {
  id: string; label: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>{label}</label>
      {children}
      {hint !== undefined && <p id={`${id}-hint`} className="text-[10px] text-[var(--mv-muted)] mt-1">{hint}</p>}
    </div>
  );
}

/**
 * The frame every form here opens in. `onSubmit` throws to refuse; the
 * message goes to the toast and the dialog stays open with what was typed.
 */
export function FormDialog({ id, title, submitLabel, onClose, onSubmit, children, ctx }: {
  id: string;
  title: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  children: React.ReactNode;
  ctx: OfficeContext;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit();
    } catch (err) {
      ctx.toast(problemOf(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      labelledBy={`${id}-title`}
      onClose={onClose}
      className="bg-[var(--mv-surface)] w-full max-w-md max-h-[90vh] overflow-y-auto rounded-3xl shadow-2xl border border-[var(--mv-border)] p-5 outline-none"
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="flex items-start justify-between gap-3">
          <h3 id={`${id}-title`} className="font-extrabold text-sm text-[var(--mv-ink)]">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-lg text-[var(--mv-muted)] hover:text-[var(--mv-ink)]"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        {children}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={secondaryButton}>Cancel</button>
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? 'Working…' : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A refusal raised by the form itself, before anything is sent. */
export class FormProblem extends Error {}
