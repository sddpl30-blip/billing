import React from 'react';
import { AlertCircle, CheckCircle } from 'lucide-react';
import type { Statements, StatementSection } from '../accounting';

/**
 * Renders a statement from engine-derived figures.
 *
 * Used by both the desktop and the mobile books screens, which previously held
 * two copies of the same report with the same seven hardcoded amounts written
 * out twice. One component means they cannot drift, and there is no amount in
 * this file — every figure arrives already computed from the ledger.
 */

type Which = 'ie' | 'bs' | 'rp' | 'tb';

interface Props {
  statements: Statements;
  which: Which;
  /** Tighter spacing and smaller type for the phone layout. */
  compact?: boolean;
}

const TITLES: Record<Which, string> = {
  ie: 'Income & Expenditure',
  bs: 'Balance Sheet',
  rp: 'Receipts & Payments',
  tb: 'Trial Balance',
};

export const FinancialStatements: React.FC<Props> = ({ statements, which, compact }) => {
  const title = TITLES[which];
  const pad = compact ? 'p-3' : 'p-4';
  const amountClass = compact ? 'text-[11px]' : 'text-xs';

  const Section: React.FC<{ section: StatementSection }> = ({ section }) => (
    <div className="space-y-1.5">
      <span className="text-[9px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">
        {section.heading}
      </span>
      {section.rows.map((r, i) => (
        <div
          key={`${section.heading}-${i}`}
          className={`flex justify-between items-baseline gap-3 ${
            r.emphasis ? 'font-bold text-[var(--mv-ink)] border-t border-[var(--mv-border)] pt-1.5 mt-1' : 'text-[var(--mv-muted)]'
          }`}
        >
          <span className={`${amountClass} font-medium leading-snug`}>{r.label}</span>
          <span
            className={`${amountClass} font-mono font-bold whitespace-nowrap ${
              r.negative ? 'text-red-600' : 'text-[var(--mv-ink)]'
            }`}
          >
            {r.negative && r.amount > 0 ? '- ' : ''}{r.formatted}
          </span>
        </div>
      ))}
    </div>
  );

  const Tie: React.FC<{ ok: boolean; okText: string; badText: string }> = ({ ok, okText, badText }) => (
    <div
      className={`flex items-start gap-2 ${pad} rounded-xl border text-[10px] font-semibold leading-snug ${
        ok
          ? 'bg-[#F0FDF4] border-[#BBF7D0] text-[#166534]'
          : 'bg-[#FEF2F2] border-[#FECACA] text-[#991B1B]'
      }`}
    >
      {ok ? <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-px" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />}
      <span>{ok ? okText : badText}</span>
    </div>
  );

  return (
    <div className="space-y-3.5 text-left">
      <div className="flex justify-between items-start gap-3 border-b border-[var(--mv-border)] pb-2.5">
        <div>
          <h4 className="font-extrabold text-sm text-[var(--mv-ink)] uppercase tracking-wide leading-tight">
            {title}
          </h4>
          <p className="text-[10px] text-[var(--mv-muted)] mt-0.5">
            {statements.periodLabel} · derived from {statements.counts.entries} journal entries
          </p>
        </div>
      </div>

      {which === 'ie' && (
        <>
          <p className="text-[10px] text-[var(--mv-muted)] leading-snug">
            {statements.incomeAndExpenditure.basis}
          </p>
          {statements.incomeAndExpenditure.sections.map(s => (
            <Section key={s.heading} section={s} />
          ))}
          <div className="flex justify-between items-center py-3 px-4 bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] rounded-xl font-bold text-[var(--mv-accent)]">
            <span className="text-xs uppercase tracking-wide">
              {statements.incomeAndExpenditure.surplus.label}
            </span>
            <span className="font-mono text-sm">
              {statements.incomeAndExpenditure.surplus.formatted}
            </span>
          </div>
        </>
      )}

      {which === 'bs' && (
        <>
          {statements.balanceSheet.sections.map(s => (
            <Section key={s.heading} section={s} />
          ))}
          <div className="space-y-1 pt-1">
            <div className="flex justify-between items-baseline font-bold text-[var(--mv-ink)] border-t-2 border-[var(--mv-ink)] pt-2">
              <span className="text-xs">{statements.balanceSheet.totalAssets.label}</span>
              <span className="text-xs font-mono">{statements.balanceSheet.totalAssets.formatted}</span>
            </div>
            <div className="flex justify-between items-baseline font-bold text-[var(--mv-ink)]">
              <span className="text-xs">{statements.balanceSheet.totalLiabilitiesAndFunds.label}</span>
              <span className="text-xs font-mono">
                {statements.balanceSheet.totalLiabilitiesAndFunds.formatted}
              </span>
            </div>
          </div>
          <Tie
            ok={statements.balanceSheet.balanced}
            okText="Assets equal liabilities plus funds plus surplus."
            badText={`The balance sheet does not balance — out by ${statements.balanceSheet.difference}. The figures below are not reliable; this is shown rather than adjusted away.`}
          />
        </>
      )}

      {which === 'rp' && (
        <>
          <p className="text-[10px] text-[var(--mv-muted)] leading-snug">
            Cash basis — what moved through bank and cash, which is why it differs
            from Income &amp; Expenditure above.
          </p>
          {statements.receiptsAndPayments.sections.map(s => (
            <Section key={s.heading} section={s} />
          ))}
          <div className="flex justify-between items-center py-3 px-4 bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] rounded-xl font-bold text-[var(--mv-accent)]">
            <span className="text-xs uppercase tracking-wide">
              {statements.receiptsAndPayments.closing.label}
            </span>
            <span className="font-mono text-sm">{statements.receiptsAndPayments.closing.formatted}</span>
          </div>
          <Tie
            ok={statements.receiptsAndPayments.reconciles}
            okText="Opening plus receipts less payments equals the closing cash balance."
            badText="Opening plus receipts less payments does not equal closing cash."
          />
        </>
      )}

      {which === 'tb' && (
        <>
          <div className="space-y-1">
            <div className="flex justify-between text-[9px] font-bold text-[var(--mv-muted)] uppercase tracking-wider pb-1 border-b border-[var(--mv-border)]">
              <span>Account</span>
              <span className="flex gap-4">
                <span className="w-20 text-right">Debit</span>
                <span className="w-20 text-right">Credit</span>
              </span>
            </div>
            {statements.trialBalance.rows.map(r => (
              <div key={r.code} className="flex justify-between items-baseline gap-2 text-[var(--mv-muted)]">
                <span className="text-[11px] font-medium leading-snug">
                  <span className="font-mono text-[9px] text-[var(--mv-muted)] mr-1.5">{r.code}</span>
                  {r.name}
                </span>
                <span className="flex gap-4 font-mono text-[11px] font-bold text-[var(--mv-ink)] whitespace-nowrap">
                  <span className="w-20 text-right">{r.debit}</span>
                  <span className="w-20 text-right">{r.credit}</span>
                </span>
              </div>
            ))}
            <div className="flex justify-between items-baseline gap-2 font-bold text-[var(--mv-ink)] border-t-2 border-[var(--mv-ink)] pt-1.5 mt-1">
              <span className="text-[11px] uppercase tracking-wide">Total</span>
              <span className="flex gap-4 font-mono text-[11px] whitespace-nowrap">
                <span className="w-20 text-right">{statements.trialBalance.totalDebit}</span>
                <span className="w-20 text-right">{statements.trialBalance.totalCredit}</span>
              </span>
            </div>
          </div>
          <Tie
            ok={statements.trialBalance.balanced}
            okText="Debits equal credits."
            badText="Debits do not equal credits."
          />
        </>
      )}

      {/* Cross-statement checks, so nobody has to take the figures on trust. */}
      <div className="space-y-1.5 pt-1">
        <span className="text-[9px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">
          Reconciliation
        </span>
        {statements.checks.map(c => (
          <div key={c.name} className="flex items-start gap-1.5 text-[10px] leading-snug">
            {c.passed
              ? <CheckCircle className="w-3 h-3 text-[#166534] shrink-0 mt-0.5" />
              : <AlertCircle className="w-3 h-3 text-[#991B1B] shrink-0 mt-0.5" />}
            <span className={c.passed ? 'text-[var(--mv-muted)]' : 'text-[#991B1B] font-semibold'}>
              {c.name}
              {!c.passed && <span className="block font-mono text-[9px] mt-0.5">{c.detail}</span>}
            </span>
          </div>
        ))}
      </div>

      {statements.importProblems.length > 0 && (
        <div className="space-y-1.5 p-3 bg-[#FFFBEB] border border-[#FDE68A] rounded-xl">
          <span className="text-[9px] font-bold text-[#92400E] uppercase tracking-wider block">
            Rows that could not be posted
          </span>
          {statements.importProblems.map((p, i) => (
            <p key={i} className="text-[10px] text-[#92400E] leading-snug">
              <span className="font-semibold">{p.what}</span> — {p.why}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-1 p-3 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl">
        <span className="text-[9px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">
          Not yet confirmed by a CA
        </span>
        {statements.pendingConfirmations.map((line, i) => (
          <p key={i} className="text-[10px] text-[var(--mv-muted)] leading-snug">· {line}</p>
        ))}
      </div>
    </div>
  );
};
