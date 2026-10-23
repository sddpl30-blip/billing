import React, { useState } from 'react';
import { X, FileText, Send, Download, CheckCircle, Clock } from 'lucide-react';
import { Invoice } from '../types';
import { formatRupee } from '../utils';
import { Dialog } from './Dialog';
import { downloadInvoice } from '../invoiceExport';

interface InvoiceDetailModalProps {
  invoice: Invoice | null;
  onClose: () => void;
  onSendReminder?: (invoice: Invoice) => void;
  onPayNow?: (invoice: Invoice) => void;
  role: 'Resident' | 'Manager' | 'Committee';
  /**
   * Fetches the document as a PDF from the server.
   *
   * Given, the export button downloads the real document — the same bytes as
   * the copy on file, rendered from the payload stored when it was issued.
   * Absent, there is no server and the button writes the text summary below,
   * which says it is a demonstration.
   */
  onDownloadPdf?: (invoice: Invoice) => Promise<Blob>;
  /** The association's own GSTIN, or how to say it has none. */
  gstinLabel?: string;
}

export const InvoiceDetailModal: React.FC<InvoiceDetailModalProps> = ({
  invoice,
  onClose,
  onSendReminder,
  onPayNow,
  role,
  onDownloadPdf,
  gstinLabel = 'not on record'
}) => {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  if (!invoice) return null;

  const cgst = invoice.gst / 2;
  const sgst = invoice.gst / 2;

  // Render status chip based on strictly blue, black, white rules
  const renderStatus = () => {
    switch (invoice.status) {
      case 'Paid':
        return (
          <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-[var(--mv-accent)] text-white flex items-center gap-1">
            <CheckCircle className="w-3.5 h-3.5" /> PAID
          </span>
        );
      case 'Pending':
        return (
          <span className="px-2.5 py-1 text-[11px] font-semibold rounded-full bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" /> UPCOMING
          </span>
        );
      case 'Overdue':
      default:
        return (
          <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-[var(--mv-ink)] text-white flex items-center gap-1 animate-pulse-subtle">
            <Clock className="w-3.5 h-3.5" /> OVERDUE
          </span>
        );
    }
  };

  const handleDownload = () => {
    // The real document from the server where there is one; the
    // demonstration's labelled summary where there is not.
    setDownloading(true);
    setDownloadError(null);
    downloadInvoice(invoice, onDownloadPdf)
      .catch((err: unknown) => {
        setDownloadError(err instanceof Error ? err.message : 'The document could not be fetched.');
      })
      .finally(() => setDownloading(false));
  };

  return (
    <Dialog
      labelledBy="invoice-modal-title"
      onClose={onClose}
      className="bg-white w-full max-w-[380px] rounded-3xl overflow-hidden shadow-2xl border border-[var(--mv-border)] animate-fade-in animate-scale-up flex flex-col max-h-[90vh] outline-none"
    >
        {/* Header */}
        <div className="p-4 flex items-center justify-between border-b border-[var(--mv-border)] bg-white">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-[var(--mv-accent)]" aria-hidden="true" />
            <h2 id="invoice-modal-title" className="font-bold text-xs text-[var(--mv-ink)] tracking-tight uppercase">Invoice {invoice.invoiceNo}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close invoice"
            className="p-1.5 hover:bg-gray-100 rounded-full transition-colors text-[#6B7280]"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Invoice Area */}
        <div className="p-5 overflow-y-auto flex-1 hide-scrollbar space-y-4">
          <div className="flex justify-between items-start text-left">
            <div>
              <p className="text-[10px] uppercase font-bold text-[#6B7280] tracking-wider">Society GSTIN: {gstinLabel}</p>
              <h4 className="font-bold text-[var(--mv-ink)] text-sm mt-0.5">Mani Vista RWA</h4>
              <p className="text-[10px] text-[#6B7280]">Mani Vista Residents Association</p>
            </div>
            {renderStatus()}
          </div>

          <hr className="border-[var(--mv-border)]" />

          {/* Metadata */}
          <div className="grid grid-cols-2 gap-3 text-xs text-left">
            <div>
              <p className="text-[10px] font-semibold text-[#6B7280] uppercase tracking-tight">Invoice No</p>
              <p className="font-bold text-[var(--mv-ink)] font-mono mt-0.5">{invoice.invoiceNo}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-[#6B7280] uppercase tracking-tight">Billing Cycle</p>
              <p className="font-bold text-[var(--mv-ink)] mt-0.5">{invoice.period}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-[#6B7280] uppercase tracking-tight">Flat Number</p>
              <p className="font-bold text-[var(--mv-ink)] mt-0.5">{invoice.flatNo}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-[#6B7280] uppercase tracking-tight">Resident Owner</p>
              <p className="font-bold text-[var(--mv-ink)] mt-0.5 truncate">{invoice.name}</p>
            </div>
          </div>

          <hr className="border-[var(--mv-border)]" />

          {/* Breakdown List */}
          <div className="space-y-2 text-left">
            <h5 className="text-[10px] font-bold text-[var(--mv-ink)] tracking-wider uppercase mb-1">Billing Head Allocations</h5>

            <div className="flex justify-between items-center text-xs py-1">
              <span className="text-[#6B7280] font-medium">1. Society Maintenance</span>
              <span className="font-bold text-[var(--mv-ink)] font-mono">{formatRupee(invoice.maintenance)}</span>
            </div>

            <div className="flex justify-between items-center text-xs py-1">
              <span className="text-[#6B7280] font-medium">2. Sinking Fund Contributions</span>
              <span className="font-bold text-[var(--mv-ink)] font-mono">{formatRupee(invoice.sinkingFund)}</span>
            </div>

            <div className="flex justify-between items-center text-xs py-1">
              <span className="text-[#6B7280] font-medium">3. Water Charges Allocation</span>
              <span className="font-bold text-[var(--mv-ink)] font-mono">{formatRupee(invoice.waterCharges)}</span>
            </div>

            <div className="flex justify-between items-center text-xs py-1">
              <span className="text-[#6B7280] font-medium">4. Car & Joint Parking Charges</span>
              <span className="font-bold text-[var(--mv-ink)] font-mono">{formatRupee(invoice.parkingCharges)}</span>
            </div>

            <div className="flex justify-between items-center text-xs py-1">
              <span className="text-[#6B7280] font-medium">5. Non-Occupancy Surcharges</span>
              <span className="font-bold text-[var(--mv-ink)] font-mono">{formatRupee(invoice.nonOccupancyCharges)}</span>
            </div>

            {(cgst > 0 || sgst > 0) && (
              <>
                <hr className="border-[var(--mv-border)] my-1" />
                <div className="flex justify-between items-center text-xs py-0.5 text-[#6B7280]">
                  <span>CGST</span>
                  <span className="font-mono font-medium">{formatRupee(cgst)}</span>
                </div>
                <div className="flex justify-between items-center text-xs py-0.5 text-[#6B7280]">
                  <span>SGST</span>
                  <span className="font-mono font-medium">{formatRupee(sgst)}</span>
                </div>
              </>
            )}

            {invoice.latePenalty > 0 && (
              <div className="flex justify-between items-center text-xs py-1 text-[var(--mv-ink)] font-semibold">
                <span>Overdue Accretion Penalty</span>
                <span className="font-mono text-[var(--mv-ink)] font-bold">{formatRupee(invoice.latePenalty)}</span>
              </div>
            )}
          </div>

          <hr className="border-t-2 border-[var(--mv-ink)] border-dashed" />

          {/* Total */}
          <div className="flex justify-between items-center bg-[var(--mv-accent-soft)] p-3 rounded-2xl border border-[var(--mv-accent-border)]">
            <span className="text-xs font-bold text-[var(--mv-accent)] uppercase tracking-wider">Net Amount Payable</span>
            <span className="text-base font-bold text-[var(--mv-accent)] font-mono">{formatRupee(invoice.total)}</span>
          </div>

          <div className="text-[10px] text-[#6B7280] bg-gray-50 p-2.5 rounded-lg border border-gray-100/50 flex flex-col gap-0.5 leading-snug text-left">
            <span>• Regular due date is fixed as: <strong>{invoice.dueDate}</strong></span>
            <span>• Standard RWA grace terms apply. Non-payment generates compounding overdue penalty.</span>
          </div>
        </div>

        {/* Actions bar */}
        <div className="p-4 border-t border-[var(--mv-border)] bg-[var(--mv-page)] grid grid-cols-2 gap-3">
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="py-2.5 px-3 bg-white border border-[var(--mv-border)] rounded-xl text-xs font-[var(--mv-ink)] font-bold hover:bg-gray-100 transition-all flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer shadow-xs disabled:opacity-60"
          >
            <Download className="w-3.5 h-3.5 text-[#6B7280]" />
            {downloading ? 'Fetching\u2026' : onDownloadPdf ? 'Download PDF' : 'Export summary'}
          </button>

          {invoice.status !== 'Paid' && role === 'Resident' && onPayNow && (
            <button
              onClick={() => {
                onPayNow(invoice);
              }}
              className="py-2.5 px-3 bg-[var(--mv-accent)] text-white rounded-xl text-xs font-bold hover:brightness-90 transition-all shadow active:scale-95 cursor-pointer flex items-center justify-center gap-1.5"
            >
              Pay Now
            </button>
          )}

          {invoice.status !== 'Paid' && role !== 'Resident' && onSendReminder && (
            <button
              onClick={() => onSendReminder(invoice)}
              className="py-2.5 px-3 bg-[var(--mv-ink)] hover:bg-black text-white rounded-xl text-xs font-bold hover:bg-gray-800 transition-all shadow active:scale-95 cursor-pointer flex items-center justify-center gap-1.5"
            >
              <Send className="w-3.5 h-3.5" /> Remind Owner
            </button>
          )}

          {invoice.status === 'Paid' && (
            <div className="col-span-2 text-center text-xs font-bold text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] py-2 rounded-xl flex items-center justify-center gap-1">
              <CheckCircle className="w-4 h-4" /> This Invoice is fully Reconciled
            </div>
          )}

          {downloadError !== null && (
            <div className="col-span-2 text-[11px] font-semibold text-red-700 bg-red-50 border border-red-100 py-2 px-2.5 rounded-xl text-left">
              {downloadError}
            </div>
          )}
        </div>
    </Dialog>
  );
};
