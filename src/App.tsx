import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Home,
  Receipt,
  CreditCard,
  BookOpen,
  Menu,
  Briefcase,
  Bell,
  Lock,
  Unlock,
  Plus,
  Trash2,
  Edit3,
  TrendingUp,
  Send,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  User,
  Users,
  ChevronRight,
  Clock,
  Check,
  ArrowRight,
  X,
  Download,
  Printer,
  FileText
} from 'lucide-react';

import {
  getLocalStorageState,
  saveStateToLocalStorage,
  clearAndResetLocalStorage,
  formatRupee
} from './utils';
// The seed arrays, imported directly rather than reached through
// getLocalStorageState(). That function returns whatever localStorage holds,
// which on a second visit is the already-seeded set — feeding it back into
// importSeedOnce is how the same invoices got imported twice.
import { INITIAL_INVOICES, INITIAL_VENDOR_INVOICES } from './data';
import { Resident, Invoice, ComplaintTicket, Vendor, VendorInvoice, JournalEntry, AuditLog } from './types';

// The modals, the books screens and the charts are loaded when first shown.
// recharts alone is most of the bundle, and a resident on a phone needs none
// of them to see what they owe.
const AdminPinModal = lazy(() => import('./components/AdminPinModal').then(m => ({ default: m.AdminPinModal })));
const InvoiceDetailModal = lazy(() => import('./components/InvoiceDetailModal').then(m => ({ default: m.InvoiceDetailModal })));
const ReceiptModal = lazy(() => import('./components/ReceiptModal').then(m => ({ default: m.ReceiptModal })));
const BackupHub = lazy(() => import('./components/BackupHub').then(m => ({ default: m.BackupHub })));
const FinancialStatements = lazy(() => import('./components/FinancialStatements').then(m => ({ default: m.FinancialStatements })));
const JournalLedger = lazy(() => import('./components/JournalLedger').then(m => ({ default: m.JournalLedger })));
const CollectionChart = lazy(() => import('./components/Charts').then(m => ({ default: m.CollectionChart })));
const OfficeHub = lazy(() => import('./components/office/OfficeHub').then(m => ({ default: m.OfficeHub })));
const BudgetChart = lazy(() => import('./components/Charts').then(m => ({ default: m.BudgetChart })));
import { BillingWorkflow } from './components/BillingWorkflow';
import { Dialog } from './components/Dialog';
import { ReceiptEntryForm, type OpenDocument } from './components/ReceiptEntryForm';
import { Toasts, type ToastMessage } from './components/Toasts';
import {
  A, buildStatements, dayMonthYearToIso, formatRupees, isoToDayMonthYear, periodToIso,
  systemClock, toRupees, type Paise,
} from './accounting';
import { EXPENSE_ACCOUNTS } from './store/booksStore';
import { useBooks } from './store/useBooks';
import type { ReceiptOutcome } from './store/actions';
import {
  apiCategoryFor, invoicesFrom, residentsFrom, ticketsFrom, vendorInvoicesFrom, vendorsFrom,
} from './api/legacy';
import type { TicketResponse } from './api/client';
import type { OfficeContext } from './components/office/types';
import { LoginScreen } from './components/LoginScreen';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import { downloadInvoice, pdfFilename, saveBlob } from './invoiceExport';

const SESSION_EMAIL_KEY = 'gm_rwa_session_email';

/**
 * The flat the demonstration shows.
 *
 * Used only when there is no server. With one, the flat comes from
 * `/api/auth/me` — the owner record the signed-in account is linked to — so
 * two members see two different sets of bills, which is the whole point. This
 * constant is now what the sample society falls back to and nothing else
 * reads it.
 */
const DEMO_RESIDENT_FLAT = 'B-204';

/** What a lazily loaded panel shows for the moment it takes to arrive. */
const PanelLoading: React.FC = () => (
  <div className="py-10 text-center text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)]" role="status">
    Loading…
  </div>
);

/**
 * An invoice's due date as ISO. The server's are ISO already; the demo's
 * seed has "10 Jun 2026", and some rows only a period.
 */
function dueIso(invoice: Invoice): string {
  const raw = invoice.dueDate ?? '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return dayMonthYearToIso(raw) ?? periodToIso(invoice.period) ?? '';
}

