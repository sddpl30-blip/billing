/**
 * The calls behind the Office's "Approvals & admin" panel.
 *
 * Shapes are the server's own, read from server/src/routes.ts and
 * routesAdmin.ts; nothing here reshapes a figure. Money stays in paise and a
 * rate in paise per square foot until the screen formats it.
 */

import type { ApiClient, TicketResponse } from '../client';

export type AreaBasis = 'carpet' | 'built-up' | 'super-built-up';
export const AREA_BASES: readonly AreaBasis[] = ['carpet', 'built-up', 'super-built-up'];

// --- rates ---------------------------------------------------------------

export interface Rate {
  readonly id: string;
  readonly paisePerSqFt: number;
  readonly ratePerSqFt: number;
  readonly basis: AreaBasis;
  readonly effectiveFrom: string;
  readonly authority: string;
  readonly approved: boolean;
  readonly approvedOn: string | null;
}

export interface NewRate {
  readonly paisePerSqFt: number;
  readonly basis: AreaBasis;
  readonly effectiveFrom: string;
  readonly authority: string;
}

export async function listRates(client: ApiClient): Promise<Rate[]> {
  const body = await client.get<{ rates: Rate[] }>('/api/rates');
  return body.rates;
}

export function addRate(client: ApiClient, rate: NewRate): Promise<{ id: string; approved: false; note: string }> {
  return client.post('/api/rates', rate);
}

export function approveRate(client: ApiClient, id: string, on: string): Promise<{ id: string; approved: true }> {
  return client.post(`/api/rates/${encodeURIComponent(id)}/approve`, { on });
}

// --- settings ------------------------------------------------------------

export interface Setting {
  readonly key: string;
  readonly value: unknown;
  readonly approved: boolean;
  readonly approvedOn: string | null;
  readonly note: string | null;
  readonly updatedAt: string;
}

export async function listSettings(client: ApiClient): Promise<Setting[]> {
  const body = await client.get<{ settings: Setting[] }>('/api/settings');
  return body.settings;
}

export function putSetting(
  client: ApiClient, key: string, value: unknown, note?: string,
): Promise<{ key: string; value: unknown; approved: false }> {
  return client.put(`/api/settings/${encodeURIComponent(key)}`, note === undefined ? { value } : { value, note });
}

export function approveSetting(
  client: ApiClient, key: string, on: string, note?: string,
): Promise<{ key: string; approved: true; approvedOn: string }> {
  return client.post(
    `/api/settings/${encodeURIComponent(key)}/approve`,
    note === undefined ? { on } : { on, note },
  );
}

// --- periods -------------------------------------------------------------

export interface FinancialPeriod {
  readonly period: string;
  readonly state: 'open' | 'closed' | 'reopened' | string;
  readonly closedAt: string | null;
  readonly trialBalancePaise: number | null;
  readonly reopenedReason: string | null;
}

export async function listPeriods(client: ApiClient): Promise<FinancialPeriod[]> {
  const body = await client.get<{ periods: FinancialPeriod[] }>('/api/periods');
  return body.periods;
}

export function closePeriod(
  client: ApiClient, period: string,
): Promise<{ period: string; closedOn: string; trialBalancePaise: number; note: string }> {
  return client.post(`/api/periods/${encodeURIComponent(period)}/close`, {});
}

export function reopenPeriod(client: ApiClient, period: string, reason: string): Promise<{ period: string; state: 'reopened' }> {
  return client.post(`/api/periods/${encodeURIComponent(period)}/reopen`, { reason });
}

// --- users ---------------------------------------------------------------

export interface UserAccount {
  readonly id: string;
  readonly email: string;
  readonly active: boolean;
  readonly hasPassword: boolean;
  readonly lastLoginAt: string | null;
  readonly ownerName: string | null;
  readonly roles: readonly string[];
  readonly flats: readonly string[];
}

export async function listUsers(client: ApiClient): Promise<{ users: UserAccount[]; availableRoles: string[] }> {
  return client.get('/api/users');
}

export function addUser(
  client: ApiClient,
  input: { email: string; roles: readonly string[]; password?: string },
): Promise<{ id: string; email: string; roles: string[]; passwordSet: boolean }> {
  return client.post('/api/users', input);
}

export function setRoles(client: ApiClient, id: string, roles: readonly string[]): Promise<{ id: string; roles: string[] }> {
  return client.post(`/api/users/${encodeURIComponent(id)}/roles`, { roles });
}

