import React, { useEffect, useId, useState } from 'react';
import { Download, IndianRupee } from 'lucide-react';
import { formatRupees, type Paise } from '../accounting';
import {
  RECEIPT_METHODS, type BankAccountOption, type BooksActions, type ReceiptMethod,
  type ReceiptOutcome,
} from '../store/actions';

export interface OpenDocument {
  readonly proformaNo: string;
  /** What the manager recognises it by: the tax invoice number where there is one. */
  readonly label: string;
  readonly outstanding: Paise;
}

interface ReceiptEntryFormProps {
  flats: ReadonlyArray<{ flatNo: string; name: string }>;
  /** The documents a receipt can be set against for a flat, oldest first. */
  openDocumentsFor: (flatNo: string) => readonly OpenDocument[];
  actions: BooksActions;
  today: string;
  /** Who is recording it, for the demonstration's audit line. */
  by: string;
  onRecorded: (outcome: ReceiptOutcome, flatNo: string) => void;
  onError: (message: string) => void;
  /** Saves the receipt the server issued, where there is a server. */
  onDownloadReceipt?: (receiptNo: string) => Promise<void>;
  /** Shown above the form: where the money goes and what is not contacted. */
  note: string;
  compact?: boolean;
}

/**
 * The manager's receipt entry: money that has already reached the bank,
 * recorded against a flat.
 *
 * This is the one way a receipt gets into the books on the server. Residents
 * cannot record their own payments — there is no gateway, and a member saying
 * "I paid" is not a bank credit — so without this screen nothing could ever be
 * marked paid.
 */
