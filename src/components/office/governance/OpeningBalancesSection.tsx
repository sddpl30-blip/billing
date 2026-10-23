/**
 * Opening balances: the society's position on the day before it went live.
 *
 * The secretary enters it — the per-flat dues and advances from a CSV, the
 * society's own balances account by account — and the treasurer approves it,
 * which is what posts it as one journal entry. The server enforces all of
 * that (who may do which step, that the preparer is not the approver, that the
 * entry balances, that it happens once); this screen shows each step to the
 * account allowed to take it and passes any refusal through verbatim.
 */

import { useMemo, useState } from 'react';
import { formatRupees } from '../../../accounting/money';
import {
  applyAdvances, approveOpening, discardOpening, listVendors, readOpening, reverseOpening, saveOpeningDraft,
  type OpeningAccountLine, type OpeningFlatLine, type OpeningPlan, type OpeningView,
} from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import {
  Badge, Button, Card, FormDialog, LoadState, Table, cellClass, inputClass, labelClass, refusalOf,
  todayInIndia, useLoad, useWrite,
} from './ui';

const money = (paise: number): string => formatRupees(paise, { paise: true });

/** The last day of the month before today's, the usual as-at date. */
function endOfLastMonth(): string {
  const [y, m] = todayInIndia().split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1, 0));
  return last.toISOString().slice(0, 10);
}

