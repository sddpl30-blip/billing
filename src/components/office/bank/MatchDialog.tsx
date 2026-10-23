import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Dialog } from '../../Dialog';
import type { OfficeContext } from '../types';
import { problemOf } from '../types';
import {
  listReceipts, matchBankLine,
  type BankLine, type MatchTarget, type ReceiptSummary,
} from '../../../api/office/bank';
import { dialogPanel, errorBox, field, label, primaryButton, rupees, secondaryButton } from './ui';

type Kind = 'receipt' | 'vendor' | 'suspense';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Matching one statement line by hand: to a member receipt, to a vendor
 * payment, or into suspense with a reason. Money in can only be a receipt and
 * money out only a vendor payment, so the dialog offers just the one that fits.
 */
export function MatchDialog({ ctx, line, onClose, onMatched }: {
  ctx: OfficeContext;
  line: BankLine;
  onClose: () => void;
  onMatched: () => Promise<void>;
}) {
  const id = useId();
  const moneyIn = line.amountPaise > 0;
  const [kind, setKind] = useState<Kind>(moneyIn ? 'receipt' : 'vendor');
  const [receipts, setReceipts] = useState<ReceiptSummary[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [receiptId, setReceiptId] = useState(line.suggestions[0]?.paymentId ?? '');
  const [vendorPaymentId, setVendorPaymentId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!moneyIn) return;
    let live = true;
    listReceipts(ctx.client)
      .then(list => { if (live) setReceipts(list); })
      .catch(err => { if (live) { setReceipts([]); setProblem(problemOf(err)); } });
    return () => { live = false; };
  }, [ctx.client, moneyIn]);

  // The server refuses a match whose amounts differ, so the same-amount
  // receipts are the ones worth offering first.
  const offered = useMemo(() => {
    if (receipts === null) return [];
    return showAll ? receipts : receipts.filter(r => r.amountPaise === line.amountPaise);
  }, [receipts, showAll, line.amountPaise]);

  const target = (): MatchTarget | string => {
    if (kind === 'receipt') return receiptId === '' ? 'Choose a receipt.' : { paymentId: receiptId };
    if (kind === 'vendor') {
      const value = vendorPaymentId.trim();
      return UUID.test(value) ? { vendorPaymentId: value } : 'A vendor payment id looks like 8-4-4-4-12 hex digits.';
    }
    return reason.trim() === '' ? 'Say why the line is going to suspense.' : { suspenseReason: reason.trim() };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const chosen = target();
    if (typeof chosen === 'string') {
      setProblem(chosen);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await matchBankLine(ctx.client, line.id, chosen);
      ctx.toast(outcome.matched ? 'Line matched.' : 'Line moved to suspense.');
      await onMatched();
      onClose();
    } catch (err) {
      const message = problemOf(err);
      setProblem(message);
      ctx.toast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const radio = (value: Kind, text: string) => (
    <label className="flex items-center gap-2 font-bold text-[var(--mv-ink)] cursor-pointer" htmlFor={`${id}-kind-${value}`}>
      <input
        id={`${id}-kind-${value}`}
        type="radio"
        name={`${id}-kind`}
        value={value}
        checked={kind === value}
        onChange={() => { setKind(value); setProblem(null); }}
        className="accent-[var(--mv-accent)]"
      />
      {text}
    </label>
  );

  return (
    <Dialog labelledBy={`${id}-title`} onClose={onClose} className={dialogPanel}>
      <h3 id={`${id}-title`} className="font-extrabold text-sm text-[var(--mv-ink)]">Match a bank line</h3>
      <div className="p-3 rounded-xl bg-[var(--mv-soft)] border border-[var(--mv-border)] space-y-0.5">
        <p className="flex justify-between gap-3">
          <span className="font-bold text-[var(--mv-ink)]">{line.valueDate}</span>
          <span className={`font-mono font-bold ${moneyIn ? 'text-[var(--mv-ink)]' : 'text-red-700'}`}>
            {moneyIn ? '+' : ''}{rupees(line.amountPaise)}
          </span>
        </p>
        <p className="text-[var(--mv-muted)] break-words">{line.narration}</p>
        {line.reference !== null && <p className="text-[var(--mv-muted)] font-mono break-all">Ref {line.reference}</p>}
      </div>

      <form onSubmit={submit} className="space-y-3">
        <fieldset className="space-y-2">
          <legend className={label}>Match to</legend>
          {moneyIn ? radio('receipt', 'A member receipt') : radio('vendor', 'A vendor payment')}
          {radio('suspense', 'Suspense, with a reason')}
        </fieldset>

        {kind === 'receipt' && (
          <div className="space-y-2">
            <label htmlFor={`${id}-receipt`} className={label}>Receipt</label>
            {receipts === null ? (
              <p className="text-[var(--mv-muted)]">Loading receipts…</p>
            ) : (
              <select
                id={`${id}-receipt`}
                className={field}
                value={receiptId}
                onChange={e => setReceiptId(e.target.value)}
              >
                <option value="">
                  {offered.length === 0 ? 'No receipt for this amount' : 'Choose a receipt'}
                </option>
                {offered.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.receiptNo} · Flat {r.flatNo} · {r.receivedOn} · {rupees(r.amountPaise)}
                    {line.suggestions.some(s => s.paymentId === r.id) ? ' (suggested)' : ''}
                  </option>
                ))}
              </select>
            )}
            <label htmlFor={`${id}-all`} className="flex items-center gap-2 text-[11px] text-[var(--mv-muted)] cursor-pointer">
              <input
                id={`${id}-all`}
                type="checkbox"
                checked={showAll}
                onChange={e => setShowAll(e.target.checked)}
                className="accent-[var(--mv-accent)]"
              />
              Show receipts of other amounts too
            </label>
          </div>
        )}

        {kind === 'vendor' && (
          <div>
            <label htmlFor={`${id}-vendor`} className={label}>Vendor payment id</label>
            <input
              id={`${id}-vendor`}
              className={`${field} font-mono`}
              value={vendorPaymentId}
              onChange={e => setVendorPaymentId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[10px] text-[var(--mv-muted)] mt-1 leading-snug">
              The server does not yet list vendor payments, so the id has to come from the payment record.
              Its amount must equal this line's.
            </p>
          </div>
        )}

        {kind === 'suspense' && (
          <div>
            <label htmlFor={`${id}-reason`} className={label}>Reason</label>
            <textarea
              id={`${id}-reason`}
              className={`${field} font-medium min-h-[72px]`}
              maxLength={300}
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </div>
        )}

        {problem !== null && <p role="alert" className={errorBox}>{problem}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={secondaryButton}>Cancel</button>
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? 'Saving…' : kind === 'suspense' ? 'Move to suspense' : 'Match'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