export function deactivateUser(
  client: ApiClient, id: string, reason: string,
): Promise<{ id: string; active: false; sessionsRevoked: number }> {
  return client.post(`/api/users/${encodeURIComponent(id)}/deactivate`, { reason });
}

// --- flats and owners ----------------------------------------------------

export interface FlatRow {
  readonly id: string;
  readonly flatNo: string;
  readonly wing: string | null;
  readonly floor: number | null;
  readonly billingAreaSqFt: number | null;
  readonly areaBasis: AreaBasis | null;
  readonly nonOccupied: boolean;
  readonly owner: string | null;
  readonly billable: boolean;
}

export async function listFlats(client: ApiClient): Promise<FlatRow[]> {
  const body = await client.get<{ flats: FlatRow[] }>('/api/flats');
  return body.flats;
}

export interface NewFlat {
  readonly flatNo: string;
  readonly wing?: string;
  readonly floor?: number;
  readonly billingAreaSqFt?: number;
  readonly areaBasis?: AreaBasis;
  readonly nonOccupied?: boolean;
}

export function addFlat(client: ApiClient, flat: NewFlat): Promise<{ id: string; flatNo: string; billable: boolean }> {
  return client.post('/api/flats', flat);
}

export interface OwnerChange {
  readonly fullName: string;
  readonly email: string;
  readonly phone?: string;
  readonly role: 'owner' | 'co-owner' | 'tenant';
  readonly heldFrom: string;
  readonly replaceCurrent: boolean;
}

export function setOwner(
  client: ApiClient, flatId: string, change: OwnerChange,
): Promise<{ ownerId: string; flatNo: string; note: string }> {
  return client.post(`/api/flats/${encodeURIComponent(flatId)}/owner`, change);
}

// --- helpdesk ------------------------------------------------------------

export type Ticket = TicketResponse;

export async function listTickets(client: ApiClient): Promise<Ticket[]> {
  const body = await client.get<{ tickets: Ticket[] }>('/api/tickets');
  return body.tickets;
}

export function assignTicket(
  client: ApiClient, id: string,
  to: { userId: string } | { vendorId: string },
  note?: string,
): Promise<{ id: string; state: 'assigned' }> {
  return client.post(`/api/tickets/${encodeURIComponent(id)}/assign`, note === undefined ? to : { ...to, note });
}

export function resolveTicket(
  client: ApiClient, id: string, resolution: string, costPaise?: number,
): Promise<{ id: string; state: 'resolved'; note: string }> {
  return client.post(
    `/api/tickets/${encodeURIComponent(id)}/resolve`,
    costPaise === undefined ? { resolution } : { resolution, costPaise },
  );
}

export interface VendorOption {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly active: boolean;
}

export async function listVendors(client: ApiClient): Promise<VendorOption[]> {
  const body = await client.get<{ vendors: VendorOption[] }>('/api/vendors');
  return body.vendors;
}

// --- going live: the member list from a CSV ------------------------------

/** The import's columns, in the order the template writes them. */
export const FLAT_IMPORT_COLUMNS = [
  'flat_no', 'tower', 'floor', 'area_sqft', 'area_basis',
  'owner_name', 'owner_email', 'owner_mobile',
  'co_owner_name', 'co_owner_email', 'owner_pan',
] as const;

export interface FlatImportReport {
  readonly dryRun: boolean;
  readonly committed: boolean;
  readonly rows: number;
  readonly columns: readonly string[];
  readonly ignoredColumns: readonly string[];
  /** Null while no rate is approved: rows without a basis stay pending verification. */
  readonly defaultAreaBasis: AreaBasis | null;
  readonly flats: { readonly new: number; readonly updated: number; readonly unchanged: number };
  readonly accounts: { readonly created: number; readonly linked: number };
  readonly errors: ReadonlyArray<{ line: number; flatNo?: string; message: string }>;
  readonly changes: ReadonlyArray<{ line: number; flatNo: string; action: 'new' | 'updated' | 'unchanged'; what: readonly string[] }>;
}

export function importFlats(
  client: ApiClient, csv: string, dryRun: boolean, filename?: string,
): Promise<FlatImportReport> {
  return client.post('/api/flats/import', filename === undefined ? { csv, dryRun } : { csv, dryRun, filename });
}

// --- going live: opening balances -----------------------------------------

