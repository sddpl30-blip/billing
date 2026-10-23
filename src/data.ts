import { Resident, Invoice, ComplaintTicket, Vendor, VendorInvoice, JournalEntry, AuditLog } from './types';

/**
 * Billing areas are DEMO FIGURES. The square footages below were invented for
 * this sample register; a live deployment imports them from the society's own
 * area statement. `res-12` deliberately has no area recorded, so the billing
 * run's refusal path is exercised by the seed rather than only by a test.
 *
 * `areaBasis` is recorded as super built-up throughout, which matches the
 * placeholder in the accounting config. Which measure the ₹4.50/sq ft rate is
 * actually expressed against has not been confirmed — see
 * src/accounting/config.ts.
 */
export const INITIAL_MEMBERS: Resident[] = [
  { id: 'res-1', name: 'Rohan Mehta', flatNo: 'B-204', wing: 'B', contact: '+91 98200 12345', billingAreaSqFt: 2000, areaBasis: 'super-built-up', nonOccupied: false },
  { id: 'res-2', name: 'Priya Nair', flatNo: 'A-101', wing: 'A', contact: '+91 98111 22233', billingAreaSqFt: 1750, areaBasis: 'super-built-up', nonOccupied: false },
  { id: 'res-3', name: 'Suresh Iyer', flatNo: 'C-302', wing: 'C', contact: '+91 98333 44455', billingAreaSqFt: 2400, areaBasis: 'super-built-up', nonOccupied: false },
  { id: 'res-4', name: 'Anjali Gupta', flatNo: 'D-404', wing: 'D', contact: '+91 98444 55566', billingAreaSqFt: 1900, areaBasis: 'super-built-up', nonOccupied: false },
  { id: 'res-5', name: 'Vikram Chawla', flatNo: 'A-201', wing: 'A', contact: '+91 98222 33344', billingAreaSqFt: 1750, areaBasis: 'super-built-up', nonOccupied: false },
  { id: 'res-6', name: 'Amit Sharma', flatNo: 'B-102', wing: 'B', contact: '+91 98555 66677', billingAreaSqFt: 2000, areaBasis: 'super-built-up', nonOccupied: false },
  { id: 'res-7', name: 'Meera Deshmukh', flatNo: 'C-401', wing: 'C', contact: '+91 98666 77788', billingAreaSqFt: 2400, areaBasis: 'super-built-up', nonOccupied: false },
  { id: 'res-8', name: 'Rajesh Kulkarni', flatNo: 'D-103', wing: 'D', contact: '+91 98777 88899', billingAreaSqFt: 1900, areaBasis: 'super-built-up', nonOccupied: false },
  { id: 'res-9', name: 'Sunita Rao', flatNo: 'B-303', wing: 'B', contact: '+91 98888 99900', billingAreaSqFt: 2000, areaBasis: 'super-built-up', nonOccupied: false },
  { id: 'res-10', name: 'Harish Patel', flatNo: 'A-304', wing: 'A', contact: '+91 98999 00011', billingAreaSqFt: 1750, areaBasis: 'super-built-up', nonOccupied: false },
  { id: 'res-11', name: 'Divya Joshi', flatNo: 'C-102', wing: 'C', contact: '+91 98123 45678', billingAreaSqFt: 2400, areaBasis: 'super-built-up', nonOccupied: false },
  { id: 'res-12', name: 'Sanjay Verma', flatNo: 'D-202', wing: 'D', contact: '+91 98234 56789', nonOccupied: false }
];

