import { useState } from 'react';
import { formatRupees } from '../../../accounting/money';
import { gstOnContribution } from '../../../accounting/transactions';
import { approveSetting, listSettings, putSetting, type Setting } from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import {
  Badge, Button, Card, FormDialog, LoadState, inputClass, labelClass, todayInIndia,
  useLoad, useWrite,
} from './ui';

const GST = 'gst.treatment';
const FUNDS_THROUGH_INCOME = 'accounting.sinkingFundThroughIncome';
/** The statutory per-member exemption the server applies when none is named. */
const DEFAULT_THRESHOLD_RUPEES = 7500;

/** What the screen knows about each setting the server reads. */
const KNOWN: Record<string, { label: string; treatment: boolean; help: string }> = {
  [GST]: {
    label: 'GST treatment', treatment: true,
    help: 'Whether maintenance carries GST, at what rate, the per-member monthly exemption, whether the sinking fund is taxed too, and whether CGST and SGST are rounded to the rupee. Billing refuses to issue a tax invoice that charges an unapproved treatment.',
  },
  [FUNDS_THROUGH_INCOME]: {
    label: 'Sinking fund through income', treatment: true,
    help: 'When on, fund contributions are credited to income and appropriated later instead of to the fund directly. While on and unapproved, nothing that credits a fund can be posted.',
  },
  'billing.invoicePrefix': { label: 'Invoice prefix', treatment: false, help: '2–12 capital letters, digits or hyphens. Anything else falls back to INV.' },
  'billing.dueDays': { label: 'Days to pay', treatment: false, help: 'Whole days from the invoice date, 0–90. Anything else falls back to 15.' },
  'billing.sinkingFundPercent': { label: 'Sinking fund share (%)', treatment: false, help: 'Percentage of maintenance, 0–100.' },
  'billing.dayOfMonth': { label: 'Billing day of month', treatment: false, help: 'The day of the month the monthly run is scheduled for.' },
};

interface GstValue {
  chargeGst?: boolean;
  ratePercent?: number;
  memberThresholdRupees?: number;
  sinkingFundTaxable?: boolean;
  roundToRupee?: boolean;
  [other: string]: unknown;
}

/**
 * The approach note's worked figure — 1,750 sq ft at ₹4.50, 10% sinking fund —
 * under the treatment being edited, so the effect of each choice is visible
 * before it is saved. The same arithmetic as both engines' `gstOnContribution`:
 * each half at half the rate, to the paisa or (rounded) to the rupee half up.
 */
function gstExample(opts: { ratePercent: number; thresholdRupees: number; sinkingFundTaxable: boolean; roundToRupee: boolean }): string {
  if (!(opts.ratePercent > 0 && opts.ratePercent <= 100)) return '';
  const maintenance = 787_500;
  const sinking = 78_750;
  const taxable = maintenance + (opts.sinkingFundTaxable ? sinking : 0);
  const thresholdPaise = Number.isFinite(opts.thresholdRupees) ? Math.round(opts.thresholdRupees * 100) : 0;
  const tax = gstOnContribution(taxable, {
    ratePercent: opts.ratePercent, thresholdPaise, roundToRupee: opts.roundToRupee,
  });
  const money = (paise: number): string => formatRupees(paise, { paise: true });
  const base = `Example: ₹7,875.00 maintenance + ₹787.50 sinking fund — taxable contribution ${money(taxable)}`;
  if (tax.total === 0) return `${base}, within the exemption, so no GST; total ${money(maintenance + sinking)}.`;
  return `${base}; CGST ${money(tax.cgst)} + SGST ${money(tax.sgst)}; total ${money(maintenance + sinking + tax.total)}.`;
}

