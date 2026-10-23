import React, { useState } from 'react';
import { X, CheckCircle, Download, Printer } from 'lucide-react';
import { Invoice } from '../types';
import { formatRupee } from '../utils';
import { Dialog } from './Dialog';
import { pdfFilename, saveBlob } from '../invoiceExport';

interface ReceiptModalProps {
  invoice: Invoice | null;
  isOpen: boolean;
  onClose: () => void;
  /** The association's own GSTIN, or how to say it has none. */
  gstinLabel?: string;
  /** Fetches the receipt as a PDF from the server, where there is one. */
  onDownloadPdf?: (invoice: Invoice) => Promise<Blob>;
  /** True for the browser-only demonstration, which the receipt then says. */
  demonstration?: boolean;
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({
  invoice,
  isOpen,
  onClose,
  gstinLabel = 'not on record',
  onDownloadPdf,
  demonstration = false,
}) => {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  if (!isOpen || !invoice) return null;

  // Only what is known. The old modal made up a receipt number, a payment
  // date and a "bank reconciled" transaction id when there was none.
  const receiptNo = invoice.transactionId ?? 'not on record';
  const paymentDate = invoice.paidDate ?? 'not on record';
  const paymentMethod = invoice.paymentMethod ?? 'not on record';

  const subtotal = invoice.maintenance + invoice.sinkingFund + invoice.waterCharges + invoice.parkingCharges + invoice.nonOccupancyCharges;

  const handleDownload = () => {
    // The server's receipt, where there is one.
    if (onDownloadPdf) {
      setDownloading(true);
      setDownloadError(null);
      void onDownloadPdf(invoice)
        .then(blob => saveBlob(blob, pdfFilename(receiptNo)))
        .catch((err: unknown) => {
          setDownloadError(err instanceof Error ? err.message : 'The receipt could not be fetched.');
        })
        .finally(() => setDownloading(false));
      return;
    }
    const textReceipt = `
============================================================
${demonstration ? '      DEMONSTRATION RECEIPT - RECORDED IN THIS BROWSER ONLY' : '                     PAYMENT RECEIPT'}
               MANI VISTA RESIDENTS ASSOCIATION
============================================================
RECEIPT NO   : ${receiptNo}
DATE         : ${paymentDate}
INVOICE REF  : ${invoice.invoiceNo}
FLAT NO      : ${invoice.flatNo}
RESIDENT MEM : ${invoice.name}
PAYMENT MODE : ${paymentMethod}
------------------------------------------------------------
PARTICULARS                                 AMOUNT (INR)
------------------------------------------------------------
A. Society General Maintenance              ${invoice.maintenance.toFixed(2)}
B. Sinking Fund                             ${invoice.sinkingFund.toFixed(2)}
C. Water Charges                            ${invoice.waterCharges.toFixed(2)}
D. Parking Charges                          ${invoice.parkingCharges.toFixed(2)}
E. Non-Occupancy Charges                    ${invoice.nonOccupancyCharges.toFixed(2)}
F. Late Payment Interest                    ${invoice.latePenalty.toFixed(2)}
------------------------------------------------------------
SUB-TOTAL                                   ${subtotal.toFixed(2)}
GST                                         ${invoice.gst.toFixed(2)}
------------------------------------------------------------
INVOICE TOTAL                               ${invoice.total.toFixed(2)}
============================================================
${demonstration ? 'No bank or payment gateway was contacted.' : ''}
`;
    saveBlob(
      new Blob([textReceipt], { type: 'text/plain;charset=utf-8' }),
      `Receipt_${receiptNo.replace(/[^A-Za-z0-9.-]/g, '-')}_${invoice.flatNo}.txt`,
    );
  };

  return (
    <Dialog
      labelledBy="receipt-modal-title"
      onClose={onClose}
      className="bg-white w-full max-w-[380px] rounded-3xl overflow-hidden shadow-2xl border border-[var(--mv-border)] animate-fade-in animate-scale-up flex flex-col max-h-[90vh] outline-none"
    >

        {/* Header */}
        <div className="p-4 flex items-center justify-between border-b border-[var(--mv-border)] bg-[var(--mv-accent-soft)]">
          <div className="flex items-center gap-1.5 text-[var(--mv-accent)]">
            <CheckCircle className="w-5 h-5" aria-hidden="true" />
            <h2 id="receipt-modal-title" className="font-bold text-xs uppercase tracking-tight text-[var(--mv-accent)]">
              {demonstration ? 'Receipt (demonstration)' : 'Receipt'}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close receipt"
            className="p-1 hover:bg-black/5 rounded-full transition-colors text-[#6B7280]"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Content printable */}
        <div className="p-5 overflow-y-auto flex-1 bg-white space-y-4 text-xs text-left">

          {/* Logo Brand */}
          <div className="text-center pb-2 border-b border-[var(--mv-border)]">
            <span className="flex items-center gap-2"><img src="/branding/mani-vista-logo.png" alt="Mani Vista" className="w-12 h-12 object-contain"/><span className="font-bold text-base text-[var(--mv-ink)] tracking-tight block">MANI VISTA</span></span>
            <span className="text-[9px] text-[#6B7280] font-bold tracking-wide block uppercase">Residents Association</span>
            <span className="text-[9px] text-[#6B7280] font-mono block">GSTIN: {gstinLabel}</span>
          </div>

          {/* Receipt Info Box */}
          <div className="bg-[var(--mv-page)] p-3 rounded-xl border border-[var(--mv-border)] space-y-2 font-mono text-[11px]">
            <div className="flex justify-between">
              <span className="text-[#6B7280]">RECEIPT NO</span>
              <span className="font-bold text-[var(--mv-ink)]">{receiptNo}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#6B7280]">PAYMENT DATE</span>
              <span className="font-bold text-[var(--mv-ink)]">{paymentDate}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#6B7280]">PAYMENT MODE</span>
              <span className="font-bold text-[var(--mv-accent)]">{paymentMethod}</span>
            </div>
            <div className="flex justify-between truncate">
              <span className="text-[#6B7280]">INVOICE</span>
              <span className="font-bold text-[var(--mv-ink)]">{invoice.invoiceNo}</span>
            </div>
          </div>

          {/* Demographics */}
          <div className="grid grid-cols-2 gap-3 pb-3 border-b border-[var(--mv-border)] text-[11px]">
            <div>
              <span className="text-[#6B7280] font-bold block uppercase text-[9px]">Received From</span>
              <span className="font-bold text-[var(--mv-ink)]">{invoice.name}</span>
            </div>
            <div>
              <span className="text-[#6B7280] font-bold block uppercase text-[9px]">Flat Unit</span>
              <span className="font-bold text-[var(--mv-ink)]">{invoice.flatNo}</span>
            </div>
          </div>

          {/* Ledger Table */}
          <div className="space-y-1.5 text-[11px]">
            <div className="flex justify-between text-[#6B7280] uppercase font-bold text-[9px]">
              <span>Cleared Head Particulars</span>
              <span>Amount Paid</span>
            </div>

            <div className="flex justify-between text-[var(--mv-ink)] py-0.5">
              <span>General Maintenance Charge</span>
              <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(invoice.maintenance)}</span>
            </div>

