import { useId, useState, type FormEvent } from 'react';
import { Dialog } from '../../Dialog';
import type { OfficeContext } from '../types';
import { problemOf } from '../types';
import { addBankAccount } from '../../../api/office/bank';
import { dialogPanel, errorBox, field, label, primaryButton, secondaryButton } from './ui';

/**
 * Records one of the society's bank accounts. Only the bank's name, the last
 * four digits and the IFSC: the server has nowhere to keep a full account
 * number, and a reconciliation needs none.
 */
export function AddAccountDialog({ ctx, taken, onClose, onAdded }: {
  ctx: OfficeContext;
  /** Purposes that already have an active account, which the server would refuse. */
  taken: readonly string[];
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const id = useId();
  const [purpose, setPurpose] = useState<'operating' | 'sinking'>(taken.includes('operating') ? 'sinking' : 'operating');
  const [bankName, setBankName] = useState('');
  const [last4, setLast4] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (bankName.trim().length < 2) { setProblem('Enter the bank\'s name.'); return; }
    if (!/^[0-9]{4}$/.test(last4)) { setProblem('Enter the last four digits of the account number.'); return; }
    if (!/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(ifsc.trim())) {
      setProblem('An IFSC is 11 characters: four letters, a zero, then six letters or digits.');
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const result = await addBankAccount(ctx.client, {
        purpose, bankName: bankName.trim(), last4, ifsc: ifsc.trim().toUpperCase(),
      });
      ctx.toast(`${result.label} added.`);
      await onAdded();
      onClose();
    } catch (err) {
      setProblem(problemOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog labelledBy={`${id}-title`} onClose={onClose} className={dialogPanel}>
      <h3 id={`${id}-title`} className="font-extrabold text-sm text-[var(--mv-ink)]">Add a bank account</h3>
      <p className="text-[11px] text-[var(--mv-muted)] leading-snug">
        The bank&apos;s name, the last four digits and the IFSC only. The full account number is never asked for or stored.
      </p>
      <form onSubmit={e => void submit(e)} className="space-y-3">
        <div>
          <label htmlFor={`${id}-purpose`} className={label}>Account</label>
          <select id={`${id}-purpose`} className={field} value={purpose}
            onChange={e => setPurpose(e.target.value as 'operating' | 'sinking')}>
            <option value="operating" disabled={taken.includes('operating')}>Operating account (maintenance collections)</option>
            <option value="sinking" disabled={taken.includes('sinking')}>Sinking fund account</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-bank`} className={label}>Bank name</label>
          <input id={`${id}-bank`} className={field} value={bankName} maxLength={100}
            onChange={e => setBankName(e.target.value)} placeholder="e.g. State Bank of India" required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-last4`} className={label}>Last 4 digits</label>
            <input id={`${id}-last4`} className={field} value={last4} inputMode="numeric" maxLength={4}
              onChange={e => setLast4(e.target.value.replace(/\D/g, ''))} required />
          </div>
          <div>
            <label htmlFor={`${id}-ifsc`} className={label}>IFSC</label>
            <input id={`${id}-ifsc`} className={field} value={ifsc} maxLength={11}
              onChange={e => setIfsc(e.target.value.toUpperCase())} required />
          </div>
        </div>
        {problem !== null && <p role="alert" className={errorBox}>{problem}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryButton}>Cancel</button>
          <button type="submit" disabled={busy} className={primaryButton}>{busy ? 'Adding…' : 'Add account'}</button>
        </div>
      </form>
    </Dialog>
  );
}
