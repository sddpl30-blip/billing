import React, { useCallback, useEffect, useState } from 'react';
import { Clock3, X } from 'lucide-react';
import type { ApiClient } from '../api/client';

/**
 * "E-mail the approved bills at 6:00 am on the 1st."
 *
 * Server mode only. The treasurer picks a period that has approved proformas
 * and a date; the server releases and e-mails whatever is approved at 06:00
 * IST that day. Listed underneath: what is scheduled, and what each past
 * release did — how many went out, how many flats had no email, and how many
 * were still in draft and so stayed behind.
 */

interface ScheduledReleaseRow {
  id: string;
  period: string;
  scheduledFor: string;
  state: string;
  result: { summary?: unknown; released?: number; withoutAnAddress?: string[]; draftsLeft?: number } | null;
  lastError: string | null;
}

interface Props {
  client: ApiClient;
  /** Periods that currently have approved, unreleased proformas. */
  approvedPeriods: readonly string[];
  mayRelease: boolean;
  toast: (message: string, tone?: 'info' | 'error') => void;
  /** Re-read the books after a release goes out. */
  reload: () => Promise<void>;
}

/** The 1st of next month in India, the note's release day. */
function firstOfNextMonthInIndia(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const [y, m] = today.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

const when = (iso: string): string =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));

export function ScheduledRelease({ client, approvedPeriods, mayRelease, toast, reload }: Props) {
  const [rows, setRows] = useState<ScheduledReleaseRow[]>([]);
  const [period, setPeriod] = useState(approvedPeriods[0] ?? '');
  const [on, setOn] = useState(firstOfNextMonthInIndia());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await client.get<{ releases: ScheduledReleaseRow[] }>('/api/billing/scheduled-releases');
      setRows(r.releases);
    } catch {
      // The card is an extra; a failed read leaves it empty rather than noisy.
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (period === '' && approvedPeriods[0] !== undefined) setPeriod(approvedPeriods[0]);
  }, [approvedPeriods, period]);

  const schedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (period === '') return;
    setBusy(true);
    try {
      const r = await client.call<{ scheduledFor: string; approvedNow: number; draftsNow: number }>(
        `/api/billing/periods/${encodeURIComponent(period)}/schedule-release`,
        { method: 'POST', body: { on } },
      );
      toast(
        `${period}: ${r.approvedNow} approved bill${r.approvedNow === 1 ? '' : 's'} will be released and e-mailed at ` +
        `${when(r.scheduledFor)}.` + (r.draftsNow > 0 ? ` ${r.draftsNow} still in draft must be approved before then.` : ''),
      );
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not schedule the release.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await client.call(`/api/billing/scheduled-releases/${id}/cancel`, { method: 'POST' });
      toast('Scheduled release cancelled.');
      await load();
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not cancel.', 'error');
    }
  };

  if (!mayRelease && rows.length === 0) return null;

  return (
    <section aria-labelledby="scheduled-release-title" className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Clock3 className="w-4 h-4 text-[var(--mv-accent)]" aria-hidden="true" />
        <h3 id="scheduled-release-title" className="text-sm font-bold text-[var(--mv-ink)]">E-mail bills at 6:00 am</h3>
      </div>
      <p className="text-xs text-[var(--mv-muted)]">
        Approved proformas for the period are released and e-mailed to owners at 06:00 IST on the chosen day.
        Anything still in draft then stays behind.
      </p>

      {mayRelease && (
        <form onSubmit={e => { void schedule(e); }} className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="sr-period" className="block text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)] mb-1">Period</label>
            {approvedPeriods.length > 0 ? (
              <select
                id="sr-period"
                value={period}
                onChange={e => setPeriod(e.target.value)}
                className="rounded-xl border border-[var(--mv-border)] bg-[var(--mv-surface)] px-3 py-2 text-sm text-[var(--mv-ink)]"
              >
                {approvedPeriods.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            ) : (
              // Only a period with approved bills can be released, so there is
              // nothing to type: a free-text box here only invited "OCT1".
              <p id="sr-period" className="rounded-xl border border-dashed border-[var(--mv-border)] px-3 py-2 text-xs text-[var(--mv-muted)] max-w-xs">
                No approved bills yet. Run and approve a period&apos;s bills first; it then appears here.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="sr-on" className="block text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)] mb-1">Send on</label>
            <input
              id="sr-on"
              type="date"
              value={on}
              onChange={e => setOn(e.target.value)}
              className="rounded-xl border border-[var(--mv-border)] bg-[var(--mv-surface)] px-3 py-2 text-sm text-[var(--mv-ink)]"
            />
          </div>
          <button
            type="submit"
            disabled={busy || period === ''}
            className="rounded-xl bg-[var(--mv-accent)] text-white text-xs font-bold uppercase tracking-wider px-4 py-2.5 disabled:opacity-60"
          >
            {busy ? 'Scheduling…' : 'Schedule for 6:00 am'}
          </button>
        </form>
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-[var(--mv-border)] text-xs">
          {rows.slice(0, 6).map(r => (
            <li key={r.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[var(--mv-ink)]">
                <strong>{r.period}</strong> · {when(r.scheduledFor)} ·{' '}
                {r.state === 'pending' && 'scheduled'}
                {r.state === 'succeeded' && `sent: ${r.result?.released ?? 0} released` +
                  ((r.result?.withoutAnAddress?.length ?? 0) > 0 ? `, ${r.result?.withoutAnAddress?.length} without email` : '') +
                  ((r.result?.draftsLeft ?? 0) > 0 ? `, ${r.result?.draftsLeft} left in draft` : '')}
                {r.state !== 'pending' && r.state !== 'succeeded' && `${r.state}${r.lastError ? `: ${r.lastError}` : ''}`}
              </span>
              {r.state === 'pending' && mayRelease && (
                <button
                  onClick={() => { void cancel(r.id); }}
                  aria-label={`Cancel the scheduled release for ${r.period}`}
                  className="inline-flex items-center gap-1 rounded-lg border border-[var(--mv-border)] px-2 py-1 text-[var(--mv-muted)] hover:text-[var(--mv-ink)]"
                >
                  <X className="w-3 h-3" aria-hidden="true" /> Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
