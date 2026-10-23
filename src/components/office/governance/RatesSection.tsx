import { useState } from 'react';
import { formatRupees, fromRupees } from '../../../accounting/money';
import { AREA_BASES, addRate, approveRate, listRates, type AreaBasis, type Rate } from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import {
  Badge, Button, Card, FormDialog, LoadState, Table, cellClass, inputClass, labelClass,
  todayInIndia, useLoad, useWrite,
} from './ui';

export function formatRate(paisePerSqFt: number): string {
  return `${formatRupees(paisePerSqFt, { paise: true })}/sq ft`;
}

/**
 * Maintenance rates: effective-dated, entered by one person and approved by
 * another. The server refuses an approval by whoever entered the rate; that
 * refusal is shown as it comes back rather than pre-empted here, because the
 * list does not say who entered each rate.
 */
export function RatesSection({ ctx }: { ctx: OfficeContext }) {
  const rates = useLoad(() => listRates(ctx.client), [ctx]);
  const { busy, run } = useWrite(ctx, rates.refresh);
  const [adding, setAdding] = useState(false);
  const mayAdd = ctx.can('settings.manage');
  const mayApprove = ctx.can('rate.approve');
  const list = rates.data ?? [];
  const today = todayInIndia();
  // The rate a billing run dated today would use: the latest one in force.
  const inForce = list.find(r => r.effectiveFrom <= today);

  return (
    <Card
      title="Maintenance rates"
      actions={mayAdd ? <Button tone="primary" onClick={() => setAdding(true)}>Add a rate</Button> : undefined}
    >
      <p className="text-xs text-[var(--mv-muted)]">
        A billing run uses the latest rate in force on its date and refuses one that has not been approved.
        Whoever enters a rate cannot approve it.
      </p>
      {inForce !== undefined && !inForce.approved && (
        <p role="status" className="text-xs font-semibold text-amber-900 bg-amber-50 border border-amber-300 rounded-xl p-3">
          The rate in force today ({formatRate(inForce.paisePerSqFt)} from {inForce.effectiveFrom}) is awaiting
          approval. Billing will refuse to run until it is approved.
        </p>
      )}
      <LoadState loaded={rates} empty="No rate is on record. Billing cannot run until one is entered and approved." isEmpty={list.length === 0} />
      {list.length > 0 && (
        <Table head={['Rate', 'Basis', 'Effective from', 'Authority', 'Status', '']}>
          {list.map(rate => (
            <RateRow
              key={rate.id}
              rate={rate}
              current={rate.id === inForce?.id}
              mayApprove={mayApprove}
              busy={busy === rate.id}
              onApprove={() => void run(
                rate.id,
                () => approveRate(ctx.client, rate.id, todayInIndia()),
                `Rate of ${formatRate(rate.paisePerSqFt)} from ${rate.effectiveFrom} approved.`,
              )}
            />
          ))}
        </Table>
      )}
      {adding && (
        <AddRateDialog
          busy={busy === 'add'}
          onClose={() => setAdding(false)}
          onSubmit={async input => {
            const done = await run(
              'add', () => addRate(ctx.client, input),
              result => (result as { note?: string }).note ?? 'Rate recorded.',
            );
            if (done) setAdding(false);
          }}
        />
      )}
    </Card>
  );
}

function RateRow({ rate, current, mayApprove, busy, onApprove }: {
  rate: Rate; current: boolean; mayApprove: boolean; busy: boolean; onApprove: () => void;
}) {
  return (
    <tr>
      <td className={`${cellClass} font-bold whitespace-nowrap`}>
        {formatRate(rate.paisePerSqFt)}
        {current && <span className="block text-[10px] font-semibold text-[var(--mv-muted)]">in force today</span>}
      </td>
      <td className={cellClass}>{rate.basis}</td>
      <td className={`${cellClass} whitespace-nowrap`}>{rate.effectiveFrom}</td>
      <td className={`${cellClass} max-w-[220px] break-words`}>{rate.authority}</td>
      <td className={cellClass}>
        {rate.approved
          ? <><Badge tone="ok">Approved</Badge>{rate.approvedOn !== null && <span className="block text-[10px] text-[var(--mv-muted)] mt-1">on {rate.approvedOn}</span>}</>
          : <Badge tone="warn">Pending approval</Badge>}
      </td>
      <td className={`${cellClass} text-right`}>
        {!rate.approved && mayApprove && (
          <Button tone="primary" disabled={busy} onClick={onApprove}>{busy ? 'Approving…' : 'Approve'}</Button>
        )}
      </td>
    </tr>
  );
}

function AddRateDialog({ busy, onClose, onSubmit }: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { paisePerSqFt: number; basis: AreaBasis; effectiveFrom: string; authority: string }) => void;
}) {
  const [rupees, setRupees] = useState('');
  const [basis, setBasis] = useState<AreaBasis>('super-built-up');
  const [effectiveFrom, setEffectiveFrom] = useState(todayInIndia());
  const [authority, setAuthority] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (): void => {
    let paise: number;
    try {
      paise = fromRupees(Number(rupees));
    } catch {
      setProblem('Enter the rate in rupees, to at most two decimals.');
      return;
    }
    if (rupees.trim() === '' || paise <= 0) { setProblem('The rate must be more than zero.'); return; }
    if (authority.trim() === '') { setProblem('Say which resolution or decision sets this rate.'); return; }
    setProblem(null);
    onSubmit({ paisePerSqFt: paise, basis, effectiveFrom, authority: authority.trim() });
  };

  return (
    <FormDialog
      id="gov-add-rate"
      title="Add a maintenance rate"
      intro="It is recorded unapproved. Someone with approval rights, other than you, signs it off before billing can use it."
      submitLabel="Record rate"
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="gov-rate-rupees" className={labelClass}>Rate (₹ per sq ft)</label>
          <input id="gov-rate-rupees" data-autofocus className={inputClass} inputMode="decimal" value={rupees}
            onChange={e => setRupees(e.target.value)} placeholder="4.50" required />
        </div>
        <div>
          <label htmlFor="gov-rate-basis" className={labelClass}>Area basis</label>
          <select id="gov-rate-basis" className={inputClass} value={basis} onChange={e => setBasis(e.target.value as AreaBasis)}>
            {AREA_BASES.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="gov-rate-from" className={labelClass}>Effective from</label>
        <input id="gov-rate-from" type="date" className={inputClass} value={effectiveFrom}
          onChange={e => setEffectiveFrom(e.target.value)} required />
      </div>
      <div>
        <label htmlFor="gov-rate-authority" className={labelClass}>Authority</label>
        <input id="gov-rate-authority" className={inputClass} value={authority} maxLength={300}
          onChange={e => setAuthority(e.target.value)} placeholder="e.g. AGM resolution 4 of 12 Aug 2026" required />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}
