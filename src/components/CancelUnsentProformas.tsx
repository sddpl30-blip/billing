import { useState } from 'react';
import type { ApiClient } from '../api/client';

interface Props {
  client: ApiClient;
  /** Periods that have proformas not yet sent (drafts, or approved but unreleased). */
  unsentPeriods: ReadonlyArray<{ period: string; count: number }>;
  toast: (message: string, tone?: 'info' | 'error') => void;
  reload: () => Promise<void>;
}

/**
 * For a run made for the wrong month: cancels every proforma of one period
 * that has not gone out, in one step, with a reason on record. Server mode,
 * treasurer only. Nothing has been posted or sent for these, so nothing else
 * changes; the month can then be run again.
 */
export function CancelUnsentProformas({ client, unsentPeriods, toast, reload }: Props) {
  const [period, setPeriod] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (unsentPeriods.length === 0) return null;
  const chosen = unsentPeriods.find(p => p.period === period) ?? null;

  const submit = async (): Promise<void> => {
    if (chosen === null || reason.trim() === '') return;
    if (!window.confirm(`Cancel all ${chosen.count} unsent proformas for ${chosen.period}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const result = await client.post<{ note: string }>(
        `/api/billing/periods/${encodeURIComponent(chosen.period)}/cancel-unsent`, { reason: reason.trim() },
      );
      toast(result.note, 'info');
      setPeriod(''); setReason('');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The cancellation failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 rounded-2xl border border-[var(--mv-border)] bg-[var(--mv-surface)] space-y-2">
      <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--mv-ink)]">Cancel a month's unsent proformas</h4>
      <p className="text-[11px] text-[var(--mv-muted)] leading-snug">
        For bills raised for the wrong month. Only proformas not yet sent are cancelled; nothing has been posted for
        them, so nothing else changes. Run the right month afterwards.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr_auto] gap-2 items-end">
        <div>
          <label htmlFor="cancel-unsent-period" className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Month</label>
          <select id="cancel-unsent-period" value={period} onChange={e => setPeriod(e.target.value)}
            className="w-full p-2 rounded-xl border border-[var(--mv-border)] bg-[var(--mv-page)] text-xs font-bold text-[var(--mv-ink)]">
            <option value="">Choose…</option>
            {unsentPeriods.map(p => <option key={p.period} value={p.period}>{p.period} ({p.count})</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="cancel-unsent-reason" className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Reason</label>
          <input id="cancel-unsent-reason" value={reason} maxLength={500} onChange={e => setReason(e.target.value)}
            placeholder="e.g. Raised as Nov 2026; these are October's bills"
            className="w-full p-2 rounded-xl border border-[var(--mv-border)] bg-[var(--mv-page)] text-xs text-[var(--mv-ink)]" />
        </div>
        <button type="button" disabled={busy || chosen === null || reason.trim() === ''} onClick={() => { void submit(); }}
          className="px-4 py-2 rounded-xl bg-red-700 text-white text-xs font-bold uppercase tracking-wider disabled:opacity-50">
          {busy ? 'Cancelling…' : chosen === null ? 'Cancel' : `Cancel ${chosen.count}`}
        </button>
      </div>
    </div>
  );
}
