import { useId, useState, type FormEvent } from 'react';
import { Dialog } from '../../Dialog';
import type { OfficeContext } from '../types';
import { problemOf } from '../types';
import { reconcile, type BankAccount, type ReconcileResult } from '../../../api/office/bank';
import { ReconcileSummary } from './ReconcileSummary';
import { dialogPanel, errorBox, field, label, parseRupees, primaryButton, rupees, secondaryButton, todayIso } from './ui';

/**
 * The reconciliation sign-off. The treasurer enters the bank's closing balance
 * from the statement; the server works out the books' balance on the same day
 * and signs off only when the two agree. A difference is still recorded, as a
 * working paper, which is why the result is shown either way.
 */
export function ReconcileDialog({ ctx, accounts, initialAccountId, onClose, onReconciled }: {
  ctx: OfficeContext;
  accounts: readonly BankAccount[];
  initialAccountId: string;
  onClose: () => void;
  onReconciled: (accountId: string, result: ReconcileResult) => Promise<void>;
}) {
  const id = useId();
  const [accountId, setAccountId] = useState(initialAccountId);
  const [asAt, setAsAt] = useState(todayIso());
  const [balance, setBalance] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<ReconcileResult | null>(null);

  const account = accounts.find(a => a.id === accountId);
  const statementPaise = parseRupees(balance);
  // The account list carries today's book balance, so for today the
  // difference can be shown before anything is sent. For another day only the
  // server knows the books' balance.
  const preview = account !== undefined && statementPaise !== null && asAt === todayIso()
    ? statementPaise - account.ledgerBalancePaise
    : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (statementPaise === null) {
      setProblem('Enter the statement balance in rupees, for example 1,25,000.50.');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await reconcile(ctx.client, { bankAccountId: accountId, asAt, statementBalancePaise: statementPaise });
      setResult(outcome);
      ctx.toast(outcome.signedOff
        ? `Reconciliation signed off as at ${outcome.asAt}.`
        : `Recorded with a difference of ${rupees(outcome.differencePaise)}; not signed off.`,
      outcome.signedOff ? 'info' : 'error');
      await onReconciled(accountId, outcome);
    } catch (err) {
      const message = problemOf(err);
      setProblem(message);
      ctx.toast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog labelledBy={`${id}-title`} onClose={onClose} className={dialogPanel}>
      <h3 id={`${id}-title`} className="font-extrabold text-sm text-[var(--mv-ink)]">Reconcile and sign off</h3>
      <p className="text-[11px] text-[var(--mv-muted)] leading-snug">
        Enter the closing balance on the bank statement. It is signed off only if it equals the books'
        balance on that day; otherwise the difference is recorded for follow-up.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor={`${id}-account`} className={label}>Bank account</label>
          <select id={`${id}-account`} className={field} value={accountId} onChange={e => { setAccountId(e.target.value); setResult(null); }}>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.label} · {a.bankName} ··{a.accountLast4}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-asat`} className={label}>As at</label>
            <input
              id={`${id}-asat`}
              type="date"
              required
              max={todayIso()}
              className={field}
              value={asAt}
              onChange={e => { setAsAt(e.target.value); setResult(null); }}
            />
          </div>
          <div>
            <label htmlFor={`${id}-balance`} className={label}>Statement balance (₹)</label>
            <input
              id={`${id}-balance`}
              inputMode="decimal"
              required
              data-autofocus
              autoComplete="off"
              className={`${field} font-mono`}
              value={balance}
              onChange={e => { setBalance(e.target.value); setResult(null); }}
            />
          </div>
        </div>

        {result === null && account !== undefined && (
          <dl className="grid grid-cols-2 gap-2 p-3 rounded-xl bg-[var(--mv-soft)] border border-[var(--mv-border)]">
            <dt className="text-[var(--mv-muted)]">Books today</dt>
            <dd className="text-right font-mono font-bold text-[var(--mv-ink)]">{rupees(account.ledgerBalancePaise)}</dd>
            {preview !== null && (
              <>
                <dt className="text-[var(--mv-muted)]">Difference</dt>
                <dd className={`text-right font-mono font-bold ${preview === 0 ? 'text-[var(--mv-ink)]' : 'text-red-700'}`}>
                  {rupees(preview)}
                </dd>
              </>
            )}
          </dl>
        )}

        {result !== null && <ReconcileSummary result={result} />}
        {problem !== null && <p role="alert" className={errorBox}>{problem}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={secondaryButton}>
            {result === null ? 'Cancel' : 'Done'}
          </button>
          <button type="submit" disabled={busy || accountId === ''} className={primaryButton}>
            {busy ? 'Checking…' : 'Reconcile'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