/** A due date as "due in 4 days", "due today" or "3 days overdue", from the dates. */
function dueLabel(dueOn: string, today: string): string {
  const due = Date.parse(`${dueOn}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return dueOn === '' ? 'NO DUE DATE' : `DUE ${dueOn}`;
  const days = Math.round((due - now) / 86_400_000);
  if (days === 0) return 'DUE TODAY';
  if (days > 0) return `DUE IN ${days} ${days === 1 ? 'DAY' : 'DAYS'}`;
  return `${-days} ${days === -1 ? 'DAY' : 'DAYS'} OVERDUE`;
}

/** "12:04" for a time today, otherwise the date. */
function syncedLabel(iso: string | null): string {
  if (iso === null) return 'NOT YET';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'NOT YET';
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export default function App() {
  // --- Persistent States ---
  const [members, setMembers] = useState<Resident[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [tickets, setTickets] = useState<ComplaintTicket[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorInvoices, setVendorInvoices] = useState<VendorInvoice[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [auditLog, setAuditLog] = useState<AuditLog[]>([]);
  const [backupHistory, setBackupHistory] = useState<any[]>([]);

  // --- Screen Width Responsive State ---
  const [isDesktop, setIsDesktop] = useState(window.innerWidth >= 768);

  useEffect(() => {
    const handleResize = () => {
      setIsDesktop(window.innerWidth >= 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // --- Member session (email OTP login) ---
  const [sessionEmail, setSessionEmail] = useState<string | null>(() => localStorage.getItem(SESSION_EMAIL_KEY));

  // --- Session UI States ---
  const [currentRole, setCurrentRole] = useState<'Resident' | 'Manager' | 'Committee'>('Resident');
  const [activeTab, setActiveTab] = useState<'home' | 'bills' | 'pay' | 'books' | 'office' | 'more'>('home');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);

  // --- Modals Triggers ---
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authTargetRole, setAuthTargetRole] = useState<'Manager' | 'Committee'>('Manager');
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<Invoice | null>(null);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [showSuccessPayModal, setShowSuccessPayModal] = useState(false);
  /** The receipt the books actually issued for the last payment, for the success dialog. */
  const [lastReceipt, setLastReceipt] = useState<(ReceiptOutcome & { amountRupees: number }) | null>(null);
  /** True while a write is being awaited, so a button cannot be pressed twice. */
  const [working, setWorking] = useState(false);

  // --- Input Forms ---
  // Resident raise complaint
  const [ticketCategory, setTicketCategory] = useState<'Plumbing' | 'Lift' | 'Security' | 'Billing Query' | 'Other'>('Plumbing');
  const [ticketDescription, setTicketDescription] = useState('');

  // Resident Pay Now UI Flow
  const [payingInvoice, setPayingInvoice] = useState<Invoice | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'UPI' | 'Net Banking' | 'Card' | 'Wallet'>('UPI');
  const [partialAmountInput, setPartialAmountInput] = useState('');
  const [customAdvanceInput, setCustomAdvanceInput] = useState('');

  // Manager members CRUD
  const [memberFormOpen, setMemberFormOpen] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formFlat, setFormFlat] = useState('');
  const [formWing, setFormWing] = useState<'A' | 'B' | 'C' | 'D'>('A');
  const [formContact, setFormContact] = useState('');

  // Manager Generate Periodic Invoices Form
  const [showBillingWizard, setShowBillingWizard] = useState(false);
  const [wizardPeriod, setWizardPeriod] = useState('Jul 2026');
  // A percentage of maintenance — the engine's own unit — not rupees, which is
  // what the old label said while 500 was being read as 500%.
  const [wizardSinking, setWizardSinking] = useState('10');
  const [wizardWater, setWizardWater] = useState('300');
  const [wizardParking, setWizardParking] = useState('0');

  // Books Tab Reports internal tabs
  const [booksSubTab, setBooksSubTab] = useState<'ledger' | 'reports' | 'budget' | 'audit'>('reports');
  const [reportsSubState, setReportsSubState] = useState<'ie' | 'bs' | 'rp' | 'tb'>('ie');

  // Notifications Queue
  const [toaster, setToaster] = useState<ToastMessage[]>([]);
  const toastSeq = useRef(0);

  /**
   * The demonstration banner's height, as a CSS variable the layouts offset
   * themselves by. The banner is fixed and wraps on a phone, so a constant
   * would be wrong; it used to cover the header and the theme switcher.
   */
  const bannerObserver = useRef<ResizeObserver | null>(null);
  const bannerRef = useCallback((node: HTMLDivElement | null) => {
    const root = document.documentElement;
    bannerObserver.current?.disconnect();
    bannerObserver.current = null;
    if (node === null) {
      root.style.setProperty('--mv-banner-h', '0px');
      return;
    }
    const measure = () => root.style.setProperty('--mv-banner-h', `${node.offsetHeight}px`);
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      bannerObserver.current = new ResizeObserver(measure);
      bannerObserver.current.observe(node);
    }
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToaster(prev => prev.filter(t => t.id !== id));
  }, []);

  // Trigger Local Toast. Errors stay up longer: they are the ones that matter.
  const triggerToast = useCallback((msg: string, tone: ToastMessage['tone'] = 'info') => {
    const id = `${Date.now()}-${toastSeq.current++}`;
    setToaster(prev => [...prev.slice(-3), { id, msg, tone }]);
    setTimeout(() => dismissToast(id), tone === 'error' ? 8000 : 4500);
  }, [dismissToast]);

  const toastError = useCallback((err: unknown, fallback: string) => {
    triggerToast(err instanceof Error && err.message !== '' ? err.message : fallback, 'error');
  }, [triggerToast]);

  /**
   * Resolved once: the server if one answers, the local demonstration if not.
   *
   * `useBooks` also holds the signed-in identity, because the two cannot be
   * separated — which flat the resident screens show depends on who is signed
   * in, and that answer comes from the server.
   */
  const booksSource = useBooks({
    vendorInvoices: INITIAL_VENDOR_INVOICES,
    demoFlatNo: DEMO_RESIDENT_FLAT,
    // A refresh that failed, a record the engine refused: shown, not lost.
    onProblem: message => triggerToast(message, 'error'),
  });
  const books = booksSource.store;
  const onServer = booksSource.kind === 'server';
  const booksVersion = booksSource.version;
  /** Changes only when the books were reloaded, not on every busy flag. */
  const booksLoadedAt = books?.snapshot().savedAt ?? null;

  /**
   * The store, for a handler.
   *
   * Handlers can only be reached once the books are open — the screen below
   * returns early until they are — but that is a fact about the app's flow,
   * not something the compiler can see. This states it in one place rather
   * than asserting it at twenty call sites.
   */
  const mustBooks = (): NonNullable<typeof books> => {
    if (books === null) throw new Error('The books are not open yet.');
    return books;
  };
  const mustActions = (): NonNullable<typeof booksSource.actions> => {
    if (booksSource.actions === null) throw new Error('The books are not open yet.');
    return booksSource.actions;
  };

  /**
   * Runs an awaited write with the busy flag held, so the button that started
   * it cannot start it again, and any refusal ends up on screen rather than
   * as an unhandled rejection.
   */
  const runWrite = async (fn: () => Promise<void>, fallback: string): Promise<void> => {
    if (working) return;
    setWorking(true);
    try {
      await fn();
    } catch (err) {
      toastError(err, fallback);
    } finally {
      setWorking(false);
    }
  };

  /** Members the server manages; the demo's own registry is local. */
  const demoOnly = (what: string): string =>
    `${what} is not available here yet: the books are on the server, and this screen only ` +
    'edits the demonstration copy.';

  // --- Load the demonstration's own state on startup ---
  //
  // Only in demo mode. With a server, every one of these arrays is filled from
  // the snapshot below instead, and nothing is read from this browser.
  useEffect(() => {
    if (booksSource.kind !== 'demo') return;
    const freshState = getLocalStorageState();
    setMembers(freshState.members);
    setInvoices(freshState.invoices);
    setTickets(freshState.tickets);
    setVendors(freshState.vendors);
    setVendorInvoices(freshState.vendorInvoices);
    setJournal(freshState.journal);
    setAuditLog(freshState.audit);
    setBackupHistory(freshState.backup);
    setIsAuthenticated(freshState.authenticated);
  }, [booksSource.kind]);

  /**
   * The screens' data, from the server.
   *
   * Runs whenever the books are reloaded, which is once after every write.
   * The members, the invoices, the vendors and their bills all come out of
   * the snapshot the store already fetched and rehydrated — read from it, not
   * fetched a second time — so what is on screen and what the ledger says are
   * the same records rather than two lists that have to be kept in step.
   */
  useEffect(() => {
    const server = booksSource.server;
    if (!onServer || server === null || books === null) return;
    const snapshot = server.lastView();
    if (snapshot === null) return;

    const residents = residentsFrom(snapshot);
    setMembers(residents);
    setVendors(vendorsFrom(snapshot));
    setVendorInvoices(vendorInvoicesFrom(snapshot));
    setInvoices(invoicesFrom(
      books.allDocuments(),
      new Map(residents.map(r => [r.flatNo, r.name])),
    ));

    // The journal screen reads this flattened list; the ledger itself is
    // what the books screens use.
    setJournal(books.journal().slice(-200).map(entry => ({
      id: entry.id,
      date: entry.date,
      description: entry.narration,
      debitAccount: entry.postings.find(leg => leg.debit > 0)?.accountCode ?? '',
      creditAccount: entry.postings.find(leg => leg.credit > 0)?.accountCode ?? '',
      amount: entry.postings.reduce((sum, leg) => sum + leg.debit, 0) / 100,
    })));
  }, [onServer, booksSource.server, books, booksLoadedAt]);

  /**
   * Tickets, and the audit trail, from their own endpoints — once signed in,
   * and each only when the account may read it, rather than asking and
   * collecting a 401 or 403 every time.
   */
  const mayReadTickets = booksSource.can('ticket.read.own') || booksSource.can('ticket.read.any');
  const mayReadAudit = booksSource.can('audit.read');
  useEffect(() => {
    if (!onServer || booksSource.client === null || booksSource.status !== 'ready') return;
    let cancelled = false;

    void (async () => {
      if (mayReadTickets) try {
        const response = await booksSource.client!.get<{ tickets: readonly TicketResponse[] }>(
          '/api/tickets',
        );
        if (!cancelled) setTickets(ticketsFrom(response.tickets));
      } catch {
        // A resident with no helpdesk permission gets a 403 here, which is
        // not an error worth a toast — it means the screen has nothing to show.
      }
      if (mayReadAudit) try {
        const response = await booksSource.client!.get<{
          entries: ReadonlyArray<{ at: string; actorLabel: string; action: string }>;
        }>('/api/audit?limit=100');
        if (!cancelled) {
          setAuditLog(response.entries.map((entry, index) => ({
            id: `audit-${index}-${entry.at}`,
            user: entry.actorLabel,
            action: entry.action,
            timestamp: entry.at,
          })));
        }
      } catch {
        // Only an auditor may read the trail. Everyone else sees the local
        // list, which is what their own actions in this session produced.
      }
    })();

    return () => { cancelled = true; };
    // Once per reload of the books, not once per busy flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onServer, booksSource.client, booksSource.status, booksLoadedAt, mayReadTickets, mayReadAudit]);

  /**
   * The view follows the roles the server granted.
   *
   * The demo let the PIN modal decide which view to show and nothing checked
   * it. Here the server decides what the account may do, and this only picks
   * which of those views to open on.
   */
  // Keyed on who is signed in and the view their roles open on — strings,
  // so the effect runs when the account changes and not on every render.
  // Depending on the session object reset the view a moment after a member
  // with two roles had switched it.
  const sessionEmailFromServer = booksSource.session?.email ?? null;
  const sessionDefaultView = booksSource.session?.view ?? null;
  const sessionViewCount = booksSource.session?.availableViews.length ?? 0;
  useEffect(() => {
    if (!onServer || sessionEmailFromServer === null || sessionDefaultView === null) return;
    setIsAuthenticated(sessionViewCount > 1);
    setCurrentRole(sessionDefaultView);
    // The address in the corner, from the session the server confirmed. A
    // cookie from a previous visit means there is no sign-in to go through,
    // so this is where it arrives.
    setSessionEmail(sessionEmailFromServer);
  }, [onServer, sessionEmailFromServer, sessionDefaultView, sessionViewCount]);

  // Sync back state properties
  const syncAndPersist = (updates: {
    members?: Resident[];
    invoices?: Invoice[];
    tickets?: ComplaintTicket[];
    vendors?: Vendor[];
    vendorInvoices?: VendorInvoice[];
    journal?: JournalEntry[];
    audit?: AuditLog[];
    backup?: any[];
    authenticated?: boolean;
  }) => {
    if (updates.members) setMembers(updates.members);
    if (updates.invoices) setInvoices(updates.invoices);
    if (updates.tickets) setTickets(updates.tickets);
    if (updates.vendors) setVendors(updates.vendors);
    if (updates.vendorInvoices) setVendorInvoices(updates.vendorInvoices);
    if (updates.journal) setJournal(updates.journal);
    if (updates.audit) setAuditLog(updates.audit);
    if (updates.backup) setBackupHistory(updates.backup);
    if (updates.authenticated !== undefined) setIsAuthenticated(updates.authenticated);

    // The demonstration keeps its state in this browser. On the server there
    // is nothing to keep here: the database already has it, and a second copy
    // in localStorage is a copy that can disagree.
    if (booksSource.kind === 'demo') saveStateToLocalStorage(updates);
  };

  // Reset sandbox flow. The demonstration only: on the server there is no
  // sandbox, and loading the seed arrays into the screens would show sample
  // flats as if they were the association's.
  const handleReset = () => {
    const local = booksSource.local;
    if (onServer || local === null) {
      triggerToast(demoOnly('Resetting'), 'error');
      return;
    }
    // The books too, not only the screens' arrays: the ledger is kept under
    // its own key, and leaving it made a "reset" demo keep every payment.
    local.resetToEmpty();
    local.importSeedOnce('demo-invoices-v1', INITIAL_INVOICES);
    const cleared = clearAndResetLocalStorage();
    setMembers(cleared.members);
    setInvoices(cleared.invoices);
    setTickets(cleared.tickets);
    setVendors(cleared.vendors);
    setVendorInvoices(cleared.vendorInvoices);
    setJournal(cleared.journal);
    setAuditLog(cleared.audit);
    setBackupHistory(cleared.backup);
    setIsAuthenticated(false);
    setCurrentRole('Resident');
    setActiveTab('home');
    triggerToast('All custom edits have been cleared. Seed data restored!');
  };

  // --- Role Checker Guard & Authenticators ---
  const handleRoleSwitchRequest = (newRole: 'Resident' | 'Manager' | 'Committee') => {
    if (newRole === 'Resident') {
      setCurrentRole('Resident');
      // If was in books tab, shift home (Resident can't access Books)
      if (activeTab === 'books') {
        setActiveTab('home');
      }
    } else if (onServer) {
      // The server decides. A view this account's roles do not include is
      // refused here and, more to the point, every endpoint behind it would
      // refuse too — so there is no PIN to bypass.
      if (booksSource.session?.availableViews.includes(newRole) === true) {
        setCurrentRole(newRole);
      } else {
        triggerToast(
          `This account does not hold the ${newRole.toLowerCase()} role. Ask the secretary ` +
          'to grant it.',
        );
      }
    } else {
      // Require auth
      if (isAuthenticated) {
        setCurrentRole(newRole);
      } else {
        setAuthTargetRole(newRole);
        setShowAuthModal(true);
      }
    }
  };

  const handleAuthSuccess = (role: 'Manager' | 'Committee') => {
    syncAndPersist({ authenticated: true });
    setCurrentRole(role);
    setShowAuthModal(false);
    triggerToast(`Authenticated successfully as ${role}! Administrative mode unlocked.`);
  };

  // --- Member login / logout (email OTP) ---
  const handleLogin = (email: string) => {
    // In server mode the session is an HttpOnly cookie the server set; this is
    // only the address to show in the corner. The demonstration has no server,
    // so there it is the whole of the "session".
    if (booksSource.kind === 'demo') localStorage.setItem(SESSION_EMAIL_KEY, email);
    setSessionEmail(email);
  };

  const handleLogout = () => {
    localStorage.removeItem(SESSION_EMAIL_KEY);
    booksSource.signOut().catch((err: unknown) => toastError(err, 'Signing out on the server failed.'));
    setSessionEmail(null);
    setIsAuthenticated(false);
    setCurrentRole('Resident');
    setActiveTab('home');
  };

  // Log out of admin modes
  const handleLockAdminMode = () => {
    syncAndPersist({ authenticated: false });
    setCurrentRole('Resident');
    setActiveTab('home');
    triggerToast('Administrative token expired. Screen locked.');
  };

  /**
   * The flat the signed-in resident is looking at.
   *
   * From the session, which got it from the owner record on the server. In
   * demo mode it is the sample flat. On the server with no flat linked to the
   * account it is empty — and empty is the truthful answer, not a fallback to
   * somebody else's flat.
   *
   * Declared before anything reads it: it used to be declared sixty lines
   * below its first use, which threw as soon as there were invoices to filter.
   */
  const residentFlatNo = booksSource.session?.primaryFlatNo ?? '';

  // --- DYNAMIC QUANTITATIVE MATHEMATICS ---
  // 1. Resident
  const rohanInvoices = invoices.filter(inv => inv.flatNo === residentFlatNo);
  // The bill to pay next: the unpaid one falling due first, whatever month it
  // is for. It was pinned to 'Jun 2026', so from July nothing showed as due.
  const rohanDueInvoice = rohanInvoices
    .filter(inv => inv.status !== 'Paid')
    .sort((a, b) => dueIso(a).localeCompare(dueIso(b)))[0];
  // What the flat owes per the ledger — so a part payment shows as part paid —
  // falling back to the unpaid invoices' totals before the books are open.
  const rohanTotalDueNum = books !== null && residentFlatNo !== ''
    ? toRupees(books.positionOf(residentFlatNo).totalDues)
    : rohanInvoices.filter(inv => inv.status !== 'Paid').reduce((acc, current) => acc + current.total, 0);
  const rohanTotalPaidNum = rohanInvoices.filter(inv => inv.status === 'Paid').reduce((acc, current) => acc + current.total, 0);
  const rohanOpenTicketsNum = tickets.filter(t => t.flatNo === residentFlatNo && t.status === 'Open').length;

  // 2. Manager
  /**
   * The money store: one ledger and one document register, created once.
   *
   * Every rupee that moves now goes through it. The `invoices` array is kept
   * as the demo's historical document list, but it is no longer the record of
   * what is owed — the ledger is, and an invoice's status is read back from
   * it. That is what stops the invoice list and the books disagreeing.
   */
  /**
   * Created once, with its saved books already loaded.
   *
   * `createBooksStore` loads from the repository synchronously before it
   * returns, so there is no window in which the screens can read an empty
   * store and show a society with no transactions. That was the initialisation
   * race: the store was built here and the demo arrays arrived from a
   * `useEffect` a render later, so whichever read happened first won.
   *
   * `useState` with an initialiser rather than `useMemo`, because useMemo is a
   * performance hint React may discard and re-run; this must happen exactly
   * once or a second store would open over the same storage.
   */
  /**
   * Imports the demo invoices into the ledger, once ever.
   *
   * The name is recorded in the saved books, so a refresh does not import them
   * again on top of what was restored. Runs in an effect rather than in the
   * initialiser so that React's development double-invoke cannot run it twice
   * — and even if it did, `importSeedOnce` would decline the second call.
   */
  useEffect(() => {
    // Only into the demonstration's own books. A production database does not
    // take sample invoices, and the server has no endpoint that would accept
    // them — the server store has no such method at all.
    const local = booksSource.local;
    if (local === null || onServer) return;
    const result = local.importSeedOnce('demo-invoices-v1', INITIAL_INVOICES);
    if (!result.imported && result.entriesAdded === 0) {
      // Not an error: the usual case is that it was imported on a previous
      // visit. Left on the store's problem list rather than toasted.
      return;
    }
  }, [booksSource.local, onServer]);

  /** Today, from one clock, instead of a date literal in each handler. */
  const today = systemClock.today();

  /**
   * The association's own GSTIN, as the screens should print it.
   *
   * There was a made-up one — 27ABCDE1234F1Z5 — in seven places, including
   * next to the words "Society GSTIN" on a tax invoice. A registration number
   * on a document is a legal assertion about the association, so it now comes
   * from the society record and reads "not on record" when there is none.
   */
  const societyGstin = onServer
    ? (booksSource.server?.context()?.gstin ?? null)
    : null;
  const gstinLabel = societyGstin ?? (onServer ? 'not on record' : 'none (demonstration)');
  const societyName = onServer
    ? (booksSource.server?.context()?.societyName ?? 'Your association')
    : 'Mani Vista (demonstration data)';

  /** The name on that flat, from the member list rather than a literal. */
  const residentName = members.find(m => m.flatNo === residentFlatNo)?.name
    ?? booksSource.session?.email
    ?? 'Member';

  /**
   * Rupees to paise at the form boundary.
   *
   * `fromRupees` throws on an amount finer than a paisa, which is right inside
   * the engine and wrong here: a stray third decimal typed into a number input
   * should round, not break the screen.
   */
  const fromRupeesSafe = (rupees: number): number => Math.round((rupees || 0) * 100);

  /**
   * The statements. Derived from the store's ledger once anything has been
   * posted through it, and from the seeded arrays before that, so the books
   * screens are never blank on a fresh load.
   */
  const statements = useMemo(
    () => buildStatements(
      invoices,
      vendorInvoices,
      books === null ? {} : { ledger: books.snapshot().ledger },
    ),
    [invoices, vendorInvoices, books, booksVersion],
  );

  /** Documents from the register, with status derived from the ledger. */
  const registerDocuments = useMemo(
    () => (books === null ? [] : books.allDocuments()),
    [books, booksVersion],
  );

  const mtdCollectedTotal = invoices.filter(inv => inv.status === 'Paid' && inv.period.includes('2026')).reduce((sum, inv) => sum + inv.total, 0);
  const mtdOutstandingTotal = invoices.filter(inv => inv.status !== 'Paid').reduce((sum, inv) => sum + inv.total, 0);
  // Defaulters count: unique flatNo with Overdue invoices
  const uniqueDefaultersCount = Array.from(new Set(invoices.filter(inv => inv.status === 'Overdue').map(inv => inv.flatNo))).length;
  // Expenses sum
  const totalMTDExpenses = vendorInvoices.filter(v => v.status === 'Approved').reduce((sum, v) => sum + v.netPayable, 0);

  // 3. Committee — balances read off the ledger, in paise. These were three
  // constants, shown on the server as if they were the association's funds.
  const ledgerNow = books?.snapshot().ledger ?? null;
  const reserveFundPaise = (ledgerNow?.balanceOf(A.GENERAL_RESERVE) ?? 0) as Paise;
  const sinkingFundPaise = (ledgerNow?.balanceOf(A.SINKING_FUND) ?? 0) as Paise;
  const operatingBankPaise = (ledgerNow?.balanceOf(A.BANK_OPERATING) ?? 0) as Paise;
  const pendingApprovalsCount = vendorInvoices.filter(v => v.status === 'Pending').length;

  /** The resident's advance on account, from the member advance subledger. */
  const residentAdvancePaise = (residentFlatNo === '' || ledgerNow === null
    ? 0
    : ledgerNow.balanceOf(A.MEMBER_ADVANCE, { party: residentFlatNo })) as Paise;
  /** The categories of the resident's open tickets, for the tile. */
  const residentOpenTicketCategories = Array.from(new Set(
    tickets.filter(t => t.flatNo === residentFlatNo && t.status === 'Open').map(t => t.category),
  ));

  /** Documents a receipt can be set against, oldest first. */
  const openDocumentsFor = (flatNo: string): readonly OpenDocument[] =>
    registerDocuments
      .filter(d => d.flatNo === flatNo && d.state === 'tax-invoice' && d.outstanding > 0)
      .sort((a, b) => a.dueOn.localeCompare(b.dueOn))
      .map(d => ({ proformaNo: d.proformaNo, label: `${d.taxInvoiceNo ?? d.proformaNo} (${d.period})`, outstanding: d.outstanding }));

  /** Whether this account may record a receipt. In demo every view may. */
  const mayRecordReceipts = !onServer || booksSource.can('payment.record');
  const mayPayOnline = !onServer || booksSource.can('payment.record');

  // The Office is server-only (it is the API's own screens) and not for the
  // resident view; OfficeHub then offers only the sections this account's
  // permissions open.
  const showOffice = onServer && booksSource.client !== null && currentRole !== 'Resident';
  // Stable for as long as the client is: panels load data in effects keyed on
  // the context, and a fresh object every render would reload them each time.
  // The latest hook result is read through a ref instead.
  const booksSourceRef = useRef(booksSource);
  booksSourceRef.current = booksSource;
  const officeContext = useMemo<OfficeContext | null>(() => (
    booksSource.client === null ? null : {
      client: booksSource.client,
      can: (permission: string) => booksSourceRef.current.can(permission),
      toast: (message: string, tone: 'info' | 'error' = 'info') => triggerToast(message, tone),
      reload: () => booksSourceRef.current.reload(),
    }
  ), [booksSource.client, triggerToast]);

  /** GST as the screens should state it: from the settings, never a constant. */
  const gstSetting = onServer
    ? booksSource.server?.context()?.settings.gst ?? null
    : null;
  const gstLabel = onServer
    ? (gstSetting === null || !gstSetting.chargeGst ? 'No GST' : `${gstSetting.ratePercent}% GST`)
    : (books?.snapshot().config.gstOnMaintenance === true
        ? `${books.snapshot().config.gst.rate}% GST`
        : 'No GST');
  /** The maintenance rate the run will use, in words. */
  const rateLabel = onServer
    ? (() => {
        const rate = booksSource.server?.context()?.rate ?? null;
        return rate === null
          ? 'No maintenance rate is on record — the server will refuse the run until one is approved.'
          : `₹${rate.ratePerSqFt.toFixed(2)}/sq ft on ${rate.basis} area, from ${rate.effectiveFrom}` +
            `${rate.approved ? '' : ' (not yet approved)'}`;
      })()
    : (() => {
        const m = books?.snapshot().config.maintenance;
        return m === undefined ? '' : `₹${m.ratePerSqFt.toFixed(2)}/sq ft on ${m.areaBasis} area (demonstration rate)`;
      })();

  // --- ACTIONS HANDLERS ---

  // Submit new ticket complaint
  const handleRaiseComplaint = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticketDescription.trim()) return;

    const raisedFlat = currentRole === 'Resident' ? residentFlatNo : (members[0]?.flatNo ?? '');

    // On the server the ticket is created there, with the SLA from the
    // category and the flat checked against this account. The local list is
    // then refreshed from the server rather than guessed at here.
    if (onServer && booksSource.client !== null) {
      const flatId = booksSource.session?.flats.find(f => f.flatNo === raisedFlat)?.id
        ?? members.find(m => m.flatNo === raisedFlat)?.id;
      if (flatId === undefined) {
        triggerToast('No flat is linked to this account, so a ticket cannot be raised against one.');
        return;
      }
      void booksSource.client
        .post<{ id: string; ticketNo: string; dueAt: string }>('/api/tickets', {
          flatId,
          category: apiCategoryFor(ticketCategory),
          description: ticketDescription,
          priority: 'normal',
        })
        .then(async created => {
          const response = await booksSource.client!.get<{ tickets: readonly TicketResponse[] }>(
            '/api/tickets',
          );
          setTickets(ticketsFrom(response.tickets));
          setTicketDescription('');
          triggerToast(`Ticket ${created.ticketNo} raised. Due ${created.dueAt.slice(0, 10)}.`);
        })
        .catch((err: unknown) => {
          triggerToast(err instanceof Error ? err.message : 'The ticket was not accepted.');
        });
      return;
    }

    const newTicket: ComplaintTicket = {
      id: `tkt-${Date.now()}`,
      flatNo: raisedFlat,
      name: currentRole === 'Resident' ? residentName : (members[0]?.name ?? 'Manager'),
      category: ticketCategory,
      description: ticketDescription,
      status: 'Open',
      date: isoToDayMonthYear(today)
    };

    const updatedTickets = [newTicket, ...tickets];
    const newLog: AuditLog = {
      id: `audit-${Date.now()}`,
      user: currentRole === 'Resident'
        ? `Resident ${residentName} (${residentFlatNo})`
        : `Manager (${booksSource.session?.email ?? 'local'})`,
      action: `Raised support grievance ticket #${newTicket.id.split('-').pop()} [${ticketCategory}]`,
      timestamp: new Date().toLocaleString('en-IN')
    };

    syncAndPersist({ tickets: updatedTickets, audit: [newLog, ...auditLog] });
    setTicketDescription('');
    triggerToast('Support ticket raised successfully! Our team will respond shortly.');
  };

  // Pay invoice action trigger
  const handlePayClick = (invoice: Invoice) => {
    if (!mayPayOnline) {
      triggerToast(
        'Online payment is not connected. Pay the association by UPI, NEFT or cheque and the ' +
        'manager records the receipt against your flat.',
        'error',
      );
      return;
    }
    setPayingInvoice(invoice);
    setPartialAmountInput('');
    setCustomAdvanceInput('');
    setActiveTab('pay');
  };

  /** A line for the demonstration's local audit list. The server keeps its own. */
  const logLocally = (user: string, action: string): void => {
    if (onServer) return;
    syncAndPersist({
      audit: [{ id: `audit-${Date.now()}`, user, action, timestamp: systemClock.now() }, ...auditLog],
    });
  };

  /**
   * Records an advance deposit.
   *
   * What this replaces: the old handler credited an "Unearned Advance Revenue
   * Liability" account that nothing else in the app referenced and that was
   * never drawn down, so an advance could only ever accumulate. The receipt
   * now lands on the member advance subledger, and whatever can settle an
   * open bill is applied to it oldest first.
   */
  const handleExecuteAdvance = (e: React.FormEvent) => {
    e.preventDefault();
    const value = parseFloat(customAdvanceInput);
    if (!Number.isFinite(value) || value <= 0) {
      triggerToast('Enter an advance amount greater than zero.', 'error');
      return;
    }
    if (!mayPayOnline) {
      triggerToast('Online payment is not connected. The manager records advances received.', 'error');
      return;
    }

    const flatNo = residentFlatNo;
    void runWrite(async () => {
      const result = await mustActions().depositAdvance({
        flatNo,
        amountRupees: value,
        method: 'upi',
        by: `${currentRole} (${flatNo})`,
      });
      logLocally(
        `${currentRole} (${flatNo})`,
        `Advance deposit ${result.receiptNo} of ${formatRupees(fromRupeesSafe(value) as Paise)}. ` +
        `${formatRupees(result.appliedToDues)} applied to open bills, ` +
        `${formatRupees(result.heldAsAdvance)} held on account.`,
      );
      setCustomAdvanceInput('');
      triggerToast(
        result.appliedToDues > 0
          ? `Receipt ${result.receiptNo}: ${formatRupees(result.appliedToDues)} went against open bills.`
          : `Receipt ${result.receiptNo}: ${formatRupees(result.heldAsAdvance)} held on account.`,
      );
    }, 'The advance could not be recorded.');
  };

  /**
   * Logs a reminder against a flat.
   *
   * No messaging provider is wired in — that needs a server holding a Gupshup
   * or Twilio key — so this records the reminder and says so, rather than
   * reporting a broadcast that did not happen. The demonstration only: on the
   * server there is nothing to log it to yet.
   */
  const handleSendReminder = (invoice: Invoice) => {
    if (onServer) {
      triggerToast(demoOnly('Sending a reminder'), 'error');
      return;
    }
    logLocally(
      `Manager (${currentRole})`,
      `Reminder logged for flat ${invoice.flatNo} (${invoice.name}) on ` +
      `${invoice.invoiceNo}, ${formatRupees(fromRupeesSafe(invoice.total) as Paise)} outstanding.`,
    );
    triggerToast(
      `Reminder logged for ${invoice.name} (${invoice.flatNo}). ` +
      `Demo — no WhatsApp or SMS is sent.`,
    );
  };

  /**
   * Records a member's payment through the books.
   *
   * What this replaces: the old handler marked the invoice `Paid` whatever was
   * tendered, and credited the receivable with the amount actually received,
   * so a part payment left the invoice list and the books disagreeing by the
   * balance. Now the receipt is allocated against the invoice, the ledger
   * records what is still owed, and the status is read back from it — and on
   * the server, nothing is shown as paid until the server has said so.
   */
  const handleExecutePayment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!payingInvoice) return;

    const typed = parseFloat(partialAmountInput);
    const amountRupees = Number.isFinite(typed) && typed > 0 ? typed : payingInvoice.total;
    if (amountRupees <= 0) {
      triggerToast('Enter an amount greater than zero.', 'error');
      return;
    }

    // On the server an invoice's id is its proforma number. In the demo, an
    // invoice carried over from the seed was already posted to the ledger by
    // the seed import: the receipt is applied to that receivable, because
    // raising a register document for it as well would post the bill twice
    // (the engine refuses: "already posted"). One that was never posted gets
    // a register document raised and approved first.
    const paying = payingInvoice;
    const local = booksSource.local;
    const seededReceivable = !onServer && local !== null
      && local.documentsFor(paying.flatNo).every(d => d.period !== paying.period || d.state === 'cancelled')
      && local.snapshot().ledger.docLedger(A.MAINTENANCE_RECEIVABLE, { party: paying.flatNo }).has(paying.invoiceNo);
    const docRef = onServer || seededReceivable ? paying.id : ensureRegisterDocument(paying);
    if (docRef === null) return;

    void runWrite(async () => {
      const result = seededReceivable
        ? await mustActions().recordReceipt({
            flatNo: paying.flatNo,
            amountRupees,
            receivedOn: today,
            method: paymentMethod === 'UPI' ? 'upi' : paymentMethod === 'Card' ? 'card' : 'neft',
            by: `${currentRole} (${paying.flatNo})`,
          })
        : await mustActions().payDocument({
            proformaNo: docRef,
            amountRupees,
            method: paymentMethod,
            by: `${currentRole} (${paying.flatNo})`,
          });

      const view = mustBooks().allDocuments().find(d => d.proformaNo === docRef);
      const seededOpen = seededReceivable
        ? (mustBooks().snapshot().ledger
            .docLedger(A.MAINTENANCE_RECEIVABLE, { party: paying.flatNo }).get(paying.invoiceNo) ?? 0)
        : null;
      const settled = seededOpen !== null ? seededOpen <= 0 : view?.status === 'Paid';

      // The demo's array keeps the document list the screens already render;
      // its status mirrors what the ledger says. On the server the list is
      // rebuilt from the refreshed snapshot instead.
      let receiptInvoice: Invoice = paying;
      if (!onServer) {
        const updatedInvoices = invoices.map(inv =>
          inv.id === paying.id
            ? {
                ...inv,
                status: (settled ? 'Paid' : 'Pending') as Invoice['status'],
                paidDate: isoToDayMonthYear(today),
                paymentMethod,
                transactionId: result.receiptNo,
              }
            : inv);
        receiptInvoice = updatedInvoices.find(inv => inv.id === paying.id) ?? paying;
        syncAndPersist({ invoices: updatedInvoices });
      } else {
        receiptInvoice = { ...paying, transactionId: result.receiptNo, paymentMethod };
      }
      logLocally(
        `${currentRole} ${paying.name} (${paying.flatNo})`,
        `Receipt ${result.receiptNo} of ${formatRupees(fromRupeesSafe(amountRupees) as Paise)} against ` +
        `${view?.taxInvoiceNo ?? docRef} via ${paymentMethod}. ` +
        `${formatRupees(result.appliedToDues)} applied to dues` +
        (result.heldAsAdvance > 0 ? `, ${formatRupees(result.heldAsAdvance)} held as advance` : '') +
        (result.outstandingAfter === null ? '.' : `. Outstanding after: ${formatRupees(result.outstandingAfter)}.`),
      );

      setSelectedReceipt(receiptInvoice);
      setLastReceipt({
        ...result,
        amountRupees,
        outstandingAfter: seededOpen !== null ? (Math.max(seededOpen, 0) as Paise) : result.outstandingAfter,
      });
      setPayingInvoice(null);
      setShowSuccessPayModal(true);

      const outstanding = result.outstandingAfter ?? 0;
      triggerToast(
        outstanding > 0
          ? `Receipt ${result.receiptNo} recorded. ${formatRupees(outstanding as Paise)} still outstanding on this bill.`
          : result.heldAsAdvance > 0
            ? `Receipt ${result.receiptNo} recorded. ${formatRupees(result.heldAsAdvance)} held as an advance.`
            : `Receipt ${result.receiptNo} recorded.`,
      );
    }, 'The payment could not be recorded.');
  };

  /**
   * Finds or creates the register document for a seeded invoice.
   *
   * The demo's invoice array predates the register, so an invoice from the
   * seed has no document. Rather than letting a receipt post against nothing,
   * a proforma is raised from the invoice's own lines and approved, which
   * keeps the amounts identical to what the member was shown. Demo only: the
   * server's invoices all come from its register.
   */
  const ensureRegisterDocument = (invoice: Invoice): string | null => {
    const local = booksSource.local;
    if (local === null) return invoice.id;
    const existing = local.documentsFor(invoice.flatNo)
      .find(d => d.period === invoice.period && d.state !== 'cancelled');
    if (existing) return existing.proformaNo;

    const lines = [
      { head: 'maintenance' as const, amount: fromRupeesSafe(invoice.maintenance), taxable: true },
      { head: 'sinking' as const, amount: fromRupeesSafe(invoice.sinkingFund), taxable: false },
      { head: 'maintenance' as const, amount: fromRupeesSafe(invoice.waterCharges), taxable: true },
      { head: 'maintenance' as const, amount: fromRupeesSafe(invoice.parkingCharges), taxable: true },
      { head: 'maintenance' as const, amount: fromRupeesSafe(invoice.nonOccupancyCharges), taxable: true },
      { head: 'other' as const, amount: fromRupeesSafe(invoice.latePenalty), taxable: false },
    ].filter(l => l.amount > 0);

    if (lines.length === 0) {
      triggerToast(`Invoice ${invoice.invoiceNo} has no chargeable lines, so no receipt can be applied to it.`, 'error');
      return null;
    }

    try {
      const doc = local.snapshot().register.issueProforma({
        flatNo: invoice.flatNo,
        period: invoice.period,
        lines,
      });
      local.approveDocuments([doc.proformaNo], `${currentRole} (carried forward from ${invoice.invoiceNo})`);
      return doc.proformaNo;
    } catch (err) {
      toastError(err, `Could not open a document for ${invoice.invoiceNo}.`);
      return null;
    }
  };

  /** A receipt the manager recorded, said in the toast and in the demo's log. */
  const handleReceiptRecorded = (outcome: ReceiptOutcome, flatNo: string) => {
    logLocally(
      `Manager (${currentRole})`,
      `Receipt ${outcome.receiptNo} recorded for flat ${flatNo}: ` +
      `${formatRupees(outcome.appliedToDues)} applied to dues` +
      (outcome.heldAsAdvance > 0 ? `, ${formatRupees(outcome.heldAsAdvance)} held as advance.` : '.'),
    );
    triggerToast(
      `Receipt ${outcome.receiptNo} recorded for ${flatNo}. ` +
      `${formatRupees(outcome.appliedToDues)} applied to dues` +
      (outcome.heldAsAdvance > 0 ? `, ${formatRupees(outcome.heldAsAdvance)} held as an advance.` : '.'),
    );
  };

  /** The server's receipt PDF, saved. */
  const downloadReceiptPdf = async (receiptNo: string): Promise<void> => {
    const server = booksSource.server;
    if (server === null) throw new Error('Receipts are only issued as PDFs by the server.');
    saveBlob(await server.receiptPdf(receiptNo), pdfFilename(receiptNo));
  };

  /** The document itself: the server's PDF, or the demonstration summary. */
  const handleDownloadInvoice = (invoice: Invoice) => {
    const server = booksSource.server;
    downloadInvoice(invoice, server === null ? undefined : inv => server.invoicePdf(inv.id))
      .then(() => triggerToast(server === null
        ? 'Demonstration summary saved. It is not a tax invoice.'
        : `${invoice.invoiceNo} saved as a PDF.`))
      .catch((err: unknown) => toastError(err, 'The document could not be fetched.'));
  };

  // Member management CRUD triggers. The demonstration's own registry: on the
  // server the flats and owners are master data, and these edited only the
  // screen's copy — a "new flat" that existed nowhere.
  const handleSaveMember = (e: React.FormEvent) => {
    e.preventDefault();
    if (onServer) {
      triggerToast(demoOnly('Editing the member registry'), 'error');
      return;
    }
    if (!formName.trim() || !formFlat.trim()) return;

    if (editingMemberId) {
      // Edit mode
      const updatedMembers = members.map(m => {
        if (m.id === editingMemberId) {
          return { ...m, name: formName, flatNo: formFlat, wing: formWing, contact: formContact };
        }
        return m;
      });

      const newLog: AuditLog = {
        id: `audit-${Date.now()}`,
        user: `Manager (${currentRole})`,
        action: `Modified Resident Registry profile for Flat ${formFlat} (${formName})`,
        timestamp: systemClock.now()
      };

      syncAndPersist({
        members: updatedMembers,
        audit: [newLog, ...auditLog]
      });
      triggerToast(`Successfully modified resident flat details for ${formName}`);
    } else {
      // Create mode
      const newMem: Resident = {
        id: `res-${Date.now()}`,
        name: formName,
        flatNo: formFlat,
        wing: formWing,
        contact: formContact,
        balance: 0
      };

      const newLog: AuditLog = {
        id: `audit-${Date.now()}`,
        user: `Manager (${currentRole})`,
        action: `Provisioned & registered new flat membership: Flat ${formFlat} -> ${formName}`,
        timestamp: systemClock.now()
      };

      syncAndPersist({
        members: [...members, newMem],
        audit: [newLog, ...auditLog]
      });
      triggerToast(`Registered new allotment flat ${formFlat} successfully!`);
    }

    // Reset Form
    setFormName('');
    setFormFlat('');
    setFormWing('A');
    setFormContact('');
    setEditingMemberId(null);
    setMemberFormOpen(false);
  };

  const handleEditMemberClick = (m: Resident) => {
    if (onServer) return;
    setEditingMemberId(m.id);
    setFormName(m.name);
    setFormFlat(m.flatNo);
    setFormWing(m.wing);
    setFormContact(m.contact);
    setMemberFormOpen(true);
  };

  const handleDeleteMember = (id: string, name: string) => {
    if (onServer) {
      triggerToast(demoOnly('Removing a member'), 'error');
      return;
    }
    const updated = members.filter(m => m.id !== id);
    const newLog: AuditLog = {
      id: `audit-${Date.now()}`,
      user: `Manager (${currentRole})`,
      action: `De-allotted & archived membership for ${name}`,
      timestamp: systemClock.now()
    };

    syncAndPersist({
      members: updated,
      audit: [newLog, ...auditLog]
    });
    triggerToast(`De-allotted wing records for ${name} successfully.`);
  };

  // Digital approval workflow & TDS deduction computations
  /**
   * Approves or rejects a vendor bill — and does only that.
   *
   * What this replaces: approving used to post two entries that between them
   * paid the vendor and withheld the tax, debiting `Vendor Payable` twice and
   * crediting it nowhere, so no expense ever reached the books and the payable
   * carried a debit balance. Approval, booking and payment are now three
   * separate steps, each with its own posting or none at all — and each is
   * awaited before the next starts, so a booking is never sent ahead of the
   * approval it depends on.
   */
  const handleVendorInvoiceStatus = (id: string, status: 'Approved' | 'Rejected') => {
    const target = vendorInvoices.find(vi => vi.id === id);
    if (!target) return;

    if (status === 'Rejected') {
      if (onServer) {
        triggerToast(demoOnly('Rejecting a vendor bill'), 'error');
        return;
      }
      void runWrite(async () => {
        await mustActions().rejectVendorBill(id, `Treasurer (${currentRole})`, 'Rejected on review');
        const updated = vendorInvoices.map(vi => (vi.id === id ? { ...vi, status } : vi));
        syncAndPersist({ vendorInvoices: updated });
        logLocally(`Treasurer (${currentRole})`, `Rejected vendor bill ${id} from ${target.vendorName}. Nothing was posted.`);
        triggerToast(`Vendor bill from ${target.vendorName} rejected. Nothing posted.`);
      }, `Vendor bill ${id} was not rejected.`);
      return;
    }

    // Approve, then book. Booking debits the expense at gross, credits the
    // payable net of tax and credits the TDS withheld; it does not touch the
    // bank. Paying is a separate action on the Payables screen.
    void runWrite(async () => {
      const actions = mustActions();
      await actions.approveVendorBill(id, `Treasurer (${currentRole})`);
      await actions.bookVendorBill(id, `Treasurer (${currentRole})`, expenseAccountForCategory(target.category));

      const booked = mustBooks().snapshot().vendorBills.find(v => v.id === id);
      if (booked?.state !== 'booked') {
        throw new Error(`Vendor bill ${id} is ${booked?.state ?? 'missing'} after booking.`);
      }
      const payableNow = mustBooks().snapshot().ledger.balanceOf('2000', { party: target.vendorId });
      if (!onServer) {
        syncAndPersist({ vendorInvoices: vendorInvoices.map(vi => (vi.id === id ? { ...vi, status } : vi)) });
      }
      logLocally(
        `Treasurer (${currentRole})`,
        `Approved and booked vendor bill ${id} from ${target.vendorName}: ` +
        `${formatRupees(fromRupeesSafe(target.amount) as Paise)} to expense, ` +
        `${formatRupees(fromRupeesSafe(target.tdsAmount) as Paise)} TDS withheld, ` +
        `${formatRupees(fromRupeesSafe(target.netPayable) as Paise)} payable. ` +
        `Not paid — payment is a separate step.`,
      );
      triggerToast(
        `Booked ${formatRupees(fromRupeesSafe(target.amount) as Paise)} to expense for ` +
        `${target.vendorName}. ${formatRupees(payableNow)} now payable — not yet paid.`,
      );
    }, `Vendor bill ${id} could not be booked.`);
  };

  /**
   * Settles a booked vendor bill. The only action that moves the bank.
   */
  const handlePayVendor = (id: string) => {
    const bill = mustBooks().snapshot().vendorBills.find(v => v.id === id);
    if (!bill) return;
    if (bill.state !== 'booked') {
      triggerToast(
        `${bill.vendorName}'s bill is ${bill.state}. It has to be booked before it can be paid, ` +
        `because until then there is no payable to settle.`,
        'error',
      );
      return;
    }

    const payable = mustBooks().snapshot().ledger.balanceOf('2000', { party: bill.vendorId });
    if (payable <= 0) {
      triggerToast(`Nothing outstanding to ${bill.vendorName}.`);
      return;
    }

    const paymentRef = `PAY-${id}-${Date.now().toString().slice(-6)}`;
    void runWrite(async () => {
      await mustActions().payVendor({
        id,
        amountRupees: toRupees(payable),
        paymentRef,
        by: `Treasurer (${currentRole})`,
      });
      logLocally(
        `Treasurer (${currentRole})`,
        `Paid ${formatRupees(payable)} to ${bill.vendorName} against ${id} ` +
        `(${paymentRef}). Recorded in the books; no bank transfer was initiated — ` +
        `this application has no banking connection.`,
      );
      triggerToast(
        `${formatRupees(payable)} recorded as paid to ${bill.vendorName}. ` +
        `Books only — no bank transfer was made.`,
      );
    }, `The payment to ${bill.vendorName} was not recorded.`);
  };

  /** Maps a vendor's free-text category onto an expenditure account. */
  const expenseAccountForCategory = (category: string): string => {
    const lower = category.toLowerCase();
    if (lower.includes('water')) return EXPENSE_ACCOUNTS.water;
    if (lower.includes('security') || lower.includes('guard')) return EXPENSE_ACCOUNTS.security;
    if (lower.includes('lift') || lower.includes('elevator')) return EXPENSE_ACCOUNTS.lift;
    if (lower.includes('clean') || lower.includes('housekeep')) return EXPENSE_ACCOUNTS.housekeeping;
    if (lower.includes('electric') || lower.includes('power')) return EXPENSE_ACCOUNTS.electricity;
    if (lower.includes('audit') || lower.includes('legal') || lower.includes('account')) {
      return EXPENSE_ACCOUNTS.professional;
    }
    return EXPENSE_ACCOUNTS.repairs;
  };

  const handleTriggerBackup = (sheetId: string) => {
    if (onServer) return;
    const recordCountSum = members.length + invoices.length + tickets.length + vendors.length + journal.length;

    // There is no remote write to report on, so this records what actually
    // happened: a local snapshot was counted. 'Success' here would assert a
    // confirmation nothing ever sent or received.
    const newBackup = {
      id: `b-${Date.now()}`,
      date: isoToDayMonthYear(today),
      recordCount: recordCountSum,
      status: 'Local only',
      spreadsheetId: sheetId.substring(0, 6) + '...' + sheetId.substring(sheetId.length - 4)
    };

    const newLog: AuditLog = {
      id: `audit-${Date.now()}`,
      user: 'Backup hub (demo)',
      action: `Local snapshot counted for ${sheetId}. No data left the browser — Google Sheets sync is not built.`,
      timestamp: systemClock.now()
    };

    syncAndPersist({
      backup: [newBackup, ...backupHistory],
      audit: [newLog, ...auditLog]
    });
  };

  // Wizard Bill Generation
  /**
   * Runs the monthly billing, through the register.
   *
   * What this replaces: the old wizard applied one typed amount to every flat
   * regardless of size, hardcoded `gst: 0`, built a July invoice number and a
   * 10 July due date whatever period was chosen, and carried a comment
   * claiming it avoided duplicates with no code behind it.
   *
   * Now the charge is the flat's area times the rate in force, GST comes from
   * the config, the period sets the dates, and a flat that already has a live
   * document for the period is skipped and reported. On the server the run is
   * the server's, with its own approved rate, and the figures shown are the
   * ones it returned.
   *
   * Nothing is posted here. The run raises proformas; the receivable and the
   * GST arise when the treasurer's approval is followed by conversion.
   */
  const handleRunBillGeneration = (e: React.FormEvent) => {
    e.preventDefault();

    const period = wizardPeriod.trim();
    if (periodToIso(period) === null) {
      triggerToast(`"${period}" is not a month and year. Use a form like "Jul 2026".`, 'error');
      return;
    }

    const flats = members.map(m => ({
      flatNo: m.flatNo,
      name: m.name,
      ...(m.billingAreaSqFt !== undefined ? { billingAreaSqFt: m.billingAreaSqFt } : {}),
      ...(m.areaBasis !== undefined ? { areaBasis: m.areaBasis } : {}),
      ...(m.nonOccupied === true ? { nonOccupied: true } : {}),
    }));

    const sinkingPercent = parseFloat(wizardSinking);
    const waterCharge = parseFloat(wizardWater);
    const parkingCharge = parseFloat(wizardParking);

    const commonCharges: Array<{ head: 'maintenance' | 'other'; amountRupees: number; taxable: boolean }> = [];
    if (Number.isFinite(waterCharge) && waterCharge > 0) {
      commonCharges.push({ head: 'maintenance', amountRupees: waterCharge, taxable: true });
    }
    if (Number.isFinite(parkingCharge) && parkingCharge > 0) {
      commonCharges.push({ head: 'maintenance', amountRupees: parkingCharge, taxable: true });
    }

    void runWrite(async () => {
      const result = await mustActions().runBilling({
        period,
        flats,
        commonCharges,
        ...(Number.isFinite(sinkingPercent) && sinkingPercent > 0
          ? { sinkingFundPercentOfMaintenance: sinkingPercent } : {}),
      });

      logLocally(
        `Manager (${currentRole})`,
        `Billing run for ${period}: ${result.raised} proforma invoices raised ` +
        `totalling ${formatRupees(result.totalGross)} ` +
        `(${formatRupees(result.totalNet)} charges plus ${formatRupees(result.totalTax)} GST). ` +
        `${result.skipped.length} flats not billed. ` +
        `Awaiting treasurer approval — nothing has been posted to the books.`,
      );

      setShowBillingWizard(false);
      triggerToast(
        result.raised === 0
          ? `No bills raised for ${period}. ${result.skipped.length} flats skipped` +
            (result.skipped[0] === undefined ? '.' : ` — ${result.skipped[0].flatNo}: ${result.skipped[0].why}`)
          : `${result.raised} proformas raised for ${period}, ` +
            `${formatRupees(result.totalGross)} in total. Awaiting approval.`,
        result.raised === 0 ? 'error' : 'info',
      );
    }, 'The billing run could not start.');
  };

  /** Says how a batch went, from the books' own answer. */
  const reportBatch = (verb: string, outcome: { done: number; refused: number; notes: readonly string[] }) => {
    const head = `${outcome.done} ${verb}` + (outcome.refused > 0 ? `; ${outcome.refused} refused` : '') + '.';
    const detail = outcome.notes.length === 0 ? '' : ` ${outcome.notes.slice(0, 2).join(' ')}`;
    triggerToast(`${head}${detail}`, outcome.done === 0 && outcome.refused > 0 ? 'error' : 'info');
  };

  /** Treasurer approval for every draft in the register. */
  const handleApproveAllDrafts = () => {
    const drafts = registerDocuments.filter(d => d.state === 'draft').map(d => d.proformaNo);
    if (drafts.length === 0) {
      triggerToast('There are no drafts awaiting approval.');
      return;
    }
    void runWrite(async () => {
      const result = await mustActions().approveDocuments(drafts, `Treasurer (${currentRole})`);
      logLocally(
        `Treasurer (${currentRole})`,
        `Approved ${result.done} proforma invoices for dispatch` +
        (result.refused > 0 ? `; ${result.refused} refused` : '') + '.',
      );
      reportBatch('proformas approved', result);
    }, 'The approval did not go through.');
  };

  /** Releases approved proformas. Records whether anything was actually sent. */
  const handleReleaseApproved = () => {
    const approved = registerDocuments.filter(d => d.state === 'approved').map(d => d.proformaNo);
    if (approved.length === 0) {
      triggerToast('There is nothing approved and waiting to be released.');
      return;
    }
    void runWrite(async () => {
      const result = await mustActions().releaseDocuments(approved, `Treasurer (${currentRole})`);
      logLocally(
        `Treasurer (${currentRole})`,
        `Released ${result.done} proforma invoices for dispatch. No email or messaging ` +
        `provider is configured, so nothing was sent to any member.`,
      );
      reportBatch('proformas released', result);
    }, 'The release did not go through.');
  };

  /**
   * Converts every released proforma that has fallen due into a tax invoice.
   * This is the step that posts the receivable and the GST.
   */
  const handleConvertDue = () => {
    void runWrite(async () => {
      const result = await mustActions().convertDueDocuments(`Treasurer (${currentRole})`);
      if (result.done === 0 && result.refused === 0) {
        triggerToast(result.notes[0] ?? 'Nothing has fallen due for conversion yet.');
        return;
      }
      logLocally(
        `Treasurer (${currentRole})`,
        `Converted ${result.done} proformas to tax invoices on their due date, ` +
        `posting the receivable and the GST` +
        (result.refused > 0 ? `; ${result.refused} refused` : '') + '.',
      );
      reportBatch('tax invoices issued and posted', result);
    }, 'The conversion did not go through.');
  };


  // Defaulters List computation
  const overdueInvoices = invoices.filter(inv => inv.status === 'Overdue');

  // Selected Invoice with fallback for desktop master-detail layout
  const currentInvoices = invoices.filter(inv => currentRole === 'Resident' ? inv.flatNo === residentFlatNo : true);
  const desktopActiveInvoice = selectedInvoice && (currentRole === 'Resident' ? selectedInvoice.flatNo === residentFlatNo : true)
    ? selectedInvoice
    : (currentInvoices[0] || null);

  // Collections by billing period, from the invoices on screen — the last six
  // periods that have any. These were invented figures, with the real month's
  // total swapped in for June only, and on the server they read as the
  // association's own history.
  const collectionTrendsData = useMemo(() => {
    const byPeriod = new Map<string, { iso: string; Collected: number; Outstanding: number }>();
    for (const inv of invoices) {
      const iso = periodToIso(inv.period);
      if (iso === null) continue;
      const row = byPeriod.get(inv.period) ?? { iso, Collected: 0, Outstanding: 0 };
      if (inv.status === 'Paid') row.Collected += inv.total;
      else row.Outstanding += inv.total;
      byPeriod.set(inv.period, row);
    }
    return [...byPeriod.entries()]
      .sort((a, b) => a[1].iso.localeCompare(b[1].iso))
      .slice(-6)
      .map(([period, row]) => ({ month: period, Collected: row.Collected, Outstanding: row.Outstanding }));
  }, [invoices]);

  // Budget figures are demonstration values: there is no approved budget on
  // the server, so this chart is shown in the demo only.
  const budgetPerformanceData = [
    { head: 'Maint', Budgeted: 350000, Actual: 338000 },
    { head: 'Sinking', Budgeted: 80000, Actual: 80000 },
    { head: 'Water', Budgeted: 45000, Actual: 54000 },
    { head: 'Rentals', Budgeted: 25000, Actual: 21000 },
    { head: 'Reserve', Budgeted: 15000, Actual: 15400 }
  ];

  /**
   * The billing run's inputs, shared by the desktop and phone layouts.
   *
   * The maintenance charge is the rate in force times each flat's area, so it
   * is shown, not typed: the old "Maintenance (₹)" and "cycle" inputs were
   * read by nothing. On the server the run uses the server's own approved
   * rate and settings, so the demo's extra charges are not offered there.
   */
  const renderWizardFields = (compact: boolean) => {
    const key = compact ? 'm' : 'd';
    const label = `text-[10px] text-[var(--mv-muted)] font-bold block mb-1 uppercase tracking-wider`;
    const input = `w-full ${compact ? 'bg-[var(--mv-surface)] p-2' : 'bg-[var(--mv-page)] p-2.5'} rounded-xl border border-[var(--mv-border)] font-bold text-xs text-[var(--mv-ink)] outline-none`;
    return (
      <>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`wiz-period-${key}`} className={label}>Billing period</label>
            <input
              id={`wiz-period-${key}`}
              type="text"
              value={wizardPeriod}
              onChange={(e) => setWizardPeriod(e.target.value)}
              placeholder="e.g. Jul 2026"
              className={input}
            />
          </div>
          <div>
            <span className={label}>Tax</span>
            <div className="p-2.5 bg-[var(--mv-soft)] rounded-xl text-center font-bold text-[var(--mv-ink)] leading-none">{gstLabel}</div>
          </div>
        </div>
        <p className="text-[10px] text-[var(--mv-muted)] leading-snug">
          <span className="font-bold text-[var(--mv-ink)]">Maintenance:</span> {rateLabel}
          {onServer && (
            <> · Sinking fund {booksSource.server?.context()?.settings.sinkingFundPercent ?? 0}% of maintenance, as set on the server.</>
          )}
        </p>
        {!onServer && (
          <div className={`grid ${compact ? 'grid-cols-2' : 'grid-cols-3'} gap-3 font-mono text-xs`}>
            <div>
              <label htmlFor={`wiz-sinking-${key}`} className={label}>Sinking fund (% of maint.)</label>
              <input id={`wiz-sinking-${key}`} type="number" min="0" step="0.1" value={wizardSinking} onChange={(e) => setWizardSinking(e.target.value)} className={input} />
            </div>
            <div>
              <label htmlFor={`wiz-water-${key}`} className={label}>Water, per flat (₹)</label>
              <input id={`wiz-water-${key}`} type="number" min="0" value={wizardWater} onChange={(e) => setWizardWater(e.target.value)} className={input} />
            </div>
            <div>
              <label htmlFor={`wiz-parking-${key}`} className={label}>Parking, per flat (₹)</label>
              <input id={`wiz-parking-${key}`} type="number" min="0" value={wizardParking} onChange={(e) => setWizardParking(e.target.value)} className={input} />
            </div>
          </div>
        )}
        <button
          type="submit"
          disabled={working}
          className="w-full py-3 bg-[var(--mv-accent)] text-white rounded-xl font-bold shadow-md uppercase tracking-wider text-center flex items-center justify-center gap-1 cursor-pointer disabled:opacity-60 disabled:cursor-wait"
        >
          <Send className="w-4 h-4" aria-hidden="true" /> {working ? 'Raising proformas…' : `Raise proformas for ${wizardPeriod || 'the period'}`}
        </button>
      </>
    );
  };

  // --- what to show before the books are open ------------------------------

  /**
   * The server was required and did not answer. Nothing else opens: not the
   * sample society, and not buttons that would look as if they acted on the
   * association's books.
   */
  if (booksSource.status === 'unavailable') {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[var(--mv-soft)] font-sans p-6" role="alert">
        <div className="text-center max-w-sm">
          <div className="mv-logo-tile mx-auto"><img src="/branding/mani-vista-logo.png" alt="Mani Vista" /></div>
          <h1 className="mt-4 text-sm font-bold text-[var(--mv-ink)]">The books cannot be opened</h1>
          <p className="mt-2 text-xs text-[var(--mv-muted)] leading-relaxed">
            {booksSource.note} Nothing is shown rather than sample figures that could be mistaken
            for the association&apos;s.
          </p>
          {booksSource.error !== null && (
            <p className="mt-2 text-[11px] font-mono text-[#7F1D1D] break-words">{booksSource.error}</p>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 py-2.5 px-5 bg-[var(--mv-ink)] text-white rounded-xl text-xs font-bold uppercase tracking-wider"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  /** While the app is working out where the books are. */
  if (booksSource.status === 'resolving' || books === null) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[var(--mv-soft)] font-sans p-6">
        <div className="text-center">
          <div className="mv-logo-tile mx-auto"><img src="/branding/mani-vista-logo.png" alt="Mani Vista" /></div>
          <p className="mt-4 text-sm font-bold text-[var(--mv-ink)]">Opening the books</p>
          <p className="mt-1 text-xs text-[var(--mv-muted)] max-w-xs">{booksSource.note}</p>
        </div>
      </div>
    );
  }

  /**
   * Sign-in.
   *
   * With a server, the screen signs in against it and the session is a cookie
   * the page cannot read. Without one, it is the local demonstration and says
   * so. The email in `sessionEmail` is only what the corner of the screen
   * shows — it authorises nothing.
   */
  const signInServer = onServer
    ? {
        requestCode: booksSource.requestLoginCode,
        signInWithCode: booksSource.signInWithCode,
        signInWithPassword: booksSource.signIn,
      }
    : undefined;

  if (onServer ? booksSource.status === 'needs-sign-in' : !sessionEmail) {
    return (
      <>
        {booksSource.error !== null && (
          <div className="fixed top-0 inset-x-0 z-[70] bg-[#7F1D1D] text-white text-[11px] font-bold px-4 py-2 text-center">
            {booksSource.error}
          </div>
        )}
        <LoginScreen onLogin={handleLogin} server={signInServer} />
      </>
    );
  }


  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--mv-soft)] font-sans text-[var(--mv-ink)]">
      {/*
        Where the figures come from, said on every screen.

        A committee reading sample data and believing it is the failure this
        banner exists to prevent, so demo mode is labelled and an unreachable
        server is an error rather than a quiet fallback.
      */}
      {!onServer && (
        <div ref={bannerRef} role="note" className="fixed top-0 inset-x-0 z-[80] bg-[var(--mv-ink)] text-white text-[10px] sm:text-[11px] font-bold px-3 py-1.5 text-center leading-tight">
          DEMONSTRATION DATA · {booksSource.note}
          {booksSource.error !== null && <span className="text-red-300"> · {booksSource.error}</span>}
        </div>
      )}

      <Toasts toasts={toaster} onDismiss={dismissToast} />

      {/* 1. DYNAMIC DESKTOP VIEWPORT LAYOUT */}
      {isDesktop ? (
        <div id="desktop-view-container" className="fixed inset-x-0 bottom-0 w-full flex bg-[var(--mv-page)] text-[var(--mv-ink)] overflow-hidden font-sans z-50" style={{ top: 'var(--mv-banner-h)' }}>

          {/* DESKTOP SIDEBAR GROUP */}
          <aside className="w-64 bg-[var(--mv-ink)] text-white flex flex-col h-full shrink-0 border-r border-[var(--mv-dark-border)] select-none">
            {/* Top RWA Brand header */}
            <div className="p-5 border-b border-[var(--mv-dark-border)] flex items-center gap-2.5">
              <div className="mv-logo-tile"><img src="/branding/mani-vista-logo.png" alt="Mani Vista Residents Association" /></div>
              <div className="text-left">
                <h2 className="text-white font-bold leading-none tracking-tight text-xs">MANI VISTA</h2>
                <span className="text-[9px] text-white/75 font-bold block mt-0.5 uppercase tracking-wider">RESIDENTS ASSOCIATION</span>
              </div>
            </div>

            <div className="px-4 pt-3"><ThemeSwitcher /></div>

            {/* Navigation links matching mobile */}
            <nav aria-label="Sections" className="flex-1 p-4 space-y-1.5">
              <button
                onClick={() => setActiveTab('home')}
                aria-current={activeTab === 'home' ? 'page' : undefined}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-semibold uppercase tracking-wider transition-all text-left ${activeTab === 'home' ? 'text-white bg-[var(--mv-accent)]' : 'text-white/70 hover:text-white hover:bg-white/5'}`}
              >
                <div className="flex items-center gap-3">
                  <Home className="w-4 h-4" />
                  <span>Home Core</span>
                </div>
              </button>

              <button
                onClick={() => setActiveTab('bills')}
                aria-current={activeTab === 'bills' ? 'page' : undefined}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-semibold uppercase tracking-wider transition-all text-left ${activeTab === 'bills' ? 'text-white bg-[var(--mv-accent)]' : 'text-white/70 hover:text-white hover:bg-white/5'}`}
              >
                <div className="flex items-center gap-3">
                  <Receipt className="w-4 h-4" />
                  <span>Bills Ledger</span>
                </div>
              </button>

              <button
                onClick={() => setActiveTab('pay')}
                aria-current={activeTab === 'pay' ? 'page' : undefined}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-semibold uppercase tracking-wider transition-all text-left ${activeTab === 'pay' ? 'text-white bg-[var(--mv-accent)]' : 'text-white/70 hover:text-white hover:bg-white/5'}`}
              >
                <div className="flex items-center gap-3">
                  <CreditCard className="w-4 h-4" />
                  <span>Pay Rooms</span>
                </div>
              </button>

              <button
                onClick={() => {
                  if (currentRole === 'Resident') {
                    triggerToast('The books are for the manager and committee views. Switch view to open them.', 'error');
                    handleRoleSwitchRequest('Manager');
                  } else {
                    setActiveTab('books');
                  }
                }}
                aria-current={activeTab === 'books' ? 'page' : undefined}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-semibold uppercase tracking-wider transition-all text-left ${activeTab === 'books' ? 'text-white bg-[var(--mv-accent)]' : 'text-white/70 hover:text-white hover:bg-white/5'}`}
              >
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <BookOpen className="w-4 h-4" />
                    {currentRole === 'Resident' && (
                      <Lock className="w-2.5 h-2.5 text-[var(--mv-accent)] absolute -top-1 -right-1 bg-[var(--mv-surface)] rounded-full p-0.5" />
                    )}
                  </div>
                  <span>Books Ledger</span>
                </div>
                {currentRole === 'Resident' && <Lock className="w-3.5 h-3.5 text-white/75 ml-auto" aria-label="Locked" />}
              </button>

              {showOffice && (
                <button
                  onClick={() => setActiveTab('office')}
                  aria-current={activeTab === 'office' ? 'page' : undefined}
                  className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-semibold uppercase tracking-wider transition-all text-left ${activeTab === 'office' ? 'text-white bg-[var(--mv-accent)]' : 'text-white/70 hover:text-white hover:bg-white/5'}`}
                >
                  <div className="flex items-center gap-3">
                    <Briefcase className="w-4 h-4" />
                    <span>Office</span>
                  </div>
                </button>
              )}

              <button
                onClick={() => setActiveTab('more')}
                aria-current={activeTab === 'more' ? 'page' : undefined}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-semibold uppercase tracking-wider transition-all text-left ${activeTab === 'more' ? 'text-white bg-[var(--mv-accent)]' : 'text-white/70 hover:text-white hover:bg-white/5'}`}
              >
                <div className="flex items-center gap-3">
                  <Menu className="w-4 h-4" />
                  <span>More Modules</span>
                </div>
              </button>
            </nav>

            {/* Active profile and session status */}
            <div className="p-4 border-t border-[var(--mv-dark-border)] bg-black/40 text-left text-xs space-y-2.5">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white" aria-hidden="true">
                  <User className="w-4.5 h-4.5" />
                </div>
                <div className="min-w-0">
                  <p className="font-bold text-white">{currentRole === 'Resident' ? residentName : currentRole === 'Manager' ? 'Finance Supt' : 'RWA Treasurer'}</p>
                  <span className="text-[9px] text-white/70 font-bold block uppercase leading-none mt-0.5">{currentRole} Mode</span>
                  <span className="text-[9px] text-white/70 block truncate leading-none mt-1" title={sessionEmail || ''}>{sessionEmail}</span>
                </div>
              </div>
              {isAuthenticated && currentRole !== 'Resident' && (
                <button
                  onClick={handleLockAdminMode}
                  className="w-full mt-2 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-200 font-bold uppercase text-[9px] rounded-lg tracking-wider transition-colors"
                >
                  Lock Admin Token
                </button>
              )}
              <button
                onClick={handleLogout}
                className="w-full mt-1 py-1.5 bg-white/5 hover:bg-white/10 text-white/80 font-bold uppercase text-[9px] rounded-lg tracking-wider transition-colors"
              >
                Logout
              </button>
            </div>
          </aside>

          {/* DESKTOP CONTENT WORKSPACE WRAPPER */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden h-full bg-[var(--mv-page)]">
            {/* STICKY TOP STRIP */}
            <header className="h-16 border-b border-[var(--mv-border)] bg-[var(--mv-surface)] px-6 flex items-center justify-between shadow-xs shrink-0 select-none">
              <div className="flex items-center gap-3">
                <span className="font-extrabold text-[9px] text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] px-2.5 py-1 rounded uppercase tracking-wider">ROSTER ACTIVE</span>
                <h1 className="text-sm font-semibold text-[var(--mv-ink)] tracking-tight">{onServer ? societyName : 'Mani Vista Residents Association'}</h1>
              </div>

              <div className="flex items-center gap-4">
                <span className="text-[10px] text-[var(--mv-muted)] font-mono">GSTIN: {gstinLabel}</span>

                <div aria-hidden="true" className="relative w-8 h-8 flex items-center justify-center bg-[var(--mv-soft)] rounded-full">
                  <Bell className="w-4 h-4 text-[var(--mv-ink)]" />
                  <div className="absolute top-1 right-1 w-2.5 h-2.5 bg-[var(--mv-accent)] border-2 border-white rounded-full"></div>
                </div>

                {/* Role dropdown switcher */}
                <div className="relative bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] px-3 py-1.5 rounded-full flex items-center gap-1 cursor-pointer">
                  <select
                    aria-label="View as"
                    value={currentRole}
                    onChange={(e) => handleRoleSwitchRequest(e.target.value as any)}
                    className="appearance-none bg-transparent text-[10px] font-bold text-[var(--mv-accent)] tracking-wider outline-none cursor-pointer uppercase pr-4"
                  >
                    <option value="Resident">Resident</option>
                    <option value="Manager">Manager</option>
                    <option value="Committee">Committee</option>
                  </select>
                  <div className="pointer-events-none absolute right-2.5 flex items-center">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--mv-accent)" strokeWidth="3">
                      <path d="m6 9 6 6 6-6"/>
                    </svg>
                  </div>
                </div>
              </div>
            </header>

            {/* MAIN MAIN CONTENT GRID COMPONENT */}
            <main className="flex-1 overflow-y-auto p-8 space-y-6 hide-scrollbar text-left font-sans">

              {/* -------------------- HOME TAB -------------------- */}
              {activeTab === 'home' && (
                <div className="space-y-6 max-w-7xl mx-auto animate-scale-up">
                  <div className="flex justify-between items-end">
                    <div>
                      {currentRole === 'Resident' ? (
                        <>
                          <h2 className="text-2xl font-bold text-[var(--mv-ink)]">{residentName}</h2>
                          <p className="text-xs text-[var(--mv-muted)]">
                            {residentFlatNo === ''
                              ? 'No flat is linked to this account'
                              : `Flat ${residentFlatNo} · Allotment registry`}
                          </p>
                        </>
                      ) : (
                        <>
                          <h2 className="text-2xl font-bold text-[var(--mv-ink)]">{currentRole} Executive Suite</h2>
                          <p className="text-xs text-[var(--mv-muted)]">Fully Authorized Administrative Operations Center</p>
                        </>
                      )}
                    </div>
                    <div className="text-right text-xs font-mono">
                      <p className="text-[10px] text-[var(--mv-muted)] font-bold uppercase tracking-wider">Ledger Synchronized</p>
                      <p className="text-[var(--mv-accent)] font-bold">STATE ONLINE · SECURE</p>
                    </div>
                  </div>

                  {/* 4-ACROSS DASHBOARD TILES */}
                  {currentRole === 'Resident' && (
                    <div className="grid grid-cols-4 gap-4">
                      {/* Current outstanding */}
                      <div className="bg-[var(--mv-ink)] text-white p-5 rounded-2xl flex flex-col justify-between shadow-md min-h-[120px]">
                        <p className="text-[10px] font-bold text-white/70 uppercase tracking-widest">Aggregate Outstanding</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-white">{formatRupee(rohanTotalDueNum)}</p>
                          <span className={`inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold rounded uppercase ${rohanTotalDueNum > 0 ? 'bg-red-700 text-white' : 'bg-[var(--mv-accent)] text-white'}`}>
                            {rohanTotalDueNum > 0 ? 'ARREARS DUE' : 'ALL CLEAR'}
                          </span>
                        </div>
                      </div>

                      {/* Cumulative paid */}
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-widest">Deposit Paid This FY</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{formatRupee(rohanTotalPaidNum)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] rounded">
                            {rohanInvoices.filter(inv => inv.status === 'Paid').length} DEPOSITS AUDITED
                          </span>
                        </div>
                      </div>

                      {/* Prepaid advance balance */}
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-widest">Prepaid Advances</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{formatRupees(residentAdvancePaise)}</p>
                          <span className="text-[9px] text-[var(--mv-muted)] mt-2 block font-medium">Held on account, from the ledger</span>
                        </div>
                      </div>

                      {/* Open complaints helpdesk */}
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-widest">Complaints Grievances</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{String(rohanOpenTicketsNum).padStart(2, '0')}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] rounded">
                            ACTIVE SUPPORT
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {currentRole === 'Manager' && (
                    <div className="grid grid-cols-4 gap-4">
                      {/* Collected MTD */}
                      <div className="bg-[var(--mv-ink)] text-white p-5 rounded-2xl flex flex-col justify-between shadow-md min-h-[120px]">
                        <p className="text-[10px] font-bold text-white/70 uppercase tracking-widest">Collected MTD Accrual</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-white">{formatRupee(mtdCollectedTotal)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-semibold bg-white/10 text-white rounded">
                            FY 2026-27 REVENUE
                          </span>
                        </div>
                      </div>

                      {/* Outstanding Receivables */}
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-widest">Arrears Outstanding</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{formatRupee(mtdOutstandingTotal)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] rounded">
                            ACTIVE DEFAULTERS
                          </span>
                        </div>
                      </div>

                      {/* Overdue units */}
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-widest">Overdue Defaulters</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{uniqueDefaultersCount} Flats</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-semibold bg-red-50 text-red-600 rounded">
                            OVERDUE DISPATCHED
                          </span>
                        </div>
                      </div>

                      {/* Outgoing expenses MTD */}
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-widest">Approved Expenses MTD</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{formatRupee(totalMTDExpenses)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] rounded">
                            VENDORS AUDITED
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {currentRole === 'Committee' && (
                    <div className="grid grid-cols-4 gap-4">
                      {/* Corpus fund */}
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-widest">General Reserve</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{formatRupees(reserveFundPaise)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] rounded">
                            LEDGER BALANCE
                          </span>
                        </div>
                      </div>

                      {/* Sinking reserve */}
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-widest">Accumulated Sinking Contributions</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{formatRupees(sinkingFundPaise)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-semibold bg-[var(--mv-soft)] text-[var(--mv-ink)] rounded">
                            LEDGER BALANCE
                          </span>
                        </div>
                      </div>

                      {/* Liquid cash reserves */}
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-widest">Liquid Operating Bank Balance</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{formatRupees(operatingBankPaise)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] rounded">
                            PER THE BOOKS
                          </span>
                        </div>
                      </div>

                      {/* Outstanding bills proposals */}
                      <div className="bg-[var(--mv-ink)] text-white p-5 rounded-2xl flex flex-col justify-between shadow-md min-h-[120px]">
                        <p className="text-[10px] font-bold text-white/70 uppercase tracking-widest">Pending Bill Proposals</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-white">{pendingApprovalsCount} Bills</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold bg-white/10 text-white rounded uppercase">
                            GOVERNING ACTION NEEDED
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* BOTTOM GRIDS */}
                  {currentRole === 'Resident' && (
                    <div className="grid grid-cols-12 gap-6 pt-2">
                      <div className="col-span-8 flex flex-col">
                        {rohanDueInvoice ? (
                          <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs flex-1 flex flex-col justify-between space-y-4">
                            <div>
                              <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Unpaid active billing assessment due</span>
                              <h3 className="font-extrabold text-lg text-[var(--mv-ink)] mt-1">Invoice Number: #{rohanDueInvoice.invoiceNo}</h3>
                            </div>

                            <div className="border-y border-[var(--mv-soft)] py-5 flex justify-between items-center bg-[var(--mv-page)] px-4 rounded-xl">
                              <div>
                                <p className="text-xs text-[var(--mv-muted)] font-medium">{rohanDueInvoice.period} General Maintenance Account</p>
                                <p className="text-3xl font-extrabold text-[var(--mv-ink)] font-mono mt-1">{formatRupee(rohanDueInvoice.total)}</p>
                              </div>
                              {mayPayOnline && (
                                <button
                                  onClick={() => handlePayClick(rohanDueInvoice)}
                                  className="bg-[var(--mv-accent)] hover:brightness-90 text-white px-6 py-3.5 rounded-xl font-bold text-xs uppercase cursor-pointer transition-all shadow-md active:scale-95"
                                >
                                  Clear Due Balance
                                </button>
                              )}
                            </div>

                            <span className="text-[10px] text-[var(--mv-muted)] font-medium leading-relaxed block">
                              {onServer
                                ? `• ${dueLabel(dueIso(rohanDueInvoice), today).toLowerCase()}. No payment gateway is connected: pay the association by UPI, NEFT or cheque and the manager records the receipt against your flat.`
                                : '• Demo checkout. No payment gateway is connected — paying marks the invoice settled in this browser and posts the matching journal entry. A live version needs a Razorpay or PayU account and a server to verify the callback.'}
                            </span>
                          </div>
                        ) : (
                          <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-10 shadow-xs flex-1 flex flex-col items-center justify-center text-center">
                            <Check className="w-12 h-12 text-[var(--mv-accent)] mb-2" />
                            <h4 className="font-bold text-base text-[var(--mv-ink)]">No Active Invoices Pending</h4>
                            <p className="text-xs text-[var(--mv-muted)] max-w-sm mt-1">Your resident core billing ledger has zero pending outstanding balances. Thank you for your proactive support!</p>
                          </div>
                        )}
                      </div>

                      {/* Mini ledger logs activity */}
                      <div className="col-span-4 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs flex flex-col justify-between">
                        <div>
                          <div className="flex justify-between items-center mb-4 select-none">
                            <h3 className="font-bold text-xs uppercase tracking-tight text-[var(--mv-ink)]">Ledger accounts activity</h3>
                            <button onClick={() => setActiveTab('bills')} className="text-[var(--mv-accent)] text-[10px] font-bold uppercase hover:underline">
                              Full index
                            </button>
                          </div>

                          <div className="space-y-3 max-h-[220px] overflow-y-auto pr-1 hide-scrollbar">
                            {rohanInvoices.slice(0, 4).map(inv => (
                              <div
                                key={inv.id}
                                onClick={() => {
                                  if (inv.status === 'Paid') {
                                    setSelectedReceipt(inv);
                                    setShowReceiptModal(true);
                                  } else {
                                    setSelectedInvoice(inv);
                                    setActiveTab('bills');
                                  }
                                }}
                                className="flex items-center justify-between p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] hover:bg-[var(--mv-soft)] transition-all cursor-pointer text-xs"
                              >
                                <div className="min-w-0 flex-1 pr-2">
                                  <p className="font-bold text-[var(--mv-ink)] truncate">{inv.period} Maintenance</p>
                                  <p className="text-[9px] text-[var(--mv-muted)] uppercase mt-0.5 leading-none font-medium">{inv.paidDate || inv.dueDate || ''}</p>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="font-bold text-[var(--mv-ink)] font-mono leading-none">{formatRupee(inv.total)}</p>
                                  <span className={`inline-block mt-1 px-1.5 py-0.5 text-[8px] font-bold text-white rounded uppercase leading-none ${inv.status === 'Paid' ? 'bg-[var(--mv-accent)]' : 'bg-[var(--mv-ink)]'}`}>
                                    {inv.status}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Manager and Committee chart layouts - Full scalable width */}
                  {currentRole === 'Manager' && (
                    <div className="grid grid-cols-12 gap-6 pt-1">
                      {/* Scalable Chart */}
                      <div className="col-span-8 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs">
                        <div className="flex justify-between items-center mb-4">
                          <div>
                            <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-wider">Collections by billing period</h4>
                            <p className="text-[10px] text-[var(--mv-muted)]">Paid against still outstanding, for the last six periods billed</p>
                          </div>
                          <TrendingUp className="w-4 h-4 text-[var(--mv-accent)]" />
                        </div>

                        <div className="h-80 w-full pt-1 select-none">
                          {collectionTrendsData.length === 0 ? (
                            <p className="py-24 text-center text-xs text-[var(--mv-muted)]">No invoices yet, so there is nothing to chart.</p>
                          ) : (
                            <Suspense fallback={<PanelLoading />}>
                              <CollectionChart data={collectionTrendsData} />
                            </Suspense>
                          )}
                        </div>
                      </div>

                      {/* Operation launch pad */}
                      <div className="col-span-4 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs flex flex-col justify-between">
                        <div>
                          <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-wider mb-4 border-b border-[var(--mv-border)] pb-2 text-left">Quick Admin Dispatch</h4>
                          <p className="text-xs text-[var(--mv-muted)] leading-relaxed mb-6">Launch water supply assessments, common lift backups operations, parking space levies, and non-occupancy utility taxes across core residential registry ledgers.</p>
                        </div>
                        <div className="space-y-3.5">
                          <button
                            onClick={() => {
                              setShowBillingWizard(true);
                              setActiveTab('bills');
                            }}
                            className="w-full py-3.5 px-4 bg-[var(--mv-accent)] hover:brightness-90 text-white rounded-xl text-xs font-bold shadow-md transition-all flex items-center justify-center gap-1.5 cursor-pointer uppercase tracking-wider"
                          >
                            <Plus className="w-4 h-4" aria-hidden="true" /> Run billing for {wizardPeriod}
                          </button>
                          <button
                            onClick={() => setActiveTab('pay')}
                            className="w-full py-3 px-5 bg-[var(--mv-ink)] hover:bg-black text-white rounded-xl text-xs font-bold transition-all text-center cursor-pointer uppercase tracking-wider"
                          >
                            Defaulting Accounts Ageing
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {currentRole === 'Committee' && (
                    <div className="grid grid-cols-12 gap-6 pt-1">
                      {/* Budget Chart */}
                      <div className="col-span-7 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs text-left">
                        <div className="flex justify-between items-center mb-4">
                          <div>
                            <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-wider">Approved FY Budget vs Realized Revenue Ledger</h4>
                            <p className="text-[10px] text-[var(--mv-muted)]">{onServer ? 'Needs an approved budget' : 'Demonstration budget figures — not an approved budget'}</p>
                          </div>
                        </div>

                        <div className="h-80 w-full pt-1 select-none">
                          {onServer ? (
                            <p className="py-24 text-center text-xs text-[var(--mv-muted)] max-w-sm mx-auto">
                              No approved budget is on record on the server, so there is nothing to compare against yet.
                            </p>
                          ) : (
                            <Suspense fallback={<PanelLoading />}>
                              <BudgetChart data={budgetPerformanceData} />
                            </Suspense>
                          )}
                        </div>
                      </div>

                      {/* Required vendor approvals panel */}
                      <div className="col-span-5 bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl shadow-xs text-left flex flex-col justify-between">
                        <div>
                          <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-wider mb-4 border-b border-[var(--mv-border)] pb-2">Governing Vendor Approvals</h4>

                          <div className="space-y-3 overflow-y-auto max-h-[260px] pr-1 hide-scrollbar">
                            {vendorInvoices.filter(vi => vi.status === 'Pending').length === 0 ? (
                              <div className="py-12 text-center text-xs text-[var(--mv-muted)] font-semibold uppercase tracking-wider">
                                RWA Balance Reconciled! No pending proposals.
                              </div>
                            ) : (
                              vendorInvoices.filter(vi => vi.status === 'Pending').map(vi => (
                                <div key={vi.id} className="p-3.5 border border-[var(--mv-border)] rounded-xl bg-[var(--mv-page)]/60 space-y-2 text-xs">
                                  <div className="flex justify-between items-baseline">
                                    <div>
                                      <span className="text-[8px] font-extrabold text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] px-1.5 py-0.5 rounded uppercase font-mono">
                                        {vi.category}
                                      </span>
                                      <h5 className="font-bold text-[var(--mv-ink)] mt-1.5">{vi.vendorName}</h5>
                                    </div>
                                    <span className="font-mono font-bold text-[var(--mv-ink)]">{formatRupee(vi.amount)}</span>
                                  </div>
                                  <div className="bg-[var(--mv-surface)] p-2 rounded border border-[var(--mv-border)] text-[9px] text-[var(--mv-muted)] flex justify-between items-center leading-none">
                                    <span>TDS Withheld (194C): <strong className="font-mono text-[var(--mv-ink)]">{formatRupee(vi.tdsAmount)}</strong></span>
                                    <span>Net Payable: <strong className="font-mono text-[var(--mv-ink)]">{formatRupee(vi.netPayable)}</strong></span>
                                  </div>
                                  <div className="flex gap-2 justify-end pt-1">
                                    {!onServer && (
                                      <button
                                        onClick={() => handleVendorInvoiceStatus(vi.id, 'Rejected')}
                                        disabled={working}
                                        className="py-1 px-3 border border-[var(--mv-border)] rounded text-[9px] font-bold text-[var(--mv-muted)] hover:bg-[var(--mv-surface)] active:scale-95 disabled:opacity-60"
                                      >
                                        Reject
                                      </button>
                                    )}
                                    <button
                                      onClick={() => handleVendorInvoiceStatus(vi.id, 'Approved')}
                                      disabled={working}
                                      className="py-1 px-3 bg-[var(--mv-accent)] text-white rounded text-[9px] font-bold hover:brightness-90 active:scale-95 disabled:opacity-60"
                                    >
                                      Approve
                                    </button>
                                    {books.snapshot().vendorBills.find(v => v.id === vi.id)?.state === 'booked' && (
                                      <button
                                        onClick={() => handlePayVendor(vi.id)}
                                        className="py-1 px-3 bg-[var(--mv-ink)] text-white rounded text-[9px] font-bold hover:bg-black active:scale-95"
                                      >
                                        Pay
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* -------------------- BILLS TWO-PANE TAB -------------------- */}
              {activeTab === 'bills' && (
                <div className="space-y-6 max-w-7xl mx-auto animate-scale-up text-left">
                  <div className="flex justify-between items-end border-b border-[var(--mv-border)] pb-4">
                    <div>
                      <h2 className="text-2xl font-bold text-[var(--mv-ink)]">Receivables Ledger Directory</h2>
                      <p className="text-xs text-[var(--mv-muted)]">Fully compliant regulatory invoices generated for Mani Vista residents</p>
                    </div>
                    {currentRole !== 'Resident' && (
                      <button
                        onClick={() => setShowBillingWizard(!showBillingWizard)}
                        aria-expanded={showBillingWizard}
                        className="py-2.5 px-4 bg-[var(--mv-ink)] hover:bg-black text-white text-xs font-bold uppercase rounded-xl shadow-md flex items-center gap-1.5"
                      >
                        <Plus className="w-4 h-4" /> {showBillingWizard ? 'Minimize Billing' : 'Launch New Campaign'}
                      </button>
                    )}
                  </div>

                  {/* The document workflow: where a proforma is in its life. */}
                  {currentRole !== 'Resident' && (
                    <div className="p-6 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl shadow-xs">
                      <BillingWorkflow
                        documents={registerDocuments}
                        problems={books.snapshot().problems}
                        today={today}
                        onApproveAll={handleApproveAllDrafts}
                        onReleaseApproved={handleReleaseApproved}
                        onConvertDue={handleConvertDue}
                      />
                    </div>
                  )}

                  {/* Wizard element positioned dynamically */}
                  {showBillingWizard && currentRole !== 'Resident' && (
                    <div className="p-6 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl max-w-3xl animate-scale-up space-y-4">
                      <div className="flex justify-between items-center border-b border-[var(--mv-border)] pb-3">
                        <span className="font-bold text-xs uppercase tracking-wider text-[var(--mv-ink)]">Billing run</span>
                        <button onClick={() => setShowBillingWizard(false)} className="text-[var(--mv-accent)] hover:underline text-xs font-semibold">Dismiss</button>
                      </div>

                      <form onSubmit={handleRunBillGeneration} className="space-y-4 text-xs font-medium">
                        {renderWizardFields(false)}
                      </form>
                    </div>
                  )}

                  {/* MASTER DETAIL TWO-PANE GRID */}
                  <div className="grid grid-cols-12 gap-6 items-start">
                    {/* LEFT MASTER LIST */}
                    <div className="col-span-5 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl shadow-xs overflow-hidden flex flex-col">
                      <div className="p-4 border-b border-[var(--mv-border)] bg-[var(--mv-page)] select-none font-bold text-[10px] uppercase tracking-wider text-[var(--mv-muted)]">
                        Select Invoice Receipts ({currentInvoices.length} Found)
                      </div>

                      <div className="divide-y divide-[var(--mv-border)] max-h-[580px] overflow-y-auto hide-scrollbar">
                        {currentInvoices.map(inv => {
                          const isActive = desktopActiveInvoice?.id === inv.id;
                          return (
                            <div
                              key={inv.id}
                              onClick={() => setSelectedInvoice(inv)}
                              className={`p-4 text-left cursor-pointer transition-all flex justify-between items-center ${isActive ? 'bg-[var(--mv-accent-soft)]/40 border-l-4 border-[var(--mv-accent)]' : 'hover:bg-[var(--mv-soft)] bg-[var(--mv-surface)]'}`}
                            >
                              <div className="min-w-0 flex-1 pr-2">
                                <span className="font-mono text-[9px] text-[var(--mv-muted)] font-bold tracking-tight block uppercase leading-none">Invoice No: {inv.invoiceNo}</span>
                                <h4 className="font-extrabold text-[var(--mv-ink)] mt-1.5 text-xs truncate">
                                  {inv.period} Maintenance {currentRole !== 'Resident' ? `(Flat ${inv.flatNo})` : ''}
                                </h4>
                                <p className="text-[9px] text-[var(--mv-muted)] font-bold mt-1 uppercase">Owner: {inv.name}</p>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="font-mono text-xs font-bold text-[var(--mv-ink)]">{formatRupee(inv.total)}</p>
                                <span className={`inline-block mt-1 px-1.5 py-0.5 text-[8px] font-extrabold text-white rounded uppercase leading-none ${inv.status === 'Paid' ? 'bg-[var(--mv-accent)]' : 'bg-[var(--mv-ink)]'}`}>
                                  {inv.status}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* RIGHT DETAIL PRESENTATION */}
                    <div className="col-span-7 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl shadow-sm p-6 space-y-4 min-h-[540px] flex flex-col justify-between">
                      {desktopActiveInvoice ? (
                        <>
                          <div className="space-y-4">
                            <div className="flex justify-between items-start">
                              <div>
                                <span className="text-[9px] font-bold uppercase text-[var(--mv-muted)] tracking-widest leading-none">Registered Society CHS RWA</span>
                                <h3 className="font-extrabold text-lg text-[var(--mv-ink)] mt-1.5">Mani Vista Residents Association</h3>
                                <p className="text-[10px] text-[var(--mv-muted)] font-medium">{societyName} · GSTIN {gstinLabel}</p>
                              </div>
                              <div className="text-right">
                                {desktopActiveInvoice.status === 'Paid' ? (
                                  <span className="px-3 py-1.5 text-[9px] font-bold rounded-lg bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] text-[var(--mv-accent)] uppercase select-none leading-none inline-block">
                                    Paid reconciled
                                  </span>
                                ) : (
                                  <span className="px-3 py-1.5 text-[9px] font-bold rounded-lg bg-red-50 text-red-700 border border-red-200 uppercase select-none leading-none inline-block">
                                    Overdue arrears
                                  </span>
                                )}
                              </div>
                            </div>

                            <hr className="border-[var(--mv-border)]" />

                            <div className="grid grid-cols-4 gap-3 bg-[var(--mv-page)] p-4 border border-[var(--mv-border)] rounded-2xl text-[10px] leading-relaxed">
                              <div>
                                <p className="font-bold uppercase tracking-tight text-[var(--mv-muted)]">Tax Invoice ID</p>
                                <p className="font-bold text-[var(--mv-ink)] font-mono mt-1">{desktopActiveInvoice.invoiceNo}</p>
                              </div>
                              <div>
                                <p className="font-bold uppercase tracking-tight text-[var(--mv-muted)]">Cycle Period</p>
                                <p className="font-bold text-[var(--mv-ink)] font-mono mt-1">{desktopActiveInvoice.period}</p>
                              </div>
                              <div>
                                <p className="font-bold uppercase tracking-tight text-[var(--mv-muted)]">Flat Reference</p>
                                <p className="font-bold text-[var(--mv-ink)] font-mono mt-1">{desktopActiveInvoice.flatNo}</p>
                              </div>
                              <div>
                                <p className="font-bold uppercase tracking-tight text-[var(--mv-muted)]">Resident Owner</p>
                                <p className="font-bold text-[var(--mv-ink)] mt-1 truncate">{desktopActiveInvoice.name}</p>
                              </div>
                            </div>

                            <div className="space-y-2 pt-2 text-xs">
                              <h5 className="font-extrabold text-[9px] uppercase tracking-wider text-[var(--mv-muted)] border-b border-[var(--mv-border)] pb-2">Billing Breakdown particulars</h5>

                              <div className="flex justify-between items-center py-1">
                                <span className="text-[var(--mv-muted)] font-medium">Common Area General Maintenance</span>
                                <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(desktopActiveInvoice.maintenance)}</span>
                              </div>
                              <div className="flex justify-between items-center py-1">
                                <span className="text-[var(--mv-muted)] font-medium font-sans">Sinking Surcharge contributions</span>
                                <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(desktopActiveInvoice.sinkingFund)}</span>
                              </div>
                              <div className="flex justify-between items-center py-1">
                                <span className="text-[var(--mv-muted)] font-medium">Water Utility tank infrastructure levy</span>
                                <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(desktopActiveInvoice.waterCharges)}</span>
                              </div>
                              <div className="flex justify-between items-center py-1">
                                <span className="text-[var(--mv-muted)] font-medium">Lock-up car parking reserve charges</span>
                                <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(desktopActiveInvoice.parkingCharges)}</span>
                              </div>
                              <div className="flex justify-between items-center py-1">
                                <span className="text-[var(--mv-muted)] font-medium">Non-Occupancy regulatory surcharge</span>
                                <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(desktopActiveInvoice.nonOccupancyCharges)}</span>
                              </div>

                              {desktopActiveInvoice.gst > 0 && (
                                <>
                                  <hr className="border-[var(--mv-border)] my-2" />
                                  <div className="flex justify-between items-center text-[var(--mv-muted)] py-0.5">
                                    <span>CGST (half of the GST charged)</span>
                                    <span className="font-mono font-bold">{formatRupee(desktopActiveInvoice.gst / 2)}</span>
                                  </div>
                                  <div className="flex justify-between items-center text-[var(--mv-muted)] py-0.5">
                                    <span>SGST (half of the GST charged)</span>
                                    <span className="font-mono font-bold">{formatRupee(desktopActiveInvoice.gst / 2)}</span>
                                  </div>
                                </>
                              )}

                              {desktopActiveInvoice.latePenalty > 0 && (
                                <div className="flex justify-between items-center py-2 bg-red-50/60 px-3.5 rounded-lg border border-red-100 mt-2 text-red-700">
                                  <span className="font-bold text-[10px]">Late-payment interest</span>
                                  <span className="font-mono font-bold text-xs">{formatRupee(desktopActiveInvoice.latePenalty)}</span>
                                </div>
                              )}
                            </div>

                            <hr className="border-t-2 border-[var(--mv-ink)] border-dashed" />

                            <div className="flex justify-between items-center bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] p-4 rounded-xl shadow-xs select-none">
                              <span className="text-xs font-bold text-[var(--mv-accent)] uppercase tracking-wider">Net Accountable dues</span>
                              <span className="text-xl font-extrabold text-[var(--mv-accent)] font-mono">{formatRupee(desktopActiveInvoice.total)}</span>
                            </div>
                          </div>

                          {/* Footer details action */}
                          <div className="pt-4 border-t border-[var(--mv-border)] flex justify-between items-center bg-[var(--mv-page)]/50 rounded-b-2xl p-4 -mx-6 -mb-6">
                            <button
                              onClick={() => handleDownloadInvoice(desktopActiveInvoice)}
                              className="py-2.5 px-4 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-xl text-xs font-semibold text-[var(--mv-ink)] hover:bg-[var(--mv-soft)] transition-all flex items-center justify-center gap-1 cursor-pointer active:scale-95 shadow-xs"
                            >
                              <Download className="w-4 h-4 text-[var(--mv-muted)]" aria-hidden="true" /> {onServer ? 'Download PDF' : 'Export summary (demo)'}
                            </button>

                            {desktopActiveInvoice.status !== 'Paid' && currentRole === 'Resident' && mayPayOnline && (
                              <button
                                onClick={() => handlePayClick(desktopActiveInvoice)}
                                className="py-2.5 px-6 bg-[var(--mv-accent)] text-white text-xs font-bold rounded-xl shadow cursor-pointer uppercase tracking-wider"
                              >
                                Clear dues now
                              </button>
                            )}

                            {desktopActiveInvoice.status !== 'Paid' && currentRole !== 'Resident' && !onServer && (
                              <button
                                onClick={() => handleSendReminder(desktopActiveInvoice)}
                                className="py-2.5 px-6 bg-[var(--mv-ink)] text-white text-xs font-bold rounded-xl shadow cursor-pointer uppercase tracking-wider flex items-center gap-1.5"
                              >
                                <Send className="w-3.5 h-3.5" /> Dispatch Alert
                              </button>
                            )}

                            {desktopActiveInvoice.status === 'Paid' && (
                              <div className="py-2 px-4 bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] font-bold text-xs uppercase rounded-xl flex items-center gap-1">
                                <CheckCircle className="w-4 h-4" /> Account settled
                              </div>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-center py-20 text-[var(--mv-muted)]">
                          <FileText className="w-12 h-12 text-[var(--mv-muted)] mb-2" />
                          <p className="text-xs font-bold uppercase tracking-wider">No active accounts selected</p>
                          <p className="text-[11px] text-[var(--mv-muted)] max-w-sm mt-1">Select an active resident accounts tax invoice from the master index layout on the left to review allocations.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* -------------------- PAY MODULES FOR DESKTOP -------------------- */}
              {activeTab === 'pay' && (
                <div className="space-y-6 max-w-7xl mx-auto animate-scale-up text-left">
                  {currentRole === 'Resident' ? (
                    <>
                      <div>
                        <h2 className="text-2xl font-bold text-[var(--mv-ink)]">Reconcile Core Ledger Account</h2>
                        <p className="text-xs text-[var(--mv-muted)]">Authorize water tankers infrastructure clearing, UPI transactions, and unearned advance predepositions</p>
                      </div>

                      <div className="grid grid-cols-12 gap-6 items-start">
                        {payingInvoice ? (
                          <div className="col-span-7 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs space-y-4">
                            <div className="flex justify-between items-center border-b border-[var(--mv-border)] pb-2">
                              <span className="font-extrabold text-[10px] uppercase text-[var(--mv-muted)] tracking-wider font-mono">Checkout — no gateway connected</span>
                              <button onClick={() => setPayingInvoice(null)} className="text-xs font-bold text-[var(--mv-accent)] hover:underline">Dismiss</button>
                            </div>

                            <div className="p-4 bg-[var(--mv-accent-soft)] rounded-2xl border border-[var(--mv-accent-border)]">
                              <span className="text-[10px] text-[var(--mv-accent)] font-bold font-mono tracking-wider">{payingInvoice.invoiceNo}</span>
                              <h4 className="font-bold text-base text-[var(--mv-ink)] mt-1">{payingInvoice.period} General Maintenance Accruals</h4>
                              <div className="mt-4 flex justify-between items-baseline pt-3 border-t border-[var(--mv-accent-border)]/40 font-mono">
                                <span className="text-[10px] font-bold uppercase text-[var(--mv-accent)]/70">Net clearance Total</span>
                                <span className="text-2xl font-extrabold text-[var(--mv-accent)]">{formatRupee(payingInvoice.total)}</span>
                              </div>
                            </div>

                            <form onSubmit={handleExecutePayment} className="space-y-4 text-xs font-medium">
                              <span className="text-[10px] uppercase font-bold text-[var(--mv-muted)]" id="pmethod-desk-label">Payment method</span>

                              <div className="grid grid-cols-4 gap-3" role="radiogroup" aria-labelledby="pmethod-desk-label">
                                {[
                                  { id: 'UPI', label: 'UPI / BHIM' },
                                  { id: 'Net Banking', label: 'Net Banking' },
                                  { id: 'Card', label: 'Debit/Credit Card' },
                                  { id: 'Wallet', label: 'Wallets' }
                                ].map(item => (
                                  <label
                                    key={item.id}
                                    className={`cursor-pointer p-3 border rounded-xl flex flex-col items-center justify-center text-center gap-2 transition-all ${paymentMethod === item.id ? 'border-[var(--mv-accent)] bg-[var(--mv-accent-soft)]/40 text-[var(--mv-accent)] font-bold' : 'border-[var(--mv-border)] bg-[var(--mv-surface)] hover:bg-[var(--mv-soft)] text-[var(--mv-muted)]'}`}
                                  >
                                    <input
                                      type="radio"
                                      name="pmethod-desk"
                                      checked={paymentMethod === item.id}
                                      onChange={() => setPaymentMethod(item.id as any)}
                                      className="sr-only"
                                    />
                                    <span>{item.label}</span>
                                  </label>
                                ))}
                              </div>

                              <div className="space-y-1">
                                <label htmlFor="pay-amount-desk" className="text-[10px] font-bold text-[var(--mv-muted)] block uppercase">Amount to pay (INR)</label>
                                <input
                                  id="pay-amount-desk"
                                  type="number"
                                  value={partialAmountInput}
                                  onChange={(e) => setPartialAmountInput(e.target.value)}
                                  placeholder={`e.g. ${payingInvoice.total}`}
                                  className="w-full bg-[var(--mv-page)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold font-mono outline-none"
                                />
                                <span className="text-[9px] text-[var(--mv-muted)] block font-medium">Leave completely blank to clear full aggregate assessment index of {formatRupee(payingInvoice.total)} instantly.</span>
                              </div>

                              <button
                                type="submit"
                                disabled={working}
                                className="w-full py-3.5 bg-[var(--mv-accent)] hover:brightness-90 text-white rounded-xl shadow font-bold text-xs uppercase text-center cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                              >
                                {working ? 'Recording…' : 'Record payment'}
                              </button>
                            </form>
                          </div>
                        ) : (
                          <div className="col-span-7 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs space-y-4">
                            <span className="text-[10px] uppercase font-bold text-[var(--mv-muted)] tracking-wider block border-b border-[var(--mv-border)] pb-2">Overdue pending receivables assessments</span>

                            <div className="divide-y divide-[var(--mv-border)]">
                              {invoices.filter(inv => inv.flatNo === residentFlatNo && inv.status !== 'Paid').length === 0 ? (
                                <p className="py-12 text-center text-xs font-semibold font-mono text-[var(--mv-muted)]">Your accounts ledger has zero active arrears! Standard accounts in green state.</p>
                              ) : (
                                invoices
                                  .filter(inv => inv.flatNo === residentFlatNo && inv.status !== 'Paid')
                                  .map(inv => (
                                    <div key={inv.id} className="py-3 flex justify-between items-center text-xs font-medium">
                                      <div>
                                        <p className="font-extrabold text-[var(--mv-ink)]">{inv.period} Maintenance invoice assessment</p>
                                        <p className="text-[9px] text-[var(--mv-muted)] font-bold uppercase mt-1">Invoice ID: {inv.invoiceNo}</p>
                                      </div>
                                      <div className="text-right flex items-center gap-3">
                                        <span className="font-mono font-bold text-red-700">{formatRupee(inv.total)}</span>
                                        {mayPayOnline && (
                                          <button
                                            onClick={() => handlePayClick(inv)}
                                            className="py-1.5 px-3 bg-[var(--mv-accent)] hover:brightness-90 text-white text-[10px] font-bold rounded-lg uppercase"
                                          >
                                            Pay
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  ))
                              )}
                            </div>
                          </div>
                        )}

                        {/* Predeposition advance right panel */}
                        <div className="col-span-5 bg-[var(--mv-surface)] border border-[var(--mv-border)] p-6 rounded-2xl shadow-xs space-y-4 text-xs font-medium">
                          <span className="text-[10px] uppercase font-bold text-[var(--mv-ink)] tracking-wider block border-b border-[var(--mv-border)] pb-2">Prepay advances reserve</span>
                          <p className="text-[var(--mv-muted)] leading-relaxed">Residents may predispatch lump-sum advances. Standard RWA double-entry protocols automatically offset incoming monthly assessments ledger from advance assets.</p>

                          {!mayPayOnline ? (
                            <p className="text-[11px] text-[var(--mv-muted)] leading-relaxed">
                              No payment gateway is connected. Pay the association by UPI, NEFT or cheque and the
                              manager records it; anything beyond your dues is held here as an advance
                              ({formatRupees(residentAdvancePaise)} now).
                            </p>
                          ) : (
                          <form onSubmit={handleExecuteAdvance} className="space-y-4 pt-1">
                            <div className="space-y-1">
                              <label htmlFor="advance-desk" className="text-[10px] text-[var(--mv-muted)] uppercase block">Deposit Sum (INR)</label>
                              <input
                                id="advance-desk"
                                type="number"
                                value={customAdvanceInput}
                                onChange={(e) => setCustomAdvanceInput(e.target.value)}
                                placeholder="e.g. 5000"
                                className="w-full bg-[var(--mv-page)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold font-mono outline-none"
                              />
                            </div>
                            <button type="submit" disabled={working} className="w-full py-2.5 bg-[var(--mv-ink)] text-white font-bold rounded-xl active:scale-95 transition-all uppercase text-center cursor-pointer disabled:opacity-60">
                              Deposit advance
                            </button>
                          </form>
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <h2 className="text-2xl font-bold text-[var(--mv-ink)]">Receivables Ageing Room</h2>
                        <p className="text-xs text-[var(--mv-muted)]">{onServer
                          ? 'Arrears by flat, and receipts for money that has reached the bank. Reminders are not sent from here yet.'
                          : 'Review arrears and log reminders against each flat. Sending them over SMS or WhatsApp needs a messaging account, so reminders are only recorded here.'}</p>
                      </div>

                      <div className="grid grid-cols-12 gap-6 items-start">
                        {/* Overdue table list */}
                        <div className="col-span-7 bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl shadow-xs space-y-3">
                          <div className="flex justify-between items-center border-b border-[var(--mv-border)] pb-2">
                            <span className="text-[10px] font-bold uppercase text-[var(--mv-muted)] tracking-wider">Flats with outstanding accounts ({overdueInvoices.length})</span>
                            <span className="text-[9px] font-bold text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] px-2 py-0.5 rounded uppercase font-mono">AR OVERDUE</span>
                          </div>

                          <div className="space-y-2.5 overflow-y-auto max-h-[380px] pr-1 hide-scrollbar">
                            {overdueInvoices.length === 0 ? (
                              <p className="py-12 text-center text-xs font-semibold text-[var(--mv-muted)]">All member accounts fully clear! Active collections settled.</p>
                            ) : (
                              overdueInvoices.map(inv => (
                                <div key={inv.id} className="p-3.5 bg-[var(--mv-page)] rounded-xl flex justify-between items-center text-xs border border-[var(--mv-border)]">
                                  <div className="min-w-0 flex-1 pr-2">
                                    <div className="flex items-center gap-2">
                                      <span className="font-extrabold text-[var(--mv-ink)] text-sm">{inv.flatNo}</span>
                                      <span className="text-[10px] font-bold text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] px-2 py-0.5 rounded-md truncate">{inv.name}</span>
                                    </div>
                                    <span className="text-[10px] text-[var(--mv-muted)] block mt-1">Period Cycle: {inv.period} · Standard 30 days grace elapsed</span>
                                  </div>
                                  <div className="text-right flex items-center gap-3 shrink-0">
                                    <span className="font-bold font-mono text-red-700 text-xs">{formatRupee(inv.total)}</span>
                                    {!onServer && (
                                      <button
                                        onClick={() => handleSendReminder(inv)}
                                        className="w-8 h-8 rounded-lg bg-[var(--mv-accent-soft)] hover:bg-[var(--mv-accent-border)] text-[var(--mv-accent)] flex items-center justify-center cursor-pointer shadow-xs transition-colors"
                                        title={`Log a reminder for ${inv.flatNo}`}
                                        aria-label={`Log a reminder for flat ${inv.flatNo}`}
                                      >
                                        <Send className="w-3.5 h-3.5" aria-hidden="true" />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>

                        {/* Receipt entry: money already in the bank, against a flat. */}
                        <div className="col-span-5 bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl shadow-xs">
                          {mayRecordReceipts ? (
                            <ReceiptEntryForm
                            flats={members.map(m => ({ flatNo: m.flatNo, name: m.name }))}
                            openDocumentsFor={openDocumentsFor}
                            actions={mustActions()}
                            today={today}
                            by={`${currentRole} (${sessionEmail ?? 'local'})`}
                            onRecorded={handleReceiptRecorded}
                            onError={message => triggerToast(message, 'error')}
                            {...(onServer ? { onDownloadReceipt: downloadReceiptPdf } : {})}
                            note={onServer
                              ? 'For money already in the association\'s bank. The server numbers the receipt and allocates it oldest invoice first unless you name one; anything over the dues is held as an advance. No bank or gateway is contacted.'
                              : 'Demonstration: recorded in this browser only. No bank or gateway is contacted.'}
                            
                          />
                          ) : (
                            <p className="text-xs text-[var(--mv-muted)] leading-relaxed">
                              Receipts are recorded by the manager. This account does not hold the
                              payment.record permission.
                            </p>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* -------------------- BOOKS DOUBLE ENTRY TAB -------------------- */}
              {activeTab === 'books' && currentRole !== 'Resident' && (
                <div className="space-y-6 max-w-7xl mx-auto animate-scale-up text-left">
                  <div>
                    <h2 className="text-2xl font-bold text-[var(--mv-ink)]">RWA Double-Entry Financial Books & Audits</h2>
                    <p className="text-xs text-[var(--mv-muted)]">Fully compliant regulatory audits, comparative assets, and live double-entry general journal ledger balances</p>
                  </div>

                  {/* Books sub-navigation */}
                  <div className="grid grid-cols-4 gap-2 bg-[var(--mv-soft)] p-1.5 rounded-xl text-xs font-bold uppercase text-center max-w-xl select-none">
                    <button
                      onClick={() => setBooksSubTab('reports')}
                      className={`py-2 px-3 rounded-lg transition-all cursor-pointer ${booksSubTab === 'reports' ? 'bg-[var(--mv-ink)] text-white shadow' : 'text-[var(--mv-muted)] hover:text-[#0b0b0f]'}`}
                    >
                      Audit Reports
                    </button>
                    <button
                      onClick={() => setBooksSubTab('ledger')}
                      className={`py-2 px-3 rounded-lg transition-all cursor-pointer ${booksSubTab === 'ledger' ? 'bg-[var(--mv-ink)] text-white shadow' : 'text-[var(--mv-muted)] hover:text-[#0b0b0f]'}`}
                    >
                      Journal Ledger
                    </button>
                    <button
                      onClick={() => setBooksSubTab('budget')}
                      className={`py-2 px-3 rounded-lg transition-all cursor-pointer ${booksSubTab === 'budget' ? 'bg-[var(--mv-ink)] text-white shadow' : 'text-[var(--mv-muted)] hover:text-[#0b0b0f]'}`}
                    >
                      Budget Variance
                    </button>
                    <button
                      onClick={() => setBooksSubTab('audit')}
                      className={`py-2 px-3 rounded-lg transition-all cursor-pointer ${booksSubTab === 'audit' ? 'bg-[var(--mv-ink)] text-white shadow' : 'text-[var(--mv-muted)] hover:text-[#0b0b0f]'}`}
                    >
                      Audit Trails
                    </button>
                  </div>

                  {/* 1. REPORTS SUBSTATION */}
                  {booksSubTab === 'reports' && (
                    <div className="grid grid-cols-12 gap-6 items-start">
                      {/* Substate categories sidebar */}
                      <div className="col-span-4 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl shadow-xs overflow-hidden flex flex-col">
                        <div className="p-4 border-b border-[var(--mv-border)] bg-[var(--mv-page)] select-none font-bold text-[10px] uppercase tracking-wider text-[var(--mv-muted)]">
                          Statements Menu directory
                        </div>

                        <div className="divide-y divide-[var(--mv-border)] text-xs font-medium">
                          <div
                            onClick={() => setReportsSubState('ie')}
                            className={`p-4 text-left cursor-pointer transition-colors ${reportsSubState === 'ie' ? 'bg-[var(--mv-accent-soft)]/40 border-l-4 border-[var(--mv-accent)] font-bold text-[var(--mv-accent)]' : 'hover:bg-[var(--mv-soft)] bg-[var(--mv-surface)] text-[var(--mv-muted)]'}`}
                          >
                            <p className="font-bold">Income & Expenditure Statement</p>
                            <span className="text-[10px] text-[var(--mv-muted)] block mt-1 font-mono tracking-tight font-semibold uppercase leading-none">Provisional surplus</span>
                          </div>
                          <div
                            onClick={() => setReportsSubState('bs')}
                            className={`p-4 text-left cursor-pointer transition-colors ${reportsSubState === 'bs' ? 'bg-[var(--mv-accent-soft)]/40 border-l-4 border-[var(--mv-accent)] font-bold text-[var(--mv-accent)]' : 'hover:bg-[var(--mv-soft)] bg-[var(--mv-surface)] text-[var(--mv-muted)]'}`}
                          >
                            <p className="font-bold">Balance Sheet</p>
                            <span className="text-[10px] text-[var(--mv-muted)] block mt-1 font-mono tracking-tight font-semibold uppercase leading-none">Assets, liabilities and funds</span>
                          </div>
                          <div
                            onClick={() => setReportsSubState('rp')}
                            className={`p-4 text-left cursor-pointer transition-colors ${reportsSubState === 'rp' ? 'bg-[var(--mv-accent-soft)]/40 border-l-4 border-[var(--mv-accent)] font-bold text-[var(--mv-accent)]' : 'hover:bg-[var(--mv-soft)] bg-[var(--mv-surface)] text-[var(--mv-muted)]'}`}
                          >
                            <p className="font-bold">Receipts &amp; Payments</p>
                            <span className="text-[10px] text-[var(--mv-muted)] block mt-1 font-mono tracking-tight font-semibold uppercase leading-none">Cash basis</span>
                          </div>
                          <div
                            onClick={() => setReportsSubState('tb')}
                            className={`p-4 text-left cursor-pointer transition-colors ${reportsSubState === 'tb' ? 'bg-[var(--mv-accent-soft)]/40 border-l-4 border-[var(--mv-accent)] font-bold text-[var(--mv-accent)]' : 'hover:bg-[var(--mv-soft)] bg-[var(--mv-surface)] text-[var(--mv-muted)]'}`}
                          >
                            <p className="font-bold">Trial Balance</p>
                            <span className="text-[10px] text-[var(--mv-muted)] block mt-1 font-mono tracking-tight font-semibold uppercase leading-none">Every account</span>
                          </div>
                        </div>
                      </div>

                      {/* Detail report sheet */}
                      <div className="col-span-8 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl shadow-sm p-6 space-y-4">
                        <Suspense fallback={<PanelLoading />}>
                          <FinancialStatements statements={statements} which={reportsSubState} />
                        </Suspense>
                      </div>
                    </div>
                  )}

                  {/* 2. GENERAL JOURNAL LEDGER */}
                  {booksSubTab === 'ledger' && (
                    <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs">
                      <Suspense fallback={<PanelLoading />}>
                        <JournalLedger statements={statements} />
                      </Suspense>
                    </div>
                  )}

                  {/* 3. BUDGET VARIANCE */}
                  {booksSubTab === 'budget' && (
                    <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs text-left space-y-3">
                      <div className="border-b border-[var(--mv-border)] pb-2">
                        <span className="text-[10px] uppercase font-bold text-[var(--mv-muted)] tracking-wider block">
                          Budget against actuals
                        </span>
                        <p className="text-[9px] text-[var(--mv-muted)] mt-0.5 leading-snug">
                          Budgeted figures are demo values standing in for an approved budget.
                          The realised column and the variance are computed from the ledger.
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-4 text-xs font-medium">
                        {statements.budget.map(b => (
                          <div key={b.head} className="p-3 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl space-y-1.5">
                            <div className="flex justify-between items-baseline gap-2">
                              <span className="font-bold text-[11px] text-[var(--mv-ink)] leading-snug">{b.head}</span>
                              {b.variancePercent !== null && (
                                <span className={`font-mono text-[9px] px-2 py-0.5 rounded font-bold leading-none whitespace-nowrap ${
                                  b.adverse ? 'bg-red-50 text-red-700' : 'bg-[var(--mv-accent-soft)] text-[var(--mv-accent)]'
                                }`}>
                                  {b.variancePercent}
                                </span>
                              )}
                            </div>
                            <div className="flex justify-between text-[10px] text-[var(--mv-muted)] font-mono">
                              <span>Budget {b.budgeted}</span>
                              <span className="font-bold text-[var(--mv-ink)]">Actual {b.actual}</span>
                            </div>
                            <div className="h-1.5 bg-[var(--mv-border)] rounded-full overflow-hidden">
                              <div
                                className={b.adverse ? 'h-full bg-red-500' : 'h-full bg-[var(--mv-accent)]'}
                                style={{ width: `${b.usedPercent}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 4. COMPLIANCE AUDIT TRAILS */}
                  {booksSubTab === 'audit' && (
                    <div className="space-y-3 text-left animate-scale-up text-xs font-medium">
                      <span className="text-[10px] font-bold uppercase text-[var(--mv-muted)] block border-b border-[var(--mv-border)] pb-2">Governing action audit ledger</span>

                      <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1 hide-scrollbar">
                        {auditLog.map(log => (
                          <div key={log.id} className="p-4 bg-[var(--mv-surface)] rounded-xl border border-[var(--mv-border)] flex flex-col gap-1 shadow-xs">
                            <div className="flex justify-between text-[9px] font-bold font-mono text-[var(--mv-muted)] uppercase">
                              <span>🤖 AUTHOR: {log.user}</span>
                              <span className="font-mono font-medium">{log.timestamp}</span>
                            </div>
                            <p className="font-bold text-[var(--mv-ink)] leading-snug mt-1 text-xs">{log.action}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* -------------------- MORE MODULES TAB -------------------- */}
              {activeTab === 'office' && officeContext !== null && (
                <div className="space-y-6 max-w-7xl mx-auto animate-scale-up text-left">
                  <div>
                    <h2 className="text-2xl font-bold text-[var(--mv-ink)]">Office</h2>
                    <p className="text-xs text-[var(--mv-muted)]">Vendors, banking, approvals, periods, users and the statutory reports</p>
                  </div>
                  <Suspense fallback={<p className="text-sm text-[var(--mv-muted)]">Loading…</p>}>
                    <OfficeHub ctx={officeContext} />
                  </Suspense>
                </div>
              )}

              {activeTab === 'more' && (
                <div className="space-y-6 max-w-7xl mx-auto animate-scale-up text-left">
                  <div>
                    <h2 className="text-2xl font-bold text-[var(--mv-ink)]">Co-operative RWA Admin Panels</h2>
                    <p className="text-xs text-[var(--mv-muted)]">Configure resident flat allocations, ticketing helpdesk, and backup parameters</p>
                  </div>

                  <div className="grid grid-cols-2 gap-6 items-start">
                    {/* HELP DESK UTILITY */}
                    <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs space-y-4">
                      <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-wider border-b border-[var(--mv-border)] pb-2">RWA Helpdesk Complaints Portal</h4>

                      {currentRole === 'Resident' ? (
                        <form onSubmit={handleRaiseComplaint} className="space-y-4 text-xs font-medium">
                          <div className="space-y-1">
                            <label htmlFor="ticket-category-desk" className="text-[10px] text-[var(--mv-muted)] uppercase block">Utility Category</label>
                            <select
                              id="ticket-category-desk"
                              value={ticketCategory}
                              onChange={(e) => setTicketCategory(e.target.value as any)}
                              className="w-full bg-[var(--mv-page)] border border-[var(--mv-border)] p-3 rounded-xl text-xs font-bold outline-none"
                            >
                              <option value="Plumbing">🚰 Plumbing & Water pipe leakaging</option>
                              <option value="Lift">🛗 Elevator backup failures</option>
                              <option value="Security">🛡️ Security patrols and CCTV inspects</option>
                              <option value="Billing Query">🧾 Billing and ledger balance query</option>
                              <option value="Other">⚙️ Other utility support complaints</option>
                            </select>
                          </div>

                          <div className="space-y-1">
                            <label htmlFor="ticket-description-desk" className="text-[10px] text-[var(--mv-muted)] uppercase block">Utility malfunction details</label>
                            <textarea
                              id="ticket-description-desk"
                              rows={4}
                              required
                              value={ticketDescription}
                              onChange={(e) => setTicketDescription(e.target.value)}
                              placeholder="Explain elevator malfunction, balcoine leakage, water supply anomalies..."
                              className="w-full bg-[var(--mv-page)] border border-[var(--mv-border)] p-3 rounded-xl text-xs font-medium outline-none focus:border-[var(--mv-accent)] leading-relaxed"
                            />
                          </div>

                          <button
                            type="submit"
                            className="w-full py-3 bg-[var(--mv-accent)] text-white font-bold text-xs rounded-xl shadow cursor-pointer uppercase tracking-wider"
                          >
                            Submit Support Ticket
                          </button>
                        </form>
                      ) : (
                        <div className="space-y-3.5">
                          <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase block font-mono">Active complaints ledger logs ({tickets.length} tickets)</span>

                          <div className="space-y-2.5 max-h-[220px] overflow-y-auto pr-1 hide-scrollbar">
                            {tickets.map(t => (
                              <div key={t.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
                                <div className="min-w-0 flex-1 pr-2 space-y-1">
                                  <span className="font-extrabold text-[var(--mv-ink)] block">Flat {t.flatNo} • {t.category}</span>
                                  <p className="text-[10px] text-[var(--mv-muted)] leading-relaxed font-semibold">{t.description}</p>
                                </div>
                                <div className="shrink-0 text-right">
                                  <span className={`px-2 py-0.5 text-[8px] font-bold rounded uppercase ${t.status === 'Open' ? 'bg-[var(--mv-accent-soft)] text-[var(--mv-accent)]' : 'bg-[var(--mv-accent)] text-white'}`}>
                                    {t.status}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* REGISTRY GRIDS */}
                    {currentRole === 'Manager' ? (
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-6 rounded-2xl shadow-xs space-y-4">
                        <div className="flex justify-between items-baseline border-b border-[var(--mv-border)] pb-2">
                          <span className="text-[10px] font-bold uppercase text-[var(--mv-muted)] tracking-wider">Residents allotment registry</span>
                          {!onServer && <button
                            onClick={() => {
                              setEditingMemberId(null);
                              setFormName('');
                              setFormFlat('');
                              setFormWing('A');
                              setFormContact('');
                              setMemberFormOpen(!memberFormOpen);
                            }}
                            className="text-[10px] text-[var(--mv-accent)] font-bold uppercase flex items-center gap-1 cursor-pointer"
                          >
                            {memberFormOpen ? 'Minimize Form' : '+ Register Allotment'}
                          </button>}
                        </div>

                        {onServer && (
                          <p className="text-[10px] text-[var(--mv-muted)] leading-snug">
                            The flats and owners on the server, read only here. Adding, editing or removing a
                            member is not available on this screen yet.
                          </p>
                        )}

                        {memberFormOpen && !onServer && (
                          <form onSubmit={handleSaveMember} className="space-y-3.5 text-xs bg-[var(--mv-page)] p-4 rounded-xl border border-[var(--mv-border)] animate-scale-up font-medium">
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <label htmlFor="member-name-desk" className="text-[9px] font-bold text-[var(--mv-muted)] block">Resident Full Name</label>
                                <input
                                  id="member-name-desk"
                                  type="text"
                                  required
                                  value={formName}
                                  onChange={(e) => setFormName(e.target.value)}
                                  placeholder="e.g. Ramesh Desai"
                                  className="w-full bg-[var(--mv-surface)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold outline-none"
                                />
                              </div>
                              <div className="space-y-1">
                                <label htmlFor="member-flat-desk" className="text-[9px] font-bold text-[var(--mv-muted)] block">Flat Code</label>
                                <input
                                  id="member-flat-desk"
                                  type="text"
                                  required
                                  value={formFlat}
                                  onChange={(e) => setFormFlat(e.target.value)}
                                  placeholder="e.g. C-303"
                                  className="w-full bg-[var(--mv-surface)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold outline-none"
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                  <label htmlFor="member-wing-desk" className="text-[9px] font-bold text-[var(--mv-muted)] block">Allotted Wing</label>
                                  <select
                                    id="member-wing-desk"
                                    value={formWing}
                                    onChange={(e) => setFormWing(e.target.value as any)}
                                    className="w-full bg-[var(--mv-surface)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold outline-none font-sans"
                                  >
                                    <option value="A">Wing A</option>
                                    <option value="B">Wing B</option>
                                    <option value="C">Wing C</option>
                                    <option value="D">Wing D</option>
                                  </select>
                              </div>
                              <div className="space-y-1">
                                <label htmlFor="member-contact-desk" className="text-[9px] font-bold text-[var(--mv-muted)] block">Mobile Contact Line</label>
                                <input
                                  id="member-contact-desk"
                                  type="text"
                                  value={formContact}
                                  onChange={(e) => setFormContact(e.target.value)}
                                  placeholder="e.g. +91 98"
                                  className="w-full bg-[var(--mv-surface)] p-2.5 rounded-xl border border-[var(--mv-border)] font-mono outline-none"
                                />
                              </div>
                            </div>

                            <button type="submit" className="w-full py-2.5 bg-[var(--mv-ink)] hover:bg-black text-white font-bold rounded-xl tracking-wider uppercase text-center cursor-pointer">
                              {editingMemberId ? 'Modify profile' : 'Confirm Flat Allotment'}
                            </button>
                          </form>
                        )}

                        <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1 hide-scrollbar">
                          {members.map(m => (
                            <div key={m.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
                              <div className="text-left">
                                <span className="font-extrabold text-[var(--mv-ink)] block">Flat {m.flatNo} · {m.name}</span>
                                <span className="text-[9px] text-[var(--mv-muted)] font-bold block font-mono">Wing {m.wing}{m.contact === '' ? '' : ` · Contact: ${m.contact}`}</span>
                              </div>
                              {!onServer && (
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => handleEditMemberClick(m)}
                                    aria-label={`Edit ${m.name}, flat ${m.flatNo}`}
                                    title="Edit"
                                    className="w-7 h-7 bg-[var(--mv-surface)] border border-[var(--mv-border)] hover:bg-[var(--mv-soft)] text-[var(--mv-muted)] hover:text-[var(--mv-ink)] rounded-lg transition-all flex items-center justify-center cursor-pointer shadow-xs"
                                  >
                                    <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                                  </button>
                                  <button
                                    onClick={() => handleDeleteMember(m.id, m.name)}
                                    aria-label={`Remove ${m.name}, flat ${m.flatNo}`}
                                    title="Remove"
                                    className="w-7 h-7 bg-[var(--mv-surface)] border border-[var(--mv-border)] hover:bg-red-50 text-red-700 rounded-lg transition-all flex items-center justify-center cursor-pointer shadow-xs"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-6 rounded-2xl shadow-xs space-y-4">
                        <div className="flex justify-between items-center pb-2 border-b border-[var(--mv-border)] select-none">
                          <span className="text-[10px] font-bold uppercase text-[var(--mv-muted)] tracking-wider">Vendor Contracts registry</span>
                          <span className="text-[8px] font-bold bg-[var(--mv-soft)] text-[var(--mv-muted)] px-2 py-0.5 rounded border border-[var(--mv-border)] font-mono">194C AUDIT</span>
                        </div>

                        <div className="space-y-2.5 max-h-[280px] overflow-y-auto pr-1 hide-scrollbar font-medium">
                          {vendors.map(v => (
                            <div key={v.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
                              <div className="min-w-0 flex-1 pr-1 bg-transparent text-left space-y-0.5">
                                <h5 className="font-extrabold text-[var(--mv-ink)] truncate">{v.name}</h5>
                                <span className="text-[9px] font-bold text-[var(--mv-muted)] block uppercase tracking-wider leading-none">{v.category}</span>
                                <span className="text-[9px] text-[var(--mv-accent)] font-bold block">Contract Renewal: <span className="font-semibold text-[var(--mv-muted)]">{v.contractRenewal}</span></span>
                              </div>
                              <div className="text-right shrink-0">
                                <span className="font-mono text-xs font-extrabold text-[var(--mv-ink)] block">{formatRupee(v.balance)}</span>
                                <span className="text-[9px] text-[var(--mv-muted)] block uppercase leading-none font-bold">Unpaid total</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Spreadsheets block */}
                  {currentRole !== 'Resident' && (
                    <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs">
                      <Suspense fallback={<PanelLoading />}>
                        <BackupHub
                          backupHistory={backupHistory}
                          onTriggerBackup={handleTriggerBackup}
                          onResetData={handleReset}
                          onServer={onServer}
                          exportJson={() => mustBooks().exportJson()}
                        />
                      </Suspense>
                    </div>
                  )}

                  {/* Code policy block disclosures */}
                  <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-5 rounded-2xl shadow-xs text-xs font-semibold space-y-2 relative leading-relaxed">
                    <span className="text-[9px] font-bold text-[var(--mv-accent)] uppercase tracking-wider bg-[var(--mv-accent-soft)] px-2 py-0.5 rounded inline-block">Co-operative Regulatory Compliance code disclosures</span>
                    <p className="text-[10px] text-[var(--mv-muted)] leading-relaxed pt-1">Association billing rules and statutory registrations must be verified against the approved Mani Vista bylaws and applicable West Bengal regulations before live use. GSTIN: {gstinLabel}.</p>
                    {!onServer && (
                      <button
                        onClick={handleReset}
                        className="text-[10px] font-bold text-[var(--mv-accent)] block py-1.5 hover:underline cursor-pointer uppercase mt-2 border-t border-[var(--mv-border)] pt-2 w-full text-center"
                      >
                        Reset sandbox database default seed data
                      </button>
                    )}
                  </div>
                </div>
              )}

            </main>
          </div>
        </div>
      ) : null}

      {/* 2. LEGACY MOBILE PHONE FRAME WRAPPER */}
      {!isDesktop ? (
        <div id="phone-frame-container" className="w-full max-w-[480px] bg-[var(--mv-surface)] overflow-hidden flex flex-col relative" style={{ height: 'calc(100dvh - var(--mv-banner-h))', marginTop: 'var(--mv-banner-h)' }}>

        {/* --- STICKY SOCIETY TOP HEADER (White styled, high density) --- */}
        <header className="sticky top-0 bg-[var(--mv-surface)] border-b border-[var(--mv-border)] pt-6 pb-2 px-4 flex items-center justify-between gap-3 z-30">
          <img src="/branding/mani-vista-logo.png" alt="Mani Vista" className="h-11 w-11 object-contain bg-[var(--mv-surface)] rounded-lg border border-[var(--mv-accent-border)] shrink-0" />
          <div className="flex flex-col flex-1 min-w-0 text-left">
            <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Residents Association</p>
            <h1 className="text-sm font-bold truncate text-[var(--mv-ink)]" title="Mani Vista Residents Association">
              Mani Vista Residents Association
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <ThemeSwitcher />
            {/* Notification bell styled exact to theme */}
            <div aria-hidden="true" className="relative w-8 h-8 flex items-center justify-center bg-[var(--mv-soft)] rounded-full">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--mv-ink)]">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path>
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path>
              </svg>
              <div className="absolute top-1 right-1 w-2.5 h-2.5 bg-[var(--mv-ink)] border-2 border-white rounded-full"></div>
            </div>

            {/* Role switch pill selector styled exact to theme */}
            <div className="relative bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] px-2 py-1 rounded-full flex items-center gap-1 cursor-pointer">
              <select
                aria-label="View as"
                value={currentRole}
                onChange={(e) => handleRoleSwitchRequest(e.target.value as any)}
                className="appearance-none bg-transparent text-[10px] font-bold text-[var(--mv-accent)] tracking-wider outline-none cursor-pointer uppercase pr-3.5"
              >
                <option value="Resident">Resident</option>
                <option value="Manager">Manager</option>
                <option value="Committee">Committee</option>
              </select>
              <div className="pointer-events-none absolute right-2 flex items-center">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--mv-accent)" strokeWidth="3">
                  <path d="m6 9 6 6 6-6"/>
                </svg>
              </div>
            </div>
          </div>
        </header>

        {/* Dynamic Warning Notification if admin acts as tester */}
        {isAuthenticated && currentRole !== 'Resident' && (
          <div className="bg-[var(--mv-ink)] text-white text-[10px] font-bold px-4 py-1.5 flex justify-between items-center z-10 border-b border-white/10 uppercase tracking-widest">
            <span>🛡️ MODE: SECURE ADMIN ({currentRole})</span>
            <button
              onClick={handleLockAdminMode}
              className="underline hover:opacity-80 font-bold"
            >
              Lock Panel
            </button>
          </div>
        )}

        {/* --- MAIN SCROLL CONTENT SCREEN --- */}
        <main className="flex-1 overflow-y-auto px-4 py-4 bg-[var(--mv-surface)] pb-24 hide-scrollbar">

          {/* =========================================
              VIEW: TAB 'HOME' DESIRED CONTROLLERS
             ========================================= */}
          {activeTab === 'home' && (
            <div className="space-y-4">
                        {/* Resident profile greetings banner */}
              {currentRole === 'Resident' && (
                <>
                  <div className="flex items-baseline justify-between transition-all">
                    <div>
                      <h2 className="text-xl font-bold text-[var(--mv-ink)]">Hi, {residentName}</h2>
                      <p className="text-sm text-[var(--mv-muted)]">
                        {residentFlatNo === ''
                          ? 'No flat is linked to this account yet'
                          : `Flat ${residentFlatNo}`}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">{onServer ? 'Last Sync' : 'Kept in'}</p>
                      <p className="text-[10px] text-[var(--mv-accent)] font-bold">{onServer ? syncedLabel(booksLoadedAt) : 'THIS BROWSER'}</p>
                    </div>
                  </div>

                  {/* 2x2 Metric tile blocks */}
                  <div className="grid grid-cols-2 grid-rows-2 gap-3 transition-all">
                    <div className="aspect-square bg-[var(--mv-ink)] p-4 rounded-2xl flex flex-col justify-between shadow-lg ring-4 ring-black/5">
                      <p className="text-[10px] font-bold text-white/75 uppercase tracking-wider">Current Due</p>
                      <div className="space-y-1">
                        <p className="text-2xl font-bold text-white font-mono">{formatRupee(rohanTotalDueNum)}</p>
                        {rohanTotalDueNum > 0 ? (
                          <div className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-white/10 text-[9px] font-bold text-white">OVERDUE</div>
                        ) : (
                          <div className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-[var(--mv-accent)] text-[9px] font-bold text-white">PAID</div>
                        )}
                      </div>
                    </div>

                    <div className="aspect-square bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Paid This FY</p>
                      <div className="space-y-1">
                        <p className="text-2xl font-bold text-[var(--mv-ink)] font-mono">{formatRupee(rohanTotalPaidNum)}</p>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-[var(--mv-accent)] text-[9px] font-bold text-white">
                          {rohanInvoices.filter(inv => inv.status === 'Paid').length} TRANSACTIONS
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Advance Bal</p>
                      <p className="text-2xl font-bold text-[var(--mv-ink)] font-mono">{formatRupees(residentAdvancePaise)}</p>
                    </div>

                    <div className="aspect-square bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Open Tickets</p>
                      <div className="space-y-1">
                        <p className="text-2xl font-bold text-[var(--mv-ink)] font-mono">
                          {String(rohanOpenTicketsNum).padStart(2, '0')}
                        </p>
                        <p className="text-[10px] font-medium text-[var(--mv-accent)] uppercase truncate">
                          {residentOpenTicketCategories.length === 0 ? 'NONE OPEN' : residentOpenTicketCategories.join(' · ')}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Latest outstanding invoice banner */}
                  {rohanDueInvoice && (
                    <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 shadow-sm space-y-4 text-left transition-all">
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Active Invoice</p>
                          <h3 className="font-bold text-[var(--mv-ink)]">#{rohanDueInvoice.invoiceNo}</h3>
                        </div>
                        <div className="bg-[var(--mv-accent-soft)] px-2 py-1 rounded-full">
                          <span className="text-[10px] font-bold text-[var(--mv-accent)] uppercase">{dueLabel(dueIso(rohanDueInvoice), today)}</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between border-y border-[var(--mv-soft)] py-3">
                        <div className="space-y-1">
                          <p className="text-xs text-[var(--mv-muted)]">{rohanDueInvoice.period} Maintenance + Sinking</p>
                          <p className="text-2xl font-bold text-[var(--mv-ink)] font-mono">{formatRupee(rohanDueInvoice.total)}</p>
                        </div>
                        {mayPayOnline && (
                          <button
                            onClick={() => handlePayClick(rohanDueInvoice)}
                            className="bg-[var(--mv-accent)] text-white px-5 py-2.5 rounded-xl font-bold text-sm shadow-md active:scale-95 transition-all cursor-pointer"
                          >
                            Pay Now
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-[var(--mv-muted)]">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0">
                          <circle cx="12" cy="12" r="10"></circle>
                          <line x1="12" y1="16" x2="12" y2="12"></line>
                          <line x1="12" y1="8" x2="12.01" y2="8"></line>
                        </svg>
                        <span>
                          {rohanDueInvoice.gst > 0
                            ? `Includes ${formatRupee(rohanDueInvoice.gst)} GST.`
                            : 'No GST on this bill.'}
                          {mayPayOnline ? '' : ' Pay the association by UPI, NEFT or cheque; the manager records the receipt.'}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* MINI PAYMENTS HISTORY (LAST 4) */}
                  <div className="space-y-3 pb-24 transition-all">
                    <div className="flex justify-between items-center">
                      <h3 className="font-bold text-sm uppercase tracking-tight text-[var(--mv-ink)]">Recent Activity</h3>
                      <button onClick={() => setActiveTab('bills')} className="text-[var(--mv-accent)] text-xs font-bold uppercase hover:underline">
                        VIEW ALL
                      </button>
                    </div>

                    <div className="space-y-2">
                      {rohanInvoices.slice(0, 4).map(inv => (
                        <div
                          key={inv.id}
                          onClick={() => {
                            if (inv.status === 'Paid') {
                              setSelectedReceipt(inv);
                              setShowReceiptModal(true);
                            } else {
                              setSelectedInvoice(inv);
                            }
                          }}
                          className="flex items-center justify-between p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] hover:bg-[var(--mv-soft)] transition-all cursor-pointer"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-[var(--mv-surface)] rounded-lg flex items-center justify-center border border-[var(--mv-border)] font-bold text-[var(--mv-accent)]">₹</div>
                            <div className="text-left">
                              <p className="text-sm font-bold text-[var(--mv-ink)]">{inv.period} Maintenance</p>
                              <p className="text-[10px] text-[var(--mv-muted)] uppercase">{inv.paidDate || inv.dueDate || ''}</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-bold text-[var(--mv-ink)] font-mono">{formatRupee(inv.total)}</p>
                            <span className={`inline-block px-2 py-0.5 rounded text-[9px] font-bold text-white uppercase ${
                              inv.status === 'Paid' ? 'bg-[var(--mv-accent)]' : 'bg-[var(--mv-ink)]'
                            }`}>
                              {inv.status}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* MANAGER VIEW dashboards */}
              {currentRole === 'Manager' && (
                <>
                  <div className="flex items-baseline justify-between transition-all">
                    <div>
                      <h2 className="text-xl font-bold text-[var(--mv-ink)]">Manager Console</h2>
                      <p className="text-sm text-[var(--mv-muted)]">Finance Superintendent · Active Session</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Books</p>
                      <p className="text-[10px] text-[var(--mv-accent)] font-bold">{onServer ? `SYNCED ${syncedLabel(booksLoadedAt)}` : 'DEMONSTRATION'}</p>
                    </div>
                  </div>

                  {/* 2x2 Metric tiles */}
                  <div className="grid grid-cols-2 grid-rows-2 gap-3 transition-all">
                    <div className="aspect-square bg-[var(--mv-ink)] p-4 rounded-2xl flex flex-col justify-between shadow-lg ring-4 ring-black/5">
                      <span className="text-[10px] font-bold text-white/75 uppercase tracking-wider">Collected MTD</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-white font-mono block leading-none">{formatRupee(mtdCollectedTotal)}</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-white/10 text-[9px] font-semibold text-white">
                          CURRENT RANGE
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Outstanding</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-[var(--mv-ink)] font-mono block leading-none">{formatRupee(mtdOutstandingTotal)}</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--mv-accent-soft)] text-[9px] font-semibold text-[var(--mv-accent)]">
                          LEDGER TOTAL
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Defaulters</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-[var(--mv-ink)] font-mono block leading-none">{uniqueDefaultersCount} Flats</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-red-50 text-[9px] font-bold text-red-600">
                          OVERDUE FLAGS
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Expenses MTD</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-[var(--mv-ink)] font-mono block leading-none">{formatRupee(totalMTDExpenses)}</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--mv-soft)] text-[9px] font-semibold text-[var(--mv-ink)]">
                          RWA OUTFLOW
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Trend charts area */}
                  <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 space-y-3 shadow-xs">
                    <div className="flex justify-between items-center">
                      <div>
                        <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-tight">Collections</h4>
                        <p className="text-[10px] text-[var(--mv-muted)] mt-0.5">Paid, by billing period</p>
                      </div>
                      <TrendingUp className="w-4 h-4 text-[var(--mv-accent)]" />
                    </div>

                    <div className="h-[140px] w-full pt-2 flex items-center justify-center relative">
                      {collectionTrendsData.length === 0 ? (
                        <p className="text-xs text-[var(--mv-muted)]">No invoices yet.</p>
                      ) : (
                        <Suspense fallback={<PanelLoading />}>
                          <CollectionChart data={collectionTrendsData} compact />
                        </Suspense>
                      )}
                    </div>
                  </div>

                  {/* Action launcher */}
                  <div className="flex gap-2.5 pt-1">
                    <button
                      onClick={() => {
                        setShowBillingWizard(true);
                        setActiveTab('bills');
                      }}
                      className="flex-1 py-3 px-4 bg-[var(--mv-accent)] hover:brightness-90 text-white rounded-xl text-xs font-bold shadow-md active:scale-95 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Plus className="w-4 h-4" aria-hidden="true" /> Run billing
                    </button>
                    <button
                      onClick={() => setActiveTab('pay')}
                      className="py-3 px-5 bg-[var(--mv-ink)] hover:bg-black text-white rounded-xl text-xs font-bold active:scale-95 transition-all text-center cursor-pointer"
                    >
                      Defaulters Room
                    </button>
                  </div>
                </>
              )}
              {/* COMMITTEE BOARD VIEW */}
              {currentRole === 'Committee' && (
                <>
                  <div className="flex items-baseline justify-between transition-all">
                    <div>
                      <h2 className="text-xl font-bold text-[var(--mv-ink)]">Treasurer Console</h2>
                      <p className="text-sm text-[var(--mv-muted)]">Reserve Fund Operations · Cabinet</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Books</p>
                      <p className="text-[10px] text-[var(--mv-accent)] font-bold">{onServer ? `SYNCED ${syncedLabel(booksLoadedAt)}` : 'DEMONSTRATION'}</p>
                    </div>
                  </div>

                  {/* 2x2 Metric tiles */}
                  <div className="grid grid-cols-2 grid-rows-2 gap-3 transition-all">
                    <div className="aspect-square bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">General Reserve</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-[var(--mv-ink)] font-mono block leading-none">{formatRupees(reserveFundPaise)}</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--mv-accent-soft)] text-[9px] font-semibold text-[var(--mv-accent)]">
                          LEDGER
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Sinking Fund</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-[var(--mv-ink)] font-mono block leading-none">{formatRupees(sinkingFundPaise)}</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--mv-soft)] text-[9px] font-semibold text-[var(--mv-ink)]">
                          LEDGER
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Operating Bal.</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-[var(--mv-ink)] font-mono block leading-none">
                          {formatRupees(operatingBankPaise)}
                        </span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--mv-accent-soft)] text-[9px] font-semibold text-[var(--mv-accent)]">
                          PER THE BOOKS
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-[var(--mv-ink)] p-4 rounded-2xl flex flex-col justify-between shadow-lg ring-4 ring-black/5">
                      <span className="text-[10px] font-bold text-white/75 uppercase tracking-wider">Pending Appr.</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-white font-mono block leading-none">{pendingApprovalsCount} Bills</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-white/10 text-[9px] font-semibold text-white">
                          ACTION REQUIRED
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Budget Performance Chart (Budget vs Actual) */}
                  <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 space-y-3 shadow-xs">
                    <div className="flex justify-between items-center">
                      <div>
                        <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-tight">Receipt Budget Performance</h4>
                        <p className="text-[10px] text-[var(--mv-muted)] mt-0.5">{onServer ? 'Needs an approved budget' : 'Demonstration budget figures'}</p>
                      </div>
                    </div>

                    <div className="h-[140px] w-full pt-2 flex items-center justify-center relative">
                      {onServer ? (
                        <p className="text-xs text-[var(--mv-muted)] text-center">No approved budget is on record on the server.</p>
                      ) : (
                        <Suspense fallback={<PanelLoading />}>
                          <BudgetChart data={budgetPerformanceData} compact />
                        </Suspense>
                      )}
                    </div>
                  </div>

                  {/* Pending Approvals Quick Controller Workflow */}
                  <div className="space-y-3 pt-1">
                    <h4 className="font-extrabold text-xs text-[var(--mv-ink)] tracking-wider uppercase">Required Approvals</h4>

                    {vendorInvoices.filter(vi => vi.status === 'Pending').length === 0 ? (
                      <div className="py-4 bg-[var(--mv-page)] text-center text-xs text-[var(--mv-muted)] rounded-2xl">
                        Clean desk! No outstanding vendor proposals on file.
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {vendorInvoices.filter(vi => vi.status === 'Pending').map(vi => (
                          <div key={vi.id} className="p-3 border border-[var(--mv-border)] rounded-3xl bg-[var(--mv-surface)] space-y-2">
                            <div className="flex justify-between items-baseline">
                              <div>
                                <span className="text-[8px] font-extrabold text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] px-1.5 py-0.5 rounded uppercase tracking-wide">
                                  {vi.category}
                                </span>
                                <h5 className="font-bold text-xs text-[var(--mv-ink)] mt-1">{vi.vendorName}</h5>
                              </div>
                              <span className="font-mono text-xs font-bold text-[var(--mv-ink)]">{formatRupee(vi.amount)}</span>
                            </div>

                            <div className="bg-[var(--mv-page)] p-2 rounded-xl text-[10px] text-[var(--mv-muted)] border border-[var(--mv-border)] flex justify-between items-center leading-snug">
                              <span>Withholding TDS 2% (u/s 194C): <strong className="font-mono text-[var(--mv-ink)]">{formatRupee(vi.tdsAmount)}</strong></span>
                              <span>Net: <strong className="font-mono text-[var(--mv-ink)]">{formatRupee(vi.netPayable)}</strong></span>
                            </div>

                            <div className="flex gap-2 justify-end">
                              {!onServer && (
                                <button
                                  onClick={() => handleVendorInvoiceStatus(vi.id, 'Rejected')}
                                  disabled={working}
                                  className="py-1 px-3 border border-[var(--mv-border)] rounded-lg text-[10px] font-bold text-[var(--mv-muted)] hover:bg-[var(--mv-soft)] active:scale-95 disabled:opacity-60"
                                >
                                  Reject
                                </button>
                              )}
                              <button
                                onClick={() => handleVendorInvoiceStatus(vi.id, 'Approved')}
                                disabled={working}
                                className="py-1 px-3 bg-[var(--mv-accent)] hover:brightness-90 text-white rounded-lg text-[10px] font-bold active:scale-95 shadow-sm disabled:opacity-60"
                              >
                                Approve
                              </button>
                              {books.snapshot().vendorBills.find(v => v.id === vi.id)?.state === 'booked' && (
                                <button
                                  onClick={() => handlePayVendor(vi.id)}
                                  className="py-1 px-3 bg-[var(--mv-ink)] text-white rounded-lg text-[10px] font-bold active:scale-95"
                                >
                                  Pay
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* =========================================
              VIEW: TAB 'BILLS' INVOICING LISTS
             ========================================= */}
          {activeTab === 'bills' && (
            <div className="space-y-4">

              {/* Header section with generate button triggers */}
              <div className="flex justify-between items-baseline">
                <div>
                  <h2 className="text-xl font-bold text-[var(--mv-ink)]">Ledger Invoices</h2>
                  <p className="text-xs text-[var(--mv-muted)]">Historical and active transactions</p>
                </div>
                {currentRole !== 'Resident' && (
                  <button
                    onClick={() => setShowBillingWizard(true)}
                    className="py-1.5 px-3 bg-[var(--mv-ink)] text-white text-[10px] font-bold uppercase rounded-lg shadow-sm hover:opacity-80 active:scale-95 flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" /> Generate Bills
                  </button>
                )}
              </div>

              {currentRole !== 'Resident' && (
                <div className="p-4 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl">
                  <BillingWorkflow
                    documents={registerDocuments}
                    problems={books.snapshot().problems}
                    today={today}
                    onApproveAll={handleApproveAllDrafts}
                    onReleaseApproved={handleReleaseApproved}
                    onConvertDue={handleConvertDue}
                    compact
                  />
                </div>
              )}

              {/* Bill Generation Form Wizard card if visible */}
              {showBillingWizard && (
                <div className="p-4 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-2xl animate-scale-up space-y-3.5 text-left">
                  <div className="flex justify-between items-center border-b border-[var(--mv-border)] pb-2">
                    <span className="font-bold text-xs uppercase tracking-tight text-[var(--mv-ink)]">Billing Generation Wizard</span>
                    <button
                      onClick={() => setShowBillingWizard(false)}
                      className="text-[10px] font-bold text-[var(--mv-accent)] uppercase py-0.5 px-1.5 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-lg"
                    >
                      Close
                    </button>
                  </div>

                  <form onSubmit={handleRunBillGeneration} className="space-y-3 text-xs">
                    {renderWizardFields(true)}
                  </form>
                </div>
              )}

              {/* Complete Invoice Stack list */}
              <div className="space-y-2 pb-24 transition-all">
                {invoices
                  .filter(inv => currentRole === 'Resident' ? inv.flatNo === residentFlatNo : true)
                  .map(inv => {
                    const viewDetails = () => {
                      setSelectedInvoice(inv);
                    };

                    return (
                      <div
                        key={inv.id}
                        onClick={viewDetails}
                        className="flex items-center justify-between p-3 bg-[var(--mv-surface)] rounded-xl border border-[var(--mv-border)] hover:bg-[var(--mv-page)] cursor-pointer transition-all text-left"
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0 pr-2">
                          <div className="w-10 h-10 bg-[var(--mv-page)] rounded-lg flex items-center justify-center border border-[var(--mv-border)] font-mono text-[9px] font-bold text-[var(--mv-muted)] shrink-0">
                            {inv.invoiceNo.replace('INV-', '')}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-[var(--mv-ink)] truncate">
                              {inv.period} Maintenance {currentRole !== 'Resident' ? `(${inv.flatNo})` : ''}
                            </p>
                            <p className="text-[10px] text-[var(--mv-accent)] font-bold uppercase truncate">
                              Owner: <span className="text-[var(--mv-muted)] font-semibold">{inv.name}</span>
                            </p>
                          </div>
                        </div>

                        <div className="text-right">
                          <p className="text-sm font-bold text-[var(--mv-ink)] font-mono">{formatRupee(inv.total)}</p>
                          <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold text-white uppercase ${
                            inv.status === 'Paid' ? 'bg-[var(--mv-accent)]' : 'bg-[var(--mv-ink)]'
                          }`}>
                            {inv.status}
                          </span>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* =========================================
              VIEW: TAB 'PAY' TRANSACTION SYSTEMS
             ========================================= */}
          {activeTab === 'pay' && (
            <div className="space-y-4">

              {/* Resident Pay flow segment */}
              {currentRole === 'Resident' && (
                <>
                  <div className="flex items-baseline justify-between transition-all">
                    <div>
                      <h2 className="text-xl font-bold text-[var(--mv-ink)]">{onServer ? 'Payments' : 'Payments (demo)'}</h2>
                      <p className="text-sm text-[var(--mv-muted)]">{mayPayOnline ? 'UPI, Net Banking & deposits' : 'What is due, and how to pay it'}</p>
                    </div>
                  </div>

                  {payingInvoice ? (
                    <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 space-y-4 shadow-sm animate-scale-up text-left">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-[10px] uppercase text-[var(--mv-muted)] tracking-wider">Checkout bill summary</span>
                        <button
                          onClick={() => setPayingInvoice(null)}
                          className="text-[10px] font-bold text-[var(--mv-accent)] uppercase"
                        >
                          Cancel
                        </button>
                      </div>

                      <div className="p-3.5 bg-[var(--mv-accent-soft)] rounded-xl border border-[var(--mv-accent-border)]">
                        <p className="text-[10px] text-[var(--mv-accent)] font-bold uppercase tracking-wider">{payingInvoice.invoiceNo}</p>
                        <p className="font-bold text-[var(--mv-ink)] text-base mt-0.5">{payingInvoice.period} General Maintenance</p>
                        <div className="mt-3 flex justify-between items-baseline pt-2 border-t border-[var(--mv-accent-border)]/40 font-mono">
                          <span className="text-[10px] text-[var(--mv-accent)]/80 font-bold uppercase tracking-wider">Net checkout</span>
                          <span className="text-2xl font-bold text-[var(--mv-accent)]">{formatRupee(payingInvoice.total)}</span>
                        </div>
                      </div>

                      {/* Payment Methods */}
                      <form onSubmit={handleExecutePayment} className="space-y-4">
                        <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block" id="pmethod-mobile-label">Payment method</span>

                        <div className="grid grid-cols-2 gap-2 text-xs" role="radiogroup" aria-labelledby="pmethod-mobile-label">
                          {[
                            { id: 'UPI', label: 'UPI / BHIM app' },
                            { id: 'Net Banking', label: 'Net Banking' },
                            { id: 'Card', label: 'Debit/Credit Card' },
                            { id: 'Wallet', label: 'Digital Wallets' }
                          ].map(item => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={paymentMethod === item.id}
                              key={item.id}
                              onClick={() => setPaymentMethod(item.id as any)}
                              className={`p-3.5 rounded-xl border transition-all flex flex-col justify-between cursor-pointer text-left ${
                                paymentMethod === item.id
                                  ? 'bg-[var(--mv-ink)] text-white border-black shadow'
                                  : 'bg-[var(--mv-surface)] text-[var(--mv-ink)] border-[var(--mv-border)] hover:bg-[var(--mv-page)]'
                              }`}
                            >
                              <span className="font-bold block leading-tight">{item.label}</span>
                              <span className={`text-[8px] mt-2 block uppercase font-mono ${paymentMethod === item.id ? 'text-white/70' : 'text-[var(--mv-muted)]'}`}>
                                No gateway — recorded only
                              </span>
                            </button>
                          ))}
                        </div>

                        {/* Partial payment modifier */}
                        <div className="space-y-1.5 text-left">
                          <label htmlFor="pay-amount-mobile" className="text-[10px] font-bold text-[var(--mv-muted)] uppercase block">Amount to pay</label>
                          <input
                            id="pay-amount-mobile"
                            type="number"
                            placeholder={`Clear full amount of ${formatRupee(payingInvoice.total)}`}
                            value={partialAmountInput}
                            onChange={(e) => setPartialAmountInput(e.target.value)}
                            max={payingInvoice.total}
                            className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-xl p-2.5 font-mono text-xs w-full text-[var(--mv-ink)] outline-none focus:border-[var(--mv-accent)]"
                          />
                          <span className="text-[9px] text-[var(--mv-muted)] block font-medium leading-tight">
                            Partial payment leaves outstanding arrears on this ledger period.
                          </span>
                        </div>

                        <button
                          type="submit"
                          disabled={working}
                          className="w-full py-3 bg-[var(--mv-accent)] text-white font-bold text-sm rounded-xl text-center shadow-md active:scale-95 transition-all cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                        >
                          {working ? 'Recording…' : 'Record payment'}
                        </button>
                      </form>
                    </div>
                  ) : (
                    <div className="space-y-3.5 pb-24 text-left">

                      {/* Outstanding bills available to pay list */}
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl space-y-3 shadow-xs">
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">
                            Pending Clearance
                          </span>
                        </div>

                        {rohanInvoices.filter(inv => inv.status !== 'Paid').length === 0 ? (
                          <div className="py-4 text-center text-xs text-[var(--mv-muted)] font-semibold">
                            🎉 No outstanding dues on Flat {residentFlatNo}! Clean slate.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {rohanInvoices.filter(inv => inv.status !== 'Paid').map(inv => (
                              <div key={inv.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
                                <div>
                                  <span className="font-mono text-[9px] font-bold text-[var(--mv-muted)]">{inv.invoiceNo}</span>
                                  <h5 className="font-bold text-[var(--mv-ink)] mt-0.5">{inv.period} Maintenance Bill</h5>
                                </div>
                                <div className="text-right flex items-center gap-2">
                                  <span className="font-mono font-bold text-[var(--mv-ink)]">{formatRupee(inv.total)}</span>
                                  {mayPayOnline && (
                                    <button
                                      onClick={() => handlePayClick(inv)}
                                      aria-label={`Pay ${inv.period} bill`}
                                      className="py-1 px-3 bg-[var(--mv-accent)] text-white font-bold rounded-lg text-[10px] shadow active:scale-95 cursor-pointer"
                                    >
                                      Pay
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Advance Payment trigger */}
                      <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl space-y-3 shadow-xs">
                        <div>
                          <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">Deposit Advance Funds</span>
                          <span className="text-[10px] text-[var(--mv-muted)] mt-0.5 block leading-snug">
                            Over-credit counts toward subsequent quarterly maintenance invoices.
                          </span>
                        </div>

                        {!mayPayOnline ? (
                          <p className="text-[11px] text-[var(--mv-muted)] leading-snug">
                            No payment gateway is connected. Pay the association by UPI, NEFT or cheque and the
                            manager records it; anything beyond your dues is held as an advance
                            ({formatRupees(residentAdvancePaise)} now).
                          </p>
                        ) : (
                        <form onSubmit={handleExecuteAdvance} className="space-y-2">
                          <label htmlFor="advance-mobile" className="sr-only">Advance amount</label>
                          <div className="flex gap-2">
                            <input
                              id="advance-mobile"
                              type="number"
                              value={customAdvanceInput}
                              onChange={(e) => setCustomAdvanceInput(e.target.value)}
                              placeholder="Deposit amount, e.g. 5000"
                              className="flex-1 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-xl p-2 px-3 text-xs font-mono font-bold text-[var(--mv-ink)] outline-none focus:border-[var(--mv-accent)]"
                            />
                            <button
                              type="submit"
                              disabled={working}
                              className="py-2.5 px-4 bg-[var(--mv-ink)] text-white hover:bg-black text-xs font-bold rounded-xl active:scale-95 transition-all text-center cursor-pointer shadow disabled:opacity-60"
                            >
                              Deposit
                            </button>
                          </div>
                        </form>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* MANAGER / COMMITTEE PAY VIEW (Defaulters room + Auto reconciliation ledger) */}
              {currentRole !== 'Resident' && (
                <>
                  <div className="flex items-baseline justify-between transition-all">
                    <div>
                      <h2 className="text-xl font-bold text-[var(--mv-ink)]">Defaulter Control</h2>
                      <p className="text-sm text-[var(--mv-muted)]">Aging outstanding accounts receivable ledger</p>
                    </div>
                  </div>

                  <div className="space-y-4 pb-24 text-left">
                    {/* Defaulter Registry cards list */}
                    <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl space-y-3.5 shadow-xs">
                      <div className="flex justify-between items-center pb-2 border-b border-[var(--mv-border)]">
                        <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Unpaid Overdue Units ({overdueInvoices.length})</span>
                        <span className="text-[9px] font-bold text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] px-2 py-0.5 rounded uppercase">
                          AR Ledger
                        </span>
                      </div>

                      <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1 hide-scrollbar">
                        {overdueInvoices.length === 0 ? (
                          <div className="py-4 text-center text-xs text-[var(--mv-muted)] font-semibold font-mono">
                            Excellent! No overdue flat arrears on general records.
                          </div>
                        ) : (
                          overdueInvoices.map(inv => (
                            <div key={inv.id} className="p-2.5 bg-[var(--mv-page)] rounded-xl flex justify-between items-center text-xs border border-[var(--mv-border)]">
                              <div className="min-w-0 flex-1 pr-1.5">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-extrabold text-[var(--mv-ink)]">{inv.flatNo}</span>
                                  <span className="text-[9px] font-bold text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] px-1.5 py-0.5 rounded-md truncate">
                                    {inv.name}
                                  </span>
                                </div>
                                <span className="text-[9px] text-[var(--mv-muted)] block mt-1 font-medium">Period: {inv.period} • Grace period expired</span>
                              </div>
                              <div className="text-right flex items-center gap-2 font-mono text-xs">
                                <span className="font-extrabold text-[var(--mv-ink)]">{formatRupee(inv.total)}</span>
                                {!onServer && (
                                  <button
                                    onClick={() => handleSendReminder(inv)}
                                    className="w-7 h-7 bg-[var(--mv-accent-soft)] hover:bg-[var(--mv-accent-border)] text-[var(--mv-accent)] rounded-lg transition-all flex items-center justify-center shadow"
                                    title={`Log a reminder for ${inv.flatNo}`}
                                    aria-label={`Log a reminder for flat ${inv.flatNo}`}
                                  >
                                    <Send className="w-3.5 h-3.5" aria-hidden="true" />
                                  </button>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* Receipt entry: money already in the bank, against a flat. */}
                    <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl shadow-xs">
                      {mayRecordReceipts ? (
                        <ReceiptEntryForm
                          flats={members.map(m => ({ flatNo: m.flatNo, name: m.name }))}
                          openDocumentsFor={openDocumentsFor}
                          actions={mustActions()}
                          today={today}
                          by={`${currentRole} (${sessionEmail ?? 'local'})`}
                          onRecorded={handleReceiptRecorded}
                          onError={message => triggerToast(message, 'error')}
                          {...(onServer ? { onDownloadReceipt: downloadReceiptPdf } : {})}
                          note={onServer
                            ? 'For money already in the association\'s bank. The server numbers the receipt and allocates it oldest invoice first unless you name one. No bank or gateway is contacted.'
                            : 'Demonstration: recorded in this browser only. No bank or gateway is contacted.'}
                          compact
                        />
                      ) : (
                        <p className="text-xs text-[var(--mv-muted)] leading-relaxed">
                          Receipts are recorded by the manager. This account does not hold the
                          payment.record permission.
                        </p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* =========================================
              VIEW: TAB 'BOOKS' CORE ACCOUNTING STATS
             ========================================= */}
          {activeTab === 'books' && currentRole !== 'Resident' && (
            <div className="space-y-4 animate-scale-up">

               <div className="flex justify-between items-baseline text-left">
                <div>
                  <h2 className="text-xl font-bold text-[var(--mv-ink)]">Financial Books</h2>
                  <p className="text-xs text-[var(--mv-muted)]">Double-entry ledger accuracy</p>
                </div>
                <BookOpen className="w-4 h-4 text-[var(--mv-accent)]" />
              </div>

              {/* internal switcher segment (Reports, ledgers, audit trail, budget) */}
              <div className="grid grid-cols-4 gap-1 bg-[var(--mv-soft)] p-1 rounded-xl text-[10px] uppercase font-bold text-center">
                <button
                  onClick={() => setBooksSubTab('reports')}
                  className={`py-1 rounded-lg transition-all cursor-pointer ${booksSubTab === 'reports' ? 'bg-[var(--mv-ink)] text-white shadow-sm' : 'text-[var(--mv-muted)]'}`}
                >
                  Reports
                </button>
                <button
                  onClick={() => setBooksSubTab('ledger')}
                  className={`py-1 rounded-lg transition-all cursor-pointer ${booksSubTab === 'ledger' ? 'bg-[var(--mv-ink)] text-white shadow-sm' : 'text-[var(--mv-muted)]'}`}
                >
                  Ledger
                </button>
                <button
                  onClick={() => setBooksSubTab('budget')}
                  className={`py-1 rounded-lg transition-all cursor-pointer ${booksSubTab === 'budget' ? 'bg-[var(--mv-ink)] text-white shadow-sm' : 'text-[var(--mv-muted)]'}`}
                >
                  Budget
                </button>
                <button
                  onClick={() => setBooksSubTab('audit')}
                  className={`py-1 rounded-lg transition-all cursor-pointer ${booksSubTab === 'audit' ? 'bg-[var(--mv-ink)] text-white shadow-sm' : 'text-[var(--mv-muted)]'}`}
                >
                  Audit
                </button>
              </div>

              {/* TAB Books -> Sub Reports */}
              {booksSubTab === 'reports' && (
                <div className="space-y-3 pt-1 text-left">
                  <div className="flex gap-1.5 text-[10px] uppercase font-bold justify-start">
                    <button
                      onClick={() => setReportsSubState('ie')}
                      className={`px-3 py-1 rounded-lg border font-bold transition-all cursor-pointer ${
                        reportsSubState === 'ie'
                          ? 'bg-[var(--mv-ink)] text-white border-black shadow'
                          : 'bg-[var(--mv-surface)] text-[var(--mv-muted)] border-[var(--mv-border)] hover:bg-[var(--mv-page)]'
                      }`}
                    >
                      Income & Expense
                    </button>
                    <button
                      onClick={() => setReportsSubState('bs')}
                      className={`px-3 py-1 rounded-lg border font-bold transition-all cursor-pointer ${
                        reportsSubState === 'bs'
                          ? 'bg-[var(--mv-ink)] text-white border-black shadow'
                          : 'bg-[var(--mv-surface)] text-[var(--mv-muted)] border-[var(--mv-border)] hover:bg-[var(--mv-page)]'
                      }`}
                    >
                      Balance Sheet
                    </button>
                    <button
                      onClick={() => setReportsSubState('rp')}
                      className={`px-3 py-1 rounded-lg border font-bold transition-all cursor-pointer ${
                        reportsSubState === 'rp'
                          ? 'bg-[var(--mv-ink)] text-white border-black shadow'
                          : 'bg-[var(--mv-surface)] text-[var(--mv-muted)] border-[var(--mv-border)] hover:bg-[var(--mv-page)]'
                      }`}
                    >
                      Receipts &amp; Payments
                    </button>
                    <button
                      onClick={() => setReportsSubState('tb')}
                      className={`px-3 py-1 rounded-lg border font-bold transition-all cursor-pointer ${
                        reportsSubState === 'tb'
                          ? 'bg-[var(--mv-ink)] text-white border-black shadow'
                          : 'bg-[var(--mv-surface)] text-[var(--mv-muted)] border-[var(--mv-border)] hover:bg-[var(--mv-page)]'
                      }`}
                    >
                      Trial Balance
                    </button>
                  </div>

                  <Suspense fallback={<PanelLoading />}>
                    <FinancialStatements statements={statements} which={reportsSubState} compact />
                  </Suspense>
                </div>
              )}

              {/* TAB Books -> Sub Journal ledgers */}
              {booksSubTab === 'ledger' && (
                <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs">
                  <Suspense fallback={<PanelLoading />}>
                    <JournalLedger statements={statements} compact />
                  </Suspense>
                </div>
              )}

              {/* TAB Books -> Head budgets variance */}
              {booksSubTab === 'budget' && (
                <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs text-left space-y-3">
                  <div className="border-b border-[var(--mv-border)] pb-2">
                    <span className="text-[10px] uppercase font-bold text-[var(--mv-muted)] tracking-wider block">
                      Budget against actuals
                    </span>
                    <p className="text-[9px] text-[var(--mv-muted)] mt-0.5 leading-snug">
                      Budgeted figures are demo values standing in for an approved budget.
                      The realised column and the variance are computed from the ledger.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-4 text-xs font-medium">
                    {statements.budget.map(b => (
                      <div key={b.head} className="p-3 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl space-y-1.5">
                        <div className="flex justify-between items-baseline gap-2">
                          <span className="font-bold text-[11px] text-[var(--mv-ink)] leading-snug">{b.head}</span>
                          {b.variancePercent !== null && (
                            <span className={`font-mono text-[9px] px-2 py-0.5 rounded font-bold leading-none whitespace-nowrap ${
                              b.adverse ? 'bg-red-50 text-red-700' : 'bg-[var(--mv-accent-soft)] text-[var(--mv-accent)]'
                            }`}>
                              {b.variancePercent}
                            </span>
                          )}
                        </div>
                        <div className="flex justify-between text-[10px] text-[var(--mv-muted)] font-mono">
                          <span>Budget {b.budgeted}</span>
                          <span className="font-bold text-[var(--mv-ink)]">Actual {b.actual}</span>
                        </div>
                        <div className="h-1.5 bg-[var(--mv-border)] rounded-full overflow-hidden">
                          <div
                            className={b.adverse ? 'h-full bg-red-500' : 'h-full bg-[var(--mv-accent)]'}
                            style={{ width: `${b.usedPercent}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* TAB Books -> Security Audit trail logs */}
              {booksSubTab === 'audit' && (
                <div className="space-y-3 pb-24 text-left">
                  <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">Security Audit Log</span>

                  <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1 hide-scrollbar">
                    {auditLog.map((log) => (
                      <div key={log.id} className="p-3 bg-[var(--mv-surface)] rounded-xl text-xs leading-relaxed border border-[var(--mv-border)] flex flex-col gap-1 shadow-xs">
                        <div className="flex justify-between text-[8px] font-bold text-[var(--mv-muted)] uppercase">
                          <span>👤 {log.user}</span>
                          <span className="font-mono font-medium">{log.timestamp}</span>
                        </div>
                        <p className="font-bold text-[var(--mv-ink)] leading-snug">{log.action}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}

          {/* =========================================
              VIEW: TAB 'MORE' EXPANDED PORTALS
             ========================================= */}
          {activeTab === 'office' && officeContext !== null && (
            <div className="space-y-4 animate-scale-up pb-24 text-left">
              <div>
                <h2 className="text-xl font-bold text-[var(--mv-ink)]">Office</h2>
                <p className="text-xs text-[var(--mv-muted)]">Vendors, banking, approvals and reports</p>
              </div>
              <Suspense fallback={<p className="text-sm text-[var(--mv-muted)]">Loading…</p>}>
                <OfficeHub ctx={officeContext} />
              </Suspense>
            </div>
          )}

          {activeTab === 'more' && (
            <div className="space-y-4 animate-scale-up pb-24 text-left">

              {/* Profile & reset utility option */}
              <div className="flex justify-between items-baseline pb-1">
                <div>
                  <h2 className="text-xl font-bold text-[var(--mv-ink)]">More Modules</h2>
                  <p className="text-xs text-[var(--mv-muted)]">Systems, configurations, and sandboxes</p>
                </div>
              </div>

              {showOffice && (
                <button
                  onClick={() => setActiveTab('office')}
                  className="w-full flex items-center justify-between bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 shadow-xs text-left"
                >
                  <span className="flex items-center gap-3">
                    <Briefcase className="w-5 h-5 text-[var(--mv-accent)]" aria-hidden="true" />
                    <span>
                      <span className="block text-sm font-bold text-[var(--mv-ink)]">Office</span>
                      <span className="block text-xs text-[var(--mv-muted)]">Vendors, banking, approvals and reports</span>
                    </span>
                  </span>
                  <ChevronRight className="w-4 h-4 text-[var(--mv-muted)]" aria-hidden="true" />
                </button>
              )}

              {/* HELPDESK Raising Ticketing Portal */}
              <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-2xl p-4 space-y-3 shadow-xs">
                <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">RWA Support Helpdesk</span>

                {currentRole === 'Resident' ? (
                  <form onSubmit={handleRaiseComplaint} className="space-y-3.5">
                    <div className="space-y-1">
                      <label htmlFor="ticket-category-mobile" className="text-[10px] text-[var(--mv-muted)] font-bold uppercase tracking-wider block">Grievance Category</label>
                      <select
                        id="ticket-category-mobile"
                        value={ticketCategory}
                        onChange={(e) => setTicketCategory(e.target.value as any)}
                        className="w-full bg-[var(--mv-surface)] border border-[var(--mv-border)] p-2.5 rounded-xl text-xs font-bold outline-none focus:border-[var(--mv-accent)]"
                      >
                        <option value="Plumbing">🚰 Plumbing</option>
                        <option value="Lift">🛗 Lift Maintenance</option>
                        <option value="Security">🛡️ Security & Watch</option>
                        <option value="Billing Query">🧾 Billing Ledger Query</option>
                        <option value="Other">⚙️ Other Inquiry</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="ticket-description-mobile" className="text-[10px] text-[var(--mv-muted)] font-bold uppercase tracking-wider block">Grievance Description</label>
                      <textarea
                        id="ticket-description-mobile"
                        rows={3}
                        value={ticketDescription}
                        onChange={(e) => setTicketDescription(e.target.value)}
                        placeholder="e.g. Balcony pipeline leakage or elevator noises..."
                        className="w-full bg-[var(--mv-surface)] border border-[var(--mv-border)] p-2.5 rounded-xl text-xs font-medium outline-none focus:border-[var(--mv-accent)] leading-snug"
                      />
                    </div>

                    <button
                      type="submit"
                      className="w-full py-2.5 bg-[var(--mv-accent)] text-white font-bold text-xs rounded-xl shadow active:scale-95 transition-all text-center cursor-pointer"
                    >
                      Raise Ticket Complaint
                    </button>
                  </form>
                ) : (
                  <div className="space-y-2.5">
                    <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase block">Active Grievance Log ({tickets.length})</span>

                    <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1 hide-scrollbar">
                      {tickets.map(t => (
                        <div key={t.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
                          <div className="min-w-0 flex-1 pr-1.5 space-y-1">
                            <span className="font-extrabold text-[var(--mv-ink)] block">{t.flatNo} • {t.category}</span>
                            <p className="text-[10px] text-[var(--mv-muted)] truncate leading-tight font-medium">{t.description}</p>
                          </div>
                          <div>
                            <span className={`px-2 py-0.5 text-[8px] font-bold rounded uppercase ${
                              t.status === 'Open' ? 'bg-[var(--mv-accent-soft)] text-[var(--mv-accent)]' : 'bg-[var(--mv-accent)] text-white'
                            }`}>
                              {t.status}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

               {/* MEMBER MANAGEMENT CRUD (Manager only) */}
              {currentRole === 'Manager' && (
                <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl space-y-3.5 shadow-sm text-left">
                  <div className="flex justify-between items-baseline border-b border-[var(--mv-border)] pb-2">
                    <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">{onServer ? 'Flats on record' : 'Resident Roster'}</span>
                    {!onServer && <button
                      onClick={() => {
                        setEditingMemberId(null);
                        setFormName('');
                        setFormFlat('');
                        setFormWing('A');
                        setFormContact('');
                        setMemberFormOpen(!memberFormOpen);
                      }}
                      className="text-[10px] text-[var(--mv-accent)] font-bold uppercase flex items-center gap-0.5 cursor-pointer"
                    >
                      {memberFormOpen ? 'Minimize Form' : '+ Register flat'}
                    </button>}
                  </div>

                  {onServer && (
                    <p className="text-[10px] text-[var(--mv-muted)] leading-snug">
                      Read only here. Adding, editing or removing a member is not available on this screen yet.
                    </p>
                  )}

                  {memberFormOpen && !onServer && (
                    <form onSubmit={handleSaveMember} className="space-y-3.5 text-xs bg-[var(--mv-page)] p-3.5 rounded-xl border border-[var(--mv-border)] animate-scale-up">
                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="space-y-1">
                          <label htmlFor="member-name-mobile" className="text-[9px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">Resident Full Name</label>
                          <input
                            id="member-name-mobile"
                            type="text"
                            required
                            value={formName}
                            onChange={(e) => setFormName(e.target.value)}
                            placeholder="e.g. Ramesh Desai"
                            className="w-full bg-[var(--mv-surface)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold text-xs outline-none focus:border-[var(--mv-accent)]"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="member-flat-mobile" className="text-[9px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">Flat Number</label>
                          <input
                            id="member-flat-mobile"
                            type="text"
                            required
                            value={formFlat}
                            onChange={(e) => setFormFlat(e.target.value)}
                            placeholder="e.g. C-303"
                            className="w-full bg-[var(--mv-surface)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold text-xs outline-none focus:border-[var(--mv-accent)]"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="space-y-1">
                          <label htmlFor="member-wing-mobile" className="text-[9px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">Sector Wing</label>
                          <select
                            id="member-wing-mobile"
                            value={formWing}
                            onChange={(e) => setFormWing(e.target.value as any)}
                            className="w-full bg-[var(--mv-surface)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold text-xs outline-none"
                          >
                            <option value="A">Wing A</option>
                            <option value="B">Wing B</option>
                            <option value="C">Wing C</option>
                            <option value="D">Wing D</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="member-contact-mobile" className="text-[9px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">Contact Line</label>
                          <input
                            id="member-contact-mobile"
                            type="text"
                            value={formContact}
                            onChange={(e) => setFormContact(e.target.value)}
                            placeholder="e.g. +91 988"
                            className="w-full bg-[var(--mv-surface)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold font-mono text-xs outline-none focus:border-[var(--mv-accent)]"
                          />
                        </div>
                      </div>

                      <button
                        type="submit"
                        className="w-full py-2.5 bg-[var(--mv-ink)] hover:bg-black text-white font-bold rounded-xl shadow active:scale-95 transition-all text-center cursor-pointer"
                      >
                        {editingMemberId ? 'Save Resident Modifications' : 'Register Allotment Flat'}
                      </button>
                    </form>
                  )}

                  {/* Member Roster List */}
                  <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1 hide-scrollbar">
                    {members.map(m => (
                      <div key={m.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
                        <div>
                          <span className="font-extrabold text-[var(--mv-ink)] block">{m.flatNo} • {m.name}</span>
                          <span className="text-[9px] text-[var(--mv-muted)] block font-mono">{m.contact}</span>
                        </div>
                        {!onServer && (
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => handleEditMemberClick(m)}
                              className="w-7 h-7 bg-[var(--mv-surface)] border border-[var(--mv-border)] hover:bg-[var(--mv-soft)] text-[var(--mv-muted)] hover:text-[var(--mv-ink)] rounded-lg transition-all flex items-center justify-center cursor-pointer shadow-xs"
                              title="Edit"
                              aria-label={`Edit ${m.name}, flat ${m.flatNo}`}
                            >
                              <Edit3 className="w-3 h-3" aria-hidden="true" />
                            </button>
                            <button
                              onClick={() => handleDeleteMember(m.id, m.name)}
                              className="w-7 h-7 bg-[var(--mv-surface)] border border-[var(--mv-border)] hover:bg-red-50 text-red-700 rounded-lg transition-all flex items-center justify-center cursor-pointer shadow-xs"
                              title="Remove"
                              aria-label={`Remove ${m.name}, flat ${m.flatNo}`}
                            >
                              <Trash2 className="w-3 h-3" aria-hidden="true" />
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                </div>
              )}

              {/* VENDOR LEDGER & CONTRACTS OUTLINE (Committee / manager accessible) */}
              {currentRole !== 'Resident' && (
                <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl space-y-3.5 shadow-sm text-left">
                  <div className="flex justify-between items-center pb-1 border-b border-[var(--mv-border)]">
                    <span className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Vendor Ledgers & Contracts</span>
                    <span className="text-[8px] font-bold text-[var(--mv-ink)] bg-[var(--mv-soft)] px-1.5 py-0.5 rounded-md font-mono">Sec 194C Compliant</span>
                  </div>

                  <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1 hide-scrollbar">
                    {vendors.map(v => (
                      <div key={v.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
                        <div className="min-w-0 flex-1 pr-1 bg-transparent">
                          <h5 className="font-bold text-[var(--mv-ink)] truncate">{v.name}</h5>
                          <span className="text-[9px] font-bold text-[var(--mv-muted)] block mt-0.5 uppercase tracking-wide">
                            {v.category}
                          </span>
                          <span className="text-[9px] text-[var(--mv-accent)] font-bold mt-1.5 block">
                            Renewal: <span className="text-[var(--mv-muted)] font-semibold">{v.contractRenewal}</span>
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="font-mono text-xs font-bold text-[var(--mv-ink)] block leading-tight">{formatRupee(v.balance)}</span>
                          <span className="text-[9px] text-[var(--mv-muted)] font-bold uppercase tracking-tight block mt-1">Due Balance</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* CLOUD GOOGLE SHEETS BACKUP MODULE INTEGRATION FOR ALL ROLES */}
              {currentRole !== 'Resident' && (
                <Suspense fallback={<PanelLoading />}>
                  <BackupHub
                    backupHistory={backupHistory}
                    onTriggerBackup={handleTriggerBackup}
                    onResetData={handleReset}
                    onServer={onServer}
                    exportJson={() => mustBooks().exportJson()}
                  />
                </Suspense>
              )}

              {/* Basic quick switch user suggestion details / manual info cards */}
              <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl text-left space-y-2 relative shadow-xs">
                <span className="text-[9px] font-bold text-[var(--mv-accent)] uppercase tracking-wider bg-[var(--mv-accent-soft)] px-2 py-0.5 rounded-md inline-block">
                  Co-op Housing Regulatory Code
                </span>
                <p className="text-[10px] text-[var(--mv-muted)] leading-relaxed pt-0.5 font-medium">
                  Billing and statutory treatment require review against Mani Vista bylaws and the applicable laws before production use. GSTIN {gstinLabel}.
                </p>
                {currentRole === 'Resident' && !onServer && (
                  <button
                    onClick={handleReset}
                    className="mt-2 text-[10px] font-bold text-[var(--mv-accent)] block py-1 cursor-pointer hover:underline"
                  >
                    Reset Sandbox Default Seed Data
                  </button>
                )}
              </div>

              {/* Logged-in member + logout */}
              <div className="bg-[var(--mv-surface)] border border-[var(--mv-border)] p-4 rounded-2xl text-left shadow-xs">
                <p className="text-[9px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Logged in as</p>
                <p className="text-xs font-bold text-[var(--mv-ink)] truncate mt-0.5" title={sessionEmail || ''}>{sessionEmail}</p>
                <button
                  onClick={handleLogout}
                  className="mt-3 w-full py-2.5 bg-[var(--mv-ink)] text-white rounded-xl text-xs font-bold uppercase tracking-wider hover:opacity-90 active:scale-[0.99] transition-all"
                >
                  Logout
                </button>
              </div>

            </div>
          )}

        </main>

        {/* --- STICKY BOTTOM NAV BAR (ALWAYS VISIBLE - BLACK THEMED) --- */}
        <nav aria-label="Sections" className="absolute bottom-0 left-0 right-0 bg-[var(--mv-ink)] text-white border-t border-[var(--mv-dark-border)] py-3.5 px-3 flex justify-around items-center z-30 shadow-2xl rounded-t-3xl min-h-[64px]">

          <button
            onClick={() => setActiveTab('home')}
            aria-current={activeTab === 'home' ? 'page' : undefined}
            className={`flex flex-col items-center gap-1 cursor-pointer transition-colors ${activeTab === 'home' ? 'text-[var(--mv-accent-on-dark)]' : 'text-white/70 hover:text-white'}`}
          >
            <Home className="w-5 h-5" />
            <span className="text-[9px] font-bold uppercase tracking-wider">Home</span>
          </button>

          <button
            onClick={() => setActiveTab('bills')}
            aria-current={activeTab === 'bills' ? 'page' : undefined}
            className={`flex flex-col items-center gap-1 cursor-pointer transition-colors ${activeTab === 'bills' ? 'text-[var(--mv-accent-on-dark)]' : 'text-white/70 hover:text-white'}`}
          >
            <Receipt className="w-5 h-5" />
            <span className="text-[9px] font-bold uppercase tracking-wider">Bills</span>
          </button>

          <button
            onClick={() => {
              if (currentRole === 'Resident') {
                setActiveTab('pay');
              } else {
                setActiveTab('pay'); // Also opens Manager room
              }
            }}
            aria-current={activeTab === 'pay' ? 'page' : undefined}
            className={`flex flex-col items-center gap-1 cursor-pointer transition-colors ${activeTab === 'pay' ? 'text-[var(--mv-accent-on-dark)]' : 'text-white/70 hover:text-white'}`}
          >
            <CreditCard className="w-5 h-5" />
            <span className="text-[9px] font-bold uppercase tracking-wider">Pay Rooms</span>
          </button>

          <button
            onClick={() => {
              if (currentRole === 'Resident') {
                // Resident cannot open books screen - show prompt!
                triggerToast('The books are for the manager and committee views. Switch view to open them.', 'error');
                handleRoleSwitchRequest('Manager'); // Direct trigger to authenticating
              } else {
                setActiveTab('books');
              }
            }}
            aria-current={activeTab === 'books' ? 'page' : undefined}
            className={`flex flex-col items-center gap-1 cursor-pointer transition-colors ${activeTab === 'books' ? 'text-[var(--mv-accent-on-dark)]' : 'text-white/70 hover:text-white'}`}
          >
            <div className="relative">
              <BookOpen className="w-5 h-5" />
              {currentRole === 'Resident' && (
                <Lock className="w-2.5 h-2.5 text-[var(--mv-accent)] absolute -top-1 -right-1 bg-[var(--mv-surface)] rounded-full p-0.5" aria-label="Locked" />
              )}
            </div>
            <span className="text-[9px] font-bold uppercase tracking-wider flex items-center justify-center">
              Books
            </span>
          </button>

          <button
            onClick={() => setActiveTab('more')}
            aria-current={activeTab === 'more' ? 'page' : undefined}
            className={`flex flex-col items-center gap-1 cursor-pointer transition-colors ${activeTab === 'more' ? 'text-[var(--mv-accent-on-dark)]' : 'text-white/70 hover:text-white'}`}
          >
            <Menu className="w-5 h-5" />
            <span className="text-[9px] font-bold uppercase tracking-wider">More</span>
          </button>

        </nav>

      </div>
      ) : null}

      {/* --- DYNAMIC FLOATING OVERLAYS MODALS (shared across desktop & mobile) --- */}
      {/* Each is rendered only while open, so its code is fetched only then. */}
      <Suspense fallback={null}>
        {/* 1. Administrative access credentials validation PIN modal */}
        {showAuthModal && (
          <AdminPinModal
            isOpen={showAuthModal}
            targetRole={authTargetRole}
            onClose={() => setShowAuthModal(false)}
            onSuccess={handleAuthSuccess}
          />
        )}

        {/* 2. Invoice Details Breakdown Modal (mobile only — desktop uses inline master-detail panel) */}
        {!isDesktop && selectedInvoice !== null && (
          <InvoiceDetailModal
            invoice={selectedInvoice}
            role={currentRole}
            onClose={() => setSelectedInvoice(null)}
            {...(mayPayOnline ? {
              onPayNow: (inv: Invoice) => {
                setSelectedInvoice(null);
                handlePayClick(inv);
              },
            } : {})}
            {...(onServer ? {} : { onSendReminder: handleSendReminder })}
            gstinLabel={gstinLabel}
            {...(booksSource.server !== null
              ? { onDownloadPdf: (inv: Invoice) => booksSource.server!.invoicePdf(inv.id) }
              : {})}
          />
        )}

        {/* 4. Receipt Download view Modal */}
        {showReceiptModal && selectedReceipt !== null && (
          <ReceiptModal
            isOpen={showReceiptModal}
            invoice={selectedReceipt}
            onClose={() => {
              setShowReceiptModal(false);
              setSelectedReceipt(null);
            }}
            gstinLabel={gstinLabel}
            demonstration={!onServer}
            {...(booksSource.server !== null && selectedReceipt.transactionId !== undefined
              ? { onDownloadPdf: (inv: Invoice) => booksSource.server!.receiptPdf(inv.transactionId ?? '') }
              : {})}
          />
        )}
      </Suspense>

      {/* 3. Payment recorded. What the books said, and nothing more: the receipt
          number is the one they issued, and no bank is claimed to have been
          involved — there is no gateway. */}
      {showSuccessPayModal && selectedReceipt && lastReceipt && (
        <Dialog
          labelledBy="payment-recorded-title"
          onClose={() => setShowSuccessPayModal(false)}
          className="bg-[var(--mv-surface)] w-full max-w-[340px] rounded-3xl overflow-hidden shadow-2xl border border-[var(--mv-border)] p-5 text-center space-y-4 animate-scale-up outline-none"
        >
          <div className="w-12 h-12 bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] rounded-full flex items-center justify-center mx-auto">
            <Check className="w-6 h-6" aria-hidden="true" />
          </div>
          <div>
            <h3 id="payment-recorded-title" className="font-extrabold text-sm text-[var(--mv-ink)]">Payment recorded</h3>
            <p className="text-xs text-[var(--mv-muted)] mt-1">
              {formatRupees(lastReceipt.appliedToDues)} applied to dues
              {lastReceipt.heldAsAdvance > 0 ? `, ${formatRupees(lastReceipt.heldAsAdvance)} held as an advance` : ''}.
              {lastReceipt.outstandingAfter !== null && lastReceipt.outstandingAfter > 0
                ? ` ${formatRupees(lastReceipt.outstandingAfter)} still outstanding.`
                : ''}
            </p>
            {lastReceipt.note !== null && (
              <p className="text-[10px] text-[var(--mv-muted)] mt-1">{lastReceipt.note}</p>
            )}
          </div>

          <div className="bg-[var(--mv-page)] p-3 rounded-2xl border border-[var(--mv-border)] text-xs font-mono">
            <p className="text-[var(--mv-muted)] text-[10px]">RECEIPT NUMBER</p>
            <p className="font-extrabold text-[var(--mv-ink)] mt-0.5 break-all">{lastReceipt.receiptNo}</p>
            <p className="font-extrabold text-[var(--mv-ink)] mt-1.5">{formatRupee(lastReceipt.amountRupees)}</p>
          </div>

          <div className="flex gap-2.5">
            <button
              data-autofocus
              onClick={() => {
                setShowSuccessPayModal(false);
                if (onServer) {
                  downloadReceiptPdf(lastReceipt.receiptNo)
                    .catch((err: unknown) => toastError(err, 'The receipt could not be fetched.'));
                } else {
                  setShowReceiptModal(true);
                }
              }}
              className="flex-1 py-2 px-3 bg-[var(--mv-accent)] text-white rounded-xl text-xs font-bold"
            >
              {onServer ? 'Download receipt PDF' : 'View receipt'}
            </button>
            <button
              onClick={() => setShowSuccessPayModal(false)}
              className="py-2 px-3 bg-[var(--mv-surface)] border border-[var(--mv-border)] rounded-xl text-xs font-semibold text-[var(--mv-muted)]"
            >
              Close
            </button>
          </div>
        </Dialog>
      )}

    </div>
  );
}