export const INITIAL_INVOICES: Invoice[] = [
  // Rohan Mehta's unpaid overdue invoice for ₹3,300
  {
    id: 'inv-rohan-overdue',
    invoiceNo: 'GM-2026-06-B204',
    flatNo: 'B-204',
    name: 'Rohan Mehta',
    period: 'Jun 2026',
    maintenance: 2500,
    sinkingFund: 500,
    waterCharges: 300,
    parkingCharges: 0,
    nonOccupancyCharges: 0,
    latePenalty: 0,
    gst: 0, // GST doesn't apply to pure maintenance below 7500 in standard RWAs unless customized, but we can have it
    total: 3300,
    status: 'Overdue',
    dueDate: '10 Jun 2026'
  },
  // 9 past paid invoices of ₹3,300 for Rohan to equal ₹29,700 paid in FY25-26
  ...Array.from({ length: 9 }).map((_, i) => ({
    id: `inv-rohan-paid-${i}`,
    invoiceNo: `GM-2025-0${9 - i}-B204`,
    flatNo: 'B-204',
    name: 'Rohan Mehta',
    period: `${['May', 'Apr', 'Mar', 'Feb', 'Jan', 'Dec', 'Nov', 'Oct', 'Sep'][i]} ${i >= 5 ? '2025' : '2026'}`,
    maintenance: 2500,
    sinkingFund: 500,
    waterCharges: 300,
    parkingCharges: 0,
    nonOccupancyCharges: 0,
    latePenalty: 0,
    gst: 0,
    total: 3300,
    status: 'Paid' as const,
    dueDate: '10th of Month',
    paidDate: '05th of Month',
    paymentMethod: 'UPI',
    transactionId: `TXN98817264${100 + i}`
  })),

  // 7 defaulters (overdue) total. We already have Rohan (1). Let's make 6 more overdue invoices
  {
    id: 'inv-def-1',
    invoiceNo: 'GM-2026-05-A101',
    flatNo: 'A-101',
    name: 'Priya Nair',
    period: 'May 2026',
    maintenance: 2500,
    sinkingFund: 500,
    waterCharges: 300,
    parkingCharges: 300,
    nonOccupancyCharges: 0,
    latePenalty: 200,
    gst: 684, // 18% of maintenance + other charges if we show it
    total: 4484,
    status: 'Overdue',
    dueDate: '10 May 2026'
  },
  {
    id: 'inv-def-2',
    invoiceNo: 'GM-2026-05-C302',
    flatNo: 'C-302',
    name: 'Suresh Iyer',
    period: 'May 2026',
    maintenance: 2500,
    sinkingFund: 500,
    waterCharges: 400,
    parkingCharges: 300,
    nonOccupancyCharges: 1000,
    latePenalty: 350,
    gst: 0,
    total: 5050,
    status: 'Overdue',
    dueDate: '10 May 2026'
  },
  {
    id: 'inv-def-3',
    invoiceNo: 'GM-2026-05-D404',
    flatNo: 'D-404',
    name: 'Anjali Gupta',
    period: 'May 2026',
    maintenance: 2500,
    sinkingFund: 500,
    waterCharges: 300,
    parkingCharges: 0,
    nonOccupancyCharges: 0,
    latePenalty: 150,
    gst: 0,
    total: 3450,
    status: 'Overdue',
    dueDate: '10 May 2026'
  },
  {
    id: 'inv-def-4',
    invoiceNo: 'GM-2026-06-A201',
    flatNo: 'A-201',
    name: 'Vikram Chawla',
    period: 'Jun 2026',
    maintenance: 2500,
    sinkingFund: 500,
    waterCharges: 300,
    parkingCharges: 300,
    nonOccupancyCharges: 0,
    latePenalty: 0,
    gst: 648,
    total: 4248,
    status: 'Overdue',
    dueDate: '10 Jun 2026'
  },
  {
    id: 'inv-def-5',
    invoiceNo: 'GM-2026-06-B102',
    flatNo: 'B-102',
    name: 'Amit Sharma',
    period: 'Jun 2026',
    maintenance: 2500,
    sinkingFund: 500,
    waterCharges: 400,
    parkingCharges: 300,
    nonOccupancyCharges: 1200,
    latePenalty: 0,
    gst: 882,
    total: 5782,
    status: 'Overdue',
    dueDate: '10 Jun 2026'
  },
  {
    id: 'inv-def-6',
    invoiceNo: 'GM-2026-05-C401',
    flatNo: 'C-401',
    name: 'Meera Deshmukh',
    period: 'May 2026',
    maintenance: 4500, // Premium penthouse
    sinkingFund: 800,
    waterCharges: 600,
    parkingCharges: 600,
    nonOccupancyCharges: 0,
    latePenalty: 300,
    gst: 1224,
    total: 8024,
    status: 'Overdue',
    dueDate: '10 May 2026'
  },

  // Paid invoices for current month to equal collected MTD ~ ₹3,86,400.
  // We can represent this with several high-value paid invoices of other residents
  {
    id: 'inv-paid-1',
    invoiceNo: 'GM-2026-06-D103',
    flatNo: 'D-103',
    name: 'Rajesh Kulkarni',
    period: 'Jun 2026',
    maintenance: 2500,
    sinkingFund: 500,
    waterCharges: 300,
    parkingCharges: 300,
    nonOccupancyCharges: 0,
    latePenalty: 0,
    gst: 0,
    total: 3600,
    status: 'Paid',
    dueDate: '10 Jun 2026',
    paidDate: '04 Jun 2026',
    paymentMethod: 'Net Banking',
    transactionId: 'TXN338812903'
  },
  {
    id: 'inv-paid-2',
    invoiceNo: 'GM-2026-06-B303',
    flatNo: 'B-303',
    name: 'Sunita Rao',
    period: 'Jun 2026',
    maintenance: 2500,
    sinkingFund: 500,
    waterCharges: 300,
    parkingCharges: 0,
    nonOccupancyCharges: 0,
    latePenalty: 0,
    gst: 0,
    total: 3300,
    status: 'Paid',
    dueDate: '10 Jun 2026',
    paidDate: '06 Jun 2026',
    paymentMethod: 'UPI',
    transactionId: 'TXN823749216'
  },
  {
    id: 'inv-paid-bulk',
    invoiceNo: 'GM-2026-06-CORP',
    // Not a flat's bill. This is the one consolidated NACH credit covering the
    // maintenance collected from the flats that are not individually seeded
    // above, so the collections total matches a full society rather than the
    // twelve sample members. Shown as a single row for exactly that reason.
    flatNo: '—',
    name: 'Consolidated NACH credit — remaining flats',
    period: 'Jun 2026',
    maintenance: 280000,
    sinkingFund: 60000,
    waterCharges: 25000,
    parkingCharges: 14500,
    nonOccupancyCharges: 0,
    latePenalty: 0,
    gst: 0,
    total: 379500,
    status: 'Paid',
    dueDate: '10 Jun 2026',
    paidDate: '05 Jun 2026',
    paymentMethod: 'Auto Bank NACH',
    transactionId: 'TXNNACH8827361'
  },

  // Some pending invoices (which are not overdue yet but upcoming)
  {
    id: 'inv-pend-1',
    invoiceNo: 'GM-2026-07-B204',
    flatNo: 'B-204',
    name: 'Rohan Mehta',
    period: 'Jul 2026',
    maintenance: 2500,
    sinkingFund: 500,
    waterCharges: 300,
    parkingCharges: 0,
    nonOccupancyCharges: 0,
    latePenalty: 0,
    gst: 0,
    total: 3300,
    status: 'Pending',
    dueDate: '10 Jul 2026'
  },
  {
    id: 'inv-pend-2',
    invoiceNo: 'GM-2026-07-C102',
    flatNo: 'C-102',
    name: 'Divya Joshi',
    period: 'Jul 2026',
    maintenance: 2500,
    sinkingFund: 500,
    waterCharges: 300,
    parkingCharges: 300,
    nonOccupancyCharges: 0,
    latePenalty: 0,
    gst: 0,
    total: 3600,
    status: 'Pending',
    dueDate: '10 Jul 2026'
  }
];

