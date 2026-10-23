import { useEffect, useState } from 'react';
import { readSociety, saveSociety, type SocietyProfileInput } from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import { Button, Card, LoadState, inputClass, labelClass, useLoad, useWrite } from './ui';

const EMPTY: SocietyProfileInput = {
  name: '', registrationNo: null, gstin: null, stateCode: null, tan: null,
  address: null, contactEmail: null, contactPhone: null,
};

/**
 * The society's registered name and tax registrations. Invoices, receipts and
 * the app's header read these from the server each time, so a correction here
 * shows on the next document generated; one already issued keeps what it was
 * issued with. The server checks the GSTIN (shape, check character, state) and
 * the TAN, and records every change with its before and after.
 */
export function SocietyProfileSection({ ctx }: { ctx: OfficeContext }) {
  const profile = useLoad(() => readSociety(ctx.client), [ctx]);
  const { busy, run } = useWrite(ctx, profile.refresh);
  const [form, setForm] = useState<SocietyProfileInput>(EMPTY);
  const editable = profile.data?.canEdit === true;

  useEffect(() => {
    const p = profile.data;
    if (p === null) return;
    setForm({
      name: p.name, registrationNo: p.registrationNo, gstin: p.gstin, stateCode: p.stateCode, tan: p.tan,
      address: p.address, contactEmail: p.contactEmail, contactPhone: p.contactPhone,
    });
  }, [profile.data]);

  const set = (field: keyof SocietyProfileInput) => (value: string): void => {
    setForm(f => ({ ...f, [field]: value === '' ? null : value }));
  };

  const field = (
    key: keyof SocietyProfileInput, label: string,
    opts: { hint?: string; upper?: boolean; maxLength?: number; type?: string; inputMode?: 'numeric' | 'email' | 'tel' } = {},
  ) => (
    <div>
      <label htmlFor={`gov-society-${key}`} className={labelClass}>{label}</label>
      <input
        id={`gov-society-${key}`}
        className={`${inputClass} ${opts.upper ? 'uppercase font-mono' : ''}`}
        type={opts.type ?? 'text'}
        inputMode={opts.inputMode}
        value={form[key] ?? ''}
        maxLength={opts.maxLength}
        readOnly={!editable}
        aria-describedby={opts.hint === undefined ? undefined : `gov-society-${key}-hint`}
        onChange={e => set(key)(opts.upper ? e.target.value.toUpperCase().replace(/\s+/g, '') : e.target.value)}
      />
      {opts.hint !== undefined && (
        <p id={`gov-society-${key}-hint`} className="text-[10px] text-[var(--mv-muted)] mt-1">{opts.hint}</p>
      )}
    </div>
  );

  const gstinState = form.gstin !== null && /^[0-9]{2}/.test(form.gstin) ? form.gstin.slice(0, 2) : null;
  const mismatch = gstinState !== null && form.stateCode !== null && gstinState !== form.stateCode;

  return (
    <Card title="Society profile">
      <LoadState loaded={profile} empty="" isEmpty={false} />
      {profile.data !== null && (
        <form
          className="space-y-4"
          onSubmit={event => {
            event.preventDefault();
            if (!editable || busy !== null) return;
            void run('save', () => saveSociety(ctx.client, form), result => (result as { note: string }).note);
          }}
        >
          <p className="text-xs text-[var(--mv-muted)] leading-relaxed">
            Printed on every invoice and receipt the society issues. Leave a registration blank until the association
            has its own — a GSTIN on a tax invoice is a legal statement, so nothing is ever filled in for you.
            {!editable && ' Only the secretary can change these.'}
          </p>
          {field('name', 'Registered name', { maxLength: 200 })}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {field('registrationNo', 'Registration no.', { maxLength: 100 })}
            {field('stateCode', 'State code', { maxLength: 2, inputMode: 'numeric', hint: 'Two digits. West Bengal is 19.' })}
            {field('gstin', 'GSTIN', { upper: true, maxLength: 15, hint: '15 characters, starting with the state code.' })}
            {field('tan', 'TAN', { upper: true, maxLength: 10, hint: 'Four letters, five digits, a letter.' })}
          </div>
          {mismatch && (
            <p role="alert" className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-xl p-2">
              The GSTIN starts {gstinState} but the state code is {form.stateCode}; the server will refuse this.
            </p>
          )}
          <div>
            <label htmlFor="gov-society-address" className={labelClass}>Address</label>
            <textarea
              id="gov-society-address"
              className={inputClass}
              rows={2}
              maxLength={500}
              readOnly={!editable}
              value={form.address ?? ''}
              onChange={e => set('address')(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {field('contactEmail', 'Office email', { type: 'email', inputMode: 'email', maxLength: 320 })}
            {field('contactPhone', 'Office phone', { type: 'tel', inputMode: 'tel', maxLength: 20 })}
          </div>
          {editable && (
            <div className="flex justify-end">
              <Button tone="primary" type="submit" disabled={busy !== null || form.name.trim() === ''}>
                {busy === 'save' ? 'Saving…' : 'Save profile'}
              </Button>
            </div>
          )}
        </form>
      )}
    </Card>
  );
}
