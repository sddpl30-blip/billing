import React, { useState, useEffect, useMemo } from 'react';
import { 
  Home, 
  Receipt, 
  CreditCard, 
  BookOpen, 
  Menu, 
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
  AreaChart, 
  Area, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer 
} from 'recharts';

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

// Importing Custom Modals
import { AdminPinModal } from './components/AdminPinModal';
import { InvoiceDetailModal } from './components/InvoiceDetailModal';
import { ReceiptModal } from './components/ReceiptModal';
import { BackupHub } from './components/BackupHub';
import { FinancialStatements } from './components/FinancialStatements';
import { JournalLedger } from './components/JournalLedger';
import { BillingWorkflow } from './components/BillingWorkflow';
import {
  buildStatements, formatRupees, isoToDayMonthYear, periodLabel, periodToIso,
  systemClock, toRupees,
} from './accounting';
import { EXPENSE_ACCOUNTS } from './store/booksStore';
import { useBooks } from './store/useBooks';
import {
  apiCategoryFor, invoicesFrom, residentsFrom, ticketsFrom, vendorInvoicesFrom, vendorsFrom,
} from './api/legacy';
import type { SnapshotResponse, TicketResponse } from './api/client';
import { LoginScreen } from './components/LoginScreen';
import { ThemeSwitcher } from './components/ThemeSwitcher';

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
  const [activeTab, setActiveTab] = useState<'home' | 'bills' | 'pay' | 'books' | 'more'>('home');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  
  // --- Modals Triggers ---
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authTargetRole, setAuthTargetRole] = useState<'Manager' | 'Committee'>('Manager');
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<Invoice | null>(null);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [showSuccessPayModal, setShowSuccessPayModal] = useState(false);

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
  const [wizardCycle, setWizardCycle] = useState('Monthly');
  const [wizardMaint, setWizardMaint] = useState('2500');
  const [wizardSinking, setWizardSinking] = useState('500');
  const [wizardWater, setWizardWater] = useState('300');
  const [wizardParking, setWizardParking] = useState('0');

  // Books Tab Reports internal tabs
  const [booksSubTab, setBooksSubTab] = useState<'ledger' | 'reports' | 'budget' | 'audit'>('reports');
  const [reportsSubState, setReportsSubState] = useState<'ie' | 'bs' | 'rp' | 'tb'>('ie');

  // Notifications Queue
  const [toaster, setToaster] = useState<{ id: string; msg: string }[]>([]);

  // Trigger Local Toast
  const triggerToast = (msg: string) => {
    const id = Date.now().toString();
    setToaster(prev => [...prev, { id, msg }]);
    setTimeout(() => {
      setToaster(prev => prev.filter(t => t.id !== id));
    }, 4500);
  };

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
  });
  const books = booksSource.store;
  const onServer = booksSource.kind === 'server';
  const booksVersion = booksSource.version;

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
   * Runs whenever the store changes, which is after every write. The members,
   * the invoices, the vendors and their bills all come out of the snapshot the
   * store has already rehydrated, so what is on screen and what the ledger
   * says are the same records rather than two lists that have to be kept in
   * step.
   */
  useEffect(() => {
    if (!onServer || booksSource.client === null || books === null) return;
    let cancelled = false;

    void (async () => {
      try {
        const snapshot = await booksSource.client!.get<SnapshotResponse>('/api/books/snapshot');
        if (cancelled) return;

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
      } catch (err) {
        if (!cancelled) {
          triggerToast(
            `Could not read the books: ${err instanceof Error ? err.message : 'unknown error'}`,
          );
        }
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onServer, booksSource.client, books, booksVersion]);

  /** Tickets, and the audit trail, from their own endpoints. */
  useEffect(() => {
    if (!onServer || booksSource.client === null) return;
    let cancelled = false;

    void (async () => {
      try {
        const response = await booksSource.client!.get<{ tickets: readonly TicketResponse[] }>(
          '/api/tickets',
        );
        if (!cancelled) setTickets(ticketsFrom(response.tickets));
      } catch {
        // A resident with no helpdesk permission gets a 403 here, which is
        // not an error worth a toast — it means the screen has nothing to show.
      }
      try {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onServer, booksSource.client, booksVersion]);

  /**
   * The view follows the roles the server granted.
   *
   * The demo let the PIN modal decide which view to show and nothing checked
   * it. Here the server decides what the account may do, and this only picks
   * which of those views to open on.
   */
  useEffect(() => {
    if (!onServer || booksSource.session === null) return;
    setIsAuthenticated(booksSource.session.availableViews.length > 1);
    setCurrentRole(booksSource.session.view);
    // The address in the corner, from the session the server confirmed. A
    // cookie from a previous visit means there is no sign-in to go through,
    // so this is where it arrives.
    setSessionEmail(booksSource.session.email);
  }, [onServer, booksSource.session]);

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

  // Reset sandbox flow
  const handleReset = () => {
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
    void booksSource.signOut();
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

  // --- DYNAMIC QUANTITATIVE MATHEMATICS ---
  // 1. Resident
  const rohanInvoices = invoices.filter(inv => inv.flatNo === residentFlatNo);
  const rohanDueInvoice = rohanInvoices.find(inv => inv.status !== 'Paid' && inv.period === 'Jun 2026');
  const rohanTotalDueNum = rohanInvoices.filter(inv => inv.status !== 'Paid').reduce((acc, current) => acc + current.total, 0);
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
    // them — `importSeedOnce` on the server store declines and says why.
    if (books === null || onServer) return;
    const result = books.importSeedOnce('demo-invoices-v1', INITIAL_INVOICES);
    if (!result.imported && result.entriesAdded === 0) {
      // Not an error: the usual case is that it was imported on a previous
      // visit. Left on the store's problem list rather than toasted.
      return;
    }
  }, [books, onServer]);

  /** Today, from one clock, instead of a date literal in each handler. */
  const today = systemClock.today();

  /**
   * The flat the signed-in resident is looking at.
   *
   * From the session, which got it from the owner record on the server. In
   * demo mode it is the sample flat. On the server with no flat linked to the
   * account it is empty — and empty is the truthful answer, not a fallback to
   * somebody else's flat.
   */
  const residentFlatNo = booksSource.session?.primaryFlatNo ?? '';

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

  // 3. Committee
  const corpusFundBase = 4820000;
  const sinkingFundBase = 1260000;
  const operatingFundBase = 684500;
  const pendingApprovalsCount = vendorInvoices.filter(v => v.status === 'Pending').length;

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
    setPayingInvoice(invoice);
    setPartialAmountInput('');
    setCustomAdvanceInput('');
    setActiveTab('pay');
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
      triggerToast('Enter an advance amount greater than zero.');
      return;
    }

    const flatNo = residentFlatNo;
    const ref = `ADV-${Date.now().toString().slice(-8)}`;

    let result;
    try {
      result = mustBooks().depositAdvance({
        flatNo,
        amountRupees: value,
        receiptNo: ref,
        method: 'UPI',
        by: `${currentRole} (${flatNo})`,
      });
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'The advance could not be recorded.');
      return;
    }

    const newLog: AuditLog = {
      id: `audit-${Date.now()}`,
      user: `${currentRole} (${flatNo})`,
      action:
        `Advance deposit ${ref} of ${formatRupees(fromRupeesSafe(value))}. ` +
        `${formatRupees(result.appliedToDues)} applied to open bills, ` +
        `${formatRupees(result.heldAsAdvance)} held on account.`,
      timestamp: systemClock.now(),
    };
    syncAndPersist({ audit: [newLog, ...auditLog] });

    setCustomAdvanceInput('');
    triggerToast(
      result.appliedToDues > 0
        ? `Advance recorded; ${formatRupees(result.appliedToDues)} went against open bills.`
        : `Advance of ${formatRupees(fromRupeesSafe(value))} held on account.`,
    );
  };

  /**
   * Logs a reminder against a flat.
   *
   * No messaging provider is wired in — that needs a server holding a Gupshup
   * or Twilio key — so this records the reminder and says so, rather than
   * reporting a broadcast that did not happen.
   */
  const handleSendReminder = (invoice: Invoice) => {
    const newLog: AuditLog = {
      id: `audit-${Date.now()}`,
      user: `Manager (${currentRole})`,
      action:
        `Reminder logged for flat ${invoice.flatNo} (${invoice.name}) on ` +
        `${invoice.invoiceNo}, ${formatRupees(fromRupeesSafe(invoice.total))} outstanding.`,
      timestamp: systemClock.now(),
    };
    syncAndPersist({ audit: [newLog, ...auditLog] });
    triggerToast(
      `Reminder logged for ${invoice.name} (${invoice.flatNo}). ` +
      `Demo — no WhatsApp or SMS is sent.`,
    );
  };

  /**
   * Records a member's payment through the accounting engine.
   *
   * What this replaces: the old handler marked the invoice `Paid` whatever was
   * tendered, and credited the receivable with the amount actually received,
   * so a part payment left the invoice list and the books disagreeing by the
   * balance. Now the receipt is allocated against the invoice, the ledger
   * records what is still owed, and the status is read back from it.
   */
  const handleExecutePayment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!payingInvoice) return;

    const typed = parseFloat(partialAmountInput);
    const amountRupees = Number.isFinite(typed) && typed > 0 ? typed : payingInvoice.total;
    if (amountRupees <= 0) {
      triggerToast('Enter an amount greater than zero.');
      return;
    }

    // The register works in proforma numbers. An invoice carried over from the
    // seed has no register document, so one is raised and approved for it
    // first — the alternative is a receipt with no document behind it.
    const docRef = ensureRegisterDocument(payingInvoice);
    if (docRef === null) return;

    const receiptNo = `RCT-${payingInvoice.invoiceNo}-${Date.now().toString().slice(-6)}`;
    let result;
    try {
      result = mustBooks().recordMemberPayment({
        proformaNo: docRef,
        amountRupees,
        receiptNo,
        method: paymentMethod,
        by: `${currentRole} (${payingInvoice.flatNo})`,
      });
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'The payment could not be recorded.');
      return;
    }

    const view = mustBooks().snapshot().register.get(docRef);
    const outstandingRupees = toRupees(result.outstandingAfter);

    // The array keeps the document list the screens already render; its status
    // now mirrors what the ledger says rather than being set independently.
    const updatedInvoices = invoices.map(inv =>
      inv.id === payingInvoice.id
        ? {
            ...inv,
            status: (view?.status === 'Paid' ? 'Paid' : 'Pending') as Invoice['status'],
            paidDate: isoToDayMonthYear(today),
            paymentMethod,
            transactionId: receiptNo,
          }
        : inv);

    const newLog: AuditLog = {
      id: `audit-${Date.now()}`,
      user: `${currentRole} ${payingInvoice.name} (${payingInvoice.flatNo})`,
      action:
        `Receipt ${receiptNo} of ${formatRupees(fromRupeesSafe(amountRupees))} against ` +
        `${view?.taxInvoiceNo ?? docRef} via ${paymentMethod}. ` +
        `${formatRupees(result.appliedToDues)} applied to dues` +
        (result.heldAsAdvance > 0 ? `, ${formatRupees(result.heldAsAdvance)} held as advance` : '') +
        `. Outstanding after: ${formatRupees(result.outstandingAfter)}.`,
      timestamp: systemClock.now(),
    };

    syncAndPersist({ invoices: updatedInvoices, audit: [newLog, ...auditLog] });

    const receiptInvoice = updatedInvoices.find(inv => inv.id === payingInvoice.id) || payingInvoice;
    setSelectedReceipt(receiptInvoice);
    setPayingInvoice(null);
    setShowSuccessPayModal(true);

    triggerToast(
      outstandingRupees > 0
        ? `Receipt recorded. ${formatRupees(result.outstandingAfter)} still outstanding on this bill.`
        : result.heldAsAdvance > 0
          ? `Bill settled. ${formatRupees(result.heldAsAdvance)} held as an advance.`
          : 'Bill settled in full.',
    );
  };

  /**
   * Finds or creates the register document for a seeded invoice.
   *
   * The demo's invoice array predates the register, so an invoice from the
   * seed has no document. Rather than letting a receipt post against nothing,
   * a proforma is raised from the invoice's own lines and approved, which
   * keeps the amounts identical to what the member was shown.
   */
  const ensureRegisterDocument = (invoice: Invoice): string | null => {
    const existing = mustBooks().documentsFor(invoice.flatNo)
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
      triggerToast(`Invoice ${invoice.invoiceNo} has no chargeable lines, so no receipt can be applied to it.`);
      return null;
    }

    try {
      const doc = mustBooks().snapshot().register.issueProforma({
        flatNo: invoice.flatNo,
        period: invoice.period,
        lines,
      });
      mustBooks().approveDocuments([doc.proformaNo], `${currentRole} (carried forward from ${invoice.invoiceNo})`);
      return doc.proformaNo;
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : `Could not open a document for ${invoice.invoiceNo}.`);
      return null;
    }
  };

  // Member management CRUD triggers
  const handleSaveMember = (e: React.FormEvent) => {
    e.preventDefault();
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
    setEditingMemberId(m.id);
    setFormName(m.name);
    setFormFlat(m.flatNo);
    setFormWing(m.wing);
    setFormContact(m.contact);
    setMemberFormOpen(true);
  };

  const handleDeleteMember = (id: string, name: string) => {
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
   * separate steps, each with its own posting or none at all.
   */
  const handleVendorInvoiceStatus = (id: string, status: 'Approved' | 'Rejected') => {
    const target = vendorInvoices.find(vi => vi.id === id);
    if (!target) return;

    if (status === 'Rejected') {
      mustBooks().rejectVendorBill(id, `Treasurer (${currentRole})`, 'Rejected on review');
      const updated = vendorInvoices.map(vi => (vi.id === id ? { ...vi, status } : vi));
      syncAndPersist({
        vendorInvoices: updated,
        audit: [{
          id: `audit-${Date.now()}`,
          user: `Treasurer (${currentRole})`,
          action: `Rejected vendor bill ${id} from ${target.vendorName}. Nothing was posted.`,
          timestamp: systemClock.now(),
        }, ...auditLog],
      });
      triggerToast(`Vendor bill from ${target.vendorName} rejected. Nothing posted.`);
      return;
    }

    // Approve, then book. Booking debits the expense at gross, credits the
    // payable net of tax and credits the TDS withheld; it does not touch the
    // bank. Paying is a separate action on the Payables screen.
    mustBooks().approveVendorBill(id, `Treasurer (${currentRole})`);
    mustBooks().bookApprovedVendorBill(
      id,
      `Treasurer (${currentRole})`,
      expenseAccountForCategory(target.category),
    );

    const booked = mustBooks().snapshot().vendorBills.find(v => v.id === id);
    if (booked?.state !== 'booked') {
      triggerToast(
        mustBooks().snapshot().problems[0] ??
        `Vendor bill ${id} could not be booked.`,
      );
      return;
    }

    const payableNow = mustBooks().snapshot().ledger.balanceOf(
      '2000', { party: target.vendorId },
    );
    const updated = vendorInvoices.map(vi => (vi.id === id ? { ...vi, status } : vi));
    syncAndPersist({
      vendorInvoices: updated,
      audit: [{
        id: `audit-${Date.now()}`,
        user: `Treasurer (${currentRole})`,
        action:
          `Approved and booked vendor bill ${id} from ${target.vendorName}: ` +
          `${formatRupees(fromRupeesSafe(target.amount))} to expense, ` +
          `${formatRupees(fromRupeesSafe(target.tdsAmount))} TDS withheld, ` +
          `${formatRupees(fromRupeesSafe(target.netPayable))} payable. ` +
          `Not paid — payment is a separate step.`,
        timestamp: systemClock.now(),
      }, ...auditLog],
    });

    triggerToast(
      `Booked ${formatRupees(fromRupeesSafe(target.amount))} to expense for ` +
      `${target.vendorName}. ${formatRupees(payableNow)} now payable — not yet paid.`,
    );
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
      );
      return;
    }

    const payable = mustBooks().snapshot().ledger.balanceOf('2000', { party: bill.vendorId });
    if (payable <= 0) {
      triggerToast(`Nothing outstanding to ${bill.vendorName}.`);
      return;
    }

    const paymentRef = `PAY-${id}-${Date.now().toString().slice(-6)}`;
    mustBooks().payVendor({
      id,
      amountRupees: toRupees(payable),
      paymentRef,
      by: `Treasurer (${currentRole})`,
    });

    syncAndPersist({
      audit: [{
        id: `audit-${Date.now()}`,
        user: `Treasurer (${currentRole})`,
        action:
          `Paid ${formatRupees(payable)} to ${bill.vendorName} against ${id} ` +
          `(${paymentRef}). Recorded in the books; no bank transfer was initiated — ` +
          `this application has no banking connection.`,
        timestamp: systemClock.now(),
      }, ...auditLog],
    });
    triggerToast(
      `${formatRupees(payable)} recorded as paid to ${bill.vendorName}. ` +
      `Books only — no bank transfer was made.`,
    );
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
   * document for the period is skipped and reported.
   *
   * Nothing is posted here. The run raises proformas; the receivable and the
   * GST arise when the treasurer's approval is followed by conversion.
   */
  const handleRunBillGeneration = (e: React.FormEvent) => {
    e.preventDefault();

    const period = wizardPeriod.trim();
    if (periodToIso(period) === null) {
      triggerToast(`"${period}" is not a month and year. Use a form like "Jul 2026".`);
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

    let result;
    try {
      result = mustBooks().runBillingFor({
        period,
        flats,
        commonCharges,
        ...(Number.isFinite(sinkingPercent) && sinkingPercent > 0
          ? { sinkingFundPercentOfMaintenance: sinkingPercent } : {}),
      });
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'The billing run could not start.');
      return;
    }

    const newLog: AuditLog = {
      id: `audit-${Date.now()}`,
      user: `Manager (${currentRole})`,
      action:
        `Billing run for ${period}: ${result.documents.length} proforma invoices raised ` +
        `totalling ${formatRupees(result.totalGross)} ` +
        `(${formatRupees(result.totalNet)} charges plus ${formatRupees(result.totalTax)} GST). ` +
        `${result.skipped.length} flats not billed. ` +
        `Awaiting treasurer approval — nothing has been posted to the books.`,
      timestamp: systemClock.now(),
    };
    syncAndPersist({ audit: [newLog, ...auditLog] });

    setShowBillingWizard(false);
    triggerToast(
      result.documents.length === 0
        ? `No bills raised for ${period}. ${result.skipped.length} flats skipped — see the run report.`
        : `${result.documents.length} proformas raised for ${period}, ` +
          `${formatRupees(result.totalGross)} in total. Awaiting approval.`,
    );
  };

  /** Treasurer approval for every draft in the register. */
  const handleApproveAllDrafts = () => {
    const drafts = registerDocuments.filter(d => d.state === 'draft').map(d => d.proformaNo);
    if (drafts.length === 0) {
      triggerToast('There are no drafts awaiting approval.');
      return;
    }
    const result = mustBooks().approveDocuments(drafts, `Treasurer (${currentRole})`);
    syncAndPersist({
      audit: [{
        id: `audit-${Date.now()}`,
        user: `Treasurer (${currentRole})`,
        action:
          `Approved ${result.approved} proforma invoices for dispatch` +
          (result.refused > 0 ? `; ${result.refused} refused` : '') + '.',
        timestamp: systemClock.now(),
      }, ...auditLog],
    });
    triggerToast(`${result.approved} proformas approved.`);
  };

  /** Releases approved proformas. Records that nothing was actually sent. */
  const handleReleaseApproved = () => {
    const approved = registerDocuments.filter(d => d.state === 'approved');
    if (approved.length === 0) {
      triggerToast('There is nothing approved and waiting to be released.');
      return;
    }
    for (const doc of approved) {
      mustBooks().releaseDocument(doc.proformaNo, `Treasurer (${currentRole})`);
    }
    syncAndPersist({
      audit: [{
        id: `audit-${Date.now()}`,
        user: `Treasurer (${currentRole})`,
        action:
          `Released ${approved.length} proforma invoices for dispatch. No email or messaging ` +
          `provider is configured, so nothing was sent to any member.`,
        timestamp: systemClock.now(),
      }, ...auditLog],
    });
    triggerToast(
      `${approved.length} proformas released. Nothing was sent — no delivery channel is configured.`,
    );
  };

  /**
   * Converts every released proforma that has fallen due into a tax invoice.
   * This is the step that posts the receivable and the GST.
   */
  const handleConvertDue = () => {
    const result = mustBooks().convertDueDocuments(`Treasurer (${currentRole})`);
    if (result.converted === 0) {
      triggerToast(
        mustBooks().snapshot().problems[0] ?? 'Nothing has fallen due for conversion yet.',
      );
      return;
    }
    syncAndPersist({
      audit: [{
        id: `audit-${Date.now()}`,
        user: `Treasurer (${currentRole})`,
        action:
          `Converted ${result.converted} proformas to tax invoices on their due date, ` +
          `posting the receivable and the GST` +
          (result.refused > 0 ? `; ${result.refused} refused` : '') + '.',
        timestamp: systemClock.now(),
      }, ...auditLog],
    });
    triggerToast(`${result.converted} tax invoices issued and posted.`);
  };


  // Defaulters List computation
  const overdueInvoices = invoices.filter(inv => inv.status === 'Overdue');

  // Selected Invoice with fallback for desktop master-detail layout
  const currentInvoices = invoices.filter(inv => currentRole === 'Resident' ? inv.flatNo === residentFlatNo : true);
  const desktopActiveInvoice = selectedInvoice && (currentRole === 'Resident' ? selectedInvoice.flatNo === residentFlatNo : true)
    ? selectedInvoice
    : (currentInvoices[0] || null);
  
  // Custom Analytics Data for Chart
  const collectionTrendsData = [
    { month: 'Jan', Collected: 310000, Outstanding: 45000 },
    { month: 'Feb', Collected: 345000, Outstanding: 39000 },
    { month: 'Mar', Collected: 380000, Outstanding: 30000 },
    { month: 'Apr', Collected: 392000, Outstanding: 21000 },
    { month: 'May', Collected: 382000, Outstanding: 115000 }, // Defaulters season
    { month: 'Jun', Collected: mtdCollectedTotal || 386400, Outstanding: mtdOutstandingTotal || 112300 }
  ];

  const budgetPerformanceData = [
    { head: 'Maint', Budgeted: 350000, Actual: 338000 },
    { head: 'Sinking', Budgeted: 80000, Actual: 80000 },
    { head: 'Water', Budgeted: 45000, Actual: 54000 },
    { head: 'Rentals', Budgeted: 25000, Actual: 21000 },
    { head: 'Reserve', Budgeted: 15000, Actual: 15400 }
  ];

  // --- what to show before the books are open ------------------------------

  /** While the app is working out where the books are. */
  if (booksSource.status === 'resolving' || books === null) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[var(--mv-soft)] font-sans p-6">
        <div className="text-center">
          <div className="mv-logo-tile mx-auto"><img src="/branding/mani-vista-logo.png" alt="Mani Vista" /></div>
          <p className="mt-4 text-sm font-bold text-[var(--mv-ink)]">Opening the books</p>
          <p className="mt-1 text-xs text-gray-500 max-w-xs">{booksSource.note}</p>
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
        <div className="fixed top-0 inset-x-0 z-[80] bg-[var(--mv-ink)] text-white text-[10px] sm:text-[11px] font-bold px-3 py-1.5 text-center leading-tight">
          DEMONSTRATION DATA · {booksSource.note}
          {booksSource.error !== null && <span className="text-red-300"> · {booksSource.error}</span>}
        </div>
      )}
      
      {/* 1. DYNAMIC DESKTOP VIEWPORT LAYOUT */}
      {isDesktop ? (
        <div id="desktop-view-container" className="fixed inset-0 w-full h-screen flex bg-[var(--mv-page)] text-[var(--mv-ink)] overflow-hidden font-sans z-50">
          
          {/* DESKTOP SIDEBAR GROUP */}
          <aside className="w-64 bg-[var(--mv-ink)] text-white flex flex-col h-screen shrink-0 border-r border-[var(--mv-dark-border)] select-none">
            {/* Top RWA Brand header */}
            <div className="p-5 border-b border-[var(--mv-dark-border)] flex items-center gap-2.5">
              <div className="mv-logo-tile"><img src="/branding/mani-vista-logo.png" alt="Mani Vista Residents Association" /></div>
              <div className="text-left">
                <h2 className="text-white font-bold leading-none tracking-tight text-xs">MANI VISTA</h2>
                <span className="text-[9px] text-white/60 font-bold block mt-0.5 uppercase tracking-wider">RESIDENTS ASSOCIATION</span>
              </div>
            </div>

            <div className="px-4 pt-3"><ThemeSwitcher /></div>

            {/* Navigation links matching mobile */}
            <nav className="flex-1 p-4 space-y-1.5">
              <button
                onClick={() => setActiveTab('home')}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-semibold uppercase tracking-wider transition-all text-left ${activeTab === 'home' ? 'text-white bg-[var(--mv-accent)]' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
              >
                <div className="flex items-center gap-3">
                  <Home className="w-4 h-4" />
                  <span>Home Core</span>
                </div>
              </button>

              <button
                onClick={() => setActiveTab('bills')}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-semibold uppercase tracking-wider transition-all text-left ${activeTab === 'bills' ? 'text-white bg-[var(--mv-accent)]' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
              >
                <div className="flex items-center gap-3">
                  <Receipt className="w-4 h-4" />
                  <span>Bills Ledger</span>
                </div>
              </button>

              <button
                onClick={() => setActiveTab('pay')}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-semibold uppercase tracking-wider transition-all text-left ${activeTab === 'pay' ? 'text-white bg-[var(--mv-accent)]' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
              >
                <div className="flex items-center gap-3">
                  <CreditCard className="w-4 h-4" />
                  <span>Pay Rooms</span>
                </div>
              </button>

              <button
                onClick={() => {
                  if (currentRole === 'Resident') {
                    triggerToast('Access Denied: Core Accounting reports are restricted to Administrative roles. Enter PIN at dropdown to view.');
                    handleRoleSwitchRequest('Manager');
                  } else {
                    setActiveTab('books');
                  }
                }}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-semibold uppercase tracking-wider transition-all text-left ${activeTab === 'books' ? 'text-white bg-[var(--mv-accent)]' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
              >
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <BookOpen className="w-4 h-4" />
                    {currentRole === 'Resident' && (
                      <Lock className="w-2.5 h-2.5 text-[var(--mv-accent)] absolute -top-1 -right-1 bg-white rounded-full p-0.5" />
                    )}
                  </div>
                  <span>Books Ledger</span>
                </div>
                {currentRole === 'Resident' && <Lock className="w-3.5 h-3.5 text-gray-500 ml-auto" />}
              </button>

              <button
                onClick={() => setActiveTab('more')}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-semibold uppercase tracking-wider transition-all text-left ${activeTab === 'more' ? 'text-white bg-[var(--mv-accent)]' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
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
                <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-gray-200">
                  <User className="w-4.5 h-4.5" />
                </div>
                <div className="min-w-0">
                  <p className="font-bold text-gray-200">{currentRole === 'Resident' ? residentName : currentRole === 'Manager' ? 'Finance Supt' : 'RWA Treasurer'}</p>
                  <span className="text-[9px] text-[#6B7280] font-bold block uppercase leading-none mt-0.5">{currentRole} Mode</span>
                  <span className="text-[9px] text-gray-500 block truncate leading-none mt-1" title={sessionEmail || ''}>{sessionEmail}</span>
                </div>
              </div>
              {isAuthenticated && currentRole !== 'Resident' && (
                <button
                  onClick={handleLockAdminMode}
                  className="w-full mt-2 py-1.5 bg-red-655/10 hover:bg-red-655/20 text-red-500 font-bold uppercase text-[9px] rounded-lg tracking-wider transition-colors"
                >
                  Lock Admin Token
                </button>
              )}
              <button
                onClick={handleLogout}
                className="w-full mt-1 py-1.5 bg-white/5 hover:bg-white/10 text-gray-300 font-bold uppercase text-[9px] rounded-lg tracking-wider transition-colors"
              >
                Logout
              </button>
            </div>
          </aside>

          {/* DESKTOP CONTENT WORKSPACE WRAPPER */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden h-screen bg-[var(--mv-page)]">
            {/* STICKY TOP STRIP */}
            <header className="h-16 border-b border-[var(--mv-border)] bg-white px-6 flex items-center justify-between shadow-xs shrink-0 select-none">
              <div className="flex items-center gap-3">
                <span className="font-extrabold text-[9px] text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] px-2.5 py-1 rounded uppercase tracking-wider">ROSTER ACTIVE</span>
                <h1 className="text-sm font-semibold text-[var(--mv-ink)] tracking-tight">Mani Vista Residents Association</h1>
              </div>

              <div className="flex items-center gap-4">
                <span className="text-[10px] text-gray-400 font-mono">GSTIN: {gstinLabel}</span>

                <div className="relative w-8 h-8 flex items-center justify-center bg-[var(--mv-soft)] rounded-full hover:opacity-85 transition-opacity cursor-pointer">
                  <Bell className="w-4 h-4 text-[var(--mv-ink)]" />
                  <div className="absolute top-1 right-1 w-2.5 h-2.5 bg-[var(--mv-accent)] border-2 border-white rounded-full"></div>
                </div>

                {/* Role dropdown switcher */}
                <div className="relative bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] px-3 py-1.5 rounded-full flex items-center gap-1 cursor-pointer">
                  <select
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
              
              {/* Toaster element stack */}
              {toaster.map(t => (
                <div key={t.id} className="max-w-2xl mx-auto p-3 bg-[var(--mv-ink)] text-white text-xs font-bold flex items-start gap-2.5 rounded-xl shadow-md animate-scale-up">
                  <Check className="w-4 h-4 text-[var(--mv-accent)] shrink-0 mt-0.5" />
                  <span className="leading-tight">{t.msg}</span>
                </div>
              ))}

              {/* -------------------- HOME TAB -------------------- */}
              {activeTab === 'home' && (
                <div className="space-y-6 max-w-7xl mx-auto animate-scale-up">
                  <div className="flex justify-between items-end">
                    <div>
                      {currentRole === 'Resident' ? (
                        <>
                          <h2 className="text-2xl font-bold text-[var(--mv-ink)]">{residentName}</h2>
                          <p className="text-xs text-[#6B7280]">
                            {residentFlatNo === ''
                              ? 'No flat is linked to this account'
                              : `Flat ${residentFlatNo} · Allotment registry`}
                          </p>
                        </>
                      ) : (
                        <>
                          <h2 className="text-2xl font-bold text-[var(--mv-ink)]">{currentRole} Executive Suite</h2>
                          <p className="text-xs text-[#6B7280]">Fully Authorized Administrative Operations Center</p>
                        </>
                      )}
                    </div>
                    <div className="text-right text-xs font-mono">
                      <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Ledger Synchronized</p>
                      <p className="text-[var(--mv-accent)] font-bold">STATE ONLINE · SECURE</p>
                    </div>
                  </div>

                  {/* 4-ACROSS DASHBOARD TILES */}
                  {currentRole === 'Resident' && (
                    <div className="grid grid-cols-4 gap-4">
                      {/* Current outstanding */}
                      <div className="bg-[var(--mv-ink)] text-white p-5 rounded-2xl flex flex-col justify-between shadow-md min-h-[120px]">
                        <p className="text-[10px] font-bold text-white/50 uppercase tracking-widest">Aggregate Outstanding</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-white">{formatRupee(rohanTotalDueNum)}</p>
                          <span className={`inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold rounded uppercase ${rohanTotalDueNum > 0 ? 'bg-red-650 text-white' : 'bg-[var(--mv-accent)] text-white'}`}>
                            {rohanTotalDueNum > 0 ? 'ARREARS DUE' : 'ALL CLEAR'}
                          </span>
                        </div>
                      </div>

                      {/* Cumulative paid */}
                      <div className="bg-white border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-widest">Deposit Paid This FY</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{formatRupee(rohanTotalPaidNum)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] rounded">
                            {rohanInvoices.filter(inv => inv.status === 'Paid').length} DEPOSITS AUDITED
                          </span>
                        </div>
                      </div>

                      {/* Prepaid advance balance */}
                      <div className="bg-white border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-widest">Prepaid Advances</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-gray-300">₹0.00</p>
                          <span className="text-[9px] text-[#6B7280] mt-2 block font-medium">Standard RWA account</span>
                        </div>
                      </div>

                      {/* Open complaints helpdesk */}
                      <div className="bg-white border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-widest">Complaints Grievances</p>
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
                        <p className="text-[10px] font-bold text-white/50 uppercase tracking-widest">Collected MTD Accrual</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-white">{formatRupee(mtdCollectedTotal)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-semibold bg-white/10 text-white rounded">
                            FY 2026-27 REVENUE
                          </span>
                        </div>
                      </div>

                      {/* Outstanding Receivables */}
                      <div className="bg-white border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-widest">Arrears Outstanding</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{formatRupee(mtdOutstandingTotal)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] rounded">
                            ACTIVE DEFAULTERS
                          </span>
                        </div>
                      </div>

                      {/* Overdue units */}
                      <div className="bg-white border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-widest">Overdue Defaulters</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{uniqueDefaultersCount} Flats</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-semibold bg-red-50 text-red-600 rounded">
                            OVERDUE DISPATCHED
                          </span>
                        </div>
                      </div>

                      {/* Outgoing expenses MTD */}
                      <div className="bg-white border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-widest">Approved Expenses MTD</p>
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
                      <div className="bg-white border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-widest">Capital Corpus Fund</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{formatRupee(corpusFundBase)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] rounded">
                            RECALCULATING TRUST
                          </span>
                        </div>
                      </div>

                      {/* Sinking reserve */}
                      <div className="bg-white border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-widest">Accumulated Sinking Contributions</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{formatRupee(sinkingFundBase)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-semibold bg-[var(--mv-soft)] text-[var(--mv-ink)] rounded">
                            REACTIVE TO PERIOD
                          </span>
                        </div>
                      </div>

                      {/* Liquid cash reserves */}
                      <div className="bg-white border border-[var(--mv-border)] p-5 rounded-2xl flex flex-col justify-between shadow-xs min-h-[120px]">
                        <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-widest">Liquid Operating Bank Balance</p>
                        <div>
                          <p className="text-2xl font-bold font-mono text-[var(--mv-ink)]">{formatRupee(operatingFundBase - totalMTDExpenses)}</p>
                          <span className="inline-block mt-2 px-1.5 py-0.5 text-[9px] font-bold bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] rounded">
                            RECONCILED CURRENT
                          </span>
                        </div>
                      </div>

                      {/* Outstanding bills proposals */}
                      <div className="bg-[var(--mv-ink)] text-white p-5 rounded-2xl flex flex-col justify-between shadow-md min-h-[120px]">
                        <p className="text-[10px] font-bold text-white/50 uppercase tracking-widest">Pending Bill Proposals</p>
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
                          <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs flex-1 flex flex-col justify-between space-y-4">
                            <div>
                              <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Unpaid active billing assessment due</span>
                              <h3 className="font-extrabold text-lg text-[var(--mv-ink)] mt-1">Invoice Number: #{rohanDueInvoice.invoiceNo}</h3>
                            </div>

                            <div className="border-y border-[var(--mv-soft)] py-5 flex justify-between items-center bg-gray-50/50 px-4 rounded-xl">
                              <div>
                                <p className="text-xs text-[#6B7280] font-medium">{rohanDueInvoice.period} General Maintenance Account</p>
                                <p className="text-3xl font-extrabold text-[var(--mv-ink)] font-mono mt-1">{formatRupee(rohanDueInvoice.total)}</p>
                              </div>
                              <button
                                onClick={() => handlePayClick(rohanDueInvoice)}
                                className="bg-[var(--mv-accent)] hover:brightness-90 text-white px-6 py-3.5 rounded-xl font-bold text-xs uppercase cursor-pointer transition-all shadow-md active:scale-95"
                              >
                                Clear Due Balance
                              </button>
                            </div>

                            <span className="text-[10px] text-[#6B7280] font-medium leading-relaxed block">
                              • Demo checkout. No payment gateway is connected — paying marks the invoice settled in this browser and posts the matching journal entry. A live version needs a Razorpay or PayU account and a server to verify the callback.
                            </span>
                          </div>
                        ) : (
                          <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-10 shadow-xs flex-1 flex flex-col items-center justify-center text-center">
                            <Check className="w-12 h-12 text-[var(--mv-accent)] mb-2" />
                            <h4 className="font-bold text-base text-[var(--mv-ink)]">No Active Invoices Pending</h4>
                            <p className="text-xs text-gray-500 max-w-sm mt-1">Your resident core billing ledger has zero pending outstanding balances. Thank you for your proactive support!</p>
                          </div>
                        )}
                      </div>

                      {/* Mini ledger logs activity */}
                      <div className="col-span-4 bg-white border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs flex flex-col justify-between">
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
                                className="flex items-center justify-between p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] hover:bg-gray-100 transition-all cursor-pointer text-xs"
                              >
                                <div className="min-w-0 flex-1 pr-2">
                                  <p className="font-bold text-[var(--mv-ink)] truncate">{inv.period} Maintenance</p>
                                  <p className="text-[9px] text-[#6B7280] uppercase mt-0.5 leading-none font-medium">{inv.paidDate || inv.dueDate || '15th Due'}</p>
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
                      <div className="col-span-8 bg-white border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs">
                        <div className="flex justify-between items-center mb-4">
                          <div>
                            <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-wider">RWA Overall Collections Tendency (MTD)</h4>
                            <p className="text-[10px] text-[#6B7280]">Last 6 Months Gross Accounts Receivables vs Cleared Revenue</p>
                          </div>
                          <TrendingUp className="w-4 h-4 text-[var(--mv-accent)]" />
                        </div>

                        <div className="h-80 w-full pt-1 select-none">
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={collectionTrendsData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--mv-soft)" />
                              <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#6B7280' }} />
                              <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} />
                              <Tooltip formatter={(value) => formatRupee(value as number)} />
                              <Area type="monotone" dataKey="Collected" stroke="var(--mv-accent)" fillOpacity={0.08} fill="var(--mv-accent)" strokeWidth={3} />
                              <Area type="monotone" dataKey="Outstanding" stroke="var(--mv-ink)" fillOpacity={0.03} fill="var(--mv-ink)" strokeWidth={2} />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      </div>

                      {/* Operation launch pad */}
                      <div className="col-span-4 bg-white border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs flex flex-col justify-between">
                        <div>
                          <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-wider mb-4 border-b border-[var(--mv-border)] pb-2 text-left">Quick Admin Dispatch</h4>
                          <p className="text-xs text-[#6B7280] leading-relaxed mb-6">Launch water supply assessments, common lift backups operations, parking space levies, and non-occupancy utility taxes across core residential registry ledgers.</p>
                        </div>
                        <div className="space-y-3.5">
                          <button
                            onClick={() => {
                              setWizardPeriod('Jul 2026');
                              setShowBillingWizard(true);
                              setActiveTab('bills');
                            }}
                            className="w-full py-3.5 px-4 bg-[var(--mv-accent)] hover:brightness-90 text-white rounded-xl text-xs font-bold shadow-md transition-all flex items-center justify-center gap-1.5 cursor-pointer uppercase tracking-wider"
                          >
                            <Plus className="w-4 h-4" /> Generate Jul 2026 Receivables
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
                      <div className="col-span-7 bg-white border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs text-left">
                        <div className="flex justify-between items-center mb-4">
                          <div>
                            <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-wider">Approved FY Budget vs Realized Revenue Ledger</h4>
                            <p className="text-[10px] text-[#6B7280]">Association budget variance — subject to approved bylaws</p>
                          </div>
                        </div>

                        <div className="h-80 w-full pt-1 select-none">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={budgetPerformanceData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--mv-soft)" />
                              <XAxis dataKey="head" tick={{ fontSize: 11, fill: '#6B7280' }} />
                              <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} />
                              <Tooltip formatter={(value) => formatRupee(value as number)} />
                              <Bar dataKey="Budgeted" fill="#9CA3AF" radius={[6, 6, 0, 0]} />
                              <Bar dataKey="Actual" fill="var(--mv-accent)" radius={[6, 6, 0, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>

                      {/* Required vendor approvals panel */}
                      <div className="col-span-5 bg-white border border-[var(--mv-border)] p-5 rounded-2xl shadow-xs text-left flex flex-col justify-between">
                        <div>
                          <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-wider mb-4 border-b border-gray-100 pb-2">Governing Vendor Approvals</h4>
                          
                          <div className="space-y-3 overflow-y-auto max-h-[260px] pr-1 hide-scrollbar">
                            {vendorInvoices.filter(vi => vi.status === 'Pending').length === 0 ? (
                              <div className="py-12 text-center text-xs text-gray-400 font-semibold uppercase tracking-wider">
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
                                    <span className="font-mono font-bold text-gray-900">{formatRupee(vi.amount)}</span>
                                  </div>
                                  <div className="bg-white p-2 rounded border border-gray-100 text-[9px] text-gray-500 flex justify-between items-center leading-none">
                                    <span>TDS Withheld (194C): <strong className="font-mono text-[var(--mv-ink)]">{formatRupee(vi.tdsAmount)}</strong></span>
                                    <span>Net Payable: <strong className="font-mono text-[var(--mv-ink)]">{formatRupee(vi.netPayable)}</strong></span>
                                  </div>
                                  <div className="flex gap-2 justify-end pt-1">
                                    <button
                                      onClick={() => handleVendorInvoiceStatus(vi.id, 'Rejected')}
                                      className="py-1 px-3 border border-gray-350 rounded text-[9px] font-bold text-gray-650 hover:bg-white active:scale-95"
                                    >
                                      Reject
                                    </button>
                                    <button
                                      onClick={() => handleVendorInvoiceStatus(vi.id, 'Approved')}
                                      className="py-1 px-3 bg-[var(--mv-accent)] text-white rounded text-[9px] font-bold hover:brightness-90 active:scale-95"
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
                      <p className="text-xs text-[#6B7280]">Fully compliant regulatory invoices generated for Mani Vista residents</p>
                    </div>
                    {currentRole !== 'Resident' && (
                      <button
                        onClick={() => setShowBillingWizard(!showBillingWizard)}
                        className="py-2.5 px-4 bg-[var(--mv-ink)] hover:bg-black text-white text-xs font-bold uppercase rounded-xl shadow-md flex items-center gap-1.5"
                      >
                        <Plus className="w-4 h-4" /> {showBillingWizard ? 'Minimize Billing' : 'Launch New Campaign'}
                      </button>
                    )}
                  </div>

                  {/* The document workflow: where a proforma is in its life. */}
                  {currentRole !== 'Resident' && (
                    <div className="p-6 bg-white border border-[var(--mv-border)] rounded-2xl shadow-xs">
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
                    <div className="p-6 bg-white border border-[var(--mv-border)] rounded-2xl max-w-3xl animate-scale-up space-y-4">
                      <div className="flex justify-between items-center border-b border-[var(--mv-border)] pb-3">
                        <span className="font-bold text-xs uppercase tracking-wider text-[var(--mv-ink)]">Campaign Generation Panel</span>
                        <button onClick={() => setShowBillingWizard(false)} className="text-[var(--mv-accent)] hover:underline text-xs font-semibold">Dismiss</button>
                      </div>

                      <form onSubmit={handleRunBillGeneration} className="space-y-4 text-xs font-medium">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-bold block mb-1 uppercase tracking-wider">Assessment Cycle Period</label>
                            <input 
                              type="text" 
                              value={wizardPeriod} 
                              onChange={(e) => setWizardPeriod(e.target.value)}
                              placeholder="e.g. Jul 2026"
                              className="w-full bg-[var(--mv-page)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold text-xs text-[var(--mv-ink)] outline-none" 
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-bold block mb-1 uppercase tracking-wider">Frequency Category</label>
                            <select 
                              value={wizardCycle} 
                              onChange={(e) => setWizardCycle(e.target.value)}
                              className="w-full bg-[var(--mv-page)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold text-xs text-[var(--mv-ink)] outline-none"
                            >
                              <option value="Monthly">Monthly Cycle</option>
                              <option value="Quarterly">Quarterly Cycle</option>
                              <option value="Annual">Annual Cycle</option>
                            </select>
                          </div>
                        </div>

                        <div className="grid grid-cols-5 gap-3 font-mono text-xs">
                          <div>
                            <label className="text-[9px] text-[#6B7280] font-bold font-sans block mb-1 uppercase">Maintenance (₹)</label>
                            <input type="number" value={wizardMaint} onChange={(e) => setWizardMaint(e.target.value)} className="w-full p-2.5 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] font-bold text-[var(--mv-ink)]" />
                          </div>
                          <div>
                            <label className="text-[9px] text-[#6B7280] font-bold font-sans block mb-1 uppercase">Sinking (₹)</label>
                            <input type="number" value={wizardSinking} onChange={(e) => setWizardSinking(e.target.value)} className="w-full p-2.5 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] font-bold text-[var(--mv-ink)]" />
                          </div>
                          <div>
                            <label className="text-[9px] text-[#6B7280] font-bold font-sans block mb-1 uppercase">Water tankers (₹)</label>
                            <input type="number" value={wizardWater} onChange={(e) => setWizardWater(e.target.value)} className="w-full p-2.5 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] font-bold text-[var(--mv-ink)]" />
                          </div>
                          <div>
                            <label className="text-[9px] text-[#6B7280] font-bold font-sans block mb-1 uppercase">Parking Sump (₹)</label>
                            <input type="number" value={wizardParking} onChange={(e) => setWizardParking(e.target.value)} className="w-full p-2.5 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] font-bold text-[var(--mv-ink)]" />
                          </div>
                          <div>
                            <span className="text-[9px] text-[#6B7280] font-bold font-sans block mb-1 uppercase">Tax Base</span>
                            <div className="p-2.5 bg-gray-100 rounded-xl text-center font-bold text-gray-700 leading-none h-[42px] flex items-center justify-center">18% GST</div>
                          </div>
                        </div>

                        <button
                          type="submit"
                          className="w-full py-3.5 bg-[var(--mv-accent)] text-white rounded-xl font-bold shadow-md uppercase tracking-wider text-center flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <Send className="w-4 h-4" /> Issue and Dispatch Campaign Bulk Invoices
                        </button>
                      </form>
                    </div>
                  )}

                  {/* MASTER DETAIL TWO-PANE GRID */}
                  <div className="grid grid-cols-12 gap-6 items-start">
                    {/* LEFT MASTER LIST */}
                    <div className="col-span-5 bg-white border border-[var(--mv-border)] rounded-2xl shadow-xs overflow-hidden flex flex-col">
                      <div className="p-4 border-b border-[var(--mv-border)] bg-gray-50/55 select-none font-bold text-[10px] uppercase tracking-wider text-gray-500">
                        Select Invoice Receipts ({currentInvoices.length} Found)
                      </div>

                      <div className="divide-y divide-[var(--mv-border)] max-h-[580px] overflow-y-auto hide-scrollbar">
                        {currentInvoices.map(inv => {
                          const isActive = desktopActiveInvoice?.id === inv.id;
                          return (
                            <div
                              key={inv.id}
                              onClick={() => setSelectedInvoice(inv)}
                              className={`p-4 text-left cursor-pointer transition-all flex justify-between items-center ${isActive ? 'bg-[var(--mv-accent-soft)]/40 border-l-4 border-[var(--mv-accent)]' : 'hover:bg-gray-50/50 bg-white'}`}
                            >
                              <div className="min-w-0 flex-1 pr-2">
                                <span className="font-mono text-[9px] text-gray-400 font-bold tracking-tight block uppercase leading-none">Invoice No: {inv.invoiceNo}</span>
                                <h4 className="font-extrabold text-[var(--mv-ink)] mt-1.5 text-xs truncate">
                                  {inv.period} Maintenance {currentRole !== 'Resident' ? `(Flat ${inv.flatNo})` : ''}
                                </h4>
                                <p className="text-[9px] text-[#6B7280] font-bold mt-1 uppercase">Owner: {inv.name}</p>
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
                    <div className="col-span-7 bg-white border border-[var(--mv-border)] rounded-2xl shadow-sm p-6 space-y-4 min-h-[540px] flex flex-col justify-between">
                      {desktopActiveInvoice ? (
                        <>
                          <div className="space-y-4">
                            <div className="flex justify-between items-start">
                              <div>
                                <span className="text-[9px] font-bold uppercase text-[#6B7280] tracking-widest leading-none">Registered Society CHS RWA</span>
                                <h3 className="font-extrabold text-lg text-[var(--mv-ink)] mt-1.5">Mani Vista Residents Association</h3>
                                <p className="text-[10px] text-gray-400 font-medium">{societyName} · GSTIN {gstinLabel}</p>
                              </div>
                              <div className="text-right">
                                {desktopActiveInvoice.status === 'Paid' ? (
                                  <span className="px-3 py-1.5 text-[9px] font-bold rounded-lg bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] text-[var(--mv-accent)] uppercase select-none leading-none inline-block">
                                    Paid reconciled
                                  </span>
                                ) : (
                                  <span className="px-3 py-1.5 text-[9px] font-bold rounded-lg bg-red-50 text-red-650 border border-red-200 uppercase select-none leading-none inline-block">
                                    Overdue arrears
                                  </span>
                                )}
                              </div>
                            </div>

                            <hr className="border-[var(--mv-border)]" />

                            <div className="grid grid-cols-4 gap-3 bg-gray-50/50 p-4 border border-[var(--mv-border)] rounded-2xl text-[10px] leading-relaxed">
                              <div>
                                <p className="font-bold uppercase tracking-tight text-[#6B7280]">Tax Invoice ID</p>
                                <p className="font-bold text-[var(--mv-ink)] font-mono mt-1">{desktopActiveInvoice.invoiceNo}</p>
                              </div>
                              <div>
                                <p className="font-bold uppercase tracking-tight text-[#6B7280]">Cycle Period</p>
                                <p className="font-bold text-[var(--mv-ink)] font-mono mt-1">{desktopActiveInvoice.period}</p>
                              </div>
                              <div>
                                <p className="font-bold uppercase tracking-tight text-[#6B7280]">Flat Reference</p>
                                <p className="font-bold text-[var(--mv-ink)] font-mono mt-1">{desktopActiveInvoice.flatNo}</p>
                              </div>
                              <div>
                                <p className="font-bold uppercase tracking-tight text-[#6B7280]">Resident Owner</p>
                                <p className="font-bold text-[var(--mv-ink)] mt-1 truncate">{desktopActiveInvoice.name}</p>
                              </div>
                            </div>

                            <div className="space-y-2 pt-2 text-xs">
                              <h5 className="font-extrabold text-[9px] uppercase tracking-wider text-gray-500 border-b border-[var(--mv-border)] pb-2">Billing Breakdown particulars</h5>
                              
                              <div className="flex justify-between items-center py-1">
                                <span className="text-gray-550 font-medium">Common Area General Maintenance</span>
                                <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(desktopActiveInvoice.maintenance)}</span>
                              </div>
                              <div className="flex justify-between items-center py-1">
                                <span className="text-gray-550 font-medium font-sans">Sinking Surcharge contributions</span>
                                <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(desktopActiveInvoice.sinkingFund)}</span>
                              </div>
                              <div className="flex justify-between items-center py-1">
                                <span className="text-gray-555 font-medium">Water Utility tank infrastructure levy</span>
                                <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(desktopActiveInvoice.waterCharges)}</span>
                              </div>
                              <div className="flex justify-between items-center py-1">
                                <span className="text-gray-555 font-medium">Lock-up car parking reserve charges</span>
                                <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(desktopActiveInvoice.parkingCharges)}</span>
                              </div>
                              <div className="flex justify-between items-center py-1">
                                <span className="text-gray-555 font-medium">Non-Occupancy regulatory surcharge</span>
                                <span className="font-bold font-mono text-[var(--mv-ink)]">{formatRupee(desktopActiveInvoice.nonOccupancyCharges)}</span>
                              </div>

                              {desktopActiveInvoice.gst > 0 && (
                                <>
                                  <hr className="border-[var(--mv-border)] my-2" />
                                  <div className="flex justify-between items-center text-gray-400 py-0.5">
                                    <span>CGST Accrual (9.0% standard levy rate)</span>
                                    <span className="font-mono font-bold">{formatRupee(desktopActiveInvoice.gst / 2)}</span>
                                  </div>
                                  <div className="flex justify-between items-center text-gray-400 py-0.5">
                                    <span>SGST Accrual (9.0% standard levy rate)</span>
                                    <span className="font-mono font-bold">{formatRupee(desktopActiveInvoice.gst / 2)}</span>
                                  </div>
                                </>
                              )}

                              {desktopActiveInvoice.latePenalty > 0 && (
                                <div className="flex justify-between items-center py-2 bg-red-50/60 px-3.5 rounded-lg border border-red-100 mt-2 text-red-650">
                                  <span className="font-bold text-[10px]">Compounding late-payment interest penalty (18% pa)</span>
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
                              onClick={() => {
                                const sub = desktopActiveInvoice.maintenance + desktopActiveInvoice.sinkingFund + desktopActiveInvoice.waterCharges + desktopActiveInvoice.parkingCharges + desktopActiveInvoice.nonOccupancyCharges;
                                const content = `
============================================================
       MANI VISTA RESIDENTS ASSOCIATION
                 GSTIN: ${gstinLabel}
============================================================
INVOICE ID: ${desktopActiveInvoice.invoiceNo}
BILLING CYCLE: ${desktopActiveInvoice.period}
FLAT: ${desktopActiveInvoice.flatNo} | OWNER: ${desktopActiveInvoice.name}
DUEDATE: ${desktopActiveInvoice.dueDate}
============================================================
PARTICULARS                           AMOUNT (INR)
------------------------------------------------------------
1. Maintenance Charges                 ${desktopActiveInvoice.maintenance.toFixed(2)}
2. Sinking Fund Contributions          ${desktopActiveInvoice.sinkingFund.toFixed(2)}
3. Bulk Water Utility Allocation       ${desktopActiveInvoice.waterCharges.toFixed(2)}
4. Covered/Open Car Parking            ${desktopActiveInvoice.parkingCharges.toFixed(2)}
5. Non-Occupancy Surcharges           ${desktopActiveInvoice.nonOccupancyCharges.toFixed(2)}
------------------------------------------------------------
SUBTOTAL                               ${sub.toFixed(2)}
GST (18.00%)                           ${desktopActiveInvoice.gst.toFixed(2)}
LATE PENALTY COMPOUND INTEREST          ${desktopActiveInvoice.latePenalty.toFixed(2)}
------------------------------------------------------------
TOTAL ACCOUNT DUE                      ${desktopActiveInvoice.total.toFixed(2)}
============================================================
STATUS: ${desktopActiveInvoice.status.toUpperCase()}
============================================================
Tax receipt file issued by state RWA SmartSuite.
                                `;
                                const blob = new Blob([content], { type: 'text/plain' });
                                const link = document.createElement('a');
                                link.href = URL.createObjectURL(blob);
                                link.download = `Invoice_${desktopActiveInvoice.invoiceNo}.txt`;
                                link.click();
                                triggerToast('Downloaded structured receipt file locally!');
                              }}
                              className="py-2.5 px-4 bg-white border border-[var(--mv-border)] rounded-xl text-xs font-semibold text-[var(--mv-ink)] hover:bg-gray-100 transition-all flex items-center justify-center gap-1 cursor-pointer active:scale-95 shadow-xs"
                            >
                              <Download className="w-4 h-4 text-[#6B7280]" /> Reconciled export file
                            </button>

                            {desktopActiveInvoice.status !== 'Paid' && currentRole === 'Resident' && (
                              <button
                                onClick={() => handlePayClick(desktopActiveInvoice)}
                                className="py-2.5 px-6 bg-[var(--mv-accent)] text-white text-xs font-bold rounded-xl shadow cursor-pointer uppercase tracking-wider"
                              >
                                Clear dues now
                              </button>
                            )}

                            {desktopActiveInvoice.status !== 'Paid' && currentRole !== 'Resident' && (
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
                        <div className="flex-1 flex flex-col items-center justify-center text-center py-20 text-gray-400">
                          <FileText className="w-12 h-12 text-gray-300 mb-2" />
                          <p className="text-xs font-bold uppercase tracking-wider">No active accounts selected</p>
                          <p className="text-[11px] text-[#6B7280] max-w-sm mt-1">Select an active resident accounts tax invoice from the master index layout on the left to review allocations.</p>
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
                        <p className="text-xs text-[#6B7280]">Authorize water tankers infrastructure clearing, UPI transactions, and unearned advance predepositions</p>
                      </div>

                      <div className="grid grid-cols-12 gap-6 items-start">
                        {payingInvoice ? (
                          <div className="col-span-7 bg-white border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs space-y-4">
                            <div className="flex justify-between items-center border-b border-[var(--mv-border)] pb-2">
                              <span className="font-extrabold text-[10px] uppercase text-[#6B7280] tracking-wider font-mono">Checkout — demo, no gateway</span>
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
                              <span className="text-[10px] uppercase font-bold text-gray-400">Choose clearance mode</span>
                              
                              <div className="grid grid-cols-4 gap-3">
                                {[
                                  { id: 'UPI', label: 'UPI / BHIM' },
                                  { id: 'Net Banking', label: 'Net Banking' },
                                  { id: 'Card', label: 'Debit/Credit Card' },
                                  { id: 'Wallet', label: 'Wallets' }
                                ].map(item => (
                                  <label
                                    key={item.id}
                                    className={`cursor-pointer p-3 border rounded-xl flex flex-col items-center justify-center text-center gap-2 transition-all ${paymentMethod === item.id ? 'border-[var(--mv-accent)] bg-[var(--mv-accent-soft)]/40 text-[var(--mv-accent)] font-bold' : 'border-[var(--mv-border)] bg-white hover:bg-gray-50 text-gray-500'}`}
                                  >
                                    <input
                                      type="radio"
                                      name="pmethod-desk"
                                      checked={paymentMethod === item.id}
                                      onChange={() => setPaymentMethod(item.id as any)}
                                      className="hidden"
                                    />
                                    <span>{item.label}</span>
                                  </label>
                                ))}
                              </div>

                              <div className="space-y-1">
                                <label className="text-[10px] font-bold text-[#6B7280] block uppercase">Partial Clearing Amount (INR)</label>
                                <input
                                  type="number"
                                  value={partialAmountInput}
                                  onChange={(e) => setPartialAmountInput(e.target.value)}
                                  placeholder={`e.g. ${payingInvoice.total}`}
                                  className="w-full bg-[var(--mv-page)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold font-mono outline-none"
                                />
                                <span className="text-[9px] text-[#6B7280] block font-medium">Leave completely blank to clear full aggregate assessment index of {formatRupee(payingInvoice.total)} instantly.</span>
                              </div>

                              <button
                                type="submit"
                                className="w-full py-3.5 bg-[var(--mv-accent)] hover:brightness-90 text-white rounded-xl shadow font-bold text-xs uppercase text-center cursor-pointer"
                              >
                                Reconcile & Clear Receivables balance
                              </button>
                            </form>
                          </div>
                        ) : (
                          <div className="col-span-7 bg-white border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs space-y-4">
                            <span className="text-[10px] uppercase font-bold text-gray-500 tracking-wider block border-b border-[var(--mv-border)] pb-2">Overdue pending receivables assessments</span>
                            
                            <div className="divide-y divide-[var(--mv-border)]">
                              {invoices.filter(inv => inv.flatNo === residentFlatNo && inv.status !== 'Paid').length === 0 ? (
                                <p className="py-12 text-center text-xs font-semibold font-mono text-gray-400">Your accounts ledger has zero active arrears! Standard accounts in green state.</p>
                              ) : (
                                invoices
                                  .filter(inv => inv.flatNo === residentFlatNo && inv.status !== 'Paid')
                                  .map(inv => (
                                    <div key={inv.id} className="py-3 flex justify-between items-center text-xs font-medium">
                                      <div>
                                        <p className="font-extrabold text-[var(--mv-ink)]">{inv.period} Maintenance invoice assessment</p>
                                        <p className="text-[9px] text-gray-400 font-bold uppercase mt-1">Invoice ID: {inv.invoiceNo}</p>
                                      </div>
                                      <div className="text-right flex items-center gap-3">
                                        <span className="font-mono font-bold text-red-650">{formatRupee(inv.total)}</span>
                                        <button
                                          onClick={() => handlePayClick(inv)}
                                          className="py-1.5 px-3 bg-[var(--mv-accent)] hover:brightness-90 text-white text-[10px] font-bold rounded-lg uppercase"
                                        >
                                          Reconcile Clear
                                        </button>
                                      </div>
                                    </div>
                                  ))
                              )}
                            </div>
                          </div>
                        )}

                        {/* Predeposition advance right panel */}
                        <div className="col-span-5 bg-white border border-[var(--mv-border)] p-6 rounded-2xl shadow-xs space-y-4 text-xs font-medium">
                          <span className="text-[10px] uppercase font-bold text-[var(--mv-ink)] tracking-wider block border-b border-gray-105 pb-2">Prepay advances reserve</span>
                          <p className="text-gray-500 leading-relaxed">Residents may predispatch lump-sum advances. Standard RWA double-entry protocols automatically offset incoming monthly assessments ledger from advance assets.</p>

                          <form onSubmit={handleExecuteAdvance} className="space-y-4 pt-1">
                            <div className="space-y-1">
                              <label className="text-[10px] text-gray-500 uppercase block">Deposit Sum (INR)</label>
                              <input
                                type="number"
                                value={customAdvanceInput}
                                onChange={(e) => setCustomAdvanceInput(e.target.value)}
                                placeholder="e.g. 5000"
                                className="w-full bg-[var(--mv-page)] p-2.5 rounded-xl border border-[var(--mv-border)] font-bold font-mono outline-none"
                              />
                            </div>
                            <button type="submit" className="w-full py-2.5 bg-[var(--mv-ink)] text-white font-bold rounded-xl active:scale-95 transition-all uppercase text-center cursor-pointer">
                              Deposit Advance reserve Fund
                            </button>
                          </form>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <h2 className="text-2xl font-bold text-[var(--mv-ink)]">Receivables Ageing Room</h2>
                        <p className="text-xs text-[#6B7280]">Review arrears and log reminders against each flat. Sending them over SMS or WhatsApp needs a messaging account, so reminders are only recorded here.</p>
                      </div>

                      <div className="grid grid-cols-12 gap-6 items-start">
                        {/* Overdue table list */}
                        <div className="col-span-7 bg-white border border-[var(--mv-border)] p-5 rounded-2xl shadow-xs space-y-3">
                          <div className="flex justify-between items-center border-b border-[var(--mv-border)] pb-2">
                            <span className="text-[10px] font-bold uppercase text-gray-500 tracking-wider">Flats with outstanding accounts ({overdueInvoices.length})</span>
                            <span className="text-[9px] font-bold text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] px-2 py-0.5 rounded uppercase font-mono">AR OVERDUE</span>
                          </div>

                          <div className="space-y-2.5 overflow-y-auto max-h-[380px] pr-1 hide-scrollbar">
                            {overdueInvoices.length === 0 ? (
                              <p className="py-12 text-center text-xs font-semibold text-gray-400">All member accounts fully clear! Active collections settled.</p>
                            ) : (
                              overdueInvoices.map(inv => (
                                <div key={inv.id} className="p-3.5 bg-[var(--mv-page)] rounded-xl flex justify-between items-center text-xs border border-[var(--mv-border)]">
                                  <div className="min-w-0 flex-1 pr-2">
                                    <div className="flex items-center gap-2">
                                      <span className="font-extrabold text-[var(--mv-ink)] text-sm">{inv.flatNo}</span>
                                      <span className="text-[10px] font-bold text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] px-2 py-0.5 rounded-md truncate">{inv.name}</span>
                                    </div>
                                    <span className="text-[10px] text-gray-405 block mt-1">Period Cycle: {inv.period} · Standard 30 days grace elapsed</span>
                                  </div>
                                  <div className="text-right flex items-center gap-3 shrink-0">
                                    <span className="font-bold font-mono text-red-650 text-xs">{formatRupee(inv.total)}</span>
                                    <button
                                      onClick={() => handleSendReminder(inv)}
                                      className="w-8 h-8 rounded-lg bg-[var(--mv-accent-soft)] hover:bg-[var(--mv-accent-border)] text-[var(--mv-accent)] flex items-center justify-center cursor-pointer shadow-xs transition-colors"
                                      title="Dispatch SMS / Email overdue alerts"
                                    >
                                      <Send className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>

                        {/* Live reconcile logs feed */}
                        <div className="col-span-5 bg-white border border-[var(--mv-border)] p-5 rounded-2xl shadow-xs space-y-4 select-none">
                          <div className="flex justify-between items-center border-b border-gray-120 pb-2">
                            <span className="text-[10px] font-bold uppercase text-gray-500 tracking-wider">Live Bank Feed settlement Reconciler</span>
                            <span className="px-2 py-0.5 rounded bg-[var(--mv-accent)] text-white text-[8px] font-bold font-mono">STATE ACTIVE</span>
                          </div>

                          <div className="space-y-3 pt-1 text-xs leading-relaxed font-mono">
                            <div className="p-3.5 bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)]/40 rounded-xl text-[11px]">
                              <strong>[SAMPLE ACTIVITY]</strong> An illustrative reconciliation of an IMPS / NEFT settlement batch of <strong>₹3,79,500</strong> across two flats. This entry is part of the demonstration narrative, not a transaction in the books.
                            </div>
                            <div className="p-3 bg-[var(--mv-page)] text-gray-550 border border-[var(--mv-border)] rounded-xl text-[11px]">
                              <strong>[LEDGER LOGGED]</strong> Decryption system checked. Sector audit logs successfully logged 3 matching dual-ledger entries for monthly GST and water utility reserves.
                            </div>
                          </div>
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
                    <p className="text-xs text-[#6B7280]">Fully compliant regulatory audits, comparative assets, and live double-entry general journal ledger balances</p>
                  </div>

                  {/* Books sub-navigation */}
                  <div className="grid grid-cols-4 gap-2 bg-[var(--mv-soft)] p-1.5 rounded-xl text-xs font-bold uppercase text-center max-w-xl select-none">
                    <button
                      onClick={() => setBooksSubTab('reports')}
                      className={`py-2 px-3 rounded-lg transition-all cursor-pointer ${booksSubTab === 'reports' ? 'bg-[var(--mv-ink)] text-white shadow' : 'text-[#6B7280] hover:text-[#0b0b0f]'}`}
                    >
                      Audit Reports
                    </button>
                    <button
                      onClick={() => setBooksSubTab('ledger')}
                      className={`py-2 px-3 rounded-lg transition-all cursor-pointer ${booksSubTab === 'ledger' ? 'bg-[var(--mv-ink)] text-white shadow' : 'text-[#6B7280] hover:text-[#0b0b0f]'}`}
                    >
                      Journal Ledger
                    </button>
                    <button
                      onClick={() => setBooksSubTab('budget')}
                      className={`py-2 px-3 rounded-lg transition-all cursor-pointer ${booksSubTab === 'budget' ? 'bg-[var(--mv-ink)] text-white shadow' : 'text-[#6B7280] hover:text-[#0b0b0f]'}`}
                    >
                      Budget Variance
                    </button>
                    <button
                      onClick={() => setBooksSubTab('audit')}
                      className={`py-2 px-3 rounded-lg transition-all cursor-pointer ${booksSubTab === 'audit' ? 'bg-[var(--mv-ink)] text-white shadow' : 'text-[#6B7280] hover:text-[#0b0b0f]'}`}
                    >
                      Audit Trails
                    </button>
                  </div>

                  {/* 1. REPORTS SUBSTATION */}
                  {booksSubTab === 'reports' && (
                    <div className="grid grid-cols-12 gap-6 items-start">
                      {/* Substate categories sidebar */}
                      <div className="col-span-4 bg-white border border-[var(--mv-border)] rounded-2xl shadow-xs overflow-hidden flex flex-col">
                        <div className="p-4 border-b border-[var(--mv-border)] bg-gray-50/55 select-none font-bold text-[10px] uppercase tracking-wider text-gray-500">
                          Statements Menu directory
                        </div>

                        <div className="divide-y divide-[var(--mv-border)] text-xs font-medium">
                          <div 
                            onClick={() => setReportsSubState('ie')}
                            className={`p-4 text-left cursor-pointer transition-colors ${reportsSubState === 'ie' ? 'bg-[var(--mv-accent-soft)]/40 border-l-4 border-[var(--mv-accent)] font-bold text-[var(--mv-accent)]' : 'hover:bg-gray-50 bg-white text-gray-650'}`}
                          >
                            <p className="font-bold">Income & Expenditure Statement</p>
                            <span className="text-[10px] text-gray-400 block mt-1 font-mono tracking-tight font-semibold uppercase leading-none">Provisional surplus</span>
                          </div>
                          <div 
                            onClick={() => setReportsSubState('bs')}
                            className={`p-4 text-left cursor-pointer transition-colors ${reportsSubState === 'bs' ? 'bg-[var(--mv-accent-soft)]/40 border-l-4 border-[var(--mv-accent)] font-bold text-[var(--mv-accent)]' : 'hover:bg-gray-50 bg-white text-gray-650'}`}
                          >
                            <p className="font-bold">Balance Sheet</p>
                            <span className="text-[10px] text-gray-400 block mt-1 font-mono tracking-tight font-semibold uppercase leading-none">Assets, liabilities and funds</span>
                          </div>
                          <div
                            onClick={() => setReportsSubState('rp')}
                            className={`p-4 text-left cursor-pointer transition-colors ${reportsSubState === 'rp' ? 'bg-[var(--mv-accent-soft)]/40 border-l-4 border-[var(--mv-accent)] font-bold text-[var(--mv-accent)]' : 'hover:bg-gray-50 bg-white text-gray-650'}`}
                          >
                            <p className="font-bold">Receipts &amp; Payments</p>
                            <span className="text-[10px] text-gray-400 block mt-1 font-mono tracking-tight font-semibold uppercase leading-none">Cash basis</span>
                          </div>
                          <div
                            onClick={() => setReportsSubState('tb')}
                            className={`p-4 text-left cursor-pointer transition-colors ${reportsSubState === 'tb' ? 'bg-[var(--mv-accent-soft)]/40 border-l-4 border-[var(--mv-accent)] font-bold text-[var(--mv-accent)]' : 'hover:bg-gray-50 bg-white text-gray-650'}`}
                          >
                            <p className="font-bold">Trial Balance</p>
                            <span className="text-[10px] text-gray-400 block mt-1 font-mono tracking-tight font-semibold uppercase leading-none">Every account</span>
                          </div>
                        </div>
                      </div>

                      {/* Detail report sheet */}
                      <div className="col-span-8 bg-white border border-[var(--mv-border)] rounded-2xl shadow-sm p-6 space-y-4">
                        <FinancialStatements statements={statements} which={reportsSubState} />
                      </div>
                    </div>
                  )}

                  {/* 2. GENERAL JOURNAL LEDGER */}
                  {booksSubTab === 'ledger' && (
                    <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs">
                      <JournalLedger statements={statements} />
                    </div>
                  )}

                  {/* 3. BUDGET VARIANCE */}
                  {booksSubTab === 'budget' && (
                    <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs text-left space-y-3">
                      <div className="border-b border-[var(--mv-border)] pb-2">
                        <span className="text-[10px] uppercase font-bold text-gray-500 tracking-wider block">
                          Budget against actuals
                        </span>
                        <p className="text-[9px] text-gray-400 mt-0.5 leading-snug">
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
                            <div className="flex justify-between text-[10px] text-gray-500 font-mono">
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
                      <span className="text-[10px] font-bold uppercase text-gray-400 block border-b border-[var(--mv-border)] pb-2">Governing action audit ledger</span>
                      
                      <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1 hide-scrollbar">
                        {auditLog.map(log => (
                          <div key={log.id} className="p-4 bg-white rounded-xl border border-[var(--mv-border)] flex flex-col gap-1 shadow-xs">
                            <div className="flex justify-between text-[9px] font-bold font-mono text-gray-400 uppercase">
                              <span>🤖 AUTHOR: {log.user}</span>
                              <span className="font-mono font-medium">{log.timestamp}</span>
                            </div>
                            <p className="font-bold text-[#000000] leading-snug mt-1 text-xs">{log.action}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* -------------------- MORE MODULES TAB -------------------- */}
              {activeTab === 'more' && (
                <div className="space-y-6 max-w-7xl mx-auto animate-scale-up text-left">
                  <div>
                    <h2 className="text-2xl font-bold text-[var(--mv-ink)]">Co-operative RWA Admin Panels</h2>
                    <p className="text-xs text-[#6B7280]">Configure resident flat allocations, ticketing helpdesk, and backup parameters</p>
                  </div>

                  <div className="grid grid-cols-2 gap-6 items-start">
                    {/* HELP DESK UTILITY */}
                    <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-6 shadow-xs space-y-4">
                      <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-wider border-b border-[var(--mv-border)] pb-2">RWA Helpdesk Complaints Portal</h4>

                      {currentRole === 'Resident' ? (
                        <form onSubmit={handleRaiseComplaint} className="space-y-4 text-xs font-medium">
                          <div className="space-y-1">
                            <label className="text-[10px] text-gray-500 uppercase block">Utility Category</label>
                            <select
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
                            <label className="text-[10px] text-gray-500 uppercase block">Utility malfunction details</label>
                            <textarea
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
                          <span className="text-[10px] font-bold text-gray-500 uppercase block font-mono">Active complaints ledger logs ({tickets.length} tickets)</span>
                          
                          <div className="space-y-2.5 max-h-[220px] overflow-y-auto pr-1 hide-scrollbar">
                            {tickets.map(t => (
                              <div key={t.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
                                <div className="min-w-0 flex-1 pr-2 space-y-1">
                                  <span className="font-extrabold text-[var(--mv-ink)] block">Flat {t.flatNo} • {t.category}</span>
                                  <p className="text-[10px] text-[#6B7280] leading-relaxed font-semibold">{t.description}</p>
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
                      <div className="bg-white border border-[var(--mv-border)] p-6 rounded-2xl shadow-xs space-y-4">
                        <div className="flex justify-between items-baseline border-b border-[var(--mv-border)] pb-2">
                          <span className="text-[10px] font-bold uppercase text-gray-500 tracking-wider">Residents allotment registry</span>
                          <button
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
                          </button>
                        </div>

                        {memberFormOpen && (
                          <form onSubmit={handleSaveMember} className="space-y-3.5 text-xs bg-[var(--mv-page)] p-4 rounded-xl border border-[var(--mv-border)] animate-scale-up font-medium">
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <label className="text-[9px] font-bold text-gray-550 block">Resident Full Name</label>
                                <input
                                  type="text"
                                  required
                                  value={formName}
                                  onChange={(e) => setFormName(e.target.value)}
                                  placeholder="e.g. Ramesh Desai"
                                  className="w-full bg-white p-2.5 rounded-xl border border-[var(--mv-border)] font-bold outline-none"
                                />
                              </div>
                              <div className="space-y-1">
                                <label className="text-[9px] font-bold text-gray-550 block">Flat Code</label>
                                <input
                                  type="text"
                                  required
                                  value={formFlat}
                                  onChange={(e) => setFormFlat(e.target.value)}
                                  placeholder="e.g. C-303"
                                  className="w-full bg-white p-2.5 rounded-xl border border-[var(--mv-border)] font-bold outline-none"
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                  <label className="text-[9px] font-bold text-gray-555 block">Allotted Wing</label>
                                  <select
                                    value={formWing}
                                    onChange={(e) => setFormWing(e.target.value as any)}
                                    className="w-full bg-white p-2.5 rounded-xl border border-[var(--mv-border)] font-bold outline-none font-sans"
                                  >
                                    <option value="A">Wing A</option>
                                    <option value="B">Wing B</option>
                                    <option value="C">Wing C</option>
                                    <option value="D">Wing D</option>
                                  </select>
                              </div>
                              <div className="space-y-1">
                                <label className="text-[9px] font-bold text-gray-555 block">Mobile Contact Line</label>
                                <input
                                  type="text"
                                  value={formContact}
                                  onChange={(e) => setFormContact(e.target.value)}
                                  placeholder="e.g. +91 98"
                                  className="w-full bg-white p-2.5 rounded-xl border border-[var(--mv-border)] font-mono outline-none"
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
                                <span className="text-[9px] text-[#6B7280] font-bold block font-mono">Wing {m.wing} · Contact: {m.contact}</span>
                              </div>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => handleEditMemberClick(m)}
                                  className="w-7 h-7 bg-white border border-[var(--mv-border)] hover:bg-gray-50 text-gray-400 hover:text-[var(--mv-ink)] rounded-lg transition-all flex items-center justify-center cursor-pointer shadow-xs"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleDeleteMember(m.id, m.name)}
                                  className="w-7 h-7 bg-white border border-[var(--mv-border)] hover:bg-red-50 text-red-650 rounded-lg transition-all flex items-center justify-center cursor-pointer shadow-xs"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="bg-white border border-[var(--mv-border)] p-6 rounded-2xl shadow-xs space-y-4">
                        <div className="flex justify-between items-center pb-2 border-b border-gray-125 select-none">
                          <span className="text-[10px] font-bold uppercase text-gray-500 tracking-wider">Vendor Contracts registry</span>
                          <span className="text-[8px] font-bold bg-gray-200 text-gray-700 px-2 py-0.5 rounded border border-gray-300 font-mono">194C AUDIT</span>
                        </div>

                        <div className="space-y-2.5 max-h-[280px] overflow-y-auto pr-1 hide-scrollbar font-medium">
                          {vendors.map(v => (
                            <div key={v.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
                              <div className="min-w-0 flex-1 pr-1 bg-transparent text-left space-y-0.5">
                                <h5 className="font-extrabold text-[var(--mv-ink)] truncate">{v.name}</h5>
                                <span className="text-[9px] font-bold text-gray-400 block uppercase tracking-wider leading-none">{v.category}</span>
                                <span className="text-[9px] text-[var(--mv-accent)] font-bold block">Contract Renewal: <span className="font-semibold text-gray-500">{v.contractRenewal}</span></span>
                              </div>
                              <div className="text-right shrink-0">
                                <span className="font-mono text-xs font-extrabold text-[var(--mv-ink)] block">{formatRupee(v.balance)}</span>
                                <span className="text-[9px] text-[#6B7280] block uppercase leading-none font-bold">Unpaid total</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Spreadsheets block */}
                  {currentRole !== 'Resident' && (
                    <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs">
                      <BackupHub 
                        backupHistory={backupHistory}
                        onTriggerBackup={handleTriggerBackup}
                        onResetData={handleReset}
                      />
                    </div>
                  )}

                  {/* Code policy block disclosures */}
                  <div className="bg-white border border-[var(--mv-border)] p-5 rounded-2xl shadow-xs text-xs font-semibold space-y-2 relative leading-relaxed">
                    <span className="text-[9px] font-bold text-[var(--mv-accent)] uppercase tracking-wider bg-[var(--mv-accent-soft)] px-2 py-0.5 rounded inline-block">Co-operative Regulatory Compliance code disclosures</span>
                    <p className="text-[10px] text-[#6B7280] leading-relaxed pt-1">Association billing rules and statutory registrations must be verified against the approved Mani Vista bylaws and applicable West Bengal regulations before live use. GSTIN: {gstinLabel}.</p>
                    <button
                      onClick={handleReset}
                      className="text-[10px] font-bold text-[var(--mv-accent)] block py-1.5 hover:underline cursor-pointer uppercase mt-2 border-t border-gray-100 pt-2 w-full text-center"
                    >
                      Reset sandbox database default seed data
                    </button>
                  </div>
                </div>
              )}

            </main>
          </div>
        </div>
      ) : null}

      {/* 2. LEGACY MOBILE PHONE FRAME WRAPPER */}
      {!isDesktop ? (
        <div id="phone-frame-container" className="w-full max-w-[480px] h-[100dvh] bg-white overflow-hidden flex flex-col relative">

        {/* --- STICKY SOCIETY TOP HEADER (White styled, high density) --- */}
        <header className="sticky top-0 bg-white border-b border-[var(--mv-border)] pt-6 pb-2 px-4 flex items-center justify-between gap-3 z-30">
          <img src="/branding/mani-vista-logo.png" alt="Mani Vista" className="h-11 w-11 object-contain bg-white rounded-lg border border-[var(--mv-accent-border)] shrink-0" />
          <div className="flex flex-col flex-1 min-w-0 text-left">
            <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Residents Association</p>
            <h1 className="text-sm font-bold truncate text-[var(--mv-ink)]" title="Mani Vista Residents Association">
              Mani Vista Residents Association
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <ThemeSwitcher />
            {/* Notification bell styled exact to theme */}
            <div className="relative w-8 h-8 flex items-center justify-center bg-[var(--mv-soft)] rounded-full hover:opacity-80 transition-opacity cursor-pointer">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--mv-ink)]">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path>
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path>
              </svg>
              <div className="absolute top-1 right-1 w-2.5 h-2.5 bg-[var(--mv-ink)] border-2 border-white rounded-full"></div>
            </div>

            {/* Role switch pill selector styled exact to theme */}
            <div className="relative bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] px-2 py-1 rounded-full flex items-center gap-1 cursor-pointer">
              <select
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
        <main className="flex-1 overflow-y-auto px-4 py-4 bg-white pb-24 hide-scrollbar">
          
          {/* TOASTER BOX BANNER */}
          {toaster.map(t => (
            <div key={t.id} className="mb-3.5 p-3 rounded-2xl bg-[var(--mv-ink)] text-white text-xs font-bold flex items-start gap-2.5 shadow-md animate-fade-in">
              <Check className="w-4 h-4 text-[var(--mv-accent)] shrink-0 mt-0.5" />
              <span className="leading-snug">{t.msg}</span>
            </div>
          ))}

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
                      <p className="text-sm text-[#6B7280]">
                        {residentFlatNo === ''
                          ? 'No flat is linked to this account yet'
                          : `Flat ${residentFlatNo}`}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Last Sync</p>
                      <p className="text-[10px] text-[var(--mv-accent)] font-bold">JUST NOW</p>
                    </div>
                  </div>

                  {/* 2x2 Metric tile blocks */}
                  <div className="grid grid-cols-2 grid-rows-2 gap-3 transition-all">
                    <div className="aspect-square bg-[var(--mv-ink)] p-4 rounded-2xl flex flex-col justify-between shadow-lg ring-4 ring-black/5">
                      <p className="text-[10px] font-bold text-white/60 uppercase tracking-wider">Current Due</p>
                      <div className="space-y-1">
                        <p className="text-2xl font-bold text-white font-mono">{formatRupee(rohanTotalDueNum)}</p>
                        {rohanTotalDueNum > 0 ? (
                          <div className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-white/10 text-[9px] font-bold text-white">OVERDUE</div>
                        ) : (
                          <div className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-[var(--mv-accent)] text-[9px] font-bold text-white">PAID</div>
                        )}
                      </div>
                    </div>

                    <div className="aspect-square bg-white border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Paid This FY</p>
                      <div className="space-y-1">
                        <p className="text-2xl font-bold text-[var(--mv-ink)] font-mono">{formatRupee(rohanTotalPaidNum)}</p>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-[var(--mv-accent)] text-[9px] font-bold text-white">
                          {rohanInvoices.filter(inv => inv.status === 'Paid').length} TRANSACTIONS
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-white border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Advance Bal</p>
                      <p className="text-2xl font-bold text-[#9CA3AF] font-mono">₹0</p>
                    </div>

                    <div className="aspect-square bg-white border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Open Tickets</p>
                      <div className="space-y-1">
                        <p className="text-2xl font-bold text-[var(--mv-ink)] font-mono">
                          {String(rohanOpenTicketsNum).padStart(2, '0')}
                        </p>
                        <p className="text-[10px] font-medium text-[var(--mv-accent)] uppercase">PLUMBING · B-WING</p>
                      </div>
                    </div>
                  </div>

                  {/* Latest outstanding invoice banner */}
                  {rohanDueInvoice && (
                    <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-4 shadow-sm space-y-4 text-left transition-all">
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Active Invoice</p>
                          <h3 className="font-bold text-[var(--mv-ink)]">#{rohanDueInvoice.invoiceNo}</h3>
                        </div>
                        <div className="bg-[var(--mv-accent-soft)] px-2 py-1 rounded-full">
                          <span className="text-[10px] font-bold text-[var(--mv-accent)] uppercase">DUE IN 4 DAYS</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between border-y border-[var(--mv-soft)] py-3">
                        <div className="space-y-1">
                          <p className="text-xs text-[#6B7280]">{rohanDueInvoice.period} Maintenance + Sinking</p>
                          <p className="text-2xl font-bold text-[var(--mv-ink)] font-mono">{formatRupee(rohanDueInvoice.total)}</p>
                        </div>
                        <button
                          onClick={() => handlePayClick(rohanDueInvoice)}
                          className="bg-[var(--mv-accent)] text-white px-5 py-2.5 rounded-xl font-bold text-sm shadow-md active:scale-95 transition-all cursor-pointer"
                        >
                          Pay Now
                        </button>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-[#6B7280]">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0">
                          <circle cx="12" cy="12" r="10"></circle>
                          <line x1="12" y1="16" x2="12" y2="12"></line>
                          <line x1="12" y1="8" x2="12.01" y2="8"></line>
                        </svg>
                        <span>Includes GST @ 18% as per society norms</span>
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
                            <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center border border-[var(--mv-border)] font-bold text-[var(--mv-accent)]">₹</div>
                            <div className="text-left">
                              <p className="text-sm font-bold text-[var(--mv-ink)]">{inv.period} Maintenance</p>
                              <p className="text-[10px] text-[#6B7280] uppercase">{inv.paidDate || inv.dueDate || '15 MAR 2024'}</p>
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
                      <p className="text-sm text-[#6B7280]">Finance Superintendent · Active Session</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">System State</p>
                      <p className="text-[10px] text-[var(--mv-accent)] font-bold">SECURED PIN</p>
                    </div>
                  </div>

                  {/* 2x2 Metric tiles */}
                  <div className="grid grid-cols-2 grid-rows-2 gap-3 transition-all">
                    <div className="aspect-square bg-[var(--mv-ink)] p-4 rounded-2xl flex flex-col justify-between shadow-lg ring-4 ring-black/5">
                      <span className="text-[10px] font-bold text-white/60 uppercase tracking-wider">Collected MTD</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-white font-mono block leading-none">{formatRupee(mtdCollectedTotal)}</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-white/10 text-[9px] font-semibold text-white">
                          CURRENT RANGE
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-white border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Outstanding</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-[var(--mv-ink)] font-mono block leading-none">{formatRupee(mtdOutstandingTotal)}</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--mv-accent-soft)] text-[9px] font-semibold text-[var(--mv-accent)]">
                          LEDGER TOTAL
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-white border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Defaulters</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-[var(--mv-ink)] font-mono block leading-none">{uniqueDefaultersCount} Flats</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-red-50 text-[9px] font-bold text-red-600">
                          OVERDUE FLAGS
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-white border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Expenses MTD</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-[var(--mv-ink)] font-mono block leading-none">{formatRupee(totalMTDExpenses)}</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--mv-soft)] text-[9px] font-semibold text-[var(--mv-ink)]">
                          RWA OUTFLOW
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Trend charts area */}
                  <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-4 space-y-3 shadow-xs">
                    <div className="flex justify-between items-center">
                      <div>
                        <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-tight">Collection Tendency</h4>
                        <p className="text-[10px] text-gray-400 mt-0.5">Last 6 Months Gross RWA Ledger</p>
                      </div>
                      <TrendingUp className="w-4 h-4 text-[var(--mv-accent)]" />
                    </div>

                    <div className="h-[140px] w-full pt-2 flex items-center justify-center relative">
                      {/* Robust area chart widget */}
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={collectionTrendsData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                          <XAxis dataKey="month" tick={{ fontSize: 9, fill: '#6B7280' }} />
                          <YAxis tick={{ fontSize: 9, fill: '#6B7280' }} />
                          <Tooltip formatter={(value) => formatRupee(value as number)} />
                          <Area type="monotone" dataKey="Collected" stroke="var(--mv-accent)" fillOpacity={0.08} fill="var(--mv-accent)" strokeWidth={2.5} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Action launcher */}
                  <div className="flex gap-2.5 pt-1">
                    <button
                      onClick={() => {
                        setWizardPeriod('Jul 2026');
                        setShowBillingWizard(true);
                      }}
                      className="flex-1 py-3 px-4 bg-[var(--mv-accent)] hover:brightness-90 text-white rounded-xl text-xs font-bold shadow-md active:scale-95 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Plus className="w-4 h-4" /> Issue July Invoices
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
                      <p className="text-sm text-[#6B7280]">Reserve Fund Operations · Cabinet</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Auth Status</p>
                      <p className="text-[10px] text-[var(--mv-accent)] font-bold">GOLD ACTIVE</p>
                    </div>
                  </div>

                  {/* 2x2 Metric tiles */}
                  <div className="grid grid-cols-2 grid-rows-2 gap-3 transition-all">
                    <div className="aspect-square bg-white border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Corpus Fund</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-[var(--mv-ink)] font-mono block leading-none">{formatRupee(corpusFundBase)}</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--mv-accent-soft)] text-[9px] font-semibold text-[var(--mv-accent)]">
                          RESTRICTED
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-white border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Sinking Fund</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-[var(--mv-ink)] font-mono block leading-none">{formatRupee(sinkingFundBase)}</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--mv-soft)] text-[9px] font-semibold text-[var(--mv-ink)]">
                          RESERVE ACCRUAL
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-white border border-[var(--mv-border)] p-4 rounded-2xl flex flex-col justify-between shadow-sm">
                      <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Operating Bal.</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-[var(--mv-ink)] font-mono block leading-none">
                          {formatRupee(operatingFundBase - totalMTDExpenses)}
                        </span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--mv-accent-soft)] text-[9px] font-semibold text-[var(--mv-accent)]">
                          LIQUID RESERVE
                        </div>
                      </div>
                    </div>

                    <div className="aspect-square bg-[var(--mv-ink)] p-4 rounded-2xl flex flex-col justify-between shadow-lg ring-4 ring-black/5">
                      <span className="text-[10px] font-bold text-white/60 uppercase tracking-wider">Pending Appr.</span>
                      <div className="space-y-1">
                        <span className="text-2xl font-bold text-white font-mono block leading-none">{pendingApprovalsCount} Bills</span>
                        <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-white/10 text-[9px] font-semibold text-white">
                          ACTION REQUIRED
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Budget Performance Chart (Budget vs Actual) */}
                  <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-4 space-y-3 shadow-xs">
                    <div className="flex justify-between items-center">
                      <div>
                        <h4 className="font-bold text-sm text-[var(--mv-ink)] uppercase tracking-tight">Receipt Budget Performance</h4>
                        <p className="text-[10px] text-gray-400 mt-0.5">Approved FY Budget vs Realized Revenue</p>
                      </div>
                    </div>

                    <div className="h-[140px] w-full pt-2 flex items-center justify-center relative">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={budgetPerformanceData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                          <XAxis dataKey="head" tick={{ fontSize: 9, fill: '#6B7280' }} />
                          <YAxis tick={{ fontSize: 9, fill: '#6B7280' }} />
                          <Tooltip formatter={(value) => formatRupee(value as number)} />
                          <Bar dataKey="Budgeted" fill="#6B7280" radius={[4, 4, 0, 0]} />
                          <Bar dataKey="Actual" fill="var(--mv-accent)" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Pending Approvals Quick Controller Workflow */}
                  <div className="space-y-3 pt-1">
                    <h4 className="font-extrabold text-xs text-[var(--mv-ink)] tracking-wider uppercase">Required Approvals</h4>
                    
                    {vendorInvoices.filter(vi => vi.status === 'Pending').length === 0 ? (
                      <div className="py-4 bg-gray-55 text-center text-xs text-gray-400 rounded-2xl">
                        Clean desk! No outstanding vendor proposals on file.
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {vendorInvoices.filter(vi => vi.status === 'Pending').map(vi => (
                          <div key={vi.id} className="p-3 border border-[var(--mv-border)] rounded-3xl bg-white space-y-2">
                            <div className="flex justify-between items-baseline">
                              <div>
                                <span className="text-[8px] font-extrabold text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] px-1.5 py-0.5 rounded uppercase tracking-wide">
                                  {vi.category}
                                </span>
                                <h5 className="font-bold text-xs text-[var(--mv-ink)] mt-1">{vi.vendorName}</h5>
                              </div>
                              <span className="font-mono text-xs font-bold text-gray-900">{formatRupee(vi.amount)}</span>
                            </div>

                            <div className="bg-gray-50 p-2 rounded-xl text-[10px] text-gray-550 border border-gray-100 flex justify-between items-center leading-snug">
                              <span>Withholding TDS 2% (u/s 194C): <strong className="font-mono text-gray-900">{formatRupee(vi.tdsAmount)}</strong></span>
                              <span>Net: <strong className="font-mono text-gray-900">{formatRupee(vi.netPayable)}</strong></span>
                            </div>

                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={() => handleVendorInvoiceStatus(vi.id, 'Rejected')}
                                className="py-1 px-3 border border-gray-300 rounded-lg text-[10px] font-bold text-gray-600 hover:bg-gray-50 active:scale-95"
                              >
                                Reject
                              </button>
                              <button
                                onClick={() => handleVendorInvoiceStatus(vi.id, 'Approved')}
                                className="py-1 px-3 bg-[var(--mv-accent)] hover:brightness-90 text-white rounded-lg text-[10px] font-bold active:scale-95 shadow-sm"
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
                  <p className="text-xs text-[#6B7280]">Historical and active transactions</p>
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
                <div className="p-4 bg-white border border-[var(--mv-border)] rounded-2xl">
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
                      className="text-[10px] font-bold text-[var(--mv-accent)] uppercase py-0.5 px-1.5 bg-white border border-[var(--mv-border)] rounded-lg"
                    >
                      Close
                    </button>
                  </div>
                  
                  <form onSubmit={handleRunBillGeneration} className="space-y-3 text-xs">
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[10px] text-[#6B7280] font-bold block mb-0.5 uppercase">Billing Period</label>
                        <input 
                          type="text" 
                          value={wizardPeriod} 
                          onChange={(e) => setWizardPeriod(e.target.value)}
                          placeholder="e.g. Jul 2026"
                          className="w-full bg-white p-2 rounded-xl border border-[var(--mv-border)] font-bold text-[var(--mv-ink)] outline-none" 
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-[#6B7280] font-bold block mb-0.5 uppercase">Billing Cycle</label>
                        <select 
                          value={wizardCycle} 
                          onChange={(e) => setWizardCycle(e.target.value)}
                          className="w-full bg-white p-2 rounded-xl border border-[var(--mv-border)] font-bold text-[var(--mv-ink)] outline-none"
                        >
                          <option value="Monthly">Monthly</option>
                          <option value="Quarterly">Quarterly</option>
                          <option value="Annual">Annual</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[10px] text-[#6B7280] font-bold block mb-0.5 uppercase">Maintenance (₹)</label>
                        <input 
                          type="number" 
                          value={wizardMaint} 
                          onChange={(e) => setWizardMaint(e.target.value)}
                          className="w-full bg-white p-2 rounded-xl border border-[var(--mv-border)] font-mono font-bold text-[var(--mv-ink)] outline-none" 
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-[#6B7280] font-bold block mb-0.5 uppercase">Sinking Fund (₹)</label>
                        <input 
                          type="number" 
                          value={wizardSinking} 
                          onChange={(e) => setWizardSinking(e.target.value)}
                          className="w-full bg-white p-2 rounded-xl border border-[var(--mv-border)] font-mono font-bold text-[var(--mv-ink)] outline-none" 
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[10px] text-[#6B7280] font-bold block mb-0.5 uppercase">Water (₹)</label>
                        <input 
                          type="number" 
                          value={wizardWater} 
                          onChange={(e) => setWizardWater(e.target.value)}
                          className="w-full bg-white p-2 rounded-xl border border-[var(--mv-border)] font-mono font-bold text-[var(--mv-ink)] outline-none" 
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-[#6B7280] font-bold block mb-0.5 uppercase">Parking (₹)</label>
                        <input 
                          type="number" 
                          value={wizardParking} 
                          onChange={(e) => setWizardParking(e.target.value)}
                          className="w-full bg-white p-2 rounded-xl border border-[var(--mv-border)] font-mono font-bold text-[var(--mv-ink)] outline-none" 
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      className="w-full py-2.5 bg-[var(--mv-accent)] text-white font-bold rounded-xl text-center shadow-md active:scale-98 cursor-pointer"
                    >
                      Preview & Dispatch July Bills (Q2)
                    </button>
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
                        className="flex items-center justify-between p-3 bg-white rounded-xl border border-[var(--mv-border)] hover:bg-[var(--mv-page)] cursor-pointer transition-all text-left"
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0 pr-2">
                          <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center border border-[var(--mv-border)] font-mono text-[9px] font-bold text-[#6B7280] shrink-0">
                            {inv.invoiceNo.replace('INV-', '')}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-[var(--mv-ink)] truncate">
                              {inv.period} Maintenance {currentRole !== 'Resident' ? `(${inv.flatNo})` : ''}
                            </p>
                            <p className="text-[10px] text-[var(--mv-accent)] font-bold uppercase truncate">
                              Owner: <span className="text-gray-500 font-semibold">{inv.name}</span>
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
                      <h2 className="text-xl font-bold text-[var(--mv-ink)]">Payments (demo)</h2>
                      <p className="text-sm text-[#6B7280]">UPI, Net Banking & deposits</p>
                    </div>
                  </div>

                  {payingInvoice ? (
                    <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-4 space-y-4 shadow-sm animate-scale-up text-left">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-[10px] uppercase text-[#6B7280] tracking-wider">Checkout bill summary</span>
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
                        <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider block">Choose Clearing Method</span>
                        
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          {[
                            { id: 'UPI', label: 'UPI / BHIM app' },
                            { id: 'Net Banking', label: 'Net Banking' },
                            { id: 'Card', label: 'Debit/Credit Card' },
                            { id: 'Wallet', label: 'Digital Wallets' }
                          ].map(item => (
                            <label
                              key={item.id}
                              onClick={() => setPaymentMethod(item.id as any)}
                              className={`p-3.5 rounded-xl border transition-all flex flex-col justify-between cursor-pointer text-left ${
                                paymentMethod === item.id
                                  ? 'bg-[var(--mv-ink)] text-white border-black shadow'
                                  : 'bg-white text-[var(--mv-ink)] border-[var(--mv-border)] hover:bg-[var(--mv-page)]'
                              }`}
                            >
                              <span className="font-bold block leading-tight">{item.label}</span>
                              <span className={`text-[8px] mt-2 block uppercase font-mono ${paymentMethod === item.id ? 'text-white/60' : 'text-[#6B7280]'}`}>
                                Instant settlement
                              </span>
                            </label>
                          ))}
                        </div>

                        {/* Partial payment modifier */}
                        <div className="space-y-1.5 text-left">
                          <label className="text-[10px] font-bold text-[#6B7280] uppercase block">Partial Payment Modification</label>
                          <input 
                            type="number" 
                            placeholder={`Clear full amount of ${formatRupee(payingInvoice.total)}`}
                            value={partialAmountInput}
                            onChange={(e) => setPartialAmountInput(e.target.value)}
                            max={payingInvoice.total}
                            className="bg-white border border-[var(--mv-border)] rounded-xl p-2.5 font-mono text-xs w-full text-gray-800 outline-none focus:border-[var(--mv-accent)]"
                          />
                          <span className="text-[9px] text-[#6B7280] block font-medium leading-tight">
                            Partial payment leaves outstanding arrears on this ledger period.
                          </span>
                        </div>

                        <button
                          type="submit"
                          className="w-full py-3 bg-[var(--mv-accent)] text-white font-bold text-sm rounded-xl text-center shadow-md active:scale-95 transition-all cursor-pointer"
                        >
                          Clear & Generate PDF Receipt
                        </button>
                      </form>
                    </div>
                  ) : (
                    <div className="space-y-3.5 pb-24 text-left">
                      
                      {/* Outstanding bills available to pay list */}
                      <div className="bg-white border border-[var(--mv-border)] p-4 rounded-2xl space-y-3 shadow-xs">
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">
                            Pending Clearance
                          </span>
                        </div>
                        
                        {rohanInvoices.filter(inv => inv.status !== 'Paid').length === 0 ? (
                          <div className="py-4 text-center text-xs text-gray-400 font-semibold">
                            🎉 No outstanding dues on Flat {residentFlatNo}! Clean slate.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {rohanInvoices.filter(inv => inv.status !== 'Paid').map(inv => (
                              <div key={inv.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
                                <div>
                                  <span className="font-mono text-[9px] font-bold text-gray-400">{inv.invoiceNo}</span>
                                  <h5 className="font-bold text-[var(--mv-ink)] mt-0.5">{inv.period} Maintenance Bill</h5>
                                </div>
                                <div className="text-right flex items-center gap-2">
                                  <span className="font-mono font-bold text-[var(--mv-ink)]">{formatRupee(inv.total)}</span>
                                  <button
                                    onClick={() => handlePayClick(inv)}
                                    className="py-1 px-3 bg-[var(--mv-accent)] text-white font-bold rounded-lg text-[10px] shadow active:scale-95 cursor-pointer"
                                  >
                                    Pay
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Advance Payment trigger */}
                      <div className="bg-white border border-[var(--mv-border)] p-4 rounded-2xl space-y-3 shadow-xs">
                        <div>
                          <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider block">Deposit Advance Funds</span>
                          <span className="text-[10px] text-gray-450 mt-0.5 block leading-snug">
                            Over-credit counts toward subsequent quarterly maintenance invoices.
                          </span>
                        </div>

                        <form onSubmit={handleExecuteAdvance} className="space-y-2">
                          <div className="flex gap-2">
                            <input
                              type="number"
                              value={customAdvanceInput}
                              onChange={(e) => setCustomAdvanceInput(e.target.value)}
                              placeholder="Deposit amount, e.g. 5000"
                              className="flex-1 bg-white border border-[var(--mv-border)] rounded-xl p-2 px-3 text-xs font-mono font-bold text-gray-800 outline-none focus:border-[var(--mv-accent)]"
                            />
                            <button
                              type="submit"
                              className="py-2.5 px-4 bg-[var(--mv-ink)] text-white hover:bg-black text-xs font-bold rounded-xl active:scale-95 transition-all text-center cursor-pointer shadow"
                            >
                              Deposit
                            </button>
                          </div>
                        </form>
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
                      <p className="text-sm text-[#6B7280]">Aging outstanding accounts receivable ledger</p>
                    </div>
                  </div>

                  <div className="space-y-4 pb-24 text-left">
                    {/* Defaulter Registry cards list */}
                    <div className="bg-white border border-[var(--mv-border)] p-4 rounded-2xl space-y-3.5 shadow-xs">
                      <div className="flex justify-between items-center pb-2 border-b border-[var(--mv-border)]">
                        <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Unpaid Overdue Units ({overdueInvoices.length})</span>
                        <span className="text-[9px] font-bold text-[var(--mv-accent)] bg-[var(--mv-accent-soft)] px-2 py-0.5 rounded uppercase">
                          AR Ledger
                        </span>
                      </div>

                      <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1 hide-scrollbar">
                        {overdueInvoices.length === 0 ? (
                          <div className="py-4 text-center text-xs text-gray-400 font-semibold font-mono">
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
                                <span className="text-[9px] text-[#6B7280] block mt-1 font-medium">Period: {inv.period} • Grace period expired</span>
                              </div>
                              <div className="text-right flex items-center gap-2 font-mono text-xs">
                                <span className="font-extrabold text-[var(--mv-ink)]">{formatRupee(inv.total)}</span>
                                <button
                                  onClick={() => handleSendReminder(inv)}
                                  className="w-7 h-7 bg-[var(--mv-accent-soft)] hover:bg-[var(--mv-accent-border)] text-[var(--mv-accent)] rounded-lg transition-all flex items-center justify-center shadow"
                                  title="Send Reminder warning"
                                >
                                  <Send className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* Auto bank reconciliation ledger segment */}
                    <div className="bg-white border border-[var(--mv-border)] p-4 rounded-2xl space-y-3 shadow-xs">
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Bank Reconciliation Feed</span>
                        <span className="inline-block px-2 py-0.5 bg-[var(--mv-accent)] text-white text-[9px] rounded font-bold uppercase tracking-wider">
                          LIVE ACTIVE
                        </span>
                      </div>

                      <div className="space-y-2 text-[10px] leading-snug">
                        <div className="p-2.5 bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] rounded-xl border border-[var(--mv-accent-border)]/40 font-mono">
                          <strong>[SUCCESS LINK]</strong> Reconciled incoming UPI bank NACH of <strong>₹3,79,500</strong> from Sector Core Accounts.
                        </div>
                        <div className="p-2.5 bg-[var(--mv-page)] text-gray-550 rounded-xl border border-[var(--mv-border)] font-mono">
                          <strong>[SAMPLE ACTIVITY]</strong> An illustrative ledger check across one wing. Part of the demonstration narrative, not a transaction in the books.
                        </div>
                      </div>
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
                  <p className="text-xs text-[#6B7280]">Double-entry ledger accuracy</p>
                </div>
                <BookOpen className="w-4 h-4 text-[var(--mv-accent)]" />
              </div>

              {/* internal switcher segment (Reports, ledgers, audit trail, budget) */}
              <div className="grid grid-cols-4 gap-1 bg-[var(--mv-soft)] p-1 rounded-xl text-[10px] uppercase font-bold text-center">
                <button
                  onClick={() => setBooksSubTab('reports')}
                  className={`py-1 rounded-lg transition-all cursor-pointer ${booksSubTab === 'reports' ? 'bg-[var(--mv-ink)] text-white shadow-sm' : 'text-[#6B7280]'}`}
                >
                  Reports
                </button>
                <button
                  onClick={() => setBooksSubTab('ledger')}
                  className={`py-1 rounded-lg transition-all cursor-pointer ${booksSubTab === 'ledger' ? 'bg-[var(--mv-ink)] text-white shadow-sm' : 'text-[#6B7280]'}`}
                >
                  Ledger
                </button>
                <button
                  onClick={() => setBooksSubTab('budget')}
                  className={`py-1 rounded-lg transition-all cursor-pointer ${booksSubTab === 'budget' ? 'bg-[var(--mv-ink)] text-white shadow-sm' : 'text-[#6B7280]'}`}
                >
                  Budget
                </button>
                <button
                  onClick={() => setBooksSubTab('audit')}
                  className={`py-1 rounded-lg transition-all cursor-pointer ${booksSubTab === 'audit' ? 'bg-[var(--mv-ink)] text-white shadow-sm' : 'text-[#6B7280]'}`}
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
                          : 'bg-white text-[#6B7280] border-[var(--mv-border)] hover:bg-[var(--mv-page)]'
                      }`}
                    >
                      Income & Expense
                    </button>
                    <button
                      onClick={() => setReportsSubState('bs')}
                      className={`px-3 py-1 rounded-lg border font-bold transition-all cursor-pointer ${
                        reportsSubState === 'bs'
                          ? 'bg-[var(--mv-ink)] text-white border-black shadow'
                          : 'bg-white text-[#6B7280] border-[var(--mv-border)] hover:bg-[var(--mv-page)]'
                      }`}
                    >
                      Balance Sheet
                    </button>
                    <button
                      onClick={() => setReportsSubState('rp')}
                      className={`px-3 py-1 rounded-lg border font-bold transition-all cursor-pointer ${
                        reportsSubState === 'rp'
                          ? 'bg-[var(--mv-ink)] text-white border-black shadow'
                          : 'bg-white text-[#6B7280] border-[var(--mv-border)] hover:bg-[var(--mv-page)]'
                      }`}
                    >
                      Receipts &amp; Payments
                    </button>
                    <button
                      onClick={() => setReportsSubState('tb')}
                      className={`px-3 py-1 rounded-lg border font-bold transition-all cursor-pointer ${
                        reportsSubState === 'tb'
                          ? 'bg-[var(--mv-ink)] text-white border-black shadow'
                          : 'bg-white text-[#6B7280] border-[var(--mv-border)] hover:bg-[var(--mv-page)]'
                      }`}
                    >
                      Trial Balance
                    </button>
                  </div>

                  <FinancialStatements statements={statements} which={reportsSubState} compact />
                </div>
              )}

              {/* TAB Books -> Sub Journal ledgers */}
              {booksSubTab === 'ledger' && (
                <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs">
                  <JournalLedger statements={statements} compact />
                </div>
              )}

              {/* TAB Books -> Head budgets variance */}
              {booksSubTab === 'budget' && (
                <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-5 shadow-xs text-left space-y-3">
                  <div className="border-b border-[var(--mv-border)] pb-2">
                    <span className="text-[10px] uppercase font-bold text-gray-500 tracking-wider block">
                      Budget against actuals
                    </span>
                    <p className="text-[9px] text-gray-400 mt-0.5 leading-snug">
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
                        <div className="flex justify-between text-[10px] text-gray-500 font-mono">
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
                  <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider block">Security Audit Log</span>
                  
                  <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1 hide-scrollbar">
                    {auditLog.map((log) => (
                      <div key={log.id} className="p-3 bg-white rounded-xl text-xs leading-relaxed border border-[var(--mv-border)] flex flex-col gap-1 shadow-xs">
                        <div className="flex justify-between text-[8px] font-bold text-[#6B7280] uppercase">
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
          {activeTab === 'more' && (
            <div className="space-y-4 animate-scale-up pb-24 text-left">
              
              {/* Profile & reset utility option */}
              <div className="flex justify-between items-baseline pb-1">
                <div>
                  <h2 className="text-xl font-bold text-[var(--mv-ink)]">More Modules</h2>
                  <p className="text-xs text-[#6B7280]">Systems, configurations, and sandboxes</p>
                </div>
              </div>

              {/* HELPDESK Raising Ticketing Portal */}
              <div className="bg-white border border-[var(--mv-border)] rounded-2xl p-4 space-y-3 shadow-xs">
                <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider block">RWA Support Helpdesk</span>

                {currentRole === 'Resident' ? (
                  <form onSubmit={handleRaiseComplaint} className="space-y-3.5">
                    <div className="space-y-1">
                      <label className="text-[10px] text-[#6B7280] font-bold uppercase tracking-wider block">Grievance Category</label>
                      <select
                        value={ticketCategory}
                        onChange={(e) => setTicketCategory(e.target.value as any)}
                        className="w-full bg-white border border-[var(--mv-border)] p-2.5 rounded-xl text-xs font-bold outline-none focus:border-[var(--mv-accent)]"
                      >
                        <option value="Plumbing">🚰 Plumbing</option>
                        <option value="Lift">🛗 Lift Maintenance</option>
                        <option value="Security">🛡️ Security & Watch</option>
                        <option value="Billing Query">🧾 Billing Ledger Query</option>
                        <option value="Other">⚙️ Other Inquiry</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] text-[#6B7280] font-bold uppercase tracking-wider block">Grievance Description</label>
                      <textarea
                        rows={3}
                        value={ticketDescription}
                        onChange={(e) => setTicketDescription(e.target.value)}
                        placeholder="e.g. Balcony pipeline leakage or elevator noises..."
                        className="w-full bg-white border border-[var(--mv-border)] p-2.5 rounded-xl text-xs font-medium outline-none focus:border-[var(--mv-accent)] leading-snug"
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
                    <span className="text-[10px] font-bold text-[#6B7280] uppercase block">Active Grievance Log ({tickets.length})</span>
                    
                    <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1 hide-scrollbar">
                      {tickets.map(t => (
                        <div key={t.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
                          <div className="min-w-0 flex-1 pr-1.5 space-y-1">
                            <span className="font-extrabold text-[var(--mv-ink)] block">{t.flatNo} • {t.category}</span>
                            <p className="text-[10px] text-[#6B7280] truncate leading-tight font-medium">{t.description}</p>
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
                <div className="bg-white border border-[var(--mv-border)] p-4 rounded-2xl space-y-3.5 shadow-sm text-left">
                  <div className="flex justify-between items-baseline border-b border-[var(--mv-border)] pb-2">
                    <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Resident Roster CRUD</span>
                    <button
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
                    </button>
                  </div>

                  {memberFormOpen && (
                    <form onSubmit={handleSaveMember} className="space-y-3.5 text-xs bg-[var(--mv-page)] p-3.5 rounded-xl border border-[var(--mv-border)] animate-scale-up">
                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="space-y-1">
                          <label className="text-[9px] font-bold text-[#6B7280] uppercase tracking-wider block">Resident Full Name</label>
                          <input
                            type="text"
                            required
                            value={formName}
                            onChange={(e) => setFormName(e.target.value)}
                            placeholder="e.g. Ramesh Desai"
                            className="w-full bg-white p-2.5 rounded-xl border border-[var(--mv-border)] font-bold text-xs outline-none focus:border-[var(--mv-accent)]"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[9px] font-bold text-[#6B7280] uppercase tracking-wider block">Flat Number</label>
                          <input
                            type="text"
                            required
                            value={formFlat}
                            onChange={(e) => setFormFlat(e.target.value)}
                            placeholder="e.g. C-303"
                            className="w-full bg-white p-2.5 rounded-xl border border-[var(--mv-border)] font-bold text-xs outline-none focus:border-[var(--mv-accent)]"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="space-y-1">
                          <label className="text-[9px] font-bold text-[#6B7280] uppercase tracking-wider block">Sector Wing</label>
                          <select
                            value={formWing}
                            onChange={(e) => setFormWing(e.target.value as any)}
                            className="w-full bg-white p-2.5 rounded-xl border border-[var(--mv-border)] font-bold text-xs outline-none"
                          >
                            <option value="A">Wing A</option>
                            <option value="B">Wing B</option>
                            <option value="C">Wing C</option>
                            <option value="D">Wing D</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[9px] font-bold text-[#6B7280] uppercase tracking-wider block">Contact Line</label>
                          <input
                            type="text"
                            value={formContact}
                            onChange={(e) => setFormContact(e.target.value)}
                            placeholder="e.g. +91 988"
                            className="w-full bg-white p-2.5 rounded-xl border border-[var(--mv-border)] font-bold font-mono text-xs outline-none focus:border-[var(--mv-accent)]"
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
                          <span className="text-[9px] text-[#6B7280] block font-mono">{m.contact}</span>
                        </div>
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => handleEditMemberClick(m)}
                            className="w-7 h-7 bg-white border border-[var(--mv-border)] hover:bg-gray-50 text-[#6B7280] hover:text-[var(--mv-ink)] rounded-lg transition-all flex items-center justify-center cursor-pointer shadow-xs"
                            title="Edit"
                          >
                            <Edit3 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => handleDeleteMember(m.id, m.name)}
                            className="w-7 h-7 bg-white border border-[var(--mv-border)] hover:bg-red-50 text-red-650 rounded-lg transition-all flex items-center justify-center cursor-pointer shadow-xs"
                            title="Deallot flat"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                </div>
              )}

              {/* VENDOR LEDGER & CONTRACTS OUTLINE (Committee / manager accessible) */}
              {currentRole !== 'Resident' && (
                <div className="bg-white border border-[var(--mv-border)] p-4 rounded-2xl space-y-3.5 shadow-sm text-left">
                  <div className="flex justify-between items-center pb-1 border-b border-[var(--mv-border)]">
                    <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Vendor Ledgers & Contracts</span>
                    <span className="text-[8px] font-bold text-[var(--mv-ink)] bg-[var(--mv-soft)] px-1.5 py-0.5 rounded-md font-mono">Sec 194C Compliant</span>
                  </div>

                  <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1 hide-scrollbar">
                    {vendors.map(v => (
                      <div key={v.id} className="p-3 bg-[var(--mv-page)] rounded-xl border border-[var(--mv-border)] flex justify-between items-center text-xs">
                        <div className="min-w-0 flex-1 pr-1 bg-transparent">
                          <h5 className="font-bold text-[var(--mv-ink)] truncate">{v.name}</h5>
                          <span className="text-[9px] font-bold text-[#6B7280] block mt-0.5 uppercase tracking-wide">
                            {v.category}
                          </span>
                          <span className="text-[9px] text-[var(--mv-accent)] font-bold mt-1.5 block">
                            Renewal: <span className="text-gray-500 font-semibold">{v.contractRenewal}</span>
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="font-mono text-xs font-bold text-[var(--mv-ink)] block leading-tight">{formatRupee(v.balance)}</span>
                          <span className="text-[9px] text-[#6B7280] font-bold uppercase tracking-tight block mt-1">Due Balance</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* CLOUD GOOGLE SHEETS BACKUP MODULE INTEGRATION FOR ALL ROLES */}
              {currentRole !== 'Resident' && (
                <BackupHub 
                  backupHistory={backupHistory}
                  onTriggerBackup={handleTriggerBackup}
                  onResetData={handleReset}
                />
              )}

              {/* Basic quick switch user suggestion details / manual info cards */}
              <div className="bg-white border border-[var(--mv-border)] p-4 rounded-2xl text-left space-y-2 relative shadow-xs">
                <span className="text-[9px] font-bold text-[var(--mv-accent)] uppercase tracking-wider bg-[var(--mv-accent-soft)] px-2 py-0.5 rounded-md inline-block">
                  Co-op Housing Regulatory Code
                </span>
                <p className="text-[10px] text-[#6B7280] leading-relaxed pt-0.5 font-medium">
                  Billing and statutory treatment require review against Mani Vista bylaws and the applicable laws before production use. GSTIN {gstinLabel}.
                </p>
                {currentRole === 'Resident' && (
                  <button
                    onClick={handleReset}
                    className="mt-2 text-[10px] font-bold text-[var(--mv-accent)] block py-1 cursor-pointer hover:underline"
                  >
                    Reset Sandbox Default Seed Data
                  </button>
                )}
              </div>

              {/* Logged-in member + logout */}
              <div className="bg-white border border-[var(--mv-border)] p-4 rounded-2xl text-left shadow-xs">
                <p className="text-[9px] font-bold text-[#6B7280] uppercase tracking-wider">Logged in as</p>
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
        <nav className="absolute bottom-0 left-0 right-0 bg-[var(--mv-ink)] text-white border-t border-gray-800 py-3.5 px-3 flex justify-around items-center z-30 shadow-2xl rounded-t-3xl min-h-[64px]">
          
          <button 
            onClick={() => setActiveTab('home')}
            className={`flex flex-col items-center gap-1 cursor-pointer transition-colors ${activeTab === 'home' ? 'text-[var(--mv-accent)]' : 'text-gray-400 hover:text-white'}`}
          >
            <Home className="w-5 h-5" />
            <span className="text-[9px] font-bold uppercase tracking-wider">Home</span>
          </button>

          <button 
            onClick={() => setActiveTab('bills')}
            className={`flex flex-col items-center gap-1 cursor-pointer transition-colors ${activeTab === 'bills' ? 'text-[var(--mv-accent)]' : 'text-gray-400 hover:text-white'}`}
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
            className={`flex flex-col items-center gap-1 cursor-pointer transition-colors ${activeTab === 'pay' ? 'text-[var(--mv-accent)]' : 'text-gray-400 hover:text-white'}`}
          >
            <CreditCard className="w-5 h-5" />
            <span className="text-[9px] font-bold uppercase tracking-wider">Pay Rooms</span>
          </button>

          <button 
            onClick={() => {
              if (currentRole === 'Resident') {
                // Resident cannot open books screen - show prompt!
                triggerToast('Access Denied: Core Accounting reports are restricted to Administrative roles. Enter PIN at dropdown to view.');
                handleRoleSwitchRequest('Manager'); // Direct trigger to authenticating
              } else {
                setActiveTab('books');
              }
            }}
            className={`flex flex-col items-center gap-1 cursor-pointer transition-colors ${activeTab === 'books' ? 'text-[var(--mv-accent)]' : 'text-gray-400 hover:text-white'}`}
          >
            <div className="relative">
              <BookOpen className="w-5 h-5" />
              {currentRole === 'Resident' && (
                <Lock className="w-2.5 h-2.5 text-[var(--mv-accent)] absolute -top-1 -right-1 bg-white rounded-full p-0.5" />
              )}
            </div>
            <span className="text-[9px] font-bold uppercase tracking-wider flex items-center justify-center">
              Books
            </span>
          </button>

          <button 
            onClick={() => setActiveTab('more')}
            className={`flex flex-col items-center gap-1 cursor-pointer transition-colors ${activeTab === 'more' ? 'text-[var(--mv-accent)]' : 'text-gray-400 hover:text-white'}`}
          >
            <Menu className="w-5 h-5" />
            <span className="text-[9px] font-bold uppercase tracking-wider">More</span>
          </button>

        </nav>

      </div>
      ) : null}

      {/* --- DYNAMIC FLOATING OVERLAYS MODALS (shared across desktop & mobile) --- */}

        {/* 1. Administrative access credentials validation PIN modal */}
        <AdminPinModal 
          isOpen={showAuthModal}
          targetRole={authTargetRole}
          onClose={() => setShowAuthModal(false)}
          onSuccess={handleAuthSuccess}
        />

        {/* 2. Invoice Details Breakdown Modal (mobile only — desktop uses inline master-detail panel) */}
        {!isDesktop && (
          <InvoiceDetailModal
            invoice={selectedInvoice}
            role={currentRole}
            onClose={() => setSelectedInvoice(null)}
            onPayNow={(inv) => {
              setSelectedInvoice(null);
              handlePayClick(inv);
            }}
            onSendReminder={handleSendReminder}
            gstinLabel={gstinLabel}
            {...(booksSource.server !== null
              ? { onDownloadPdf: (inv: Invoice) => booksSource.server!.invoicePdf(inv.id) }
              : {})}
          />
        )}

        {/* 3. Success Checkout Clear Modal */}
        {showSuccessPayModal && selectedReceipt && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
            <div className="bg-white w-full max-w-[340px] rounded-3xl overflow-hidden shadow-2xl border border-[var(--mv-border)] p-5 text-center space-y-4 animate-scale-up">
              <div className="w-12 h-12 bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] border border-[var(--mv-accent-border)] rounded-full flex items-center justify-center mx-auto">
                <Check className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-extrabold text-sm text-[var(--mv-ink)]">Clearing Succeeded!</h3>
                <p className="text-xs text-gray-500 mt-1">Bank instant auto-reconcile cleared the receivables.</p>
              </div>

              <div className="bg-gray-50 p-3 rounded-2xl border border-gray-100 text-xs font-mono">
                <p className="text-gray-400 text-[10px]">TRANSACTION REFERENCE</p>
                <p className="font-extrabold text-gray-800 mt-0.5">{selectedReceipt.transactionId || 'RECON9981'}</p>
                <p className="font-extrabold text-gray-900 mt-1.5">{formatRupee(selectedReceipt.total)}</p>
              </div>

              <div className="flex gap-2.5">
                <button
                  onClick={() => {
                    setShowSuccessPayModal(false);
                    setShowReceiptModal(true);
                  }}
                  className="flex-1 py-2 px-3 bg-[var(--mv-accent)] text-white rounded-xl text-xs font-bold"
                >
                  Download Receipt File
                </button>
                <button
                  onClick={() => setShowSuccessPayModal(false)}
                  className="py-2 px-3 bg-white border border-gray-300 rounded-xl text-xs font-semibold text-gray-600"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 4. Receipt Download view Modal */}
        <ReceiptModal
          isOpen={showReceiptModal}
          invoice={selectedReceipt}
          onClose={() => {
            setShowReceiptModal(false);
            setSelectedReceipt(null);
          }}
          gstinLabel={gstinLabel}
        />

    </div>
  );
}
