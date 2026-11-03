import { useEffect, useState } from 'react';
import { readPaymentQr, readSociety, savePaymentQr, saveSociety, type SocietyProfileInput } from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import { Button, Card, LoadState, inputClass, labelClass, useLoad, useWrite } from './ui';

const EMPTY: SocietyProfileInput = {
  name: '', registrationNo: null, gstin: null, stateCode: null, tan: null,
  address: null, contactEmail: null, contactPhone: null,
  payBankName: null, payBranch: null, payAccountNo: null, payIfsc: null, payUpiId: null,
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
  const qr = useLoad(() => readPaymentQr(ctx.client), [ctx]);
  const qrWrite = useWrite(ctx, qr.refresh);
  const [qrError, setQrError] = useState<string | null>(null);
  const editable = profile.data?.canEdit === true;

  useEffect(() => {
    const p = profile.data;
    if (p === null) return;
    setForm({
      name: p.name, registrationNo: p.registrationNo, gstin: p.gstin, stateCode: p.stateCode, tan: p.tan,
      address: p.address, contactEmail: p.contactEmail, contactPhone: p.contactPhone,
      payBankName: p.payBankName ?? null, payBranch: p.payBranch ?? null,
      payAccountNo: p.payAccountNo ?? null, payIfsc: p.payIfsc ?? null, payUpiId: p.payUpiId ?? null,
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

  const chooseQr = async (file: File | undefined): Promise<void> => {
    setQrError(null);
    if (file === undefined) return;
    if (file.type === 'application/pdf') {
      setQrError('A PDF cannot be used directly. Open it, take a screenshot or export the QR as an image (JPG or PNG), and upload that.');
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const side = Math.min(bitmap.width, bitmap.height);
      if (side < 300) { setQrError(`The image is ${bitmap.width} × ${bitmap.height}; it must be at least 300 × 300 so the QR scans cleanly.`); return; }
      if (Math.abs(bitmap.width - bitmap.height) > side * 0.1) {
        setQrError('Crop the image to just the QR square (width and height nearly equal) and upload again.'); return;
      }
      const out = Math.min(side, 1000);
      const canvas = document.createElement('canvas');
      canvas.width = out; canvas.height = out;
      const g = canvas.getContext('2d');
      if (g === null) { setQrError('This browser cannot prepare the image.'); return; }
      g.fillStyle = '#fff'; g.fillRect(0, 0, out, out);
      g.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, out, out);
      const data = canvas.toDataURL('image/jpeg', 0.92).split(',')[1] ?? '';
      void qrWrite.run('qr', () => savePaymentQr(ctx.client, data), r => (r as { note: string }).note);
    } catch {
      setQrError('That file could not be read as an image. Use a JPG or PNG.');
    }
  };

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
          <fieldset className="space-y-2">
            <legend className={labelClass}>Bank details printed on proforma invoices</legend>
            <p className="text-[10px] text-[var(--mv-muted)]">
              The account members pay into, in full, as the bill should show it. Leave all blank and the bill says
              the details are not yet entered.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {field('payBankName', 'Bank', { maxLength: 100 })}
              {field('payBranch', 'Branch', { maxLength: 100 })}
              {field('payAccountNo', 'Account no.', { inputMode: 'numeric', maxLength: 20, hint: 'Digits only.' })}
              {field('payIfsc', 'IFSC', { upper: true, maxLength: 11, hint: 'Such as ICIC0001064.' })}
            </div>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className={labelClass}>Payment QR code (UPI)</legend>
            {field('payUpiId', 'UPI ID', { maxLength: 120, hint: 'Printed under the QR. With no QR uploaded, only this line is printed.' })}
            {qr.data !== null && !qr.data.available && (
              <p role="alert" className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-xl p-2">
                The QR needs database migration 013 (docs/neon/013-apply.sql) before it can be saved.
              </p>
            )}
            {qr.data?.present === true && qr.data.imageBase64 !== undefined && (
              <img
                alt="Current payment QR code" width={120} height={120}
                className="border border-[var(--mv-border)] rounded-lg"
                src={`data:image/jpeg;base64,${qr.data.imageBase64}`}
              />
            )}
            {editable && (
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="file" accept="image/jpeg,image/png" aria-label="Upload payment QR image"
                  disabled={qrWrite.busy !== null || qr.data?.available === false}
                  onChange={e => { void chooseQr(e.target.files?.[0]); e.target.value = ''; }}
                  className="text-xs"
                />
                {qr.data?.present === true && (
                  <Button tone="secondary" type="button" disabled={qrWrite.busy !== null}
                    onClick={() => void qrWrite.run('qr', () => savePaymentQr(ctx.client, null), r => (r as { note: string }).note)}>
                    Remove QR
                  </Button>
                )}
              </div>
            )}
            {qrError !== null && <p role="alert" className="text-xs text-red-700">{qrError}</p>}
            <p className="text-[10px] text-[var(--mv-muted)]">
              Upload the QR as a square image (JPG or PNG, at least 300 × 300 px). Bills read it from here each time they are drawn.
            </p>
          </fieldset>
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
