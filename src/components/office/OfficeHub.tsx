/**
 * The Office: one screen with a section per area of back-office work.
 *
 * Each section is its own lazily loaded module, so a resident never downloads
 * any of it and a treasurer only loads the section they open. A section the
 * account has no permission for is not offered; the server would refuse its
 * calls anyway, and offering a screen that can only fail is worse than not.
 */

import { Suspense, lazy, useState } from 'react';
import type { OfficeContext } from './types';

const MoneyOutPanel = lazy(() => import('./MoneyOutPanel'));
const BankingPanel = lazy(() => import('./BankingPanel'));
const GovernancePanel = lazy(() => import('./GovernancePanel'));
const ReportsPanel = lazy(() => import('./ReportsPanel'));

type SectionKey = 'money' | 'bank' | 'governance' | 'reports';

interface Section {
  readonly key: SectionKey;
  readonly label: string;
  readonly blurb: string;
  /** Any one of these lets the account see the section. */
  readonly anyOf: readonly string[];
}

const SECTIONS: readonly Section[] = [
  {
    key: 'money', label: 'Vendors & notes',
    blurb: 'Vendor master, bills with TDS, payments, TDS remittance, credit and debit notes.',
    anyOf: ['vendor.manage', 'vendor.bill.approve', 'vendor.bill.book', 'vendor.pay', 'tds.remit', 'billing.cancel'],
  },
  {
    key: 'bank', label: 'Banking',
    blurb: 'Bank accounts, statement import, matching and reconciliation sign-off.',
    anyOf: ['bank.import', 'bank.match', 'bank.reconcile'],
  },
  {
    key: 'governance', label: 'Approvals & admin',
    blurb: 'Rates, GST and settings approval, financial periods, users and roles, flats and owners, helpdesk.',
    anyOf: ['settings.manage', 'rate.approve', 'period.close', 'period.reopen', 'user.manage', 'member.manage', 'ticket.assign', 'ticket.resolve'],
  },
  {
    key: 'reports', label: 'Reports',
    blurb: 'Trial balance, balance sheet, income & expenditure, ageing, collections, GST, TDS, statements, ledger, audit trail.',
    anyOf: ['report.read'],
  },
];

export function OfficeHub({ ctx }: { ctx: OfficeContext }) {
  const offered = SECTIONS.filter(s => s.anyOf.some(p => ctx.can(p)));
  const [open, setOpen] = useState<SectionKey | null>(offered[0]?.key ?? null);

  if (offered.length === 0) {
    return (
      <p className="text-sm text-[var(--mv-muted)]">
        This account has no office permissions. Ask the secretary if you need access.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Office sections" className="flex flex-wrap gap-2">
        {offered.map(s => (
          <button
            key={s.key}
            role="tab"
            aria-selected={open === s.key}
            onClick={() => setOpen(s.key)}
            className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider border transition-colors ${
              open === s.key
                ? 'bg-[var(--mv-accent)] text-white border-[var(--mv-accent)]'
                : 'bg-[var(--mv-surface)] text-[var(--mv-ink)] border-[var(--mv-border)] hover:border-[var(--mv-accent)]'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {open !== null && (
        <section role="tabpanel" aria-label={SECTIONS.find(s => s.key === open)?.label}>
          <p className="text-xs text-[var(--mv-muted)] mb-4">{SECTIONS.find(s => s.key === open)?.blurb}</p>
          <Suspense fallback={<p className="text-sm text-[var(--mv-muted)]">Loading…</p>}>
            {open === 'money' && <MoneyOutPanel ctx={ctx} />}
            {open === 'bank' && <BankingPanel ctx={ctx} />}
            {open === 'governance' && <GovernancePanel ctx={ctx} />}
            {open === 'reports' && <ReportsPanel ctx={ctx} />}
          </Suspense>
        </section>
      )}
    </div>
  );
}
