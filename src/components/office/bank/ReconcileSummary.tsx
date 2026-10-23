import type { ReconcileResult } from '../../../api/office/bank';
import { rupees } from './ui';

/** Book against bank for one reconciliation, and whether it was signed off. */
export function ReconcileSummary({ result }: { result: ReconcileResult }) {
  const clean = result.signedOff;
  return (
    <div
      role="status"
      className={`p-3 rounded-xl border space-y-2 ${
        clean
          ? 'bg-[var(--mv-accent-soft)] border-[var(--mv-accent-border)]'
          : 'bg-red-50 border-red-200'
      }`}
    >
      <p className={`font-bold ${clean ? 'text-[var(--mv-ink)]' : 'text-red-700'}`}>
        {clean
          ? `Signed off as at ${result.asAt}.`
          : `Not signed off: the books and the bank disagree as at ${result.asAt}.`}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[var(--mv-ink)]">
        <dt className="text-[var(--mv-muted)]">Book balance</dt>
        <dd className="text-right font-mono font-bold">{rupees(result.ledgerBalancePaise)}</dd>
        <dt className="text-[var(--mv-muted)]">Bank balance</dt>
        <dd className="text-right font-mono font-bold">{rupees(result.statementBalancePaise)}</dd>
        <dt className="text-[var(--mv-muted)]">Difference</dt>
        <dd className={`text-right font-mono font-bold ${result.differencePaise === 0 ? '' : 'text-red-700'}`}>
          {rupees(result.differencePaise)}
        </dd>
        <dt className="text-[var(--mv-muted)]">Lines not yet matched</dt>
        <dd className="text-right font-mono font-bold">{result.unmatchedCount}</dd>
      </dl>
    </div>
  );
}
