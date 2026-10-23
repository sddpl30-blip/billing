/**
 * The reports: the server's own figures, for a date or a period.
 *
 * Every number on this screen is what the API returned. The panel chooses the
 * report and the dates, lays the answer out, and offers it as a CSV or a
 * printout; it never works a figure out for itself, because a second
 * calculation in the browser is how the old demo's reports came to disagree.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { isoDateInIndia } from '../../accounting/clock';
import { reportsApi, type FlatSummary, type TrialBalanceLine } from '../../api/office/reports';
import { problemOf, type OfficeContext } from './types';
import { downloadCsv, formatDate, type ReportView } from './reports/format';
import { ReportOutput } from './reports/ReportOutput';
import {
  fyBounds, fyLabel, fyOptions, fyStartOf, isIsoDate, quarterCode, quarterOf, QUARTER_MONTHS,
} from './reports/periods';
import {
  ageingView, auditView, balanceSheetView, collectionsView, gstView, incomeExpenditureView,
  ledgerView, statementView, tdsView, trialBalanceView,
} from './reports/views';

type ReportKey =
  | 'trial-balance' | 'balance-sheet' | 'income-expenditure' | 'ageing' | 'collections'
  | 'gst' | 'tds' | 'statement' | 'ledger' | 'audit';

/** What a report is asked for: a date, a range, a GST month, a TDS quarter, or neither. */
type PeriodKind = 'asAt' | 'range' | 'month' | 'quarter' | 'none';

interface ReportDef {
  readonly key: ReportKey;
  readonly label: string;
  readonly group: string;
  readonly period: PeriodKind;
  /** Every one of these is needed; the server checks the same names. */
  readonly needs: readonly string[];
}

const REPORTS: readonly ReportDef[] = [
  { key: 'trial-balance', label: 'Trial balance', group: 'Financial statements', period: 'asAt', needs: ['report.read'] },
  { key: 'balance-sheet', label: 'Balance sheet', group: 'Financial statements', period: 'asAt', needs: ['report.read'] },
  { key: 'income-expenditure', label: 'Income & expenditure', group: 'Financial statements', period: 'range', needs: ['report.read'] },
  { key: 'ageing', label: 'Receivables ageing', group: 'Members', period: 'asAt', needs: ['report.read'] },
  { key: 'collections', label: 'Collections', group: 'Members', period: 'range', needs: ['report.read'] },
  // The statement route checks access to the flat, which for a whole society
  // is `invoice.read.any`.
  { key: 'statement', label: 'Flat statement', group: 'Members', period: 'range', needs: ['report.read', 'invoice.read.any'] },
  { key: 'gst', label: 'GST summary', group: 'Tax', period: 'month', needs: ['report.read'] },
  { key: 'tds', label: 'TDS summary', group: 'Tax', period: 'quarter', needs: ['report.read'] },
  { key: 'ledger', label: 'General ledger', group: 'Books', period: 'range', needs: ['ledger.read'] },
  { key: 'audit', label: 'Audit trail', group: 'Books', period: 'none', needs: ['audit.read'] },
];

const AUDIT_LIMITS = [100, 200, 500, 1000] as const;

const labelClass = 'text-[10px] text-[var(--mv-muted)] font-bold block mb-1 uppercase tracking-wider';
const inputClass = 'w-full bg-[var(--mv-surface)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold text-xs text-[var(--mv-ink)] outline-none focus:border-[var(--mv-accent)]';
const buttonClass = 'px-4 py-2 rounded-xl text-xs font-bold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/** Shown in place of the report only while printing; see the print styles. */
const PRINT_CSS = `
.sb-print-portal { display: none; }
@media print {
  body > *:not(.sb-print-portal) { display: none !important; }
  .sb-print-portal { display: block; padding: 0; color: #000; }
  .sb-print-portal .sb-print-scroll { overflow: visible !important; }
  .sb-print-portal .sb-print-card { box-shadow: none !important; break-inside: auto; }
  .sb-print-portal tr { break-inside: avoid; }
  .sb-print-portal thead { display: table-header-group; }
  @page { margin: 12mm; }
}`;

type Load =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready' }
  | { readonly state: 'error'; readonly message: string };

