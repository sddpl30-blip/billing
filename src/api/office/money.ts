/**
 * Typed calls for the money-out side of the Office: vendors, their bills, TDS
 * remittance, and credit and debit notes against tax invoices.
 *
 * The shapes are the server's own (server/src/routes.ts and routesAdmin.ts),
 * amounts in paise. Nothing here computes a figure the server also computes;
 * the panel shows what comes back.
 */

import type { ApiClient } from '../client';

export type TdsSection = '194C' | '194J' | '194I';
export type PayeeKind = 'company' | 'individual-or-huf';
export type PaymentMethod = 'neft' | 'rtgs' | 'imps' | 'upi' | 'cheque' | 'cash';
export type VendorBillState = 'awaiting-approval' | 'approved' | 'booked' | 'rejected';

export interface Vendor {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly pan: string | null;
  readonly gstin: string | null;
  readonly tdsSection: TdsSection | 'none' | null;
  readonly payeeKind: PayeeKind | null;
  readonly bankLast4: string | null;
  readonly active: boolean;
  readonly payablePaise: number;
}

export interface NewVendor {
  readonly name: string;
  readonly category: string;
  readonly pan?: string;
  readonly gstin?: string;
  readonly tdsSection: TdsSection | 'none';
  readonly payeeKind: PayeeKind;
  readonly bankLast4?: string;
  readonly bankIfsc?: string;
}

export interface VendorBill {
  readonly id: string;
  readonly billNo: string;
  readonly vendor: string;
  readonly billDate: string;
  readonly grossPaise: number;
  readonly tdsPaise: number;
  readonly netPayablePaise: number;
  readonly paidPaise: number;
  readonly state: VendorBillState;
  readonly expenseAccount: string;
}

export interface NewVendorBill {
  readonly billNo: string;
  readonly billDate: string;
  readonly receivedOn?: string;
  readonly expenseAccount: string;
  readonly grossPaise: number;
  readonly inputGstPaise?: number;
  /** Only for a lower-deduction certificate; otherwise the statutory rate applies. */
  readonly tdsRateBps?: number;
}

export interface EnteredBill {
  readonly id: string;
  readonly tdsPaise: number;
  readonly netPayablePaise: number;
  readonly tdsRateBps: number;
  readonly state: VendorBillState;
  readonly note: string;
}

export interface VendorPayment {
  readonly amountPaise: number;
  readonly paidOn: string;
  readonly method: PaymentMethod;
  readonly paymentRef: string;
  readonly bankAccountId?: string;
}

export interface BankAccount {
  readonly id: string;
  readonly label: string;
  readonly bankName: string;
  readonly accountLast4: string;
  readonly purpose: string;
  readonly active: boolean;
}

export interface TdsSummary {
  readonly quarter: string;
  readonly bySection: ReadonlyArray<{
    section: string; deductions: number; gross: number; tds: number; unremitted: number;
  }>;
  readonly total: number;
  readonly unremitted: number;
}

export interface TdsRemittanceInput {
  readonly section: TdsSection;
  readonly challanNo: string;
  readonly challanDate: string;
  readonly bankAccountId?: string;
}

export interface TdsRemittance {
  readonly entryId: string;
  readonly section: string;
  readonly quarter: string;
  readonly amount: number;
  readonly deductions: number;
  readonly challanNo: string;
  readonly note: string;
}

export interface InvoiceNote {
  readonly id: string;
  readonly noteNo: string;
  readonly kind: 'credit' | 'debit';
  readonly reason: string;
  readonly amountPaise: number;
  readonly taxPaise: number;
  readonly issuedOn: string;
  readonly taxInvoiceNo: string | null;
  readonly flatNo: string;
}

export interface NewInvoiceNote {
  readonly kind: 'credit' | 'debit';
  readonly amountPaise: number;
  readonly reason: string;
  readonly on: string;
  readonly withTax: boolean;
}

export interface IssuedNote {
  readonly id: string;
  readonly noteNo: string;
  readonly taxPaise: number;
  readonly totalPaise: number;
  readonly appliedToInvoicePaise: number;
  readonly heldAsAdvancePaise: number;
}

/** The fields of a billing document a note needs; the server sends more. */
export interface TaxInvoice {
  readonly id: string;
  readonly taxInvoiceNo: string | null;
  readonly flatNo: string;
  readonly period: string;
  readonly gross: number;
  readonly outstanding: number;
  readonly issuedOn: string;
  readonly state: string;
}

/** A server reply that says what it did, and what it did not, to the outside world. */
interface Noted { readonly note: string }

export const money = {
  async vendors(client: ApiClient): Promise<readonly Vendor[]> {
    return (await client.get<{ vendors: Vendor[] }>('/api/vendors')).vendors;
  },

  addVendor(client: ApiClient, input: NewVendor): Promise<{ id: string }> {
    return client.post('/api/vendors', input);
  },

  async bills(client: ApiClient): Promise<readonly VendorBill[]> {
    return (await client.get<{ bills: VendorBill[] }>('/api/vendor-bills')).bills;
  },

  enterBill(client: ApiClient, vendorId: string, input: NewVendorBill): Promise<EnteredBill> {
    return client.post(`/api/vendors/${encodeURIComponent(vendorId)}/bills`, input);
  },

  approveBill(client: ApiClient, billId: string): Promise<Noted> {
    return client.post(`/api/vendor-bills/${encodeURIComponent(billId)}/approve`);
  },

  bookBill(client: ApiClient, billId: string, on: string): Promise<Noted> {
    return client.post(`/api/vendor-bills/${encodeURIComponent(billId)}/book`, { on });
  },

  /** The key is the caller's, made once per attempt, so a retry cannot pay twice. */
  payBill(client: ApiClient, billId: string, input: VendorPayment, idempotencyKey: string): Promise<Noted> {
    return client.post(`/api/vendor-bills/${encodeURIComponent(billId)}/pay`, input, { idempotencyKey });
  },

  async bankAccounts(client: ApiClient): Promise<readonly BankAccount[]> {
    return (await client.get<{ accounts: BankAccount[] }>('/api/bank-accounts')).accounts;
  },

  /** Without a quarter, the server answers for the quarter it is in today. */
  tds(client: ApiClient, quarter?: string): Promise<TdsSummary> {
    return client.get('/api/reports/tds', quarter === undefined ? undefined : { quarter });
  },

  remitTds(client: ApiClient, quarter: string, input: TdsRemittanceInput, idempotencyKey: string): Promise<TdsRemittance> {
    return client.post(`/api/tds/${encodeURIComponent(quarter)}/remit`, input, { idempotencyKey });
  },

  async notes(client: ApiClient): Promise<readonly InvoiceNote[]> {
    return (await client.get<{ notes: InvoiceNote[] }>('/api/billing/notes')).notes;
  },

  async taxInvoices(client: ApiClient): Promise<readonly TaxInvoice[]> {
    const { documents } = await client.get<{ documents: TaxInvoice[] }>(
      '/api/billing/documents', { state: 'tax-invoice' },
    );
    return documents.filter(d => d.taxInvoiceNo !== null);
  },

  issueNote(client: ApiClient, documentId: string, input: NewInvoiceNote): Promise<IssuedNote> {
    return client.post(`/api/billing/documents/${encodeURIComponent(documentId)}/notes`, input);
  },
};
