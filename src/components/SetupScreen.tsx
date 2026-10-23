import React, { useEffect, useState } from 'react';
import { Building2, CheckCircle2 } from 'lucide-react';
import type { ApiClient } from '../api/client';
import { ThemeSwitcher } from './ThemeSwitcher';

/**
 * First-time setup, in front of the sign-in screen.
 *
 * A fresh production database has no society and no accounts, so the sign-in
 * screen alone is a locked door with no key. While the server says setup is
 * still needed, this gate shows the setup form instead; once the society
 * exists (or for any deployment that already has one) it shows its children,
 * the ordinary sign-in screen.
 */
export function SetupGate({ client, children }: { client: ApiClient; children: React.ReactNode }) {
  const [status, setStatus] = useState<{ required: boolean; open: boolean } | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client.get<{ required: boolean; open: boolean }>('/api/setup')
      // An older server without the route, or any failure here, falls through
      // to sign-in: setup is an extra door, never a reason to block the main one.
      .then(r => { if (live) setStatus(r); })
      .catch(() => { if (live) setStatus({ required: false, open: false }); });
    return () => { live = false; };
  }, [client]);

  if (status === null) return null;
  if (created !== null) {
    return (
      <>
        <div role="status" className="fixed top-0 inset-x-0 z-[70] bg-[#14532D] text-white text-[11px] font-bold px-4 py-2 text-center">
          The society is set up. Sign in as {created} with a password, then remove SETUP_TOKEN from the deployment.
        </div>
        {children}
      </>
    );
  }
  if (!status.required) return <>{children}</>;
  return <SetupForm client={client} open={status.open} onDone={setCreated} />;
}

