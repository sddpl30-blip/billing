import React from 'react';
import type { Statements } from '../accounting';

/**
 * The general journal, read from the accounting engine.
 *
 * Replaces a list that labelled every debit "Dr asset" and every credit
 * "Cr liability" — wrong whenever the leg is income or expenditure — and
 * printed "Reconciled Balanced" on every row without checking anything. Each
 * entry here carries its real legs, however many, and the badge states the
 * leg count rather than asserting a reconciliation.
 */
export const JournalLedger: React.FC<{ statements: Statements; compact?: boolean }> = ({
  statements, compact,
}) => (
  <div className="space-y-2.5 text-left">
    <div className="flex justify-between items-baseline gap-3 border-b border-[var(--mv-border)] pb-2">
      <span className="text-[10px] uppercase font-bold text-gray-500 tracking-wider">
        General journal
      </span>
      <span className="text-[9px] font-mono text-gray-400">
        {statements.journal.length} entries
      </span>
    </div>

    <div className={`space-y-2.5 ${compact ? 'max-h-[320px]' : 'max-h-[460px]'} overflow-y-auto pr-1 hide-scrollbar`}>
      {statements.journal.map(entry => (
        <div key={entry.id} className="p-3 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl space-y-2">
          <div className="flex justify-between items-baseline gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[9px] text-gray-400 font-mono">
                <span>{entry.date}</span>
                <span>·</span>
                <span>{entry.id}</span>
              </div>
              <p className="text-[11px] font-semibold text-[var(--mv-ink)] leading-snug mt-0.5">
                {entry.narration}
              </p>
            </div>
            <span className="text-[9px] font-mono text-gray-400 whitespace-nowrap shrink-0">
              {entry.legs.length} legs
            </span>
          </div>

          <div className="space-y-0.5 pt-1.5 border-t border-[var(--mv-border)]">
            {entry.legs.map((leg, i) => (
              <div key={i} className="flex justify-between items-baseline gap-2 text-[10px]">
                <span className="flex items-baseline gap-1.5 min-w-0">
                  <span
                    className={`font-mono font-bold shrink-0 ${
                      leg.side === 'Dr' ? 'text-[var(--mv-accent)]' : 'text-[#B45309]'
                    }`}
                  >
                    {leg.side}
                  </span>
                  <span className="font-mono text-gray-400 shrink-0">{leg.account}</span>
                  {leg.party && (
                    <span className="font-mono text-gray-400 truncate">[{leg.party}]</span>
                  )}
                </span>
                <span className="font-mono font-bold text-[var(--mv-ink)] whitespace-nowrap">
                  {leg.amount}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  </div>
);
