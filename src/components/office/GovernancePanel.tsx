/**
 * Approvals & admin: the committee's sign-offs and housekeeping.
 *
 * Rates and settings are entered by one person and approved by another; the
 * server enforces that, so this screen only shows each action to an account
 * whose permissions allow it and passes the server's refusal through when it
 * says no. Each sub-section loads its own data when opened.
 */

import { useState } from 'react';
import type { OfficeContext } from './types';
import { RatesSection } from './governance/RatesSection';
import { SettingsSection } from './governance/SettingsSection';
import { PeriodsSection } from './governance/PeriodsSection';
import { UsersSection } from './governance/UsersSection';
import { FlatsSection } from './governance/FlatsSection';
import { HelpdeskSection } from './governance/HelpdeskSection';
import { OpeningBalancesSection } from './governance/OpeningBalancesSection';
import { SocietyProfileSection } from './governance/SocietyProfileSection';
import { MyPasswordSection } from './governance/MyPasswordSection';
import { NoticesSection } from './governance/NoticesSection';

type TabKey = 'rates' | 'settings' | 'periods' | 'users' | 'flats' | 'opening' | 'profile' | 'helpdesk' | 'notices' | 'password';

interface Tab {
  readonly key: TabKey;
  readonly label: string;
  /** Any one of these opens the tab; none listed means every account. */
  readonly anyOf: readonly string[];
}

const TABS: readonly Tab[] = [
  { key: 'rates', label: 'Rates', anyOf: ['settings.manage', 'rate.approve'] },
  { key: 'settings', label: 'Settings & GST', anyOf: ['settings.manage', 'rate.approve'] },
  { key: 'periods', label: 'Periods', anyOf: ['period.close', 'period.reopen'] },
  { key: 'users', label: 'Users & roles', anyOf: ['user.manage'] },
  { key: 'flats', label: 'Flats & owners', anyOf: ['member.manage'] },
  { key: 'opening', label: 'Opening balances', anyOf: ['settings.manage', 'period.close'] },
  { key: 'profile', label: 'Society profile', anyOf: ['settings.manage', 'report.read'] },
  { key: 'helpdesk', label: 'Helpdesk', anyOf: ['ticket.assign', 'ticket.resolve'] },
  { key: 'notices', label: 'Notices', anyOf: ['notice.send'] },
  { key: 'password', label: 'My password', anyOf: [] },
];

export default function GovernancePanel({ ctx }: { ctx: OfficeContext }) {
  const offered = TABS.filter(t => t.anyOf.length === 0 || t.anyOf.some(p => ctx.can(p)));
  const [open, setOpen] = useState<TabKey | null>(offered[0]?.key ?? null);
  const current = offered.find(t => t.key === open) ?? offered[0];

  if (current === undefined) {
    return <p className="text-sm text-[var(--mv-muted)]">This account has no approval or admin permissions.</p>;
  }

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Approvals and admin" className="flex gap-1 overflow-x-auto pb-1 -mx-1 px-1">
        {offered.map(t => (
          <button
            key={t.key}
            id={`gov-tab-${t.key}`}
            role="tab"
            aria-selected={current.key === t.key}
            aria-controls={`gov-panel-${t.key}`}
            onClick={() => setOpen(t.key)}
            className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              current.key === t.key
                ? 'bg-[var(--mv-ink)] text-white border-[var(--mv-ink)]'
                : 'bg-[var(--mv-surface)] text-[var(--mv-ink)] border-[var(--mv-border)] hover:border-[var(--mv-accent)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`gov-panel-${current.key}`} aria-labelledby={`gov-tab-${current.key}`}>
        {current.key === 'rates' && <RatesSection ctx={ctx} />}
        {current.key === 'settings' && <SettingsSection ctx={ctx} />}
        {current.key === 'periods' && <PeriodsSection ctx={ctx} />}
        {current.key === 'users' && <UsersSection ctx={ctx} />}
        {current.key === 'flats' && <FlatsSection ctx={ctx} />}
        {current.key === 'opening' && <OpeningBalancesSection ctx={ctx} />}
        {current.key === 'profile' && <SocietyProfileSection ctx={ctx} />}
        {current.key === 'helpdesk' && <HelpdeskSection ctx={ctx} />}
        {current.key === 'notices' && <NoticesSection ctx={ctx} />}
        {current.key === 'password' && <MyPasswordSection ctx={ctx} />}
      </div>
    </div>
  );
}