            <div className="flex justify-between text-[var(--mv-ink)] py-0.5">
              <span>Sinking Surcharge Contribution</span>
              <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(invoice.sinkingFund)}</span>
            </div>

            <div className="flex justify-between text-[var(--mv-ink)] py-0.5">
              <span>Water Utility Allocation</span>
              <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(invoice.waterCharges)}</span>
            </div>

            {invoice.parkingCharges > 0 && (
              <div className="flex justify-between text-[var(--mv-ink)] py-0.5">
                <span>Joint Parking Surcharges</span>
                <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(invoice.parkingCharges)}</span>
              </div>
            )}

            {invoice.latePenalty > 0 && (
              <div className="flex justify-between text-[var(--mv-ink)] py-0.5 font-bold">
                <span>Indemnity Overdue Fees</span>
                <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(invoice.latePenalty)}</span>
              </div>
            )}

            {invoice.gst > 0 && (
              <div className="flex justify-between text-[#6B7280] py-0.5 text-[10px]">
                <span>GST (CGST + SGST)</span>
                <span className="font-mono text-[#6B7280]">{formatRupee(invoice.gst)}</span>
              </div>
            )}
          </div>

          <div className="border-t border-[var(--mv-ink)] border-dashed pt-3 flex justify-between items-center">
            <span className="font-bold text-[var(--mv-ink)] uppercase text-[10px]">Gross Cleared Book Sum</span>
            <span className="text-sm font-bold text-[var(--mv-accent)] font-mono">{formatRupee(invoice.total)}</span>
          </div>

          {/* Signature stamp representation */}
          <div className="pt-4 flex flex-col items-end">
            <div className="border border-[var(--mv-accent)]/45 bg-[var(--mv-accent-soft)] px-2.5 py-1 text-center rounded-lg rotate-[-2deg] mr-2">
              <span className="text-[9px] text-[var(--mv-accent)]/70 font-mono font-bold block leading-none">MANI VISTA RWA</span>
              <span className="text-[10px] text-[var(--mv-accent)] font-bold block leading-tight font-sans">{demonstration ? 'DEMONSTRATION' : 'RECEIPT'}</span>
              <span className="text-[8px] text-[#6B7280] font-mono block leading-none">{demonstration ? 'No bank contacted' : 'Issued by the books'}</span>
            </div>
            <span className="text-[9px] text-[#6B7280] font-bold uppercase mr-2 mt-2">Treasurer Audit Signatory</span>
          </div>

        </div>

        {/* Actions bar for receipt */}
        <div className="p-4 border-t border-[var(--mv-border)] bg-[var(--mv-page)] flex gap-3">
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="flex-1 py-2.5 px-3 bg-[var(--mv-ink)] text-white rounded-xl text-xs font-bold hover:bg-black transition-all shadow-xs flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer disabled:opacity-60"
          >
            <Download className="w-4 h-4" aria-hidden="true" /> {downloading ? 'Fetching…' : onDownloadPdf ? 'Download PDF' : 'Download summary'}
          </button>
          <button
            onClick={() => window.print()}
            className="py-2.5 px-3 bg-white border border-[var(--mv-border)] text-[var(--mv-ink)] rounded-xl text-xs font-bold hover:bg-gray-50 transition-all flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer shadow-xs"
          >
            <Printer className="w-4 h-4 text-[#6B7280]" aria-hidden="true" /> Print
          </button>
        </div>
        {downloadError !== null && (
          <p role="alert" className="mx-4 mb-4 text-[11px] font-semibold text-red-700 bg-red-50 border border-red-100 py-2 px-2.5 rounded-xl">
            {downloadError}
          </p>
        )}

    </Dialog>
  );
};
