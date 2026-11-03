import { useState } from 'react';
import { formatRupees } from '../../../accounting/money';
import { listReceipts } from '../../../api/office/bank';
import {
  decideReceiptRequest, listFlats, listReceiptRequests, requestReceipt,
  type ReceiptRequest,
} from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import { Badge, Button, Card, FormDialog, LoadState, inputClass, labelClass, todayInIndia, useLoad, useWrite } from './ui';

const METHODS = ['upi', 'neft', 'imps', 'cheque', 'cash', 'nach', 'card'] as const;

const rupeesToPaise = (text: string): number | null => {
  if (!/^\d+(\.\d{1,2})?$/.test(text.trim())) return null;
  const paise = Math.round(Number(text) * 100);
  return paise > 0 ? paise : null;
};

/**
 * Receipts and advances, kept honest. A receipt (or an advance, which is a
 * receipt on a flat with nothing due) is added or reversed only by a request
 * with a reason that one person prepares and the treasurer decides. A
 * reversal posts a mirror entry; the receipt, the request and the decision all
 * stay on record. Every balance, resident screen, dashboard figure and PDF
 * reads the ledger, so they follow without anything being typed.
 */
export function ReceiptsSection({ ctx }: { ctx: OfficeContext }) {
  const requests = useLoad(() => listReceiptRequests(ctx.client), [ctx]);
  const receipts = useLoad(() => listReceipts(ctx.client, 100), [ctx]);
  const flats = useLoad(() => listFlats(ctx.client), [ctx]);
  const { busy, run } = useWrite(ctx, async () => { await Promise.all([requests.refresh(), receipts.refresh()]); });
  const mayPrepare = ctx.can('payment.request');
  const mayDecide = ctx.can('payment.reverse');

  const [adding, setAdding] = useState(false);
  const [reversing, setReversing] = useState<{ id: string; receiptNo: string; flatNo: string; amountPaise: number } | null>(null);
  const [deciding, setDeciding] = useState<{ request: ReceiptRequest; decision: 'approved' | 'rejected' } | null>(null);
  const [filter, setFilter] = useState('');

  const all = requests.data?.requests ?? [];
  const open = all.filter(r => r.decision === null);
  const decided = all.filter(r => r.decision !== null).slice(0, 15);
  const shown = (receipts.data ?? []).filter(r => filter.trim() === '' || r.flatNo.toLowerCase().includes(filter.trim().toLowerCase()) || r.receiptNo.toLowerCase().includes(filter.trim().toLowerCase()));
  const describe = (r: ReceiptRequest): string => r.kind === 'add'
    ? `Add ${formatRupees(r.amountPaise ?? 0, { paise: true })} to flat ${r.flatNo ?? ''} · ${r.method ?? ''} · received ${r.receivedOn ?? ''}${r.instrumentRef === null ? '' : ` · ${r.instrumentRef}`}`
    : `Reverse ${r.receiptNo ?? 'receipt'} (${formatRupees(r.amountPaise ?? 0, { paise: true })}, flat ${r.flatNo ?? ''}) on ${r.effectiveOn ?? ''}`;

  return (
    <Card
      title="Receipts & advances"
      actions={mayPrepare && requests.data?.available === true
        ? <Button tone="primary" onClick={() => setAdding(true)}>Add receipt / advance</Button>
        : undefined}
    >
      <p className="text-xs text-[var(--mv-muted)] leading-relaxed">
        One person prepares, with a reason; the treasurer approves. Nothing is posted until then. A reversal is a
        mirror entry, never a deletion, and the history stays. Previous outstanding, resident screens, the dashboard
        and PDFs recalculate from the ledger.
      </p>
      <LoadState loaded={requests} empty="" isEmpty={false} />
      {requests.data?.available === false && (
        <p role="alert" className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-xl p-2">
          This needs database migration 014. Run docs/neon/014-apply.sql in Neon (societybooks) once.
        </p>
      )}

      {open.length > 0 && (
        <div className="space-y-2">
          <h4 className={labelClass}>Waiting for a decision</h4>
          <ul className="divide-y divide-[var(--mv-border)]">
            {open.map(r => (
              <li key={r.id} className="py-2 flex flex-col sm:flex-row sm:items-center gap-2">
                <div className="flex-1 min-w-0 text-sm">
                  <p className="font-semibold text-[var(--mv-ink)] break-words">{describe(r)}</p>
                  <p className="text-[11px] text-[var(--mv-muted)] break-words">Reason: {r.reason} · prepared by {r.requestedBy} · {r.requestedAt.slice(0, 16).replace('T', ' ')}</p>
                </div>
                {mayDecide && (
                  <div className="flex gap-2">
                    <Button tone="primary" onClick={() => setDeciding({ request: r, decision: 'approved' })} aria-label={`Approve: ${describe(r)}`}>Approve</Button>
                    <Button onClick={() => setDeciding({ request: r, decision: 'rejected' })} aria-label={`Reject: ${describe(r)}`}>Reject</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className={labelClass}>Recent receipts</h4>
          <input className={`${inputClass} max-w-[12rem]`} placeholder="Find flat or receipt no." value={filter}
            onChange={e => setFilter(e.target.value)} aria-label="Find a receipt" />
        </div>
        <LoadState loaded={receipts} empty="No receipts yet." isEmpty={(receipts.data ?? []).length === 0} />
        <ul className="divide-y divide-[var(--mv-border)]">
          {shown.slice(0, 50).map(r => (
            <li key={r.id} className="py-2 flex flex-col sm:flex-row sm:items-center gap-2 text-sm">
              <span className="flex-1 min-w-0 break-words">
                <strong>{r.receiptNo}</strong> · flat {r.flatNo} · {formatRupees(r.amountPaise, { paise: true })} · {r.method} · {r.receivedOn}
                {r.instrumentRef !== null && <span className="text-[var(--mv-muted)]"> · {r.instrumentRef}</span>}
              </span>
              {mayPrepare && requests.data?.available === true && (
                <Button onClick={() => setReversing({ id: r.id, receiptNo: r.receiptNo, flatNo: r.flatNo, amountPaise: r.amountPaise })}
                  aria-label={`Reverse receipt ${r.receiptNo}`}>Reverse…</Button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {decided.length > 0 && (
        <div className="space-y-2">
          <h4 className={labelClass}>Decided</h4>
          <ul className="divide-y divide-[var(--mv-border)]">
            {decided.map(r => (
              <li key={r.id} className="py-2 text-sm space-y-0.5">
                <p className="break-words">
                  {describe(r)} <Badge tone={r.decision === 'approved' ? 'ok' : 'muted'}>{r.decision}</Badge>
                  {r.resultReceiptNo !== null && <span className="text-[var(--mv-muted)]"> → {r.resultReceiptNo}</span>}
                </p>
                <p className="text-[11px] text-[var(--mv-muted)] break-words">
                  Reason: {r.reason} · prepared by {r.requestedBy} · decided by {r.decidedBy}
                  {r.decisionNote !== null ? ` · ${r.decisionNote}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {adding && (
        <AddDialog
          flats={(flats.data ?? []).map(f => ({ id: f.id, flatNo: f.flatNo }))}
          busy={busy === 'add'}
          onClose={() => setAdding(false)}
          onSubmit={async input => {
            const done = await run('add', () => requestReceipt(ctx.client, input), r => (r as { note: string }).note);
            if (done) setAdding(false);
          }}
        />
      )}
      {reversing !== null && (
        <ReasonDialog
          title={`Reverse receipt ${reversing.receiptNo}`}
          intro={`${formatRupees(reversing.amountPaise, { paise: true })} on flat ${reversing.flatNo}. The treasurer must approve; the receipt stays on record and a mirror entry is posted.`}
          dateLabel="Reversal date" submitLabel="Prepare reversal" busy={busy === 'reverse'}
          onClose={() => setReversing(null)}
          onSubmit={async (on, reason) => {
            const done = await run('reverse', () => requestReceipt(ctx.client, { kind: 'reverse', paymentId: reversing.id, effectiveOn: on, reason }), r => (r as { note: string }).note);
            if (done) setReversing(null);
          }}
        />
      )}
      {deciding !== null && (
        <DecideDialog
          request={deciding.request} decision={deciding.decision} text={describe(deciding.request)}
          busy={busy === 'decide'}
          onClose={() => setDeciding(null)}
          onSubmit={async note => {
            const done = await run('decide', () => decideReceiptRequest(ctx.client, deciding.request.id, deciding.decision, note), r => (r as { note: string }).note);
            if (done) setDeciding(null);
          }}
        />
      )}
    </Card>
  );
}

function AddDialog({ flats, busy, onClose, onSubmit }: {
  flats: ReadonlyArray<{ id: string; flatNo: string }>;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { kind: 'add'; flatId: string; amountPaise: number; receivedOn: string; method: string; instrumentRef?: string; reason: string }) => void;
}) {
  const [flatId, setFlatId] = useState('');
  const [amount, setAmount] = useState('');
  const [on, setOn] = useState(todayInIndia());
  const [method, setMethod] = useState('neft');
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (): void => {
    const paise = rupeesToPaise(amount);
    if (flatId === '') return setProblem('Choose the flat.');
    if (paise === null) return setProblem('Enter the amount in rupees, such as 5000 or 5000.50.');
    if (reason.trim().length < 3) return setProblem('Give the reason, in a few words.');
    setProblem(null);
    onSubmit({ kind: 'add', flatId, amountPaise: paise, receivedOn: on, method, ...(ref.trim() === '' ? {} : { instrumentRef: ref.trim() }), reason: reason.trim() });
  };
  return (
    <FormDialog id="gov-add-receipt" title="Add a receipt or advance" submitLabel="Prepare for approval" busy={busy}
      intro="Money already received. If the flat has nothing due, it is held as an advance and applied to its next bill. The treasurer approves before anything is posted."
      onClose={onClose} onSubmit={submit}>
      <div>
        <label htmlFor="rc-flat" className={labelClass}>Flat</label>
        <select id="rc-flat" data-autofocus className={inputClass} value={flatId} onChange={e => setFlatId(e.target.value)}>
          <option value="">Choose…</option>
          {flats.map(f => <option key={f.id} value={f.id}>{f.flatNo}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="rc-amount" className={labelClass}>Amount (₹)</label>
          <input id="rc-amount" className={inputClass} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
        </div>
        <div>
          <label htmlFor="rc-on" className={labelClass}>Received on</label>
          <input id="rc-on" type="date" className={inputClass} value={on} onChange={e => setOn(e.target.value)} />
        </div>
        <div>
          <label htmlFor="rc-method" className={labelClass}>Method</label>
          <select id="rc-method" className={inputClass} value={method} onChange={e => setMethod(e.target.value)}>
            {METHODS.map(m => <option key={m} value={m}>{m.toUpperCase()}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="rc-ref" className={labelClass}>UTR / cheque no.</label>
          <input id="rc-ref" className={inputClass} maxLength={100} value={ref} onChange={e => setRef(e.target.value)} />
        </div>
      </div>
      <div>
        <label htmlFor="rc-reason" className={labelClass}>Reason (required)</label>
        <textarea id="rc-reason" className={inputClass} rows={2} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}

function ReasonDialog({ title, intro, dateLabel, submitLabel, busy, onClose, onSubmit }: {
  title: string; intro: string; dateLabel: string; submitLabel: string; busy: boolean;
  onClose: () => void; onSubmit: (on: string, reason: string) => void;
}) {
  const [on, setOn] = useState(todayInIndia());
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <FormDialog id="gov-reverse-receipt" title={title} intro={intro} submitLabel={submitLabel} busy={busy} onClose={onClose}
      onSubmit={() => {
        if (reason.trim().length < 3) return setProblem('Give the reason, in a few words.');
        setProblem(null);
        onSubmit(on, reason.trim());
      }}>
      <div>
        <label htmlFor="rv-on" className={labelClass}>{dateLabel}</label>
        <input id="rv-on" type="date" data-autofocus className={inputClass} value={on} onChange={e => setOn(e.target.value)} />
      </div>
      <div>
        <label htmlFor="rv-reason" className={labelClass}>Reason (required)</label>
        <textarea id="rv-reason" className={inputClass} rows={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}

function DecideDialog({ request, decision, text, busy, onClose, onSubmit }: {
  request: ReceiptRequest; decision: 'approved' | 'rejected'; text: string; busy: boolean;
  onClose: () => void; onSubmit: (note: string | undefined) => void;
}) {
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <FormDialog id="gov-decide-receipt" title={decision === 'approved' ? 'Approve and post' : 'Reject'} busy={busy}
      submitLabel={decision === 'approved' ? 'Approve' : 'Reject'}
      intro={`${text}. Reason given: ${request.reason}. Prepared by ${request.requestedBy}.`}
      onClose={onClose}
      onSubmit={() => {
        if (decision === 'rejected' && note.trim().length < 3) return setProblem('Say why it is rejected.');
        setProblem(null);
        onSubmit(note.trim() === '' ? undefined : note.trim());
      }}>
      <div>
        <label htmlFor="dc-note" className={labelClass}>{decision === 'rejected' ? 'Why (required)' : 'Note (optional)'}</label>
        <textarea id="dc-note" data-autofocus className={inputClass} rows={2} maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}
