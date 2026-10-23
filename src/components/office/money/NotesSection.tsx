import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { formatRupees } from '../../../accounting';
import { money, type InvoiceNote, type TaxInvoice } from '../../../api/office/money';
import { problemOf, type OfficeContext } from '../types';
import {
  Card, Empty, Field, FormDialog, FormProblem, TableScroll,
  inputClass, numClass, parseRupees, primaryButton, tdClass, thClass, todayIso,
} from './ui';

export function NotesSection({ ctx, notes, error, onChanged }: {
  ctx: OfficeContext;
  notes: readonly InvoiceNote[] | null;
  error: string | null;
  onChanged: () => Promise<void>;
}) {
  const [issuing, setIssuing] = useState(false);
  const canIssue = ctx.can('billing.cancel');

  return (
    <Card
      title="Credit & debit notes"
      action={canIssue && (
        <button type="button" className={`${primaryButton} inline-flex items-center gap-1.5`} onClick={() => setIssuing(true)}>
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Issue note
        </button>
      )}
    >
      <p className="text-[11px] text-[var(--mv-muted)]">
        A note adjusts what a member owes on a tax invoice already issued. A credit beyond what is still unpaid is
        held as the member's advance.
      </p>
      {error !== null ? <Empty>{error}</Empty>
        : notes === null ? <Empty>Loading…</Empty>
        : notes.length === 0 ? <Empty>No notes issued yet.</Empty>
        : (
          <TableScroll label="Credit and debit notes">
            <thead>
              <tr className="border-b border-[var(--mv-border)]">
                <th scope="col" className={thClass}>Note</th>
                <th scope="col" className={thClass}>Kind</th>
                <th scope="col" className={thClass}>Invoice</th>
                <th scope="col" className={thClass}>Flat</th>
                <th scope="col" className={thClass}>Date</th>
                <th scope="col" className={`${thClass} text-right`}>Amount</th>
                <th scope="col" className={`${thClass} text-right`}>Tax</th>
                <th scope="col" className={thClass}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {notes.map(n => (
                <tr key={n.id} className="border-b border-[var(--mv-border)] last:border-0">
                  <td className={`${tdClass} font-bold`}>{n.noteNo}</td>
                  <td className={tdClass}>{n.kind === 'credit' ? 'Credit' : 'Debit'}</td>
                  <td className={tdClass}>{n.taxInvoiceNo ?? '—'}</td>
                  <td className={tdClass}>{n.flatNo}</td>
                  <td className={tdClass}>{n.issuedOn}</td>
                  <td className={numClass}>{formatRupees(n.amountPaise)}</td>
                  <td className={numClass}>{formatRupees(n.taxPaise)}</td>
                  <td className={`${tdClass} max-w-[16rem] truncate`} title={n.reason}>{n.reason}</td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      {issuing && (
        <IssueNoteDialog ctx={ctx} onClose={() => setIssuing(false)}
          onDone={async () => { setIssuing(false); await onChanged(); }} />
      )}
    </Card>
  );
}

function IssueNoteDialog({ ctx, onClose, onDone }: {
  ctx: OfficeContext; onClose: () => void; onDone: () => Promise<void>;
}) {
  // Read when the dialog opens rather than with the panel: only someone
  // issuing a note needs the society's whole list of tax invoices.
  const [invoices, setInvoices] = useState<readonly TaxInvoice[] | null>(null);
  const [documentId, setDocumentId] = useState('');
  const [kind, setKind] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [on, setOn] = useState(todayIso());
  const [withTax, setWithTax] = useState(false);

  useEffect(() => {
    let live = true;
    money.taxInvoices(ctx.client).then(
      list => {
        if (!live) return;
        setInvoices(list);
        setDocumentId(list[0]?.id ?? '');
      },
      err => { if (live) { setInvoices([]); ctx.toast(problemOf(err), 'error'); } },
    );
    return () => { live = false; };
  }, [ctx]);

  const invoice = invoices?.find(i => i.id === documentId);

  const submit = async () => {
    if (invoice === undefined) throw new FormProblem('Choose the tax invoice the note is against.');
    const amountPaise = parseRupees(amount);
    if (amountPaise === null || amountPaise <= 0) throw new FormProblem('Enter the amount in rupees, before tax.');
    if (reason.trim() === '') throw new FormProblem('A note needs a reason.');
    const result = await money.issueNote(ctx.client, invoice.id, {
      kind, amountPaise, reason: reason.trim(), on, withTax,
    });
    const advance = result.heldAsAdvancePaise > 0
      ? ` ${formatRupees(result.heldAsAdvancePaise)} held as the member's advance.` : '';
    ctx.toast(`${result.noteNo} issued for ${formatRupees(result.totalPaise)} on ${invoice.taxInvoiceNo}.${advance}`);
    await onDone();
  };

  return (
    <FormDialog id="issue-note" title="Issue credit or debit note" submitLabel="Issue note" onClose={onClose} onSubmit={submit} ctx={ctx}>
      {invoices === null ? <Empty>Loading tax invoices…</Empty>
        : invoices.length === 0 ? <Empty>There are no tax invoices to adjust. A note cannot be raised against a proforma.</Empty>
        : (
          <>
            <Field id="note-invoice" label="Tax invoice">
              <select id="note-invoice" data-autofocus className={inputClass} value={documentId} onChange={e => setDocumentId(e.target.value)}>
                {invoices.map(i => (
                  <option key={i.id} value={i.id}>
                    {i.taxInvoiceNo} · flat {i.flatNo} · {i.period} · {formatRupees(i.gross)}
                  </option>
                ))}
              </select>
            </Field>
            {invoice !== undefined && (
              <p className="text-[11px] text-[var(--mv-muted)]">
                Issued {invoice.issuedOn}; {formatRupees(invoice.outstanding)} still unpaid.
              </p>
            )}
            <fieldset>
              <legend className="text-[10px] text-[var(--mv-muted)] font-bold block mb-1 uppercase tracking-wider">Kind</legend>
              <div className="flex gap-4 text-xs text-[var(--mv-ink)] font-bold">
                <label htmlFor="note-kind-credit" className="inline-flex items-center gap-1.5">
                  <input id="note-kind-credit" type="radio" name="note-kind" checked={kind === 'credit'} onChange={() => setKind('credit')} />
                  Credit (reduces dues)
                </label>
                <label htmlFor="note-kind-debit" className="inline-flex items-center gap-1.5">
                  <input id="note-kind-debit" type="radio" name="note-kind" checked={kind === 'debit'} onChange={() => setKind('debit')} />
                  Debit (adds to dues)
                </label>
              </div>
            </fieldset>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field id="note-amount" label="Amount before tax (₹)">
                <input id="note-amount" inputMode="decimal" className={inputClass} value={amount} onChange={e => setAmount(e.target.value)} />
              </Field>
              <Field id="note-on" label="Note date">
                <input id="note-on" type="date" className={inputClass} value={on} onChange={e => setOn(e.target.value)} />
              </Field>
            </div>
            <Field id="note-reason" label="Reason">
              <textarea id="note-reason" rows={2} className={inputClass} value={reason} onChange={e => setReason(e.target.value)} maxLength={500} />
            </Field>
            <label htmlFor="note-tax" className="flex items-start gap-2 text-xs text-[var(--mv-ink)]">
              <input id="note-tax" type="checkbox" className="mt-0.5" checked={withTax} onChange={e => setWithTax(e.target.checked)} />
              <span>Carries GST, as when waiving a taxed charge. Refused while the GST treatment is unconfirmed.</span>
            </label>
          </>
        )}
    </FormDialog>
  );
}