/** "1,23,456.50" → 12345650 paise, exactly; null if it is not an amount. */
function toPaise(text: string): number | null {
  const t = text.replace(/[₹,\s]/g, '');
  if (t === '') return 0;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  return m === null ? null : Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

const OPENING_TEMPLATE = 'flat_no,opening_due,opening_advance,due_since\r\nA-101,4500.00,0,2026-07-01\r\nA-102,0,1200.00,\r\n';

function downloadOpeningTemplate(): void {
  const blob = new Blob(['﻿', OPENING_TEMPLATE], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'opening-balances-per-flat.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function OpeningBalancesSection({ ctx }: { ctx: OfficeContext }) {
  const view = useLoad(() => readOpening(ctx.client), [ctx]);
  const { busy, run } = useWrite(ctx, view.refresh);
  const [editing, setEditing] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [applyingOn, setApplyingOn] = useState<string | null>(null);
  const data = view.data;
  const current = data?.current ?? null;
  const mayApply = ctx.can('payment.record') || ctx.can('billing.convert');

  return (
    <Card
      title="Opening balances"
      actions={data !== null && data.canPrepare && current === null && !editing
        ? <Button tone="primary" onClick={() => setEditing(true)}>Enter opening balances</Button>
        : undefined}
    >
      <p className="text-xs text-[var(--mv-muted)] leading-relaxed">
        What each flat owed or had paid ahead, and what the society held and owed, on the day before going live —
        agreed with the trial balance at that date. It posts once, as one balanced journal entry. Each flat&apos;s opening
        due then behaves like an unpaid bill: receipts settle it first and it shows in ageing and the flat statement.
        It is not a sale, so no GST arises on it.
      </p>
      <LoadState loaded={view} empty="" isEmpty={false} />

      {data !== null && editing && (
        <OpeningEditor
          ctx={ctx}
          view={data}
          onCancel={() => setEditing(false)}
          onSaved={async () => { setEditing(false); await Promise.all([view.refresh(), ctx.reload()]); }}
        />
      )}

      {data !== null && !editing && current === null && (
        <p className="text-sm text-[var(--mv-muted)]">
          No opening balances have been entered.{' '}
          {data.canPrepare ? '' : 'The secretary enters them; the treasurer approves them.'}
        </p>
      )}

      {data !== null && !editing && current !== null && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={current.state === 'posted' ? 'ok' : 'warn'}>{current.state}</Badge>
            <span className="text-sm text-[var(--mv-ink)]">
              Batch {current.batchNo}, as at <strong>{current.asAt}</strong>
            </span>
          </div>
          <p className="text-xs text-[var(--mv-muted)]">
            Prepared by {current.preparedBy}
            {current.approvedBy !== null ? <> · approved and posted by {current.approvedBy}</> : null}
            {current.note ? <> · {current.note}</> : null}
          </p>
          <PlanSummary plan={current.plan} />

          {current.state === 'draft' && (
            <div className="flex flex-wrap gap-2 justify-end">
              {data.canPrepare && (
                <>
                  <Button
                    disabled={busy !== null}
                    onClick={() => void run('discard', () => discardOpening(ctx.client, current.id), 'Draft discarded.')}
                  >
                    Discard draft
                  </Button>
                  <Button onClick={() => setEditing(true)}>Edit draft</Button>
                </>
              )}
              {data.canApprove && (
                current.preparedBy === data.you
                  ? <p className="text-xs text-[var(--mv-muted)] self-center">You prepared this draft, so another office-bearer must approve it.</p>
                  : (
                    <Button
                      tone="primary"
                      disabled={busy !== null || current.plan.blockers.length > 0 || current.plan.errors.length > 0}
                      onClick={() => void run(
                        'approve', () => approveOpening(ctx.client, current.id),
                        r => {
                          const result = r as { documents: number; totalPaise: number };
                          return `Posted: one entry of ${money(result.totalPaise)}, with ${result.documents} opening dues.`;
                        },
                      )}
                    >
                      {busy === 'approve' ? 'Posting…' : 'Approve and post'}
                    </Button>
                  )
              )}
            </div>
          )}

          {current.state === 'posted' && (
            <div className="flex flex-wrap gap-2 justify-end">
              {mayApply && <Button onClick={() => setApplyingOn(todayInIndia())}>Apply held advances to open bills</Button>}
              {data.canApprove && <Button onClick={() => setReversing(true)}>Reverse to correct…</Button>}
            </div>
          )}
        </div>
      )}

      {data !== null && data.history.some(b => b.state === 'reversed' || b.state === 'discarded') && (
        <details className="text-xs">
          <summary className="cursor-pointer font-bold text-[var(--mv-ink)]">Earlier batches</summary>
          <ul className="mt-2 space-y-1">
            {data.history.filter(b => b.state === 'reversed' || b.state === 'discarded').map(b => (
              <li key={b.id} className="break-words">
                <Badge tone="muted">{b.state}</Badge> Batch {b.batchNo}, as at {b.asAt}
                {b.reversalReason ? <> — reversed by {b.reversedBy}: {b.reversalReason}</> : null}
              </li>
            ))}
          </ul>
        </details>
      )}

      {reversing && current !== null && (
        <ReverseDialog
          busy={busy === 'reverse'}
          onClose={() => setReversing(false)}
          onSubmit={async reason => {
            const done = await run('reverse', () => reverseOpening(ctx.client, current.id, reason), r => (r as { note: string }).note);
            if (done) setReversing(false);
          }}
        />
      )}
      {applyingOn !== null && (
        <FormDialog
          id="gov-apply-advances"
          title="Apply held advances"
          intro="Every flat holding an advance has it set against its open bills, oldest first, as at the date below. Run it after the month's bills have been converted."
          submitLabel="Apply advances"
          busy={busy === 'apply'}
          onClose={() => setApplyingOn(null)}
          onSubmit={async () => {
            const done = await run('apply', () => applyAdvances(ctx.client, applyingOn), r => {
              const result = r as { flats: number; appliedPaise: number };
              return result.flats === 0
                ? 'No flat had both an advance and an open bill.'
                : `Applied ${money(result.appliedPaise)} across ${result.flats} ${result.flats === 1 ? 'flat' : 'flats'}.`;
            });
            if (done) setApplyingOn(null);
          }}
        >
          <div>
            <label htmlFor="gov-apply-on" className={labelClass}>As at</label>
            <input id="gov-apply-on" data-autofocus type="date" className={inputClass} value={applyingOn} onChange={e => setApplyingOn(e.target.value)} required />
          </div>
        </FormDialog>
      )}
    </Card>
  );
}

function PlanSummary({ plan }: { plan: OpeningPlan }) {
  const dues = plan.flats.filter(f => f.duePaise > 0);
  const advances = plan.flats.filter(f => f.advancePaise > 0);
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Figure label={`Dues · ${dues.length} flats`} value={money(plan.totals.duePaise)} />
        <Figure label={`Advances · ${advances.length} flats`} value={money(plan.totals.advancePaise)} />
        <Figure label="Total debits" value={money(plan.totals.debitPaise + plan.accounts.filter(a => a.isBalancing).reduce((s, a) => s + a.debitPaise, 0))} />
        <Figure label="Total credits" value={money(plan.totals.creditPaise + plan.accounts.filter(a => a.isBalancing).reduce((s, a) => s + a.creditPaise, 0))} />
      </dl>
      {plan.accounts.length > 0 && (
        <Table head={['Account', 'Debit', 'Credit']}>
          {plan.accounts.map((a, i) => (
            <tr key={i}>
              <td className={`${cellClass} break-words`}>
                <span className="font-mono">{a.accountCode}</span> {a.accountName}
                {a.vendorName ? <span className="block text-[10px] text-[var(--mv-muted)]">{a.vendorName} · bill {a.reference}</span> : null}
                {a.isBalancing ? <span className="block text-[10px] text-[var(--mv-muted)]">Balancing figure</span> : null}
              </td>
              <td className={`${cellClass} text-right tabular-nums whitespace-nowrap`}>{a.debitPaise > 0 ? money(a.debitPaise) : '—'}</td>
              <td className={`${cellClass} text-right tabular-nums whitespace-nowrap`}>{a.creditPaise > 0 ? money(a.creditPaise) : '—'}</td>
            </tr>
          ))}
        </Table>
      )}
      {plan.flats.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-bold text-[var(--mv-ink)]">Per-flat lines ({plan.flats.length})</summary>
          <ul className="mt-2 max-h-56 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-x-4">
            {plan.flats.map(f => (
              <li key={f.flatNo} className="flex justify-between gap-2 py-0.5 border-b border-[var(--mv-border)]">
                <span className="font-bold">{f.flatNo}</span>
                <span className="tabular-nums">
                  {f.duePaise > 0 ? `due ${money(f.duePaise)}` : `advance ${money(f.advancePaise)}`}
                  {f.dueSince ? <span className="text-[var(--mv-muted)]"> since {f.dueSince}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <Problems plan={plan} />
    </div>
  );
}

function Problems({ plan }: { plan: OpeningPlan }) {
  if (plan.errors.length === 0 && plan.blockers.length === 0) return null;
  return (
    <div role="alert" className="space-y-2">
      {plan.errors.length > 0 && (
        <ul className="max-h-48 overflow-y-auto text-xs border border-red-200 bg-red-50 rounded-xl divide-y divide-red-100">
          {plan.errors.map((e, i) => (
            <li key={i} className="px-3 py-1.5 text-red-900 break-words">
              <span className="font-bold">{e.part === 'flats' ? 'Flats' : e.part === 'accounts' ? 'Accounts' : 'Batch'}{e.line !== undefined ? `, line ${e.line}` : ''}:</span> {e.message}
            </li>
          ))}
        </ul>
      )}
      {plan.blockers.map((b, i) => (
        <p key={i} className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-xl p-2">{b}</p>
      ))}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--mv-border)] bg-[var(--mv-soft)] p-2 min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)]">{label}</dt>
      <dd className="text-sm font-bold text-[var(--mv-ink)] tabular-nums break-words">{value}</dd>
    </div>
  );
}

interface LineDraft {
  readonly key: number;
  accountCode: string;
  side: 'debit' | 'credit';
  amount: string;
  vendorId: string;
  reference: string;
  expenseAccount: string;
  memo: string;
}

let nextKey = 1;
const blankLine = (accountCode = ''): LineDraft => ({
  key: nextKey++, accountCode, side: 'debit', amount: '', vendorId: '', reference: '', expenseAccount: '', memo: '',
});

function OpeningEditor({ ctx, view, onCancel, onSaved }: {
  ctx: OfficeContext; view: OpeningView; onCancel: () => void; onSaved: () => Promise<void>;
}) {
  const draft = view.current?.state === 'draft' ? view.current : null;
  const [asAt, setAsAt] = useState(draft?.asAt ?? endOfLastMonth());
  const [autoBalance, setAutoBalance] = useState(draft?.autoBalance ?? true);
  const [note, setNote] = useState(draft?.note ?? '');
  const [flatsCsv, setFlatsCsv] = useState<{ name: string; text: string } | null>(null);
  const keptFlatLines: OpeningFlatLine[] = useMemo(
    () => (draft?.plan.flats ?? []).map(f => ({ flatNo: f.flatNo, duePaise: f.duePaise, advancePaise: f.advancePaise, dueSince: f.dueSince ?? null })),
    [draft],
  );
  const [lines, setLines] = useState<LineDraft[]>(() => {
    const stored = (draft?.plan.accounts ?? []).filter(a => !a.isBalancing);
    if (stored.length === 0) return [blankLine('1000')];
    return stored.map(a => ({
      ...blankLine(a.accountCode),
      side: a.creditPaise > 0 ? 'credit' : 'debit',
      amount: ((a.creditPaise || a.debitPaise) / 100).toFixed(2),
      vendorId: a.vendorId ?? '',
      reference: a.reference ?? '',
      expenseAccount: a.expenseAccount ?? '',
      memo: a.memo ?? '',
    }));
  });
  const [plan, setPlan] = useState<OpeningPlan | null>(draft?.plan ?? null);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const vendors = useLoad(() => listVendors(ctx.client), [ctx]);
  const accountByCode = new Map(view.accounts.map(a => [a.code, a]));

  const update = (key: number, patch: Partial<LineDraft>): void => {
    setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));
  };

  const build = (dryRun: boolean): Parameters<typeof saveOpeningDraft>[1] | string => {
    const accountLines: OpeningAccountLine[] = [];
    for (const [i, l] of lines.entries()) {
      if (l.accountCode === '' && l.amount.trim() === '') continue;
      const paise = toPaise(l.amount);
      if (paise === null || paise === 0) return `Line ${i + 1}: enter an amount in rupees.`;
      const vendorLine = accountByCode.get(l.accountCode)?.control === 'vendor';
      accountLines.push({
        accountCode: l.accountCode,
        debitPaise: l.side === 'debit' ? paise : 0,
        creditPaise: l.side === 'credit' ? paise : 0,
        ...(vendorLine ? { vendorId: l.vendorId || null, reference: l.reference.trim() || null, expenseAccount: l.expenseAccount || null } : {}),
        ...(l.memo.trim() !== '' ? { memo: l.memo.trim() } : {}),
      });
    }
    return {
      asAt, autoBalance, dryRun, accountLines,
      ...(note.trim() !== '' ? { note: note.trim() } : {}),
      ...(flatsCsv !== null ? { flatsCsv: flatsCsv.text } : { flatLines: keptFlatLines }),
    };
  };

  const submit = async (dryRun: boolean): Promise<void> => {
    const body = build(dryRun);
    if (typeof body === 'string') { setProblem(body); return; }
    setBusy(dryRun ? 'check' : 'save');
    setProblem(null);
    try {
      const result = await saveOpeningDraft(ctx.client, body);
      setPlan(result.plan);
      if (!dryRun) {
        ctx.toast(result.plan.blockers.length === 0
          ? 'Draft saved. The treasurer can now approve and post it.'
          : 'Draft saved, but it cannot be posted yet; see the notes below it.');
        await onSaved();
      }
    } catch (err) {
      const detail = (err as { detail?: { plan?: OpeningPlan } }).detail;
      if (detail?.plan !== undefined) setPlan(detail.plan);
      setProblem(refusalOf(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 border border-[var(--mv-border)] rounded-2xl p-3 sm:p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="gov-ob-asat" className={labelClass}>Balances as at</label>
          <input id="gov-ob-asat" type="date" className={inputClass} value={asAt} onChange={e => setAsAt(e.target.value)} required />
          <p className="text-[10px] text-[var(--mv-muted)] mt-1">The day before cut-over, matching the trial balance. The entry is dated this day.</p>
        </div>
        <div>
          <label htmlFor="gov-ob-note" className={labelClass}>Note (optional)</label>
          <input id="gov-ob-note" className={inputClass} value={note} maxLength={500} onChange={e => setNote(e.target.value)} placeholder="e.g. Per audited TB, 30 Sep 2026" />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-bold text-[var(--mv-ink)]">Per flat: dues and advances</legend>
        <p className="text-[11px] text-[var(--mv-muted)]">
          A CSV with <code>flat_no, opening_due, opening_advance</code> in rupees, and optionally <code>due_since</code> so
          ageing shows how old an arrear is. A flat has a due or an advance, not both.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="gov-ob-flats" className={labelClass}>Per-flat CSV</label>
            <input
              id="gov-ob-flats"
              type="file"
              accept=".csv,text/csv"
              className={inputClass}
              onChange={async e => {
                const f = e.target.files?.[0];
                if (f === undefined) return;
                setFlatsCsv({ name: f.name, text: await f.text() });
              }}
            />
          </div>
          <Button onClick={downloadOpeningTemplate}>Download template</Button>
        </div>
        <p className="text-[11px] text-[var(--mv-ink)]" role="status">
          {flatsCsv !== null
            ? `Using ${flatsCsv.name}. Check to see what it brings in.`
            : keptFlatLines.length > 0
              ? `Keeping the draft's ${keptFlatLines.length} per-flat lines; choose a file to replace them.`
              : 'No per-flat balances yet.'}
        </p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-bold text-[var(--mv-ink)]">The society&apos;s balances</legend>
        <p className="text-[11px] text-[var(--mv-muted)]">
          One line per account from the trial balance: bank, sinking fund and its deposits, funds, payables. Assets are
          debits; funds and liabilities are credits. A vendor payable names the vendor and the bill it is owed on.
        </p>
        {lines.map((l, i) => {
          const account = accountByCode.get(l.accountCode);
          const vendorLine = account?.control === 'vendor';
          return (
            <div key={l.key} className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end border-b border-[var(--mv-border)] pb-2">
              <div className="col-span-2 sm:col-span-5">
                <label htmlFor={`gov-ob-acct-${l.key}`} className={labelClass}>Account {i + 1}</label>
                <select
                  id={`gov-ob-acct-${l.key}`}
                  className={inputClass}
                  value={l.accountCode}
                  onChange={e => {
                    const next = accountByCode.get(e.target.value);
                    update(l.key, {
                      accountCode: e.target.value,
                      side: next === undefined ? l.side : next.class === 'asset' ? 'debit' : 'credit',
                    });
                  }}
                >
                  <option value="">Choose…</option>
                  {view.accounts.map(a => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label htmlFor={`gov-ob-side-${l.key}`} className={labelClass}>Side</label>
                <select id={`gov-ob-side-${l.key}`} className={inputClass} value={l.side} onChange={e => update(l.key, { side: e.target.value as 'debit' | 'credit' })}>
                  <option value="debit">Debit</option>
                  <option value="credit">Credit</option>
                </select>
              </div>
              <div className="sm:col-span-3">
                <label htmlFor={`gov-ob-amt-${l.key}`} className={labelClass}>Amount (₹)</label>
                <input id={`gov-ob-amt-${l.key}`} className={`${inputClass} text-right tabular-nums`} inputMode="decimal" value={l.amount} onChange={e => update(l.key, { amount: e.target.value })} placeholder="0.00" />
              </div>
              <div className="col-span-2 sm:col-span-2 flex justify-end">
                <Button onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))} aria-label={`Remove account line ${i + 1}`}>Remove</Button>
              </div>
              {vendorLine && (
                <>
                  <div className="col-span-2 sm:col-span-4">
                    <label htmlFor={`gov-ob-vendor-${l.key}`} className={labelClass}>Vendor</label>
                    <select id={`gov-ob-vendor-${l.key}`} className={inputClass} value={l.vendorId} onChange={e => update(l.key, { vendorId: e.target.value })}>
                      <option value="">Choose…</option>
                      {(vendors.data ?? []).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                  </div>
                  <div className="sm:col-span-4">
                    <label htmlFor={`gov-ob-ref-${l.key}`} className={labelClass}>Bill no.</label>
                    <input id={`gov-ob-ref-${l.key}`} className={inputClass} value={l.reference} maxLength={60} onChange={e => update(l.key, { reference: e.target.value })} />
                  </div>
                  <div className="sm:col-span-4">
                    <label htmlFor={`gov-ob-exp-${l.key}`} className={labelClass}>Bill was for</label>
                    <select id={`gov-ob-exp-${l.key}`} className={inputClass} value={l.expenseAccount} onChange={e => update(l.key, { expenseAccount: e.target.value })}>
                      <option value="">Choose…</option>
                      {view.expenseAccounts.map(a => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                    </select>
                  </div>
                </>
              )}
            </div>
          );
        })}
        <Button onClick={() => setLines(ls => [...ls, blankLine()])}>Add a line</Button>
      </fieldset>

      <div className="flex items-start gap-2">
        <input id="gov-ob-auto" type="checkbox" checked={autoBalance} onChange={e => setAutoBalance(e.target.checked)} className="w-4 h-4 mt-0.5 accent-[var(--mv-accent)]" />
        <label htmlFor="gov-ob-auto" className="text-sm text-[var(--mv-ink)]">
          Post any difference to {view.balancingAccount} General reserve as the balancing figure (the opening general fund).
          Untick to require debits and credits to agree exactly.
        </label>
      </div>

      {plan !== null && (
        <div className="space-y-2">
          <h4 className="text-xs font-bold text-[var(--mv-ink)]">What this would post</h4>
          <PlanSummary plan={plan} />
          {!autoBalance && plan.totals.differencePaise !== 0 && (
            <p className="text-xs text-[var(--mv-muted)]">Difference: {money(plan.totals.differencePaise)}.</p>
          )}
        </div>
      )}
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button disabled={busy !== null} onClick={() => void submit(true)}>{busy === 'check' ? 'Checking…' : 'Check'}</Button>
        <Button tone="primary" disabled={busy !== null} onClick={() => void submit(false)}>{busy === 'save' ? 'Saving…' : 'Save draft'}</Button>
      </div>
    </div>
  );
}

function ReverseDialog({ busy, onClose, onSubmit }: {
  busy: boolean; onClose: () => void; onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <FormDialog
      id="gov-ob-reverse"
      title="Reverse the opening balances"
      intro="A mirror entry is posted on the same date and both stay in the ledger; the opening dues are cancelled. Refused once a receipt, an advance or a vendor payment has been set against an opening item. Enter the corrected balances as a new draft afterwards."
      submitLabel="Reverse"
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        if (reason.trim() === '') { setProblem('Give the reason; it stays on record.'); return; }
        setProblem(null);
        onSubmit(reason.trim());
      }}
    >
      <div>
        <label htmlFor="gov-ob-reason" className={labelClass}>Reason</label>
        <textarea id="gov-ob-reason" data-autofocus className={inputClass} rows={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}
