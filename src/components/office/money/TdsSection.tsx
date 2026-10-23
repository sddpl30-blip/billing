import { useState } from 'react';
import { formatRupees } from '../../../accounting';
import { money, type BankAccount, type TdsSection as Section, type TdsSummary } from '../../../api/office/money';
import type { OfficeContext } from '../types';
import {
  Card, Empty, Field, FormDialog, FormProblem, TableScroll,
  inputClass, numClass, secondaryButton, tdClass, thClass, todayIso,
} from './ui';

const QUARTER = /^Q([1-4])-FY(\d{2})-(\d{2})$/;

/** The quarter before 'Q1-FY26-27' is 'Q4-FY25-26'. */
export function previousQuarter(quarter: string): string | null {
  const match = QUARTER.exec(quarter);
  if (match === null) return null;
  const q = Number(match[1]);
  const start = Number(match[2]);
  if (q > 1) return `Q${q - 1}-FY${match[2]}-${match[3]}`;
  const pad = (n: number) => String((n + 100) % 100).padStart(2, '0');
  return `Q4-FY${pad(start - 1)}-${pad(start)}`;
}

/** The same spelling the server uses for a date's quarter of the Indian financial year. */
export function quarterOf(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const fyStart = month >= 4 ? year : year - 1;
  const q = month >= 4 && month <= 6 ? 1 : month <= 9 && month >= 7 ? 2 : month >= 10 ? 3 : 4;
  const pad = (n: number) => String(n % 100).padStart(2, '0');
  return `Q${q}-FY${pad(fyStart)}-${pad(fyStart + 1)}`;
}

interface DueRow {
  readonly quarter: string;
  readonly section: string;
  readonly deductions: number;
  readonly tds: number;
  readonly unremitted: number;
}