export interface OpeningAccountLine {
  readonly accountCode: string;
  readonly debitPaise: number;
  readonly creditPaise: number;
  readonly vendorId?: string | null;
  readonly reference?: string | null;
  readonly expenseAccount?: string | null;
  readonly memo?: string | null;
}

export interface OpeningFlatLine {
  readonly flatNo: string;
  readonly duePaise: number;
  readonly advancePaise: number;
  readonly dueSince?: string | null;
}

export interface OpeningPlan {
  readonly asAt: string;
  readonly autoBalance: boolean;
  readonly flats: ReadonlyArray<OpeningFlatLine & { flatId: string }>;
  readonly accounts: ReadonlyArray<OpeningAccountLine & { accountName: string; vendorName?: string; isBalancing: boolean }>;
  readonly totals: {
    readonly duePaise: number; readonly advancePaise: number;
    readonly debitPaise: number; readonly creditPaise: number; readonly differencePaise: number;
  };
  readonly errors: ReadonlyArray<{ part: 'flats' | 'accounts' | 'batch'; line?: number; message: string }>;
  readonly blockers: readonly string[];
}

export interface OpeningBatch {
  readonly id: string;
  readonly batchNo: number;
  readonly asAt: string;
  readonly state: 'draft' | 'posted' | 'reversed' | 'discarded';
  readonly autoBalance: boolean;
  readonly note: string | null;
  readonly preparedBy: string;
  readonly preparedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly postedEntryId: string | null;
  readonly reversedBy: string | null;
  readonly reversedAt: string | null;
  readonly reversalReason: string | null;
}

export interface OpeningView {
  readonly current: (OpeningBatch & { plan: OpeningPlan }) | null;
  readonly history: readonly OpeningBatch[];
  readonly accounts: ReadonlyArray<{ code: string; name: string; class: string; control: string | null }>;
  readonly expenseAccounts: ReadonlyArray<{ code: string; name: string }>;
  readonly balancingAccount: string;
  readonly canPrepare: boolean;
  readonly canApprove: boolean;
  readonly you: string;
}

export function readOpening(client: ApiClient): Promise<OpeningView> {
  return client.get('/api/opening-balances');
}

export interface OpeningDraftInput {
  readonly asAt: string;
  readonly autoBalance: boolean;
  readonly dryRun: boolean;
  readonly note?: string;
  readonly flatsCsv?: string;
  readonly flatLines?: readonly OpeningFlatLine[];
  readonly accountLines: readonly OpeningAccountLine[];
}

export function saveOpeningDraft(
  client: ApiClient, input: OpeningDraftInput,
): Promise<{ dryRun: boolean; saved: boolean; batchId: string | null; plan: OpeningPlan }> {
  return client.post('/api/opening-balances/draft', input);
}

export function approveOpening(
  client: ApiClient, id: string,
): Promise<{ entryId: string; documents: number; vendorBills: number; totalPaise: number }> {
  return client.post(`/api/opening-balances/${encodeURIComponent(id)}/approve`, {});
}

export function discardOpening(client: ApiClient, id: string): Promise<{ id: string; state: 'discarded' }> {
  return client.post(`/api/opening-balances/${encodeURIComponent(id)}/discard`, {});
}

export function reverseOpening(
  client: ApiClient, id: string, reason: string,
): Promise<{ reversalEntryId: string; note: string }> {
  return client.post(`/api/opening-balances/${encodeURIComponent(id)}/reverse`, { reason });
}

export function applyAdvances(
  client: ApiClient, on: string,
): Promise<{ flats: number; appliedPaise: number }> {
  return client.post('/api/advances/apply', { on });
}

// --- the society's profile -------------------------------------------------

export interface SocietyProfile {
  readonly name: string;
  readonly mode: 'demo' | 'production';
  readonly registrationNo: string | null;
  readonly gstin: string | null;
  readonly stateCode: string | null;
  readonly tan: string | null;
  readonly address: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly canEdit: boolean;
}

export type SocietyProfileInput = Omit<SocietyProfile, 'mode' | 'canEdit'>;

export function readSociety(client: ApiClient): Promise<SocietyProfile> {
  return client.get('/api/society');
}

export function saveSociety(
  client: ApiClient, profile: SocietyProfileInput,
): Promise<SocietyProfile & { changed: string[]; note: string }> {
  // Null is "not recorded"; the server reads an empty string the same way.
  const body = Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, v ?? '']));
  return client.put('/api/society', body);
}
