export interface Resident {
  id: string;
  name: string;
  flatNo: string;
  wing: 'A' | 'B' | 'C' | 'D';
  contact: string;
  balance?: number;

  /**
   * Measured area in square feet, used for the per-square-foot maintenance
   * charge. Optional because a flat with no area on file must be refused
   * rather than billed on a guess — `runBilling` skips it and says so.
   */
  billingAreaSqFt?: number;

  /**
   * Which measure `billingAreaSqFt` is. There is no sensible default: the
   * same rupee rate over carpet area and over super built-up area produces
   * bills that differ by a third, so a flat without this recorded cannot be
   * billed either.
   */
  areaBasis?: 'carpet' | 'built-up' | 'super-built-up';

  /** True where the owner does not occupy, for the non-occupancy surcharge. */
  nonOccupied?: boolean;
}

export interface Invoice {
  id: string;
  invoiceNo: string;
  flatNo: string;
  name: string;
  period: string;
  maintenance: number;
  sinkingFund: number;
  waterCharges: number;
  parkingCharges: number;
  nonOccupancyCharges: number;
  latePenalty: number;
  gst: number; // 18% where applicable or computed
  total: number;
  status: 'Paid' | 'Pending' | 'Overdue';
  dueDate: string;
  paidDate?: string;
  paymentMethod?: string;
  transactionId?: string;
}

export interface Receipt {
  receiptNo: string;
  invoiceId: string;
  invoiceNo: string;
  flatNo: string;
  name: string;
  amount: number;
  paymentDate: string;
  paymentMethod: string;
  transactionId: string;
}

export interface ComplaintTicket {
  id: string;
  flatNo: string;
  name: string;
  category: 'Plumbing' | 'Lift' | 'Security' | 'Billing Query' | 'Other';
  description: string;
  status: 'Open' | 'Resolved';
  date: string;
}

export interface Vendor {
  id: string;
  name: string;
  balance: number;
  contractRenewal: string;
  category: string;
}

export interface VendorInvoice {
  id: string;
  vendorId: string;
  vendorName: string;
  category: string;
  amount: number; // Gross amount
  tdsRate: number; // e.g. 2 for 2%
  tdsAmount: number;
  netPayable: number;
  status: 'Pending' | 'Approved' | 'Rejected';
  date: string;
}

export interface JournalEntry {
  id: string;
  date: string;
  description: string;
  debitAccount: string;
  creditAccount: string;
  amount: number;
}

export interface AuditLog {
  id: string;
  user: string;
  action: string;
  timestamp: string;
}

export interface BackupHistory {
  id: string;
  date: string;
  recordCount: number;
  status: 'Success' | 'Pending';
  spreadsheetId?: string;
}
