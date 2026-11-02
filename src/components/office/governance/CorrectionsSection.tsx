import { useMemo, useState } from 'react';
import { listFlats, listRates, type AreaBasis } from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import { Button, Card, LoadState, inputClass, labelClass, useLoad, useWrite } from './ui';

interface BillRow { id: string; proformaNo: string; flatNo: string; period: string; dueOn: string; state: string; gross: number }

/**
 * Corrections in place. Every record has an edit path that keeps the audit
 * trail (who, what it was, what it is now, and why); cancel-and-redo is not
 * the only way to fix a typo. An issued tax invoice is the one thing not
 * edited here: GST law has it corrected by a credit or debit note.
 */
export function CorrectionsSection({ ctx }: { ctx: OfficeContext }) {
  const flats = useLoad(() => listFlats(ctx.client), [ctx]);
  const rates = useLoad(() => listRates(ctx.client), [ctx]);
  const bills = useLoad(
    async () => (await ctx.client.get<{ documents: BillRow[] }>('/api/billing/documents')).documents
      .filter(d => d.state === 'draft' || d.state === 'approved'),
    [ctx],
  );
  const { busy, run } = useWrite(ctx, async () => { await Promise.all([flats.refresh(), rates.refresh(), bills.refresh()]); });

  const mayBills = ctx.can('billing.run');
  const mayFlats = ctx.can('member.manage');
  const mayRates = ctx.can('settings.manage');

  // --- bills
  const periods = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of bills.data ?? []) m.set(b.period, (m.get(b.period) ?? 0) + 1);
    return [...m];
  }, [bills.data]);
  const [fromMonth, setFromMonth] = useState(''); const [toMonth, setToMonth] = useState(''); const [monthWhy, setMonthWhy] = useState('');
  const [billId, setBillId] = useState(''); const [billDue, setBillDue] = useState(''); const [billWhy, setBillWhy] = useState('');
  const [billRecalc, setBillRecalc] = useState(true);
  // --- flats
  const [flatId, setFlatId] = useState(''); const [area, setArea] = useState(''); const [basis, setBasis] = useState<AreaBasis | ''>('');
  const [flatWhy, setFlatWhy] = useState('');
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState(''); const [ownerWhy, setOwnerWhy] = useState('');
  // --- rates
  const [rateId, setRateId] = useState(''); const [rateValue, setRateValue] = useState('');

  const field = (id: string, label: string, value: string, set: (v: string) => void, opts: { type?: string; placeholder?: string } = {}) => (
    <div>
      <label htmlFor={id} className={labelClass}>{label}</label>
      <input id={id} className={inputClass} type={opts.type ?? 'text'} value={value} placeholder={opts.placeholder} onChange={e => set(e.target.value)} />
    </div>
  );
  const post = (path: string, body: unknown) => () => ctx.client.post<{ note: string }>(path, body);
  const noteOf = (r: unknown): string => (r as { note: string }).note;

  const flat = (flats.data ?? []).find(f => f.id === flatId);
  const pendingRates = (rates.data ?? []).filter(r => !r.approved);

  return (
    <div className="space-y-5">
      <p className="text-xs text-[var(--mv-muted)] leading-relaxed">
        Fix a mistake without cancelling and re-raising. Each correction records who changed it, from what, to what, and
        why. A bill already approved goes back to the treasurer for approval again. An issued tax invoice is corrected
        with a credit or debit note (Vendors &amp; notes).
      </p>
      <LoadState loaded={bills} empty="" isEmpty={false} />

      {mayBills && (
        <Card title="Wrong month on a whole run">
          <form className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end" onSubmit={e => {
            e.preventDefault();
            void run('month', post(`/api/billing/periods/${encodeURIComponent(fromMonth)}/change-month`, { to: toMonth.trim(), reason: monthWhy }), noteOf).then(ok => { if (ok) { setToMonth(''); setMonthWhy(''); } });
          }}>
            <div>
              <label htmlFor="cx-from" className={labelClass}>Unsent bills for</label>
              <select id="cx-from" className={inputClass} value={fromMonth} onChange={e => setFromMonth(e.target.value)}>
                <option value="">Choose…</option>
                {periods.map(([p, n]) => <option key={p} value={p}>{p} ({n})</option>)}
              </select>
            </div>
            {field('cx-to', 'Change to', toMonth, setToMonth, { placeholder: 'Oct 2026' })}
            {field('cx-month-why', 'Reason', monthWhy, setMonthWhy)}
            <Button tone="primary" type="submit" disabled={busy !== null || fromMonth === '' || toMonth.trim() === '' || monthWhy.trim() === ''}>
              {busy === 'month' ? 'Moving…' : 'Move them'}
            </Button>
          </form>
          <p className="text-[10px] text-[var(--mv-muted)] mt-2">Bill numbers stay the same; amounts are worked out again at the new month's rate; all go back to draft for approval.</p>
        </Card>
      )}

      {mayBills && (
        <Card title="Correct one unsent bill">
          <form className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end" onSubmit={e => {
            e.preventDefault();
            void run('bill', post(`/api/billing/documents/${billId}/edit`, {
              ...(billDue === '' ? {} : { dueOn: billDue }), ...(billRecalc ? { recalculate: true } : {}), reason: billWhy,
            }), noteOf);
          }}>
            <div>
              <label htmlFor="cx-bill" className={labelClass}>Bill</label>
              <select id="cx-bill" className={inputClass} value={billId} onChange={e => setBillId(e.target.value)}>
                <option value="">Choose…</option>
                {(bills.data ?? []).map(b => <option key={b.id} value={b.id}>{b.flatNo} · {b.period} · {b.proformaNo} ({b.state})</option>)}
              </select>
            </div>
            {field('cx-due', 'New due date (optional)', billDue, setBillDue, { type: 'date' })}
            {field('cx-bill-why', 'Reason', billWhy, setBillWhy)}
            <div className="flex items-center gap-2 pb-2">
              <input id="cx-recalc" type="checkbox" checked={billRecalc} onChange={e => setBillRecalc(e.target.checked)} className="w-4 h-4 accent-[var(--mv-accent)]" />
              <label htmlFor="cx-recalc" className="text-xs text-[var(--mv-ink)]">Recalculate from the flat's area and the rate</label>
            </div>
            <Button tone="primary" type="submit" disabled={busy !== null || billId === '' || billWhy.trim() === ''}>{busy === 'bill' ? 'Saving…' : 'Save correction'}</Button>
          </form>
        </Card>
      )}

      {mayFlats && (
        <Card title="Flat and owner details">
          <LoadState loaded={flats} empty="No flats." isEmpty={(flats.data ?? []).length === 0} />
          <div className="max-w-sm mb-3">
            <label htmlFor="cx-flat" className={labelClass}>Flat</label>
            <select id="cx-flat" className={inputClass} value={flatId} onChange={e => {
              setFlatId(e.target.value);
              const f = (flats.data ?? []).find(x => x.id === e.target.value);
              setArea(f?.billingAreaSqFt == null ? '' : String(f.billingAreaSqFt)); setBasis(f?.areaBasis ?? ''); setName(f?.owner ?? '');
            }}>
              <option value="">Choose…</option>
              {(flats.data ?? []).map(f => <option key={f.id} value={f.id}>{f.flatNo}{f.owner ? ` · ${f.owner}` : ''}</option>)}
            </select>
          </div>
          {flat !== undefined && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form className="space-y-2" onSubmit={e => {
                e.preventDefault();
                void run('flat', post(`/api/flats/${flatId}/edit`, {
                  ...(area === '' ? {} : { billingAreaSqFt: Number(area) }), ...(basis === '' ? {} : { areaBasis: basis }), reason: flatWhy,
                }), noteOf);
              }}>
                <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--mv-ink)]">Area</h4>
                {field('cx-area', 'Billing area (sq ft)', area, setArea, { type: 'number' })}
                <div>
                  <label htmlFor="cx-basis" className={labelClass}>Area basis</label>
                  <select id="cx-basis" className={inputClass} value={basis} onChange={e => setBasis(e.target.value as AreaBasis | '')}>
                    <option value="">—</option><option value="carpet">carpet</option><option value="built-up">built-up</option><option value="super-built-up">super built-up</option>
                  </select>
                </div>
                {field('cx-flat-why', 'Reason', flatWhy, setFlatWhy)}
                <Button tone="primary" type="submit" disabled={busy !== null || flatWhy.trim() === ''}>{busy === 'flat' ? 'Saving…' : 'Save area'}</Button>
              </form>
              <form className="space-y-2" onSubmit={e => {
                e.preventDefault();
                void run('owner', post(`/api/flats/${flatId}/owner/correct`, {
                  ...(name.trim() === '' ? {} : { fullName: name.trim() }), ...(email.trim() === '' ? {} : { email: email.trim() }),
                  ...(phone.trim() === '' ? {} : { phone: phone.trim() }), reason: ownerWhy,
                }), noteOf);
              }}>
                <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--mv-ink)]">Owner (a correction, not a change of owner)</h4>
                {field('cx-name', 'Name', name, setName)}
                {field('cx-email', 'E-mail (leave blank to keep)', email, setEmail, { type: 'email' })}
                {field('cx-phone', 'Phone (leave blank to keep)', phone, setPhone, { type: 'tel' })}
                {field('cx-owner-why', 'Reason', ownerWhy, setOwnerWhy)}
                <Button tone="primary" type="submit" disabled={busy !== null || ownerWhy.trim() === ''}>{busy === 'owner' ? 'Saving…' : 'Save owner'}</Button>
              </form>
            </div>
          )}
        </Card>
      )}

      {mayRates && (
        <Card title="A rate still waiting for approval">
          {pendingRates.length === 0 ? (
            <p className="text-xs text-[var(--mv-muted)]">No rate is waiting. An approved rate is corrected by recording a new one with a new effective date.</p>
          ) : (
            <form className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end" onSubmit={e => {
              e.preventDefault();
              void run('rate', post(`/api/rates/${rateId}/edit`, { paisePerSqFt: Math.round(Number(rateValue) * 100) }), noteOf);
            }}>
              <div>
                <label htmlFor="cx-rate" className={labelClass}>Rate</label>
                <select id="cx-rate" className={inputClass} value={rateId} onChange={e => setRateId(e.target.value)}>
                  <option value="">Choose…</option>
                  {pendingRates.map(r => <option key={r.id} value={r.id}>₹{r.ratePerSqFt.toFixed(2)} from {r.effectiveFrom}</option>)}
                </select>
              </div>
              {field('cx-rate-value', 'Correct rate (₹ per sq ft)', rateValue, setRateValue, { type: 'number' })}
              <Button tone="primary" type="submit" disabled={busy !== null || rateId === '' || rateValue === ''}>{busy === 'rate' ? 'Saving…' : 'Save rate'}</Button>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