export const INITIAL_TICKETS: ComplaintTicket[] = [
  {
    id: 'tkt-1',
    flatNo: 'B-204',
    name: 'Rohan Mehta',
    category: 'Plumbing',
    description: 'Slow leakage in main inlet pipe in utility balcony.',
    status: 'Open',
    date: '19 Jun 2026'
  },
  {
    id: 'tkt-2',
    flatNo: 'A-101',
    name: 'Priya Nair',
    category: 'Billing Query',
    description: 'Late penalty of ₹200 applied incorrect; I paid on 9th May.',
    status: 'Open',
    date: '18 Jun 2026'
  },
  {
    id: 'tkt-3',
    flatNo: 'C-302',
    name: 'Suresh Iyer',
    category: 'Lift',
    description: 'Wing C elevator is making grinding noises during downward travel.',
    status: 'Resolved',
    date: '14 Jun 2026'
  },
  {
    id: 'tkt-4',
    flatNo: 'D-404',
    name: 'Anjali Gupta',
    category: 'Security',
    description: 'CCTV near Wing D basement entrance is currently misaligned / facing down.',
    status: 'Open',
    date: '15 Jun 2026'
  }
];

export const INITIAL_VENDORS: Vendor[] = [
  { id: 'v-1', name: 'Lift Care Pvt Ltd', balance: 35000, contractRenewal: '12 Aug 2026', category: 'Elevator Maintenance' },
  { id: 'v-2', name: 'SecureGuard Agency', balance: 145000, contractRenewal: '30 Sep 2026', category: 'Security Services' },
  { id: 'v-3', name: 'GreenScape Gardening', balance: 12000, contractRenewal: '15 Nov 2026', category: 'Landscaping' },
  { id: 'v-4', name: 'Force Aqua Water Suppliers', balance: 49000, contractRenewal: 'Ongoing', category: 'Water Supplying tanker' }
];