function SetupForm({ client, open, onDone }: {
  client: ApiClient; open: boolean; onDone: (secretaryEmail: string) => void;
}) {
  const [form, setForm] = useState({
    token: '', societyName: '', registrationNo: '', gstin: '', stateCode: '',
    invoicePrefix: 'MV', secretaryEmail: '', secretaryPassword: '', confirm: '',
    bankName: '', last4: '', ifsc: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (form.secretaryPassword !== form.confirm) {
      setError('The two passwords do not match.');
      return;
    }
    const anyBank = form.bankName !== '' || form.last4 !== '' || form.ifsc !== '';
    setBusy(true);
    try {
      const reply = await client.call<{ secretaryEmail: string }>('/api/setup', {
        method: 'POST',
        body: {
          token: form.token.trim(),
          societyName: form.societyName.trim(),
          invoicePrefix: form.invoicePrefix.trim().toUpperCase(),
          secretaryEmail: form.secretaryEmail.trim(),
          secretaryPassword: form.secretaryPassword,
          ...(form.registrationNo.trim() ? { registrationNo: form.registrationNo.trim() } : {}),
          ...(form.gstin.trim() ? { gstin: form.gstin.trim().toUpperCase() } : {}),
          ...(form.stateCode.trim() ? { stateCode: form.stateCode.trim() } : {}),
          ...(anyBank
            ? { bank: { bankName: form.bankName.trim(), last4: form.last4.trim(), ifsc: form.ifsc.trim().toUpperCase() } }
            : {}),
        },
      });
      onDone(reply.secretaryEmail);
    } catch (err) {
      const detail = (err as { detail?: unknown }).detail;
      const issues = Array.isArray(detail)
        ? ` ${detail.map(d => (typeof d === 'object' && d !== null && 'path' in d && 'message' in d
          ? `${String((d as { path: unknown }).path)}: ${String((d as { message: unknown }).message)}`
          : String(d))).join('; ')}`
        : '';
      setError((err instanceof Error ? err.message : 'Setup failed.') + issues);
    } finally {
      setBusy(false);
    }
  };

  const field = (
    key: keyof typeof form, label: string,
    opts: { type?: string; required?: boolean; hint?: string; autoComplete?: string; maxLength?: number } = {},
  ) => (
    <div>
      <label htmlFor={`setup-${key}`} className="block text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)] mb-1">
        {label}{opts.required ? ' *' : ''}
      </label>
      <input
        id={`setup-${key}`}
        type={opts.type ?? 'text'}
        value={form[key]}
        onChange={set(key)}
        required={opts.required}
        autoComplete={opts.autoComplete ?? 'off'}
        maxLength={opts.maxLength}
        className="w-full rounded-xl border border-[var(--mv-border)] bg-[var(--mv-surface)] px-3 py-2.5 text-sm text-[var(--mv-ink)] focus:outline-none focus:border-[var(--mv-accent)]"
      />
      {opts.hint && <p className="mt-1 text-[11px] text-[var(--mv-muted)]">{opts.hint}</p>}
    </div>
  );

  return (
    <div className="min-h-screen bg-[var(--mv-soft)] font-sans text-[var(--mv-ink)] px-4 py-10">
      <div className="max-w-xl mx-auto">
        <div className="flex justify-end mb-4"><ThemeSwitcher /></div>
        <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl shadow-xs p-6 sm:p-8">
          <div className="flex items-center gap-3 mb-2">
            <Building2 className="w-6 h-6 text-[var(--mv-accent)]" aria-hidden="true" />
            <h1 className="text-xl font-bold">Set up your society</h1>
          </div>
          <p className="text-sm text-[var(--mv-muted)] mb-6">
            This database has no society yet. Setup creates it once, with the chart of accounts and the
            secretary's account. The secretary then adds flats, owners, the other office-bearers and the
            maintenance rate from the Office.
          </p>

          {!open ? (
            <p role="alert" className="text-sm rounded-xl border border-[var(--mv-border)] p-4">
              Setup from this page is closed because <code>SETUP_TOKEN</code> is not set in the deployment.
              Add it (at least 16 characters) in the hosting settings and redeploy, or run{' '}
              <code>npm run db:bootstrap</code> from a terminal.
            </p>
          ) : (
            <form onSubmit={e => { void submit(e); }} className="space-y-5" noValidate={false}>
              <fieldset className="space-y-3">
                <legend className="text-xs font-bold uppercase tracking-wider mb-2">Society</legend>
                {field('societyName', 'Registered name', { required: true })}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {field('registrationNo', 'Registration no.')}
                  {field('invoicePrefix', 'Invoice prefix', { required: true, maxLength: 6, hint: 'Up to 6 letters or digits, e.g. MV' })}
                  {field('gstin', 'GSTIN', { maxLength: 15, hint: 'Only the society\'s own. Leave blank if not registered.' })}
                  {field('stateCode', 'State code', { maxLength: 2, hint: 'Two digits, e.g. 27 for Maharashtra' })}
                </div>
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="text-xs font-bold uppercase tracking-wider mb-2">Secretary's account</legend>
                {field('secretaryEmail', 'Email', { type: 'email', required: true, autoComplete: 'email' })}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {field('secretaryPassword', 'Password', { type: 'password', required: true, autoComplete: 'new-password', hint: 'At least 12 characters' })}
                  {field('confirm', 'Confirm password', { type: 'password', required: true, autoComplete: 'new-password' })}
                </div>
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="text-xs font-bold uppercase tracking-wider mb-2">Operating bank account (optional)</legend>
                <p className="text-[11px] text-[var(--mv-muted)] -mt-1">Last four digits and IFSC only. The full account number is never stored.</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {field('bankName', 'Bank')}
                  {field('last4', 'Last 4 digits', { maxLength: 4 })}
                  {field('ifsc', 'IFSC', { maxLength: 11 })}
                </div>
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="text-xs font-bold uppercase tracking-wider mb-2">Authorisation</legend>
                {field('token', 'Setup token', { type: 'password', required: true, hint: 'The SETUP_TOKEN value set in the deployment.' })}
              </fieldset>

              {error && <p role="alert" className="text-sm text-[#991B1B] bg-[#FEF2F2] border border-[#FECACA] rounded-xl p-3">{error}</p>}

              <button
                type="submit"
                disabled={busy}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-[var(--mv-accent)] text-white font-bold text-sm py-3 disabled:opacity-60"
              >
                <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                {busy ? 'Setting up…' : 'Create the society'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