export const ReceiptEntryForm: React.FC<ReceiptEntryFormProps> = ({
  flats, openDocumentsFor, actions, today, by, onRecorded, onError, onDownloadReceipt, note,
  compact = false,
}) => {
  const id = useId();
  const [flatNo, setFlatNo] = useState(flats[0]?.flatNo ?? '');
  const [against, setAgainst] = useState('');
  const [amount, setAmount] = useState('');
  const [receivedOn, setReceivedOn] = useState(today);
  const [method, setMethod] = useState<ReceiptMethod>('upi');
  const [reference, setReference] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');
  const [accounts, setAccounts] = useState<readonly BankAccountOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ReceiptOutcome | null>(null);

  useEffect(() => {
    let cancelled = false;
    // An account to bank it into, where the society keeps more than one. A
    // refusal here only means there is no choice to offer; the server then
    // uses the operating account.
    actions.bankAccounts()
      .then(list => { if (!cancelled) setAccounts(list); })
      .catch(() => { if (!cancelled) setAccounts([]); });
    return () => { cancelled = true; };
  }, [actions]);

  useEffect(() => {
    if (flatNo === '' && flats.length > 0) setFlatNo(flats[0].flatNo);
  }, [flats, flatNo]);

  const open = flatNo === '' ? [] : openDocumentsFor(flatNo);
  const owed = open.reduce((sum, d) => sum + d.outstanding, 0);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const rupees = parseFloat(amount);
    if (flatNo === '') {
      onError('Choose the flat the money came from.');
      return;
    }
    if (!Number.isFinite(rupees) || rupees <= 0) {
      onError('Enter the amount received, greater than zero.');
      return;
    }
    if (receivedOn > today) {
      onError('A receipt cannot be dated in the future.');
      return;
    }
    setBusy(true);
    try {
      const outcome = await actions.recordReceipt({
        flatNo,
        amountRupees: Math.round(rupees * 100) / 100,
        receivedOn,
        method,
        by,
        ...(reference.trim() === '' ? {} : { reference: reference.trim() }),
        ...(bankAccountId === '' ? {} : { bankAccountId }),
        ...(against === '' ? {} : { againstProformaNo: against }),
      });
      setLast(outcome);
      setAmount('');
      setReference('');
      setAgainst('');
      onRecorded(outcome, flatNo);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'The receipt was not recorded.');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full bg-[var(--mv-surface)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold text-xs text-[var(--mv-ink)] outline-none focus:border-[var(--mv-accent)]';
  const label = 'text-[10px] text-[var(--mv-muted)] font-bold block mb-1 uppercase tracking-wider';

  return (
    <form onSubmit={submit} className="space-y-3 text-xs font-medium text-left" aria-labelledby={`${id}-title`}>
      <div className="flex items-center gap-2 border-b border-[var(--mv-border)] pb-2">
        <IndianRupee className="w-4 h-4 text-[var(--mv-accent)]" aria-hidden="true" />
        <h3 id={`${id}-title`} className="text-[10px] font-bold uppercase text-[var(--mv-ink)] tracking-wider">Record a receipt</h3>
      </div>
      <p className="text-[10px] text-[var(--mv-muted)] leading-snug">{note}</p>

      <div className={compact ? 'space-y-3' : 'grid grid-cols-2 gap-3'}>
        <div>
          <label htmlFor={`${id}-flat`} className={label}>Flat</label>
          <select
            id={`${id}-flat`}
            value={flatNo}
            onChange={e => { setFlatNo(e.target.value); setAgainst(''); }}
            className={field}
            required
          >
            {flats.length === 0 && <option value="">No flats on record</option>}
            {flats.map(flat => (
              <option key={flat.flatNo} value={flat.flatNo}>{flat.flatNo} · {flat.name}</option>
            ))}
          </select>
          <span className="text-[9px] text-[var(--mv-muted)] block mt-1">
            {open.length === 0 ? 'Nothing open on this flat; the receipt is held as an advance.' : `${formatRupees(owed as Paise)} open across ${open.length} ${open.length === 1 ? 'invoice' : 'invoices'}.`}
          </span>
        </div>
        <div>
          <label htmlFor={`${id}-against`} className={label}>Against</label>
          <select
            id={`${id}-against`}
            value={against}
            onChange={e => setAgainst(e.target.value)}
            className={field}
          >
            <option value="">Oldest open invoice first</option>
            {open.map(d => (
              <option key={d.proformaNo} value={d.proformaNo}>
                {d.label} · {formatRupees(d.outstanding)} open
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-amount`} className={label}>Amount received (₹)</label>
          <input
            id={`${id}-amount`}
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            required
            value={amount}
            onChange={e => setAmount(e.target.value)}
            className={`${field} font-mono`}
          />
        </div>
        <div>
          <label htmlFor={`${id}-date`} className={label}>Received on</label>
          <input
            id={`${id}-date`}
            type="date"
            required
            max={today}
            value={receivedOn}
            onChange={e => setReceivedOn(e.target.value)}
            className={`${field} font-mono`}
          />
        </div>
        <div>
          <label htmlFor={`${id}-method`} className={label}>Method</label>
          <select
            id={`${id}-method`}
            value={method}
            onChange={e => setMethod(e.target.value as ReceiptMethod)}
            className={field}
          >
            {RECEIPT_METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-ref`} className={label}>UTR / cheque no. / reference</label>
          <input
            id={`${id}-ref`}
            type="text"
            maxLength={100}
            value={reference}
            onChange={e => setReference(e.target.value)}
            className={`${field} font-mono`}
          />
        </div>
        {accounts.length > 0 && (
          <div className={compact ? '' : 'col-span-2'}>
            <label htmlFor={`${id}-bank`} className={label}>Banked into</label>
            <select
              id={`${id}-bank`}
              value={bankAccountId}
              onChange={e => setBankAccountId(e.target.value)}
              className={field}
            >
              <option value="">Operating account (default)</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={busy || flats.length === 0}
        className="w-full py-3 bg-[var(--mv-accent)] hover:brightness-90 text-white rounded-xl font-bold uppercase tracking-wider text-center cursor-pointer disabled:opacity-60 disabled:cursor-wait"
      >
        {busy ? 'Recording…' : 'Record receipt'}
      </button>

      {last !== null && (
        <div className="p-3 rounded-xl border border-[var(--mv-accent-border)] bg-[var(--mv-accent-soft)] text-[11px] text-[var(--mv-ink)] space-y-1" role="status">
          <p className="font-bold">Receipt {last.receiptNo} recorded.</p>
          <p>
            {formatRupees(last.appliedToDues)} applied to dues
            {last.heldAsAdvance > 0 ? `, ${formatRupees(last.heldAsAdvance)} held as an advance` : ''}.
          </p>
          {onDownloadReceipt !== undefined && (
            <button
              type="button"
              onClick={() => {
                onDownloadReceipt(last.receiptNo).catch((err: unknown) => {
                  onError(err instanceof Error ? err.message : 'The receipt could not be fetched.');
                });
              }}
              className="mt-1 inline-flex items-center gap-1 font-bold text-[var(--mv-accent)] hover:underline"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" /> Download receipt PDF
            </button>
          )}
        </div>
      )}
    </form>
  );
};
