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
