import { useState } from 'react';
import { formatRupees } from '../../../accounting/money';
import { closePeriod, listPeriods, reopenPeriod, type FinancialPeriod } from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import {
  Badge, Button, Card, FormDialog, LoadState, Table, cellClass, inputClass, labelClass,
  todayInIndia, useLoad, useWrite,
} from './ui';

/** The month before this one, which is the period usually being closed. */
function lastMonth(): string {
  const [y, m] = todayInIndia().split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * Financial periods. Only a period that has been closed at least once has a
 * row, so closing takes a month rather than a pick from the list. The server
 * records the trial balance it closed on and refuses if that does not tie.
 */
export function PeriodsSection({ ctx }: { ctx: OfficeContext }) {
  const periods = useLoad(() => listPeriods(ctx.client), [ctx]);
  const { busy, run } = useWrite(ctx, periods.refresh);
  const [closing, setClosing] = useState<string | null>(null);
  const [reopening, setReopening] = useState<FinancialPeriod | null>(null);
  const mayClose = ctx.can('period.close');
  const mayReopen = ctx.can('period.reopen');
  const list = periods.data ?? [];

  return (
    <Card
      title="Financial periods"
      actions={mayClose ? <Button tone="primary" onClick={() => setClosing(lastMonth())}>Close a period</Button> : undefined}
    >
      <p className="text-xs text-[var(--mv-muted)]">
        Once a period is closed the database refuses any posting dated in it. Reopening needs a reason, which stays on record.
      </p>
      <LoadState loaded={periods} empty="No period has been closed yet." isEmpty={list.length === 0} />
      {list.length > 0 && (
        <Table head={['Period', 'State', 'Closed', 'Trial balance', 'Reopened because', '']}>
          {list.map(p => (
            <tr key={p.period}>
              <td className={`${cellClass} font-bold whitespace-nowrap`}>{p.period}</td>
              <td className={cellClass}>
                <Badge tone={p.state === 'closed' ? 'ok' : p.state === 'reopened' ? 'warn' : 'muted'}>{p.state}</Badge>
              </td>
              <td className={`${cellClass} whitespace-nowrap`}>{p.closedAt === null ? '—' : p.closedAt.slice(0, 16)}</td>
              <td className={`${cellClass} whitespace-nowrap`}>
                {p.trialBalancePaise === null ? '—' : formatRupees(p.trialBalancePaise, { paise: true })}
              </td>
              <td className={`${cellClass} max-w-[220px] break-words`}>{p.reopenedReason ?? '—'}</td>
              <td className={`${cellClass} text-right whitespace-nowrap`}>
                {p.state === 'closed' && mayReopen && (
                  <Button onClick={() => setReopening(p)} aria-label={`Reopen ${p.period}`}>Reopen</Button>
                )}
                {p.state !== 'closed' && mayClose && (
                  <Button tone="primary" onClick={() => setClosing(p.period)} aria-label={`Close ${p.period} again`}>Close again</Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {closing !== null && (
        <ClosePeriodDialog
          initial={closing}
          busy={busy === 'close'}
          onClose={() => setClosing(null)}
          onSubmit={async period => {
            const done = await run(
              'close', () => closePeriod(ctx.client, period),
              result => {
                const r = result as { trialBalancePaise: number; note: string };
                return `${period} closed on a trial balance of ${formatRupees(r.trialBalancePaise, { paise: true })}. ${r.note}`;
              },
            );
            if (done) setClosing(null);
          }}
        />
      )}
      {reopening !== null && (
        <ReopenPeriodDialog
          period={reopening.period}
          busy={busy === 'reopen'}
          onClose={() => setReopening(null)}
          onSubmit={async reason => {
            const done = await run('reopen', () => reopenPeriod(ctx.client, reopening.period, reason), `${reopening.period} reopened.`);
            if (done) setReopening(null);
          }}
        />
      )}
    </Card>
  );
}

function ClosePeriodDialog({ initial, busy, onClose, onSubmit }: {
  initial: string; busy: boolean; onClose: () => void; onSubmit: (period: string) => void;
}) {
  const [period, setPeriod] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <FormDialog
      id="gov-close-period"
      title="Close a financial period"
      intro="The trial balance to the last day of the month is recorded with the close. After this, nothing dated in the month can be posted until it is reopened."
      submitLabel="Close period"
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) { setProblem('Choose a month.'); return; }
        setProblem(null);
        onSubmit(period);
      }}
    >
      <div>
        <label htmlFor="gov-period-month" className={labelClass}>Month (YYYY-MM)</label>
        <input id="gov-period-month" type="month" data-autofocus className={inputClass} value={period}
          onChange={e => setPeriod(e.target.value)} pattern="\d{4}-\d{2}" placeholder="2026-09" required />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}

function ReopenPeriodDialog({ period, busy, onClose, onSubmit }: {
  period: string; busy: boolean; onClose: () => void; onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <FormDialog
      id="gov-reopen-period"
      title={`Reopen ${period}`}
      intro="Postings dated in the month are accepted again until it is closed once more. The reason goes on the period and into the audit trail."
      submitLabel="Reopen period"
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        if (reason.trim() === '') { setProblem('Reopening a period needs a reason.'); return; }
        setProblem(null);
        onSubmit(reason.trim());
      }}
    >
      <div>
        <label htmlFor="gov-reopen-reason" className={labelClass}>Reason</label>
        <textarea id="gov-reopen-reason" data-autofocus className={inputClass} rows={3} maxLength={500}
          value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Bank charges for September found after close" required />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}
