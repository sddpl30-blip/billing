import React from 'react';
import { Check, Clock, FileText, Send, AlertCircle, CheckCircle } from 'lucide-react';
import { formatRupees, type RegisterView } from '../accounting';

/**
 * The billing document workflow: draft, approved, released, tax invoice.
 *
 * Each stage says what it does and what it does not. Release in particular
 * records that nothing was sent, because no delivery channel is configured —
 * a screen reporting a dispatch that did not happen is worse than no screen.
 */

interface Props {
  documents: readonly RegisterView[];
  problems: readonly string[];
  today: string;
  onApproveAll: () => void;
  onReleaseApproved: () => void;
  onConvertDue: () => void;
  compact?: boolean;
}

const STATE_LABEL: Record<RegisterView['state'], string> = {
  draft: 'Awaiting approval',
  approved: 'Approved, not released',
  released: 'Released, awaiting conversion',
  'tax-invoice': 'Tax invoice issued',
  cancelled: 'Cancelled',
};

const STATE_STYLE: Record<RegisterView['state'], string> = {
  draft: 'bg-[#FFFBEB] text-[#92400E] border-[#FDE68A]',
  approved: 'bg-[var(--mv-accent-soft)] text-[#1D4ED8] border-[var(--mv-accent-border)]',
  released: 'bg-[#F5F3FF] text-[#6D28D9] border-[#DDD6FE]',
  'tax-invoice': 'bg-[#F0FDF4] text-[#166534] border-[#BBF7D0]',
  cancelled: 'bg-gray-100 text-gray-500 border-gray-200',
};

export const BillingWorkflow: React.FC<Props> = ({
  documents, problems, today, onApproveAll, onReleaseApproved, onConvertDue, compact,
}) => {
  const count = (state: RegisterView['state']) => documents.filter(d => d.state === state).length;
  const dueForConversion = documents.filter(
    d => (d.state === 'released' || d.state === 'approved') && d.dueOn <= today,
  ).length;

  const Stage: React.FC<{
    icon: React.ReactNode; title: string; detail: string; n: number;
    action?: { label: string; onClick: () => void; disabled: boolean };
  }> = ({ icon, title, detail, n, action }) => (
    <div className="p-3.5 bg-white border border-[var(--mv-border)] rounded-xl space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <span className="text-[var(--mv-accent)] shrink-0 mt-0.5">{icon}</span>
          <div className="min-w-0">
            <p className="font-bold text-[11px] text-[var(--mv-ink)] leading-tight">{title}</p>
            <p className="text-[10px] text-[#6B7280] leading-snug mt-0.5">{detail}</p>
          </div>
        </div>
        <span className="font-mono font-bold text-base text-[var(--mv-ink)] shrink-0">{n}</span>
      </div>
      {action && (
        <button
          onClick={action.onClick}
          disabled={action.disabled}
          className="w-full py-2 bg-[var(--mv-ink)] text-white rounded-lg text-[10px] font-bold uppercase tracking-wide transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {action.label}
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-3.5 text-left">
      <div className="border-b border-[var(--mv-border)] pb-2.5">
        <h4 className="font-extrabold text-sm text-[var(--mv-ink)] uppercase tracking-wide leading-tight">
          Billing workflow
        </h4>
        <p className="text-[10px] text-[#6B7280] mt-0.5 leading-snug">
          A proforma invoice posts nothing. The receivable and the GST arise when
          it becomes a tax invoice — on payment, or on its due date.
        </p>
      </div>

      <div className={`grid gap-3 ${compact ? 'grid-cols-1' : 'grid-cols-2'}`}>
        <Stage
          icon={<FileText className="w-4 h-4" />}
          title="Drafts awaiting approval"
          detail="Raised by the billing run. Nothing can be sent or posted until the treasurer approves."
          n={count('draft')}
          action={{
            label: 'Approve all drafts',
            onClick: onApproveAll,
            disabled: count('draft') === 0,
          }}
        />
        <Stage
          icon={<Send className="w-4 h-4" />}
          title="Approved, not released"
          detail="Releasing marks them dispatched. No email or messaging provider is configured, so nothing is actually sent."
          n={count('approved')}
          action={{
            label: 'Release for dispatch',
            onClick: onReleaseApproved,
            disabled: count('approved') === 0,
          }}
        />
        <Stage
          icon={<Clock className="w-4 h-4" />}
          title="Due for conversion"
          detail="Released proformas past their due date. Converting issues the tax invoice and posts it."
          n={dueForConversion}
          action={{
            label: 'Convert what has fallen due',
            onClick: onConvertDue,
            disabled: dueForConversion === 0,
          }}
        />
        <Stage
          icon={<Check className="w-4 h-4" />}
          title="Tax invoices issued"
          detail="On the books. Cancelling one posts a reversal rather than removing it."
          n={count('tax-invoice')}
        />
      </div>

      {documents.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[9px] font-bold text-[#6B7280] uppercase tracking-wider block">
            Register
          </span>
          <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1 hide-scrollbar">
            {documents.map(doc => (
              <div
                key={doc.proformaNo}
                className="p-2.5 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-lg space-y-1"
              >
                <div className="flex justify-between items-baseline gap-2">
                  <span className="font-mono text-[10px] font-bold text-[var(--mv-ink)] truncate">
                    {doc.taxInvoiceNo ?? doc.proformaNo}
                  </span>
                  <span className="font-mono text-[11px] font-bold text-[var(--mv-ink)] shrink-0">
                    {formatRupees(doc.gross)}
                  </span>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <span className="text-[9px] text-[#6B7280] font-medium truncate">
                    {doc.flatNo} · {doc.period} · due {doc.dueOn}
                  </span>
                  <span
                    className={`text-[8px] font-bold uppercase px-1.5 py-0.5 rounded border shrink-0 ${STATE_STYLE[doc.state]}`}
                  >
                    {STATE_LABEL[doc.state]}
                  </span>
                </div>
                {doc.state === 'tax-invoice' && (
                  <div className="flex justify-between text-[9px] font-mono text-[#6B7280]">
                    <span>Status: {doc.status}</span>
                    <span>
                      {doc.outstanding > 0
                        ? `${formatRupees(doc.outstanding)} outstanding`
                        : 'settled'}
                    </span>
                  </div>
                )}
                {doc.dispatch && doc.dispatch.length > 0 && !doc.dispatch[0].delivered && (
                  <p className="text-[9px] text-[#92400E] leading-snug flex items-start gap-1">
                    <AlertCircle className="w-2.5 h-2.5 shrink-0 mt-0.5" />
                    Released, not delivered — no dispatch channel is configured.
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {documents.length === 0 && (
        <p className="text-[10px] text-[#6B7280] p-3 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl leading-snug">
          No documents in the register yet. Run the billing for a period to raise proformas.
        </p>
      )}

      {problems.length > 0 && (
        <div className="space-y-1 p-3 bg-[#FFFBEB] border border-[#FDE68A] rounded-xl">
          <span className="text-[9px] font-bold text-[#92400E] uppercase tracking-wider block">
            Refused or skipped
          </span>
          {problems.slice(0, 6).map((p, i) => (
            <p key={i} className="text-[10px] text-[#92400E] leading-snug">· {p}</p>
          ))}
        </div>
      )}

      {problems.length === 0 && documents.length > 0 && (
        <p className="text-[10px] text-[#166534] flex items-center gap-1.5">
          <CheckCircle className="w-3 h-3" /> Nothing was refused in this session.
        </p>
      )}
    </div>
  );
};