export default function ReportsPanel({ ctx }: { ctx: OfficeContext }) {
  const api = useMemo(() => reportsApi(ctx.client), [ctx.client]);
  const today = useMemo(() => isoDateInIndia(), []);
  const offered = useMemo(() => REPORTS.filter(r => r.needs.every(p => ctx.can(p))), [ctx]);

  const [key, setKey] = useState<ReportKey | null>(offered[0]?.key ?? null);
  const def = offered.find(r => r.key === key) ?? null;

  const fy = fyBounds(fyStartOf(today), today);
  const [asAt, setAsAt] = useState(today);
  const [from, setFrom] = useState(fy.from);
  const [to, setTo] = useState(fy.to);
  const [taxPeriod, setTaxPeriod] = useState(today.slice(0, 7));
  const [quarterFy, setQuarterFy] = useState(fyStartOf(today));
  const [quarter, setQuarter] = useState<number>(quarterOf(today));
  const [flatId, setFlatId] = useState('');
  const [accountCode, setAccountCode] = useState('');
  const [auditLimit, setAuditLimit] = useState<number>(200);
  const [auditAction, setAuditAction] = useState('');
  const [auditActionApplied, setAuditActionApplied] = useState('');

  const [flats, setFlats] = useState<readonly FlatSummary[] | null>(null);
  const [accounts, setAccounts] = useState<readonly TrialBalanceLine[] | null>(null);
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  // Kept, dimmed, while the next answer loads; it names its own report and
  // period, so it cannot be mistaken for the one being fetched.
  const [view, setView] = useState<ReportView | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [printing, setPrinting] = useState(false);
  const requestNo = useRef(0);

  // The pickers' own lists, fetched once and only for the report that needs them.
  useEffect(() => {
    if (key !== 'statement' || flats !== null) return;
    api.flats()
      .then(r => {
        setFlats(r.flats);
        setFlatId(current => current || (r.flats[0]?.id ?? ''));
      })
      .catch(err => {
        setFlats([]);
        ctx.toast(`Could not load the flats: ${problemOf(err)}`, 'error');
      });
  }, [api, ctx, flats, key]);

  useEffect(() => {
    if (key !== 'ledger' || accounts !== null) return;
    // The trial balance to date lists every account that has ever been posted
    // to, which is every account a ledger could show anything for.
    api.trialBalance(today)
      .then(r => setAccounts(r.lines))
      .catch(err => {
        setAccounts([]);
        ctx.toast(`Could not load the accounts: ${problemOf(err)}`, 'error');
      });
  }, [accounts, api, ctx, key, today]);

  const problem = useMemo((): string | null => {
    if (def === null) return null;
    if (def.period === 'asAt' && !isIsoDate(asAt)) return 'Choose the date to report as at.';
    if (def.period === 'range') {
      if (!isIsoDate(from) || !isIsoDate(to)) return 'Choose both a from date and a to date.';
      if (from > to) return 'The from date is after the to date.';
    }
    if (def.period === 'month' && !/^\d{4}-\d{2}$/.test(taxPeriod)) return 'Choose the tax period.';
    if (def.key === 'statement' && flatId === '') return flats?.length === 0 ? 'There are no flats to choose from.' : 'Choose a flat.';
    return null;
  }, [asAt, def, flatId, flats, from, taxPeriod, to]);

  const account = accounts?.find(a => a.code === accountCode) ?? null;

  const fetchView = useCallback(async (): Promise<ReportView | null> => {
    switch (key) {
      case 'trial-balance': return trialBalanceView(await api.trialBalance(asAt));
      case 'balance-sheet': return balanceSheetView(await api.balanceSheet(asAt));
      case 'income-expenditure': return incomeExpenditureView(await api.incomeExpenditure({ from, to }));
      case 'ageing': return ageingView(await api.ageing(asAt));
      case 'collections': return collectionsView(await api.collections({ from, to }));
      case 'gst': return gstView(await api.gst(taxPeriod));
      case 'tds': return tdsView(await api.tds(quarterCode(quarter, quarterFy)));
      case 'statement': return statementView(await api.statement(flatId, { from, to }), from, to);
      case 'ledger': {
        const data = await api.ledger({ from, to });
        return ledgerView(data, account === null ? null : { code: account.code, name: account.name });
      }
      case 'audit': {
        const r = await api.audit({ limit: auditLimit, action: auditActionApplied });
        return auditView(r.entries, auditLimit, auditActionApplied);
      }
      default: return null;
    }
  }, [account, api, asAt, auditActionApplied, auditLimit, flatId, from, key, quarter, quarterFy, taxPeriod, to]);

  // Fetch whenever the report or its period changes. A slower answer to an
  // earlier question is dropped, so the screen never shows last month's
  // figures under this month's heading.
  useEffect(() => {
    if (key === null || problem !== null) {
      requestNo.current++;
      setLoad({ state: 'idle' });
      setView(null);
      return;
    }
    const mine = ++requestNo.current;
    setLoad({ state: 'loading' });
    fetchView()
      .then(view => {
        if (mine !== requestNo.current) return;
        setView(view);
        setLoad(view === null ? { state: 'idle' } : { state: 'ready' });
      })
      .catch(err => {
        if (mine !== requestNo.current) return;
        setView(null);
        setLoad({ state: 'error', message: problemOf(err) });
      });
  }, [fetchView, key, problem, reloadTick]);

  // Ctrl+P prints the same layout as the button: the report alone.
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);

  if (offered.length === 0 || def === null) {
    return <p className="text-sm text-[var(--mv-muted)]">This account cannot read any reports.</p>;
  }

  const groups = [...new Set(offered.map(r => r.group))];
  const settled = load.state === 'ready' && view !== null;
  const pickFy = (start: number) => {
    const b = fyBounds(start, today);
    setFrom(b.from);
    setTo(b.to);
    setAsAt(b.to);
  };
  const fyOfDates = def.period === 'asAt' ? fyStartOf(asAt) : fyStartOf(isIsoDate(to) ? to : today);

  return (
    <div className="space-y-5">
      <style>{PRINT_CSS}</style>

      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 shadow-xs">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="sm:col-span-2 lg:col-span-1">
            <label htmlFor="report-kind" className={labelClass}>Report</label>
            <select id="report-kind" className={inputClass} value={def.key} onChange={e => setKey(e.target.value as ReportKey)}>
              {groups.map(g => (
                <optgroup key={g} label={g}>
                  {offered.filter(r => r.group === g).map(r => (
                    <option key={r.key} value={r.key}>{r.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {(def.period === 'asAt' || def.period === 'range') && (
            <div>
              <label htmlFor="report-fy" className={labelClass}>Financial year</label>
              <select id="report-fy" className={inputClass} value={fyOfDates} onChange={e => pickFy(Number(e.target.value))}>
                {fyOptions(today).map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}
              </select>
            </div>
          )}

          {def.period === 'asAt' && (
            <div>
              <label htmlFor="report-asat" className={labelClass}>As at</label>
              <input id="report-asat" type="date" className={inputClass} value={asAt} max={today} onChange={e => setAsAt(e.target.value)} />
            </div>
          )}

          {def.period === 'range' && (
            <>
              <div>
                <label htmlFor="report-from" className={labelClass}>From</label>
                <input id="report-from" type="date" className={inputClass} value={from} onChange={e => setFrom(e.target.value)} />
              </div>
              <div>
                <label htmlFor="report-to" className={labelClass}>To</label>
                <input id="report-to" type="date" className={inputClass} value={to} onChange={e => setTo(e.target.value)} />
              </div>
            </>
          )}

          {def.period === 'month' && (
            <div>
              <label htmlFor="report-taxperiod" className={labelClass}>Tax period</label>
              <input
                id="report-taxperiod" type="month" className={inputClass} value={taxPeriod}
                max={today.slice(0, 7)} placeholder="YYYY-MM" onChange={e => setTaxPeriod(e.target.value)}
              />
            </div>
          )}

          {def.period === 'quarter' && (
            <>
              <div>
                <label htmlFor="report-tds-fy" className={labelClass}>Financial year</label>
                <select id="report-tds-fy" className={inputClass} value={quarterFy} onChange={e => setQuarterFy(Number(e.target.value))}>
                  {fyOptions(today).map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="report-tds-quarter" className={labelClass}>Quarter</label>
                <select id="report-tds-quarter" className={inputClass} value={quarter} onChange={e => setQuarter(Number(e.target.value))}>
                  {[1, 2, 3, 4].map(q => <option key={q} value={q}>Q{q} · {QUARTER_MONTHS[q]}</option>)}
                </select>
              </div>
            </>
          )}

          {def.key === 'statement' && (
            <div className="sm:col-span-2 lg:col-span-1">
              <label htmlFor="report-flat" className={labelClass}>Flat</label>
              <select id="report-flat" className={inputClass} value={flatId} disabled={flats === null} onChange={e => setFlatId(e.target.value)}>
                {flats === null && <option value="">Loading flats…</option>}
                {flats?.map(f => (
                  <option key={f.id} value={f.id}>{f.flatNo}{f.owner ? ` — ${f.owner}` : ''}</option>
                ))}
              </select>
            </div>
          )}

          {def.key === 'ledger' && (
            <div className="sm:col-span-2 lg:col-span-1">
              <label htmlFor="report-account" className={labelClass}>Account</label>
              <select id="report-account" className={inputClass} value={accountCode} onChange={e => setAccountCode(e.target.value)}>
                <option value="">All accounts (journal)</option>
                {accounts?.map(a => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
              </select>
            </div>
          )}

          {def.key === 'audit' && (
            <>
              <div>
                <label htmlFor="report-audit-limit" className={labelClass}>Entries</label>
                <select id="report-audit-limit" className={inputClass} value={auditLimit} onChange={e => setAuditLimit(Number(e.target.value))}>
                  {AUDIT_LIMITS.map(n => <option key={n} value={n}>Newest {n}</option>)}
                </select>
              </div>
              <form
                className="sm:col-span-2"
                onSubmit={e => { e.preventDefault(); setAuditActionApplied(auditAction.trim()); }}
              >
                <label htmlFor="report-audit-action" className={labelClass}>Action (exact, e.g. payment.record)</label>
                <div className="flex gap-2">
                  <input
                    id="report-audit-action" type="search" className={inputClass} value={auditAction}
                    onChange={e => setAuditAction(e.target.value)} placeholder="All actions"
                  />
                  <button type="submit" className={`${buttonClass} bg-[var(--mv-surface)] text-[var(--mv-ink)] border-[var(--mv-border)] hover:border-[var(--mv-accent)]`}>
                    Filter
                  </button>
                </div>
              </form>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-4">
          <button
            type="button"
            className={`${buttonClass} bg-[var(--mv-accent)] text-white border-[var(--mv-accent)]`}
            disabled={!settled}
            onClick={() => view && downloadCsv(view)}
          >
            Download CSV
          </button>
          <button
            type="button"
            className={`${buttonClass} bg-[var(--mv-surface)] text-[var(--mv-ink)] border-[var(--mv-border)] hover:border-[var(--mv-accent)]`}
            disabled={!settled}
            onClick={() => window.print()}
          >
            Print
          </button>
          <button
            type="button"
            className={`${buttonClass} bg-[var(--mv-surface)] text-[var(--mv-ink)] border-[var(--mv-border)] hover:border-[var(--mv-accent)]`}
            disabled={load.state === 'loading' || problem !== null}
            onClick={() => setReloadTick(t => t + 1)}
          >
            Refresh
          </button>
          <span className="text-[11px] text-[var(--mv-muted)]" aria-live="polite">
            {load.state === 'loading' ? 'Loading…' : ''}
          </span>
        </div>
      </div>

      {problem !== null && <p className="text-sm text-[var(--mv-muted)]">{problem}</p>}

      {load.state === 'error' && (
        <p role="alert" className="text-sm font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
          The server refused this report: {load.message}
        </p>
      )}

      {view !== null && (
        <div className={load.state === 'loading' ? 'opacity-60' : ''}>
          <ReportOutput view={view} />
        </div>
      )}

      {printing && view !== null && createPortal(
        <div className="sb-print-portal">
          <ReportOutput view={view} />
          <p className="mt-6 text-[10px] text-[var(--mv-muted)]">
            From SocietyBooks, printed {formatDate(isoDateInIndia())}. Figures are the server’s ledger as at the period shown.
          </p>
        </div>,
        document.body,
      )}
    </div>
  );
}
