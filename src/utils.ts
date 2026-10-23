import { Resident, Invoice, ComplaintTicket, Vendor, VendorInvoice, JournalEntry, AuditLog } from './types';
import { INITIAL_MEMBERS, INITIAL_INVOICES, INITIAL_TICKETS, INITIAL_VENDORS, INITIAL_VENDOR_INVOICES, INITIAL_JOURNAL, INITIAL_AUDIT_LOG } from './data';

// Indian Number Formatting
export function formatRupee(amount: number): string {
  // Handles Indian grouping format (e.g., 1,24,500)
  const x = Math.round(amount).toString();
  let lastThree = x.substring(x.length - 3);
  const otherNumbers = x.substring(0, x.length - 3);
  if (otherNumbers !== '') {
    lastThree = ',' + lastThree;
  }
  const res = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + lastThree;
  return '₹' + res;
}

// Initial Local Storage setup
const KEYS = {
  MEMBERS: 'gm_rwa_members',
  INVOICES: 'gm_rwa_invoices',
  TICKETS: 'gm_rwa_tickets',
  VENDORS: 'gm_rwa_vendors',
  VENDOR_INVOICES: 'gm_rwa_vendor_invoices',
  JOURNAL: 'gm_rwa_journal',
  AUDIT: 'gm_rwa_audit',
  BACKUP: 'gm_rwa_backup_history',
  AUTH: 'gm_rwa_auth_state'
};

export function getLocalStorageState() {
  const getOrSeed = <T>(key: string, initialData: T): T => {
    const data = localStorage.getItem(key);
    if (!data) {
      localStorage.setItem(key, JSON.stringify(initialData));
      return initialData;
    }
    try {
      return JSON.parse(data);
    } catch {
      return initialData;
    }
  };

  return {
    members: getOrSeed<Resident[]>(KEYS.MEMBERS, INITIAL_MEMBERS),
    invoices: getOrSeed<Invoice[]>(KEYS.INVOICES, INITIAL_INVOICES),
    tickets: getOrSeed<ComplaintTicket[]>(KEYS.TICKETS, INITIAL_TICKETS),
    vendors: getOrSeed<Vendor[]>(KEYS.VENDORS, INITIAL_VENDORS),
    vendorInvoices: getOrSeed<VendorInvoice[]>(KEYS.VENDOR_INVOICES, INITIAL_VENDOR_INVOICES),
    journal: getOrSeed<JournalEntry[]>(KEYS.JOURNAL, INITIAL_JOURNAL),
    audit: getOrSeed<AuditLog[]>(KEYS.AUDIT, INITIAL_AUDIT_LOG),
    backup: getOrSeed<any[]>(KEYS.BACKUP, [
      { id: 'b-1', date: '10 Jun 2026', recordCount: 42, status: 'Local only', spreadsheetId: '1p4G...meAdowS18' },
      { id: 'b-2', date: '18 Jun 2026', recordCount: 45, status: 'Local only', spreadsheetId: '1p4G...meAdowS18' }
    ]),
    authenticated: getOrSeed<boolean>(KEYS.AUTH, false)
  };
}

export function saveStateToLocalStorage(state: {
  members?: Resident[];
  invoices?: Invoice[];
  tickets?: ComplaintTicket[];
  vendors?: Vendor[];
  vendorInvoices?: VendorInvoice[];
  journal?: JournalEntry[];
  audit?: AuditLog[];
  backup?: any[];
  authenticated?: boolean;
}) {
  if (state.members) localStorage.setItem(KEYS.MEMBERS, JSON.stringify(state.members));
  if (state.invoices) localStorage.setItem(KEYS.INVOICES, JSON.stringify(state.invoices));
  if (state.tickets) localStorage.setItem(KEYS.TICKETS, JSON.stringify(state.tickets));
  if (state.vendors) localStorage.setItem(KEYS.VENDORS, JSON.stringify(state.vendors));
  if (state.vendorInvoices) localStorage.setItem(KEYS.VENDOR_INVOICES, JSON.stringify(state.vendorInvoices));
  if (state.journal) localStorage.setItem(KEYS.JOURNAL, JSON.stringify(state.journal));
  if (state.audit) localStorage.setItem(KEYS.AUDIT, JSON.stringify(state.audit));
  if (state.backup) localStorage.setItem(KEYS.BACKUP, JSON.stringify(state.backup));
  if (state.authenticated !== undefined) localStorage.setItem(KEYS.AUTH, JSON.stringify(state.authenticated));
}

export function clearAndResetLocalStorage() {
  localStorage.removeItem(KEYS.MEMBERS);
  localStorage.removeItem(KEYS.INVOICES);
  localStorage.removeItem(KEYS.TICKETS);
  localStorage.removeItem(KEYS.VENDORS);
  localStorage.removeItem(KEYS.VENDOR_INVOICES);
  localStorage.removeItem(KEYS.JOURNAL);
  localStorage.removeItem(KEYS.AUDIT);
  localStorage.removeItem(KEYS.BACKUP);
  localStorage.removeItem(KEYS.AUTH);
  return getLocalStorageState();
}
