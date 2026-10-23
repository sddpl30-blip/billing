/**
 * Server data, in the shapes the existing screens take.
 *
 * The screens were written around `Resident`, `Invoice`, `Vendor`,
 * `VendorInvoice` and `ComplaintTicket` from types.ts, and those were filled
 * from the demo arrays in data.ts. This maps the server's snapshot onto the
 * same shapes, so the whole UI runs on database records without being
 * rewritten screen by screen.
 *
 * Every figure here is derived, not invented. Where the server has no answer —
 * a flat with no owner on record, a charge the legacy shape has no column for
 * — the field is empty or the amount lands in `maintenance`, and nothing is
 * filled in with a plausible-looking number.
 */

import type { Invoice, Resident, Vendor, VendorInvoice, ComplaintTicket } from '../types';
import type { SnapshotResponse, TicketResponse } from './client';
import type { RegisterView } from '../accounting';

const toRupees = (paise: number): number => Math.round(paise) / 100;

/** 'A'–'D' from a flat number, because the legacy Resident type insists. */
function wingOf(flatNo: string): Resident['wing'] {
  const first = flatNo.trim().charAt(0).toUpperCase();
  return first === 'B' || first === 'C' || first === 'D' ? first : 'A';
}

export function residentsFrom(snapshot: SnapshotResponse): Resident[] {
  return snapshot.flats.map(flat => ({
    id: flat.id,
    name: flat.name,
    flatNo: flat.flatNo,
    wing: wingOf(flat.flatNo),
    // No contact number is exposed by the API: it is not needed to render any
    // of these screens, and a member's phone number is not something to ship
    // to every browser that asks for a flat list.
    contact: '',
    ...(flat.billingAreaSqFt === undefined ? {} : { billingAreaSqFt: flat.billingAreaSqFt }),
    ...(flat.areaBasis === undefined ? {} : { areaBasis: flat.areaBasis }),
    ...(flat.nonOccupied === undefined ? {} : { nonOccupied: flat.nonOccupied }),
  }));
}

/**
 * Documents as the legacy `Invoice` shape.
 *
 * Taken from the rehydrated register rather than from the snapshot JSON, so
 * `status` and `outstanding` are the engine's derived values — the same ones
 * every other screen reads — instead of a second opinion computed here.
 */
export function invoicesFrom(
  documents: readonly RegisterView[],
  flatNames: ReadonlyMap<string, string>,
): Invoice[] {
  return documents.map(document => {
    const amountFor = (head: string): number =>
      toRupees(document.lines
        .filter(line => line.head === head)
        .reduce((sum, line) => sum + line.amount, 0));

    const tax = toRupees(
      document.state === 'tax-invoice'
        ? document.gross - document.lines.reduce((sum, line) => sum + line.amount, 0)
        : document.estimatedTax,
    );

    return {
      id: document.proformaNo,
      invoiceNo: document.taxInvoiceNo ?? document.proformaNo,
      flatNo: document.flatNo,
      name: flatNames.get(document.flatNo) ?? document.flatNo,
      period: document.period,
      maintenance: amountFor('maintenance'),
      sinkingFund: amountFor('sinking'),
      // The legacy shape has columns the register does not: there is no water
      // or parking head in the six the books keep. They stay zero rather than
      // having part of the maintenance charge split into them arbitrarily.
      waterCharges: 0,
      parkingCharges: 0,
      nonOccupancyCharges: 0,
      latePenalty: 0,
      gst: tax,
      total: toRupees(document.gross),
      status: legacyStatus(document.status),
      dueDate: document.dueOn,
      ...(document.status === 'Paid' && document.convertedOn !== undefined
        ? { paidDate: document.convertedOn }
        : {}),
    };
  });
}

/** The engine's derived status, in the three the legacy screens know. */
function legacyStatus(status: RegisterView['status']): Invoice['status'] {
  if (status === 'Paid') return 'Paid';
  if (status === 'Overdue') return 'Overdue';
  // 'Partly paid', 'Pending', 'Not raised' and 'Cancelled' all read as
  // Pending in the old three-state field. The register keeps the real one and
  // the billing screens show it; this is only for the legacy list.
  return 'Pending';
}

export function vendorsFrom(snapshot: SnapshotResponse): Vendor[] {
  const byVendor = new Map<string, Vendor>();
  for (const bill of snapshot.vendorBills) {
    const existing = byVendor.get(bill.vendorId);
    const outstanding = bill.state === 'booked' ? bill.grossRupees : 0;
    if (existing === undefined) {
      byVendor.set(bill.vendorId, {
        id: bill.vendorId,
        name: bill.vendorName,
        category: bill.category,
        balance: outstanding,
        // No contract end date is in the snapshot, and inventing one would put
        // a renewal date on screen that nobody agreed.
        contractRenewal: '',
      });
    } else {
      byVendor.set(bill.vendorId, { ...existing, balance: existing.balance + outstanding });
    }
  }
  return [...byVendor.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function vendorInvoicesFrom(snapshot: SnapshotResponse): VendorInvoice[] {
  return snapshot.vendorBills.map(bill => {
    const tdsAmount = Math.round(bill.grossRupees * bill.tdsRate) / 100;
    return {
      id: bill.id,
      vendorId: bill.vendorId,
      vendorName: bill.vendorName,
      category: bill.category,
      amount: bill.grossRupees,
      tdsRate: bill.tdsRate,
      tdsAmount,
      netPayable: bill.grossRupees - tdsAmount,
      // The legacy field has three states for four. 'booked' and 'approved'
      // both read as Approved; the vendor screens show the real state from the
      // store's own vendorBills list.
      status: bill.state === 'rejected'
        ? 'Rejected'
        : bill.state === 'awaiting-approval' ? 'Pending' : 'Approved',
      date: bill.date,
    };
  });
}

const CATEGORY: Record<string, ComplaintTicket['category']> = {
  plumbing: 'Plumbing',
  lift: 'Lift',
  security: 'Security',
  billing: 'Billing Query',
  electrical: 'Other',
  housekeeping: 'Other',
};

export function ticketsFrom(tickets: readonly TicketResponse[]): ComplaintTicket[] {
  return tickets.map(ticket => ({
    id: ticket.id,
    flatNo: ticket.flatNo ?? '',
    // The raiser's name is not in the ticket list and is not needed to render
    // it; the flat is what identifies it on screen.
    name: ticket.flatNo ?? '',
    category: CATEGORY[ticket.category] ?? 'Other',
    description: ticket.description,
    status: ticket.state === 'resolved' || ticket.state === 'confirmed' || ticket.state === 'closed'
      ? 'Resolved'
      : 'Open',
    date: ticket.raisedAt.slice(0, 10),
  }));
}

/** The ticket categories the API accepts, from the labels the screens show. */
export function apiCategoryFor(category: ComplaintTicket['category']): string {
  switch (category) {
    case 'Plumbing': return 'plumbing';
    case 'Lift': return 'lift';
    case 'Security': return 'security';
    case 'Billing Query': return 'billing';
    default: return 'housekeeping';
  }
}