function describe(key: string, value: unknown): string {
  if (key === GST) {
    const gst = (value ?? {}) as GstValue;
    const threshold = typeof gst.memberThresholdRupees === 'number' ? gst.memberThresholdRupees : DEFAULT_THRESHOLD_RUPEES;
    const thresholdText = `${formatRupees(Math.round(threshold * 100))}/member/month exempt` +
      (typeof gst.memberThresholdRupees === 'number' ? '' : ' (statutory default)');
    return gst.chargeGst === true
      ? `Charge GST at ${String(gst.ratePercent ?? 0)}% · ${thresholdText}` +
        (gst.sinkingFundTaxable === true ? ' · sinking fund taxed (counts towards the exemption)' : '') +
        (gst.roundToRupee === true ? ' · CGST and SGST rounded to the rupee per invoice' : '')
      : 'No GST charged';
  }
  if (key === FUNDS_THROUGH_INCOME) {
    return value === true ? 'On — contributions credited to income' : 'Off — contributions credited to the fund';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Society settings. Writing a value never approves it, and changing one drops
 * an earlier sign-off, so the pending state is stated at the top: it is the
 * reason billing refuses, and the person who can fix it may not be the person
 * looking.
 */
export function SettingsSection({ ctx }: { ctx: OfficeContext }) {
  const settings = useLoad(() => listSettings(ctx.client), [ctx]);
  const { busy, run } = useWrite(ctx, settings.refresh);
  const [editing, setEditing] = useState<string | null>(null);
  const [approving, setApproving] = useState<Setting | null>(null);
  const mayEdit = ctx.can('settings.manage');
  const mayApprove = ctx.can('rate.approve');

  const stored = settings.data ?? [];
  // The two treatments are always listed: absent is a real state with a
  // meaning (no GST; fund credited directly) that someone may need to change.
  const rows: Array<Setting | { key: string; missing: true }> = [
    ...[GST, FUNDS_THROUGH_INCOME]
      .filter(k => !stored.some(s => s.key === k))
      .map(k => ({ key: k, missing: true as const })),
    ...stored,
  ].sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));

  const pendingTreatments = stored.filter(s => !s.approved && KNOWN[s.key]?.treatment === true);
  const gst = stored.find(s => s.key === GST);
  const gstBlocking = gst !== undefined && !gst.approved && (gst.value as GstValue | null)?.chargeGst === true;
  const editingRow = editing === null ? null : rows.find(r => r.key === editing) ?? null;

  return (
    <Card title="Society settings">
      {settings.data !== null && pendingTreatments.length > 0 && (
        <div role="status" className="rounded-xl border-2 border-amber-400 bg-amber-50 p-3 text-xs text-amber-950 space-y-1">
          <p className="font-bold uppercase tracking-wider text-[10px]">Pending approval</p>
          {pendingTreatments.map(s => (
            <p key={s.key}>
              <strong>{KNOWN[s.key]?.label ?? s.key}</strong>: {describe(s.key, s.value)}.
              {s.key === GST && gstBlocking && ' Billing will refuse to convert any invoice that charges this GST until it is approved.'}
              {s.key === FUNDS_THROUGH_INCOME && s.value === true && ' Nothing that credits a fund can be posted until it is approved.'}
            </p>
          ))}
          <p className="text-amber-900">
            {mayApprove ? 'You can approve these below, unless you set them yourself.' : 'Someone with approval rights (the treasurer) has to sign these off.'}
          </p>
        </div>
      )}
      <LoadState loaded={settings} empty="No settings are on record." isEmpty={false} />
      {settings.data !== null && (
        <ul className="divide-y divide-[var(--mv-border)]">
          {rows.map(row => {
            const known = KNOWN[row.key];
            const missing = 'missing' in row;
            return (
              <li key={row.key} className="py-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-[var(--mv-ink)]">{known?.label ?? row.key}</span>
                    <code className="text-[10px] text-[var(--mv-muted)] break-all">{row.key}</code>
                  </div>
                  <p className="text-sm text-[var(--mv-ink)] break-words">
                    {missing ? `Not set — ${describe(row.key, undefined).toLowerCase()}` : describe(row.key, row.value)}
                  </p>
                  {known !== undefined && <p className="text-[11px] text-[var(--mv-muted)]">{known.help}</p>}
                  {!missing && row.note !== null && <p className="text-[11px] text-[var(--mv-muted)] italic">Note: {row.note}</p>}
                  {!missing && (
                    <p className="text-[10px] text-[var(--mv-muted)]">
                      Last changed {row.updatedAt.slice(0, 16).replace('T', ' ')}
                      {row.approved && row.approvedOn !== null ? ` · approved on ${row.approvedOn}` : ''}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {missing ? <Badge tone="muted">Not set</Badge> : row.approved ? <Badge tone="ok">Approved</Badge> : <Badge tone="warn">Pending approval</Badge>}
                  {mayEdit && (
                    <Button onClick={() => setEditing(row.key)} aria-label={`Edit ${known?.label ?? row.key}`}>Edit</Button>
                  )}
                  {mayApprove && !missing && !row.approved && (
                    <Button tone="primary" onClick={() => setApproving(row)} disabled={busy === `approve:${row.key}`}
                      aria-label={`Approve ${known?.label ?? row.key}`}>
                      Approve
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editingRow !== null && (
        <EditSettingDialog
          settingKey={editingRow.key}
          current={'missing' in editingRow ? undefined : editingRow.value}
          busy={busy === `edit:${editingRow.key}`}
          onClose={() => setEditing(null)}
          onSubmit={async (value, note) => {
            const done = await run(
              `edit:${editingRow.key}`,
              () => putSetting(ctx.client, editingRow.key, value, note),
              `${KNOWN[editingRow.key]?.label ?? editingRow.key} saved. It needs approval by someone else before it takes effect.`,
            );
            if (done) setEditing(null);
          }}
        />
      )}
      {approving !== null && (
        <ApproveSettingDialog
          setting={approving}
          busy={busy === `approve:${approving.key}`}
          onClose={() => setApproving(null)}
          onSubmit={async note => {
            const done = await run(
              `approve:${approving.key}`,
              () => approveSetting(ctx.client, approving.key, todayInIndia(), note),
              `${KNOWN[approving.key]?.label ?? approving.key} approved.`,
            );
            if (done) setApproving(null);
          }}
        />
      )}
    </Card>
  );
}

function order(key: string): number {
  if (key === GST) return 0;
  if (key === FUNDS_THROUGH_INCOME) return 1;
  return KNOWN[key] === undefined ? 3 : 2;
}

function EditSettingDialog({ settingKey, current, busy, onClose, onSubmit }: {
  settingKey: string;
  current: unknown;
  busy: boolean;
  onClose: () => void;
  onSubmit: (value: unknown, note: string | undefined) => void;
}) {
  const label = KNOWN[settingKey]?.label ?? settingKey;
  const gst = (settingKey === GST ? current ?? {} : {}) as GstValue;
  const [chargeGst, setChargeGst] = useState(gst.chargeGst === true);
  const [ratePercent, setRatePercent] = useState(gst.ratePercent !== undefined && gst.ratePercent !== 0 ? String(gst.ratePercent) : '');
  const [threshold, setThreshold] = useState(typeof gst.memberThresholdRupees === 'number' ? String(gst.memberThresholdRupees) : '');
  const [sinkingTaxable, setSinkingTaxable] = useState(gst.sinkingFundTaxable === true);
  const [roundToRupee, setRoundToRupee] = useState(gst.roundToRupee === true);
  const [flag, setFlag] = useState(current === true);
  const [text, setText] = useState(
    settingKey === GST || settingKey === FUNDS_THROUGH_INCOME ? ''
      : current === undefined ? '' : typeof current === 'string' ? current : JSON.stringify(current),
  );
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const build = (): unknown => {
    if (settingKey === GST) {
      const rate = chargeGst ? Number(ratePercent) : 0;
      if (chargeGst && !(rate > 0 && rate <= 100)) throw new Error('A GST rate is a percentage above 0 and at most 100.');
      // Fields this form does not edit are kept, so saving the rate does not
      // quietly drop something else the treatment carries.
      const {
        chargeGst: _c, ratePercent: _r, memberThresholdRupees: _m,
        sinkingFundTaxable: _s, roundToRupee: _t, ...rest
      } = gst;
      const value: GstValue = { ...rest, chargeGst, ratePercent: rate };
      // Written only when on, so a treatment that never opted in keeps the
      // shape it had; absent means off on the server.
      if (sinkingTaxable) value.sinkingFundTaxable = true;
      if (roundToRupee) value.roundToRupee = true;
      if (threshold.trim() !== '') {
        const amount = Number(threshold);
        if (!(Number.isFinite(amount) && amount >= 0 && amount <= 10_000_000)) {
          throw new Error('The per-member threshold is an amount in rupees.');
        }
        value.memberThresholdRupees = amount;
      }
      return value;
    }
    if (settingKey === FUNDS_THROUGH_INCOME) return flag;
    if (settingKey === 'billing.invoicePrefix') return text.trim();
    if (KNOWN[settingKey] !== undefined) {
      const n = Number(text);
      if (text.trim() === '' || !Number.isFinite(n)) throw new Error(`${label} is a number.`);
      return n;
    }
    try { return JSON.parse(text); } catch { throw new Error('Enter the value as JSON, e.g. "text", 12 or true.'); }
  };

  const submit = (): void => {
    try {
      const value = build();
      setProblem(null);
      onSubmit(value, note.trim() === '' ? undefined : note.trim());
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'That value is not usable.');
    }
  };

  return (
    <FormDialog
      id="gov-edit-setting"
      title={`Edit ${label}`}
      intro="Saving records the value unapproved and drops any earlier sign-off. Someone else with approval rights then approves it."
      submitLabel="Save for approval"
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
    >
      {settingKey === GST && (
        <>
          <div className="flex items-center gap-2">
            <input id="gov-gst-charge" type="checkbox" data-autofocus checked={chargeGst} onChange={e => setChargeGst(e.target.checked)} className="w-4 h-4 accent-[var(--mv-accent)]" />
            <label htmlFor="gov-gst-charge" className="text-sm text-[var(--mv-ink)]">Charge GST on maintenance</label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="gov-gst-rate" className={labelClass}>Rate (%)</label>
              <input id="gov-gst-rate" className={inputClass} inputMode="decimal" value={ratePercent} disabled={!chargeGst}
                onChange={e => setRatePercent(e.target.value)} placeholder="18" />
            </div>
            <div>
              <label htmlFor="gov-gst-threshold" className={labelClass}>Exempt up to (₹/member/month)</label>
              <input id="gov-gst-threshold" className={inputClass} inputMode="decimal" value={threshold}
                onChange={e => setThreshold(e.target.value)} placeholder={String(DEFAULT_THRESHOLD_RUPEES)} />
            </div>
          </div>
          <p className="text-[11px] text-[var(--mv-muted)]">Leave the threshold blank for the statutory ₹7,500.</p>
          <div className="flex items-start gap-2">
            <input id="gov-gst-sinking" type="checkbox" checked={sinkingTaxable} disabled={!chargeGst}
              onChange={e => setSinkingTaxable(e.target.checked)} className="w-4 h-4 mt-0.5 accent-[var(--mv-accent)]" />
            <label htmlFor="gov-gst-sinking" className="text-sm text-[var(--mv-ink)]">
              Charge GST on the sinking fund too
              <span className="block text-[11px] text-[var(--mv-muted)]">
                The sinking fund line is taxed at the maintenance rate, and the exemption is tested on maintenance plus sinking fund. Off: only maintenance is taxed and counted. Applies to bills raised after approval.
              </span>
            </label>
          </div>
          <div className="flex items-start gap-2">
            <input id="gov-gst-round" type="checkbox" checked={roundToRupee} disabled={!chargeGst}
              onChange={e => setRoundToRupee(e.target.checked)} className="w-4 h-4 mt-0.5 accent-[var(--mv-accent)]" />
            <label htmlFor="gov-gst-round" className="text-sm text-[var(--mv-ink)]">
              Round CGST and SGST to the rupee per invoice
              <span className="block text-[11px] text-[var(--mv-muted)]">
                Each half is rounded to the nearest rupee, half up (₹708.75 → ₹709, ₹911.25 → ₹911), so the two stay equal. Also applies to credit and debit notes. Off: to the paisa.
              </span>
            </label>
          </div>
          {chargeGst && (
            <p className="text-[11px] text-[var(--mv-muted)] bg-[var(--mv-soft)] rounded-xl p-2">
              {gstExample({
                ratePercent: Number(ratePercent),
                thresholdRupees: threshold.trim() === '' ? DEFAULT_THRESHOLD_RUPEES : Number(threshold),
                sinkingFundTaxable: sinkingTaxable,
                roundToRupee,
              }) || 'Enter a rate to see its effect on a bill.'}
            </p>
          )}
        </>
      )}
      {settingKey === FUNDS_THROUGH_INCOME && (
        <div className="flex items-center gap-2">
          <input id="gov-fund-income" type="checkbox" data-autofocus checked={flag} onChange={e => setFlag(e.target.checked)} className="w-4 h-4 accent-[var(--mv-accent)]" />
          <label htmlFor="gov-fund-income" className="text-sm text-[var(--mv-ink)]">Credit fund contributions to income, appropriated later</label>
        </div>
      )}
      {settingKey !== GST && settingKey !== FUNDS_THROUGH_INCOME && (
        <div>
          <label htmlFor="gov-setting-value" className={labelClass}>{KNOWN[settingKey] === undefined ? 'Value (JSON)' : 'Value'}</label>
          <input id="gov-setting-value" data-autofocus className={inputClass} value={text} onChange={e => setText(e.target.value)} />
          {KNOWN[settingKey] !== undefined && <p className="text-[11px] text-[var(--mv-muted)] mt-1">{KNOWN[settingKey].help}</p>}
        </div>
      )}
      <div>
        <label htmlFor="gov-setting-note" className={labelClass}>Note (optional)</label>
        <input id="gov-setting-note" className={inputClass} value={note} maxLength={500}
          onChange={e => setNote(e.target.value)} placeholder="e.g. Per committee meeting of 10 Oct" />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}

function ApproveSettingDialog({ setting, busy, onClose, onSubmit }: {
  setting: Setting; busy: boolean; onClose: () => void; onSubmit: (note: string | undefined) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <FormDialog
      id="gov-approve-setting"
      title={`Approve ${KNOWN[setting.key]?.label ?? setting.key}`}
      intro="You are recording that the committee agreed to this value, dated today. The person who set it cannot approve it."
      submitLabel="Approve"
      busy={busy}
      onClose={onClose}
      onSubmit={() => onSubmit(note.trim() === '' ? undefined : note.trim())}
    >
      <p className="text-sm font-bold text-[var(--mv-ink)] bg-[var(--mv-soft)] rounded-xl p-3">
        {describe(setting.key, setting.value)}
      </p>
      <div>
        <label htmlFor="gov-approve-note" className={labelClass}>Note (optional)</label>
        <input id="gov-approve-note" data-autofocus className={inputClass} value={note} maxLength={500}
          onChange={e => setNote(e.target.value)} placeholder="e.g. Minuted at MC meeting, item 3" />
      </div>
    </FormDialog>
  );
}
