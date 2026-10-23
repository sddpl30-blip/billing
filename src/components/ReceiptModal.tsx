import React from 'react';
import { X, CheckCircle, Download, Printer } from 'lucide-react';
import { Invoice } from '../types';
import { formatRupee } from '../utils';

interface ReceiptModalProps {
  invoice: Invoice | null;
  isOpen: boolean;
  onClose: () => void;
  /** The association's own GSTIN, or how to say it has none. */
  gstinLabel?: string;
  /** Fetches the receipt as a PDF from the server, where there is one. */
  onDownloadPdf?: (invoice: Invoice) => Promise<Blob>;
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({
  invoice,
  isOpen,
  onClose,
  gstinLabel = 'not on record',
  onDownloadPdf
}) => {
  if (!isOpen || !invoice) return null;

  // Derive mock receipt details
  const receiptNo = `RCP-${invoice.id.toUpperCase().split('-').pop() || 'A992'}`;
  const paymentDate = invoice.paidDate || '20 Jun 2026';
  const paymentMethod = invoice.paymentMethod || 'UPI Intent';
  const transactionId = invoice.transactionId || `TXN${Math.floor(Math.random() * 90000000) + 10000000}`;

  const subtotal = invoice.maintenance + invoice.sinkingFund + invoice.waterCharges + invoice.parkingCharges + invoice.nonOccupancyCharges;

  const handleDownload = () => {
    // Generate downloadable file
    const textReceipt = `
============================================================
              OFFICIAL PAYMENT RECEIPT & ACKNOWLEDGEMENT
               MANI VISTA RESIDENTS ASSOCIATION
============================================================
RECEIPT NO   : ${receiptNo}
DATE         : ${paymentDate}
INVOICE REF  : ${invoice.invoiceNo}
FLAT NO      : ${invoice.flatNo}
RESIDENT MEM : ${invoice.name}
------------------------------------------------------------
TRANSACTION DETAILS:
------------------------------------------------------------
PAYMENT MODE : ${paymentMethod}
TXN STATUS   : SUCCESS / BANK RECONCILED
REF TRANS ID : ${transactionId}
------------------------------------------------------------
PARTICULARS OF CLEARANCE                    AMOUNT (INR)
------------------------------------------------------------
A. Society General Maintenance              ${invoice.maintenance.toFixed(2)}
B. Sinking & Repair Fund                    ${invoice.sinkingFund.toFixed(2)}
C. Water Surcharge Allocations              ${invoice.waterCharges.toFixed(2)}
D. Car Parking Surcharges                   ${invoice.parkingCharges.toFixed(2)}
E. Non-Occupancy Fees                      ${invoice.nonOccupancyCharges.toFixed(2)}
F. Late Payment Indemnity Int               ${invoice.latePenalty.toFixed(2)}
------------------------------------------------------------
SUB-TOTAL CLEANED                           ${subtotal.toFixed(2)}
GST APPLICABLE CHARGES                      ${invoice.gst.toFixed(2)}
------------------------------------------------------------
NET AMOUNT RECEIVED IN BANK:                ${invoice.total.toFixed(2)}
============================================================
      This is an auto-generated, system authenticated
      receipt representing immediate clearing from bank.
      
      Authorized Seal & Signatory,
      Board Treasurer, Mani Vista RWA
============================================================
`;
    const blob = new Blob([textReceipt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Receipt_${receiptNo}_${invoice.flatNo}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div className="bg-white w-full max-w-[380px] rounded-3xl overflow-hidden shadow-2xl border border-[var(--mv-border)] animate-fade-in animate-scale-up flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="p-4 flex items-center justify-between border-b border-[var(--mv-border)] bg-[var(--mv-accent-soft)]">
          <div className="flex items-center gap-1.5 text-[var(--mv-accent)]">
            <CheckCircle className="w-5 h-5" />
            <span className="font-bold text-xs uppercase tracking-tight text-[var(--mv-accent)]">Receipt Dispatched</span>
          </div>
          <button 
            onClick={onClose}
            className="p-1 hover:bg-black/5 rounded-full transition-colors text-[#6B7280]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content printable */}
        <div className="p-5 overflow-y-auto flex-1 bg-white space-y-4 text-xs text-left">
          
          {/* Logo Brand */}
          <div className="text-center pb-2 border-b border-[var(--mv-border)]">
            <span className="flex items-center gap-2"><img src="/branding/mani-vista-logo.png" alt="Mani Vista" className="w-12 h-12 object-contain"/><span className="font-bold text-base text-[var(--mv-ink)] tracking-tight block">MANI VISTA</span></span>
            <span className="text-[9px] text-[#6B7280] font-bold tracking-wide block uppercase">Co-op Housing Society Ltd • Pune</span>
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
              <span className="text-[#6B7280]">REF TRANS ID</span>
              <span className="font-bold text-[var(--mv-ink)]">{transactionId}</span>
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
                <span>18% GST (CGST 9% + SGST 9%)</span>
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
              <span className="text-[10px] text-[var(--mv-accent)] font-bold block leading-tight font-sans">FULLY RECONCILED</span>
              <span className="text-[8px] text-[#6B7280] font-mono block leading-none">Online Core Clearing</span>
            </div>
            <span className="text-[9px] text-[#6B7280] font-bold uppercase mr-2 mt-2">Treasurer Audit Signatory</span>
          </div>

        </div>

        {/* Actions bar for receipt */}
        <div className="p-4 border-t border-[var(--mv-border)] bg-[var(--mv-page)] flex gap-3">
          <button
            onClick={handleDownload}
            className="flex-1 py-2.5 px-3 bg-[var(--mv-ink)] text-white rounded-xl text-xs font-bold hover:bg-black transition-all shadow-xs flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer"
          >
            <Download className="w-4 h-4" /> Download PDF Receipt
          </button>
          <button
            onClick={() => window.print()}
            className="py-2.5 px-3 bg-white border border-[var(--mv-border)] text-[var(--mv-ink)] rounded-xl text-xs font-bold hover:bg-gray-50 transition-all flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer shadow-xs"
          >
            <Printer className="w-4 h-4 text-[#6B7280]" /> Print
          </button>
        </div>

      </div>
    </div>
  );
};
