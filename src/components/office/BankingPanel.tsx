/**
 * Banking: the society's bank accounts, statement import, matching statement
 * lines to receipts and vendor payments, and the reconciliation sign-off.
 *
 * Nothing here posts to the ledger. A statement import records lines, a match
 * links a line to a receipt already in the books, and a reconciliation compares
 * the bank's balance with the books'. Each action is offered only to an account
 * whose permissions the server would accept for it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Landmark, RefreshCw } from 'lucide-react';
import type { OfficeContext } from './types';
import { problemOf } from './types';
import {
  listBankAccounts, listBankLines, matchBankLine,
  type BankAccount, type BankLine, type BankLineState, type ReconcileResult,
} from '../../api/office/bank';
import { ImportDialog } from './bank/ImportDialog';
import { MatchDialog } from './bank/MatchDialog';
import { ReconcileDialog } from './bank/ReconcileDialog';
import { ReconcileSummary } from './bank/ReconcileSummary';
import { card, primaryButton, rupees, secondaryButton } from './bank/ui';

const LINE_VIEWS: ReadonlyArray<{ state: BankLineState; label: string }> = [
  { state: 'unmatched', label: 'Unmatched' },
  { state: 'suspense', label: 'Suspense' },
  { state: 'matched', label: 'Matched' },
];

export default function BankingPanel({ ctx }: { ctx: OfficeContext }) {
  const mayImport = ctx.can('bank.import');
  const mayMatch = ctx.can('bank.match');
  const mayReconcile = ctx.can('bank.reconcile');

  const [accounts, setAccounts] = useState<BankAccount[] | null>(null);
  const [view, setView] = useState<BankLineState>('unmatched');
  const [lines, setLines] = useState<BankLine[] | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'import' }
    | { kind: 'match'; line: BankLine }
    | { kind: 'reconcile'; accountId: string }
    | null
  >(null);
  const [lastReconciliation, setLastReconciliation] =
    useState<{ accountId: string; result: ReconcileResult } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadProblem(null);
    try {
      const [accountList, lineList] = await Promise.all([
        listBankAccounts(ctx.client),
        listBankLines(ctx.client, view),
      ]);
      setAccounts(accountList);
      setLines(lineList);
    } catch (err) {
      setLoadProblem(problemOf(err));
    }
  }, [ctx.client, view]);

  useEffect(() => { void load(); }, [load]);

  /** After any write: the rest of the app re-reads the books, and so does this panel. */
  const afterWrite = useCallback(async () => {
    await Promise.all([ctx.reload(), load()]);
  }, [ctx, load]);

  const confirmSuggestion = async (line: BankLine, paymentId: string) => {
    setConfirming(line.id);
    try {
      await matchBankLine(ctx.client, line.id, { paymentId });
      ctx.toast('Line matched to the suggested receipt.');
      await afterWrite();
    } catch (err) {
      ctx.toast(problemOf(err), 'error');
    } finally {
      setConfirming(null);
    }
  };

  if (loadProblem !== null && accounts === null) {
    return (
      <div className={`${card} p-5 space-y-3`}>
        <p role="alert" className="text-sm text-red-700">The bank details could not be loaded: {loadProblem}</p>
        <button type="button" onClick={() => void load()} className={secondaryButton}>Try again</button>
      </div>
    );
  }
  if (accounts === null) {
    return <p className="text-sm text-[var(--mv-muted)]">Loading…</p>;
  }

  const activeAccounts = accounts.filter(a => a.active);
  const accountName = (id: string) => accounts.find(a => a.id === id)?.label ?? 'Bank account';

  return (
    <div className="space-y-5">
      {/* Accounts, with the two account-level actions. */}
      <section className={`${card} p-5 space-y-4`} aria-labelledby="bank-accounts-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="bank-accounts-title" className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[var(--mv-ink)]">
            <Landmark className="w-4 h-4 text-[var(--mv-accent)]" aria-hidden="true" />
            Bank accounts
          </h3>
          <div className="flex flex-wrap gap-2">
            {mayImport && activeAccounts.length > 0 && (
              <button type="button" onClick={() => setDialog({ kind: 'import' })} className={primaryButton}>
                Import statement
              </button>
            )}
            {mayReconcile && activeAccounts.length > 0 && (
              <button
                type="button"
                onClick={() => setDialog({ kind: 'reconcile', accountId: activeAccounts[0].id })}
                className={mayImport ? secondaryButton : primaryButton}
              >
                Reconcile
              </button>
            )}
          </div>
        </div>
        {accounts.length === 0 ? (
          <p className="text-xs text-[var(--mv-muted)]">
            No bank account is on record. Accounts are set up on the server; this screen cannot add one yet.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {accounts.map(a => (
              <li key={a.id} className="p-4 rounded-xl border border-[var(--mv-border)] bg-[var(--mv-page)] space-y-1">
                <p className="flex justify-between gap-2">
                  <span className="font-bold text-sm text-[var(--mv-ink)]">{a.label}</span>
                  {!a.active && <span className="text-[10px] font-bold uppercase text-[var(--mv-muted)]">Inactive</span>}
                </p>
                <p className="text-xs text-[var(--mv-muted)]">
                  {a.bankName} ··{a.accountLast4} · {a.ifsc} · ledger {a.ledgerAccount}
                </p>
                <p className="text-xs text-[var(--mv-muted)]">
                  Book balance{' '}
                  <span className="font-mono font-bold text-[var(--mv-ink)]">{rupees(a.ledgerBalancePaise)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {lastReconciliation !== null && (
        <section className={`${card} p-5 space-y-3`} aria-labelledby="bank-recon-title">
          <h3 id="bank-recon-title" className="text-xs font-bold uppercase tracking-wider text-[var(--mv-ink)]">
            Last reconciliation · {accountName(lastReconciliation.accountId)}
          </h3>
          <ReconcileSummary result={lastReconciliation.result} />
        </section>
      )}

      {/* Statement lines. */}
      <section className={`${card} p-5 space-y-4 min-w-0`} aria-labelledby="bank-lines-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="bank-lines-title" className="text-xs font-bold uppercase tracking-wider text-[var(--mv-ink)]">
            Statement lines
          </h3>
          <div className="flex items-center gap-2">
            <div role="group" aria-label="Which lines to show" className="flex gap-1">
              {LINE_VIEWS.map(v => (
                <button
                  key={v.state}
                  type="button"
                  aria-pressed={view === v.state}
                  onClick={() => { setView(v.state); setLines(null); }}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border ${
                    view === v.state
                      ? 'bg-[var(--mv-accent)] text-white border-[var(--mv-accent)]'
                      : 'bg-[var(--mv-surface)] text-[var(--mv-ink)] border-[var(--mv-border)] hover:border-[var(--mv-accent)]'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void load()}
              aria-label="Refresh statement lines"
              className="p-2 rounded-lg border border-[var(--mv-border)] text-[var(--mv-ink)] hover:border-[var(--mv-accent)]"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {loadProblem !== null && <p role="alert" className="text-xs text-red-700">{loadProblem}</p>}

        {lines === null ? (
          <p className="text-xs text-[var(--mv-muted)]">Loading…</p>
        ) : lines.length === 0 ? (
          <p className="text-xs text-[var(--mv-muted)]">
            {view === 'unmatched'
              ? 'Every imported line is matched or in suspense.'
              : view === 'suspense' ? 'Nothing is in suspense.' : 'No line has been matched yet.'}
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full min-w-[560px] text-xs text-left">
              <caption className="sr-only">{LINE_VIEWS.find(v => v.state === view)?.label} statement lines</caption>
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-[var(--mv-muted)] border-b border-[var(--mv-border)]">
                  <th scope="col" className="py-2 pr-3 font-bold">Date</th>
                  <th scope="col" className="py-2 pr-3 font-bold">Narration</th>
                  <th scope="col" className="py-2 pr-3 font-bold text-right">Amount</th>
                  {mayMatch && view !== 'matched' && <th scope="col" className="py-2 font-bold text-right">Action</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map(line => {
                  const suggestion = line.suggestions[0];
                  return (
                    <tr key={line.id} className="border-b border-[var(--mv-border)] last:border-0 align-top">
                      <td className="py-2.5 pr-3 font-mono whitespace-nowrap text-[var(--mv-ink)]">{line.valueDate}</td>
                      <td className="py-2.5 pr-3 text-[var(--mv-ink)]">
                        <span className="block break-words">{line.narration}</span>
                        {line.reference !== null && (
                          <span className="block text-[10px] font-mono text-[var(--mv-muted)] break-all">Ref {line.reference}</span>
                        )}
                        {suggestion !== undefined && view !== 'matched' && (
                          <span className="block text-[10px] text-[var(--mv-accent)] font-bold mt-0.5">
                            Suggested: receipt {suggestion.receiptNo ?? 'on file'}
                            {line.suggestions.length > 1 ? ` (and ${line.suggestions.length - 1} more)` : ''}
                          </span>
                        )}
                      </td>
                      <td className={`py-2.5 pr-3 text-right font-mono font-bold whitespace-nowrap ${line.amountPaise < 0 ? 'text-red-700' : 'text-[var(--mv-ink)]'}`}>
                        {line.amountPaise > 0 ? '+' : ''}{rupees(line.amountPaise)}
                      </td>
                      {mayMatch && view !== 'matched' && (
                        <td className="py-2 text-right whitespace-nowrap">
                          <div className="inline-flex gap-1.5">
                            {suggestion !== undefined && line.suggestions.length === 1 && (
                              <button
                                type="button"
                                disabled={confirming !== null}
                                onClick={() => void confirmSuggestion(line, suggestion.paymentId)}
                                className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-[var(--mv-accent)] text-white border border-[var(--mv-accent)] disabled:opacity-50"
                              >
                                {confirming === line.id ? 'Matching…' : 'Confirm'}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setDialog({ kind: 'match', line })}
                              aria-label={`Match the line of ${rupees(line.amountPaise)} on ${line.valueDate}`}
                              className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-[var(--mv-surface)] text-[var(--mv-ink)] border border-[var(--mv-border)] hover:border-[var(--mv-accent)]"
                            >
                              Match…
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dialog?.kind === 'import' && (
        <ImportDialog ctx={ctx} accounts={activeAccounts} onClose={() => setDialog(null)} onImported={afterWrite} />
      )}
      {dialog?.kind === 'match' && (
        <MatchDialog ctx={ctx} line={dialog.line} onClose={() => setDialog(null)} onMatched={afterWrite} />
      )}
      {dialog?.kind === 'reconcile' && (
        <ReconcileDialog
          ctx={ctx}
          accounts={activeAccounts}
          initialAccountId={dialog.accountId}
          onClose={() => setDialog(null)}
          onReconciled={async (accountId, result) => {
            setLastReconciliation({ accountId, result });
            await afterWrite();
          }}
        />
      )}
    </div>
  );
}