export function TdsSection({ ctx, summaries, error, bankAccounts, onLookup, onChanged }: {
  ctx: OfficeContext;
  summaries: readonly TdsSummary[] | null;
  error: string | null;
  bankAccounts: readonly BankAccount[];
  onLookup: (quarter: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [remitting, setRemitting] = useState<DueRow | null>(null);
  const [lookup, setLookup] = useState('');
  const canRemit = ctx.can('tds.remit');

  const rows: DueRow[] = (summaries ?? []).flatMap(s => s.bySection.map(r => ({
    quarter: s.quarter, section: r.section, deductions: r.deductions, tds: r.tds, unremitted: r.unremitted,
  })));
  const due = rows.reduce((sum, r) => sum + r.unremitted, 0);

  return (
    <Card title="TDS to remit">
      <p className="text-[11px] text-[var(--mv-muted)]">
        Tax withheld on booked vendor bills, by quarter and section. Record the remittance once the challan is paid;
        nothing is filed with the income-tax portal from here.
      </p>
      {error !== null ? <Empty>{error}</Empty>
        : summaries === null ? <Empty>Loading…</Empty>
        : (
          <>
            <p className="text-sm font-bold text-[var(--mv-ink)]">
              {due > 0 ? `${formatRupees(due)} withheld and not yet remitted` : 'Nothing withheld is waiting to be remitted.'}
            </p>
            {rows.length === 0 ? <Empty>No deductions in {summaries.map(s => s.quarter).join(', ')}.</Empty> : (
              <TableScroll label="TDS by quarter and section">
                <thead>
                  <tr className="border-b border-[var(--mv-border)]">
                    <th scope="col" className={thClass}>Quarter</th>
                    <th scope="col" className={thClass}>Section</th>
                    <th scope="col" className={`${thClass} text-right`}>Deductions</th>
                    <th scope="col" className={`${thClass} text-right`}>Withheld</th>
                    <th scope="col" className={`${thClass} text-right`}>Not remitted</th>
                    <th scope="col" className={thClass}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={`${r.quarter}:${r.section}`} className="border-b border-[var(--mv-border)] last:border-0">
                      <td className={`${tdClass} font-bold`}>{r.quarter}</td>
                      <td className={tdClass}>{r.section}</td>
                      <td className={numClass}>{r.deductions}</td>
                      <td className={numClass}>{formatRupees(r.tds)}</td>
                      <td className={numClass}>{formatRupees(r.unremitted)}</td>
                      <td className={tdClass}>
                        {r.unremitted > 0 && canRemit && (
                          <button type="button" className={secondaryButton} onClick={() => setRemitting(r)}
                            aria-label={`Remit ${r.section} TDS for ${r.quarter}`}>Remit</button>
                        )}
                        {r.unremitted === 0 && <span className="text-[var(--mv-muted)]">Remitted</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </>
        )}
      <form
        className="flex flex-wrap items-end gap-2 pt-1"
        onSubmit={e => {
          e.preventDefault();
          const q = lookup.trim().toUpperCase();
          if (!QUARTER.test(q)) { ctx.toast('A quarter is written like Q2-FY26-27.', 'error'); return; }
          onLookup(q);
          setLookup('');
        }}
      >
        <div>
          <label htmlFor="tds-lookup" className="text-[10px] text-[var(--mv-muted)] font-bold block mb-1 uppercase tracking-wider">
            Another quarter
          </label>
          <input id="tds-lookup" className={`${inputClass} w-40`} placeholder="Q4-FY25-26" value={lookup} onChange={e => setLookup(e.target.value)} />
        </div>
        <button type="submit" className={secondaryButton}>Show</button>
      </form>
      {remitting !== null && (
        <RemitDialog ctx={ctx} row={remitting} bankAccounts={bankAccounts} onClose={() => setRemitting(null)}
          onDone={async () => { setRemitting(null); await onChanged(); }} />
      )}
    </Card>
  );
}

function RemitDialog({ ctx, row, bankAccounts, onClose, onDone }: {
  ctx: OfficeContext; row: DueRow; bankAccounts: readonly BankAccount[];
  onClose: () => void; onDone: () => Promise<void>;
}) {
  const [challanNo, setChallanNo] = useState('');
  const [challanDate, setChallanDate] = useState(todayIso());
  const [bankAccountId, setBankAccountId] = useState('');
  // As for a vendor payment: a second press is the same remittance, not another.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const submit = async () => {
    if (challanNo.trim() === '') throw new FormProblem('Enter the challan number from the bank counterfoil.');
    const result = await money.remitTds(ctx.client, row.quarter, {
      section: row.section as Section,
      challanNo: challanNo.trim(),
      challanDate,
      ...(bankAccountId === '' ? {} : { bankAccountId }),
    }, idempotencyKey);
    ctx.toast(
      `${formatRupees(result.amount)} under ${result.section} for ${result.quarter} ` +
      `(${result.deductions} ${result.deductions === 1 ? 'deduction' : 'deductions'}). ${result.note}`,
    );
    await onDone();
  };

  return (
    <FormDialog id="remit-tds" title={`Remit ${row.section} TDS for ${row.quarter}`} submitLabel="Record remittance" onClose={onClose} onSubmit={submit} ctx={ctx}>
      <p className="text-xs text-[var(--mv-muted)]">
        Clears {formatRupees(row.unremitted)} of withholding liability and takes it out of the bank.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field id="remit-challan" label="Challan no.">
          <input id="remit-challan" data-autofocus className={inputClass} value={challanNo} onChange={e => setChallanNo(e.target.value)} maxLength={60} />
        </Field>
        <Field id="remit-date" label="Challan date">
          <input id="remit-date" type="date" className={inputClass} value={challanDate} onChange={e => setChallanDate(e.target.value)} />
        </Field>
      </div>
      {bankAccounts.length > 0 && (
        <Field id="remit-bank" label="Paid from">
          <select id="remit-bank" className={inputClass} value={bankAccountId} onChange={e => setBankAccountId(e.target.value)}>
            <option value="">Operating account (default)</option>
            {bankAccounts.filter(a => a.active).map(a => (
              <option key={a.id} value={a.id}>{a.label} · {a.bankName} ••{a.accountLast4}</option>
            ))}
          </select>
        </Field>
      )}
    </FormDialog>
  );
}