// 3 pending approvals expected for Committee (Board) Dashboard
export const INITIAL_VENDOR_INVOICES: VendorInvoice[] = [
  {
    id: 'vi-1',
    vendorId: 'v-2',
    vendorName: 'SecureGuard Agency',
    category: 'Security Services',
    amount: 140000,
    tdsRate: 2, // 2% under Section 194C
    tdsAmount: 2800,
    netPayable: 137200,
    status: 'Pending',
    date: '18 Jun 2026'
  },
  {
    id: 'vi-2',
    vendorId: 'v-1',
    vendorName: 'Lift Care Pvt Ltd',
    category: 'Elevator Maintenance',
    amount: 35000,
    tdsRate: 2,
    tdsAmount: 700,
    netPayable: 34300,
    status: 'Pending',
    date: '17 Jun 2026'
  },
  {
    id: 'vi-3',
    vendorId: 'v-3',
    vendorName: 'GreenScape Gardening',
    category: 'Landscaping',
    amount: 12000,
    tdsRate: 1, // 1% for individual/HUF contract or 2% other
    tdsAmount: 120,
    netPayable: 11880,
    status: 'Pending',
    date: '15 Jun 2026'
  },
  {
    id: 'vi-4',
    vendorId: 'v-4',
    vendorName: 'Force Aqua Water Suppliers',
    category: 'Water Tankers',
    amount: 54000,
    tdsRate: 2,
    tdsAmount: 1080,
    netPayable: 52920,
    status: 'Approved',
    date: '10 Jun 2026'
  }
];

export const INITIAL_JOURNAL: JournalEntry[] = [
  { id: 'j-1', date: '05 Jun 2026', description: 'Monthly Maintenance Billing - June', debitAccount: 'Maintenance Receivable Account', creditAccount: 'Operating Income Fund', amount: 330000 },
  { id: 'j-2', date: '06 Jun 2026', description: 'Advance Bank NACH Bulk Clearing', debitAccount: 'Operating Cash Bank A/c', creditAccount: 'Maintenance Receivable Account', amount: 379500 },
  { id: 'j-3', date: '10 Jun 2026', description: 'Force Aqua Tankers Invoicing & TDS Transfer', debitAccount: 'Water Supply Vendor A/c', creditAccount: 'TDS Payable A/c', amount: 1080 },
  { id: 'j-4', date: '12 Jun 2026', description: 'Lift Spares Purchase Allocation', debitAccount: 'Lift Maintenance Reserve', creditAccount: 'Operating Cash Bank A/c', amount: 15400 },
  { id: 'j-5', date: '15 Jun 2026', description: 'Transfer to Sinking Surcharge Fund', debitAccount: 'Operating Cash Bank A/c', creditAccount: 'Sinking Fund Reserve', amount: 60000 }
];

export const INITIAL_AUDIT_LOG: AuditLog[] = [
  { id: 'a-1', user: 'Manager Rohan K.', action: 'Generated Monthly Maintenance Invoices for June 2026 Cycle', timestamp: '2026-06-01 10:15' },
  { id: 'a-2', user: 'System Auto', action: 'Applied ₹200 Overdue Penalty on 7 unpaid May invoices', timestamp: '2026-06-11 00:00' },
  { id: 'a-3', user: 'Treasurer Amit S.', action: 'Approved Force Aqua vendor invoice #V-8827', timestamp: '2026-06-12 14:32' },
  { id: 'a-4', user: 'Resident Priya N.', action: 'Raised plumbing helpdesk ticket B-204', timestamp: '2026-06-19 16:11' }
];
