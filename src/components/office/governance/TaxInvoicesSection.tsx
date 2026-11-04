import { useState } from 'react';
import { formatRupees } from '../../../accounting/money';
import {
  approveTaxInvoices, listTaxInvoiceQueue, resendTaxInvoice, type TaxInvoiceRequest,
} from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import { Badge, Button, Card, LoadState, useLoad, useWrite } from './ui';

const EMAIL_TAG: Record<string, { label: string; tone: 'ok' | 'warn' | 'muted'; red?: boolean }> = {
  sent: { label: 'E-mailed', tone: 'ok' },
  failed: { label: 'E-mail failed', tone: 'warn', red: true },
  blocked: { label: 'E-mail blocked', tone: 'warn', red: true },
  'in-app': { label: 'In-app only', tone: 'muted' },
  none: { label: 'Not sent yet', tone: 'muted' },
};

/**
 * Tax invoices waiting for the treasurer. In "approval" mode (Settings) a
 * payment leaves the proforma here instead of issuing the invoice. Approving
 * (one or many) numbers and posts the tax invoice, builds its PDF and e-mails
 * it to every address the owner has. What the mail service answered stays on
 * each issued invoice: a failed or blocked send shows red, with Resend.
 */
export function TaxInvoicesSection({ ctx }: { ctx: OfficeContext }) {
  const queue = useLoad(() => listTaxInvoiceQueue(ctx.client), [ctx]);
  const { busy, run } = useWrite(ctx, queue.refresh);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const mayApprove = ctx.can('billing.convert');
  const mayResend = ctx.can('billing.release') || mayApprove;
  const pending = queue.data?.pending ?? [];
  const recent = queue.data?.recent ?? [];

  const toggle = (id: string): void => setChosen(c => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allChosen = pending.length > 0 && pending.every(p => chosen.has(p.id));

  const approve = (ids: string[]): void => {
    if (ids.length === 0) return;
    void run('approve', async () => {
      const r = await approveTaxInvoices(ctx.client, ids);
      setChosen(new Set());
      return r;
    }, result => {
      const r = result as { approved: number; failed: number; results: Array<{ ok: boolean; error?: string; email?: string }> };
      const bad = r.results.filter(x => x.ok && (x.email === 'failed' || x.email === 'blocked')).length;
      const refused = r.results.find(x => !x.ok);
      return `${r.approved} tax invoice${r.approved === 1 ? '' : 's'} issued` +
        (bad > 0 ? `; ${bad} e-mail${bad === 1 ? '' : 's'} failed or blocked (marked red below)` : '') +
        (r.failed > 0 ? `; ${r.failed} not approved: ${refused?.error ?? 'refused'}` : '.');
    });
  };

  const download = async (documentId: string): Promise<void> => {
    try {
      const blob = await ctx.client.pdf(`/api/billing/documents/${encodeURIComponent(documentId)}/pdf`);
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (err) {
      ctx.toast(err instanceof Error ? err.message : 'The PDF could not be opened.', 'error');
    }
  };

  const money = (paise: number): string => formatRupees(paise, { paise: true });

  const row = (r: TaxInvoiceRequest, issued: boolean) => {
    const tag = issued ? EMAIL_TAG[r.email?.state ?? 'none'] : null;
    return (
      <li key={r.id} className="py-2 flex flex-col sm:flex-row sm:items-center gap-2 text-sm">
        {!issued && mayApprove && (
          <input type="checkbox" className="w-4 h-4 accent-[var(--mv-accent)]" checked={chosen.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.proformaNo}`} />
        )}
        <div className="flex-1 min-w-0 break-words">
          <p>
            <strong>{r.flatNo}</strong> · {issued ? <span className="font-mono">{r.taxInvoiceNo}</span> : r.proformaNo} · {r.period}
            {' '}· bill {money(r.grossPaise)}
          </p>
          <p className="text-[11px] text-[var(--mv-muted)]">
            Paid {money(r.paidPaise)}{r.paidPaise < r.grossPaise ? ' (part payment)' : ''} on {r.paidOn} · receipt {r.receiptNos}
            {!issued && r.requestedBy !== null ? ` · recorded by ${r.requestedBy}` : ''}
          </p>
          {issued && r.email?.note != null && (
            <p className={`text-[11px] break-words ${tag?.red === true ? 'text-red-700' : 'text-[var(--mv-muted)]'}`}>{r.email.note}</p>
          )}
        </div>
        {tag !== null && (
          <span className={tag.red === true ? 'rounded-full ring-2 ring-red-500' : ''}>
            <Badge tone={tag.tone}>{tag.label}</Badge>
          </span>
        )}
        {issued && (
          <div className="flex flex-wrap gap-1">
            {mayResend && (
              <Button disabled={busy !== null} onClick={() => void run(`resend:${r.id}`, () => resendTaxInvoice(ctx.client, r.documentId), x => (x as { note: string }).note)}
                aria-label={`Resend ${r.taxInvoiceNo ?? 'tax invoice'}`}>Resend</Button>
            )}
            <Button onClick={() => void download(r.documentId)} aria-label={`Download PDF of ${r.taxInvoiceNo ?? 'tax invoice'}`}>Print / Download PDF</Button>
          </div>
        )}
      </li>
    );
  };

  return (
    <Card
      title="Tax invoices"
      actions={mayApprove && pending.length > 0 ? (
        <>
          <Button onClick={() => setChosen(allChosen ? new Set() : new Set(pending.map(p => p.id)))}>{allChosen ? 'Clear selection' : 'Select all'}</Button>
          <Button tone="primary" disabled={busy !== null || chosen.size === 0} onClick={() => approve([...chosen])}>
            {busy === 'approve' ? 'Approving…' : `Approve all selected (${chosen.size})`}
          </Button>
        </>
      ) : undefined}
    >
      <p className="text-xs text-[var(--mv-muted)] leading-relaxed">
        A payment (UPI, cash, bank) waits here until the treasurer approves it. Approving issues the next tax invoice
        number, posts it, and e-mails the PDF to every address the owner has. Whoever recorded the payment cannot approve
        it. Nothing already issued or posted is changed; a wrong invoice is corrected by a credit note.
      </p>
      <LoadState loaded={queue} empty="" isEmpty={false} />
      {queue.data?.available === false && (
        <p role="alert" className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-xl p-2">
          This needs database migration 017. Run docs/neon/017-apply.sql in Neon (societybooks) once.
        </p>
      )}
      {queue.data?.available === true && queue.data.mode === 'immediate' && (
        <p className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-xl p-2">
          Payments currently issue the tax invoice at once, with no approval and no e-mail. To use this queue, set
          "Tax invoice on payment" to <strong>approval</strong> in Settings &amp; GST.
        </p>
      )}
      {queue.data?.available === true && (
        <>
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)]">Pending approval ({pending.length})</h4>
          {pending.length === 0
            ? <p className="text-xs text-[var(--mv-muted)]">Nothing is waiting.</p>
            : <ul className="divide-y divide-[var(--mv-border)]">{pending.map(r => row(r, false))}</ul>}
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)]">Issued through this queue</h4>
          {recent.length === 0
            ? <p className="text-xs text-[var(--mv-muted)]">None yet.</p>
            : <ul className="divide-y divide-[var(--mv-border)]">{recent.map(r => row(r, true))}</ul>}
        </>
      )}
    </Card>
  );
}
