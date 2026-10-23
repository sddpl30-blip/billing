/**
 * Downloading a document, the same way from every screen.
 *
 * With a server there is a real PDF — the bytes on file, rendered from the
 * payload stored when the document was issued — and that is what is saved.
 * The demonstration has no server, so it saves a text summary that says it is
 * a demonstration and carries no tax registration and no invented rate.
 */

import type { Invoice } from './types';

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: some browsers start the download after click()
  // returns, and a revoked URL then downloads nothing.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const pdfFilename = (documentNo: string): string =>
  `${documentNo.replace(/[^A-Za-z0-9.-]/g, '-')}.pdf`;

/** The demonstration's summary of an invoice, as plain text. */
export function invoiceSummaryText(invoice: Invoice): string {
  const subtotal = invoice.maintenance + invoice.sinkingFund + invoice.waterCharges
    + invoice.parkingCharges + invoice.nonOccupancyCharges;
  return `
============================================================
       DEMONSTRATION SUMMARY - NOT A TAX INVOICE
       No GSTIN, because this is not a real document.
============================================================
INVOICE NO: ${invoice.invoiceNo}
BILLING CYCLE: ${invoice.period}
FLAT: ${invoice.flatNo} | OWNER: ${invoice.name}
DUE DATE: ${invoice.dueDate}
============================================================
PARTICULARS                           AMOUNT (INR)
------------------------------------------------------------
1. Maintenance Charges                 ${invoice.maintenance.toFixed(2)}
2. Sinking Fund Contributions          ${invoice.sinkingFund.toFixed(2)}
3. Water Charges                       ${invoice.waterCharges.toFixed(2)}
4. Parking Charges                     ${invoice.parkingCharges.toFixed(2)}
5. Non-Occupancy Charges               ${invoice.nonOccupancyCharges.toFixed(2)}
------------------------------------------------------------
SUBTOTAL                               ${subtotal.toFixed(2)}
GST                                    ${invoice.gst.toFixed(2)}
LATE PAYMENT INTEREST / PENALTY        ${invoice.latePenalty.toFixed(2)}
------------------------------------------------------------
TOTAL DUE                              ${invoice.total.toFixed(2)}
============================================================
STATUS: ${invoice.status.toUpperCase()}
============================================================
Generated from demonstration data held in this browser.
`;
}

/**
 * Saves the document: the server's PDF when `pdf` is given, the
 * demonstration summary otherwise. Rejects with the server's reason.
 */
export async function downloadInvoice(
  invoice: Invoice,
  pdf?: (invoice: Invoice) => Promise<Blob>,
): Promise<void> {
  if (pdf !== undefined) {
    saveBlob(await pdf(invoice), pdfFilename(invoice.invoiceNo));
    return;
  }
  saveBlob(
    new Blob([invoiceSummaryText(invoice)], { type: 'text/plain;charset=utf-8' }),
    `Summary_${invoice.invoiceNo}.txt`,
  );
}
