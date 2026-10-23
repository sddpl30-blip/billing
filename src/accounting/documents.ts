/**
 * The billing document register: proforma invoices, approval, dispatch and
 * conversion to tax invoices.
 *
 * A proforma invoice is a demand for payment, not a tax document, so issuing
 * one posts nothing. The receivable and the GST arise when it becomes a tax
 * invoice — on receipt of payment, or on its due date if it is still unpaid.
 * That ordering is why the register exists rather than the screens simply
 * appending to an array: a document's state and the ledger have to move
 * together or an invoice says one thing and the books another.
 *
 * Nothing here sends anything. There is no email or messaging provider in this
 * application, so `dispatch` records that a document was released for dispatch
 * and that no channel was configured; it never records a delivery.
 */

import { Paise, formatRupees, sum } from './money';
import { Ledger, JournalEntry } from './journal';
import { AccountingConfig } from './config';
import { Clock, addDays, periodToIso, requireIsoDate } from './clock';
import { BillLine, MaintenanceBill, billMaintenance, receiveFromMember } from './transactions';
import { DerivedStatus, deriveStatus } from './allocation';
import { A } from './accounts';

export class DocumentError extends Error {}

export type DocumentState =
  | 'draft'
  | 'approved'
  | 'released'
  | 'tax-invoice'
  | 'cancelled';

export interface DispatchAttempt {
  readonly at: string;
  readonly by: string;
  /** What it would have gone out over. 'none-configured' is the honest value here. */
  readonly channel: string;
  /**
   * Whether anything actually left the building. Always false while no provider
   * is wired in; a register that recorded "sent" would be a lie a committee
   * could act on.
   */
  readonly delivered: boolean;
  readonly note: string;
}

export interface BillingDocument {
  /** The proforma number. Stays the document's identity after conversion. */
  readonly proformaNo: string;
  /** Assigned only on conversion, from the tax-invoice series. */
  readonly taxInvoiceNo?: string;
  readonly flatNo: string;
  readonly period: string;
  readonly lines: readonly BillLine[];
  /** Tax as computed at issue, for the member to see before conversion. */
  readonly estimatedTax: Paise;
  readonly gross: Paise;
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly state: DocumentState;
  readonly approvedBy?: string;
  readonly approvedOn?: string;
  readonly dispatch?: readonly DispatchAttempt[];
  readonly convertedOn?: string;
  readonly convertedBecause?: 'payment-received' | 'due-date-reached' | 'manual';
  /** The journal entry the conversion posted. */
  readonly postedEntryId?: string;
  readonly cancelledBy?: string;
  readonly cancelledReason?: string;
}

export interface RegisterView extends BillingDocument {
  /** Still owed on this document, read from the ledger. Zero before conversion. */
  readonly outstanding: Paise;
  /** Derived, never stored. */
  readonly status: DerivedStatus;
}

/**
 * Holds the documents and keeps them in step with a ledger.
 *
 * The register owns the numbering series, the duplicate check and the state
 * machine; the ledger owns the money. Every method that moves money goes
 * through a transaction in `transactions.ts`, so the register cannot post
 * anything the engine would refuse.
 */
export class BillingRegister {
  private readonly docs = new Map<string, BillingDocument>();
  /** flatNo + period, for the duplicate check. */
  private readonly byFlatPeriod = new Map<string, string>();
  private taxInvoiceSequence = 0;

  constructor(
    private readonly ledger: Ledger,
    private readonly config: AccountingConfig,
    private readonly clock: Clock,
  ) {}

  private key(flatNo: string, period: string): string {
    return `${flatNo}::${period}`;
  }

  private mustGet(proformaNo: string): BillingDocument {
    const doc = this.docs.get(proformaNo);
    if (!doc) throw new DocumentError(`No document numbered ${proformaNo}`);
    return doc;
  }

  /**
   * Raises a proforma invoice. Posts nothing.
   *
   * Refuses a second document for the same flat and period. The demo's billing
   * wizard carried a comment claiming it avoided duplicates with no code
   * behind it, so re-running a run produced a second set of invoices with the
   * same numbers.
   */
  issueProforma(input: {
    flatNo: string;
    period: string;
    lines: readonly BillLine[];
    issuedOn?: string;
    dueOn?: string;
    proformaNo?: string;
  }): BillingDocument {
    const existingNo = this.byFlatPeriod.get(this.key(input.flatNo, input.period));
    if (existingNo !== undefined) {
      const existing = this.mustGet(existingNo);
      if (existing.state !== 'cancelled') {
        throw new DocumentError(
          `Flat ${input.flatNo} already has ${existingNo} for ${input.period} ` +
          `(${existing.state}). Cancel it before raising another.`,
        );
      }
    }

    if (input.lines.length === 0) {
      throw new DocumentError(`A document for ${input.flatNo} ${input.period} has no lines`);
    }

    const periodStart = periodToIso(input.period);
    if (periodStart === null) {
      throw new DocumentError(
        `"${input.period}" is not a month and year, so no billing date can be derived from it.`,
      );
    }
    const issuedOn = requireIsoDate(input.issuedOn ?? periodStart, 'issue date');
    const dueOn = requireIsoDate(
      input.dueOn ?? addDays(issuedOn, this.config.billing.dueAfterDays),
      'due date',
    );
    if (dueOn < issuedOn) {
      throw new DocumentError(`Due date ${dueOn} is before the issue date ${issuedOn}.`);
    }

    const net = sum(input.lines.map(l => l.amount));
    const taxable = this.config.gstOnMaintenance
      ? sum(input.lines.filter(l => l.taxable).map(l => l.amount))
      : 0;
    const estimatedTax = taxable === 0
      ? 0
      : Math.round((taxable * Math.round(this.config.gst.rate * 10000)) / 1000000);

    const proformaNo = input.proformaNo ?? this.nextProformaNo(input.flatNo, input.period);
    if (this.docs.has(proformaNo)) {
      throw new DocumentError(`Document number ${proformaNo} is already in use.`);
    }

    const doc: BillingDocument = {
      proformaNo,
      flatNo: input.flatNo,
      period: input.period,
      lines: input.lines.map(l => ({ ...l })),
      estimatedTax,
      gross: net + estimatedTax,
      issuedOn,
      dueOn,
      state: 'draft',
    };
    this.docs.set(proformaNo, doc);
    this.byFlatPeriod.set(this.key(input.flatNo, input.period), proformaNo);
    return doc;
  }

  private nextProformaNo(flatNo: string, period: string): string {
    const iso = periodToIso(period) ?? this.clock.today();
    return `PI-${iso.slice(0, 7)}-${flatNo.replace(/[^A-Za-z0-9]/g, '')}`;
  }

  /**
   * Treasurer approval. A document cannot be released or converted without it.
   */
  approve(proformaNo: string, by: string, on?: string): BillingDocument {
    const doc = this.mustGet(proformaNo);
    if (doc.state === 'cancelled') {
      throw new DocumentError(`${proformaNo} is cancelled and cannot be approved.`);
    }
    if (doc.state !== 'draft') {
      throw new DocumentError(`${proformaNo} is already ${doc.state}.`);
    }
    if (by.trim() === '') {
      throw new DocumentError('An approval must name who gave it.');
    }
    const updated: BillingDocument = {
      ...doc,
      state: 'approved',
      approvedBy: by,
      approvedOn: requireIsoDate(on ?? this.clock.today(), 'approval date'),
    };
    this.docs.set(proformaNo, updated);
    return updated;
  }

  /** Approves a whole batch, which is what a monthly run needs. */
  approveBatch(proformaNos: readonly string[], by: string, on?: string): {
    approved: readonly string[];
    refused: ReadonlyArray<{ proformaNo: string; why: string }>;
  } {
    const approved: string[] = [];
    const refused: Array<{ proformaNo: string; why: string }> = [];
    for (const no of proformaNos) {
      try {
        this.approve(no, by, on);
        approved.push(no);
      } catch (err) {
        refused.push({ proformaNo: no, why: err instanceof Error ? err.message : String(err) });
      }
    }
    return { approved, refused };
  }

  /**
   * Releases an approved document for dispatch.
   *
   * Records that it was released and that no delivery channel is configured.
   * It does not record a delivery, because none happens.
   */
  release(proformaNo: string, by: string): BillingDocument {
    const doc = this.mustGet(proformaNo);
    if (doc.state !== 'approved') {
      throw new DocumentError(
        `${proformaNo} is ${doc.state}; only an approved document can be released.`,
      );
    }
    const attempt: DispatchAttempt = {
      at: this.clock.now(),
      by,
      channel: 'none-configured',
      delivered: false,
      note:
        'Released for dispatch. No email or messaging provider is configured in this ' +
        'application, so nothing was sent to the member. Delivery needs a transactional ' +
        'email service and a server to hold its credentials.',
    };
    const updated: BillingDocument = {
      ...doc,
      state: 'released',
      dispatch: [...(doc.dispatch ?? []), attempt],
    };
    this.docs.set(proformaNo, updated);
    return updated;
  }

  /**
   * Converts a proforma into a tax invoice and posts it.
   *
   * This is the point the receivable and the GST liability arise. Requires
   * approval, and refuses to convert twice.
   */
  convertToTaxInvoice(
    proformaNo: string,
    opts: { on?: string; because: BillingDocument['convertedBecause']; by: string },
  ): { document: BillingDocument; entry: JournalEntry } {
    const doc = this.mustGet(proformaNo);
    if (doc.state === 'tax-invoice') {
      throw new DocumentError(`${proformaNo} is already tax invoice ${doc.taxInvoiceNo}.`);
    }
    if (doc.state === 'cancelled') {
      throw new DocumentError(`${proformaNo} is cancelled and cannot be converted.`);
    }
    if (doc.state === 'draft') {
      throw new DocumentError(
        `${proformaNo} has not been approved. A tax invoice cannot be issued from an ` +
        `unapproved proforma.`,
      );
    }

    const on = requireIsoDate(opts.on ?? this.clock.today(), 'conversion date');
    if (on < doc.issuedOn) {
      throw new DocumentError(
        `Cannot date tax invoice ${on}, before the proforma's issue date ${doc.issuedOn}.`,
      );
    }

    this.taxInvoiceSequence += 1;
    const fyLabel = on.slice(0, 4);
    const taxInvoiceNo =
      `${this.config.billing.taxInvoicePrefix}/${fyLabel}/` +
      `${this.taxInvoiceSequence.toString().padStart(5, '0')}`;

    const bill: MaintenanceBill = {
      flatNo: doc.flatNo,
      period: doc.period,
      date: on,
      invoiceNo: taxInvoiceNo,
      lines: doc.lines,
    };
    const posted = billMaintenance(this.ledger, bill, this.config, { postedBy: opts.by });

    const updated: BillingDocument = {
      ...doc,
      state: 'tax-invoice',
      taxInvoiceNo,
      convertedOn: on,
      convertedBecause: opts.because,
      postedEntryId: posted.entry.id,
      gross: posted.gross,
    };
    this.docs.set(proformaNo, updated);
    return { document: updated, entry: posted.entry };
  }

  /**
   * Converts everything released and still unconverted whose due date has
   * passed. The scheduled job's body.
   */
  convertDue(asOf: string, by: string): {
    converted: ReadonlyArray<{ proformaNo: string; taxInvoiceNo: string }>;
    refused: ReadonlyArray<{ proformaNo: string; why: string }>;
  } {
    requireIsoDate(asOf, 'as-of date');
    const converted: Array<{ proformaNo: string; taxInvoiceNo: string }> = [];
    const refused: Array<{ proformaNo: string; why: string }> = [];

    for (const doc of [...this.docs.values()].sort((a, b) => a.proformaNo.localeCompare(b.proformaNo))) {
      if (doc.state !== 'released' && doc.state !== 'approved') continue;
      if (doc.dueOn > asOf) continue;
      try {
        const result = this.convertToTaxInvoice(doc.proformaNo, {
          on: asOf, because: 'due-date-reached', by,
        });
        converted.push({
          proformaNo: doc.proformaNo,
          taxInvoiceNo: result.document.taxInvoiceNo as string,
        });
      } catch (err) {
        refused.push({
          proformaNo: doc.proformaNo,
          why: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { converted, refused };
  }

  /**
   * Records a member's payment against a document.
   *
   * A payment on a proforma converts it first — the supply has been paid for,
   * so the tax invoice is due — and then allocates. Conversion and allocation
   * are one call so they cannot half-happen.
   */
  recordPayment(input: {
    proformaNo: string;
    amount: Paise;
    receiptNo: string;
    method: string;
    on?: string;
    by: string;
    bankAccount?: string;
  }): {
    document: BillingDocument;
    conversion?: JournalEntry;
    receipt: JournalEntry;
    appliedToDues: Paise;
    heldAsAdvance: Paise;
    outstandingAfter: Paise;
  } {
    const doc = this.mustGet(input.proformaNo);
    if (doc.state === 'cancelled') {
      throw new DocumentError(`${input.proformaNo} is cancelled; a payment cannot be applied to it.`);
    }
    const on = requireIsoDate(input.on ?? this.clock.today(), 'payment date');

    let conversion: JournalEntry | undefined;
    let current = doc;
    if (doc.state !== 'tax-invoice') {
      const result = this.convertToTaxInvoice(input.proformaNo, {
        on, because: 'payment-received', by: input.by,
      });
      conversion = result.entry;
      current = result.document;
    }

    const receipt = receiveFromMember(this.ledger, {
      flatNo: current.flatNo,
      date: on,
      amount: input.amount,
      receiptNo: input.receiptNo,
      method: input.method,
      bankAccount: input.bankAccount,
      against: current.taxInvoiceNo,
    }, { postedBy: input.by });

    return {
      document: current,
      conversion,
      receipt: receipt.entry,
      appliedToDues: receipt.appliedToDues,
      heldAsAdvance: receipt.heldAsAdvance,
      outstandingAfter: this.outstandingOf(current),
    };
  }

  /**
   * Cancels a document.
   *
   * Before conversion this is a register change only. After conversion the
   * posting is reversed, because a tax invoice that has hit the books cannot be
   * withdrawn by deleting a row.
   */
  cancel(proformaNo: string, by: string, reason: string, on?: string): {
    document: BillingDocument;
    reversal?: JournalEntry;
  } {
    const doc = this.mustGet(proformaNo);
    if (doc.state === 'cancelled') {
      throw new DocumentError(`${proformaNo} is already cancelled.`);
    }
    if (reason.trim() === '') {
      throw new DocumentError('A cancellation must record a reason.');
    }
    const date = requireIsoDate(on ?? this.clock.today(), 'cancellation date');

    let reversal: JournalEntry | undefined;
    if (doc.state === 'tax-invoice') {
      const received = this.receivedAgainst(doc);
      if (received > 0) {
        throw new DocumentError(
          `${proformaNo} has ${formatRupees(received)} received against it. Refund or ` +
          `reallocate that first; cancelling would leave the receipt unapplied.`,
        );
      }
      if (doc.postedEntryId === undefined) {
        throw new DocumentError(`${proformaNo} is a tax invoice but records no journal entry.`);
      }
      reversal = this.ledger.reverse(doc.postedEntryId, { date, postedBy: by, reason });
    }

    const updated: BillingDocument = {
      ...doc, state: 'cancelled', cancelledBy: by, cancelledReason: reason,
    };
    this.docs.set(proformaNo, updated);
    return { document: updated, reversal };
  }

  /** What is still owed on a document. Zero until it is a tax invoice. */
  outstandingOf(doc: BillingDocument, asAt?: string): Paise {
    if (doc.taxInvoiceNo === undefined) return 0;
    return this.ledger.balanceOf(A.MAINTENANCE_RECEIVABLE, {
      party: doc.flatNo, docRef: doc.taxInvoiceNo, to: asAt,
    });
  }

  /** What has been received against a document. */
  receivedAgainst(doc: BillingDocument, asAt?: string): Paise {
    if (doc.taxInvoiceNo === undefined) return 0;
    const rows = this.ledger.generalLedger(A.MAINTENANCE_RECEIVABLE, {
      party: doc.flatNo, docRef: doc.taxInvoiceNo, to: asAt,
    });
    return sum(rows.map(r => r.posting.credit));
  }

  get(proformaNo: string): RegisterView | undefined {
    const doc = this.docs.get(proformaNo);
    return doc === undefined ? undefined : this.view(doc);
  }

  private view(doc: BillingDocument, asAt?: string): RegisterView {
    const outstanding = this.outstandingOf(doc, asAt);
    return {
      ...doc,
      outstanding,
      status: doc.state === 'cancelled'
        ? 'Cancelled'
        : doc.state !== 'tax-invoice'
          // A proforma raises nothing, so its "status" is its demand state.
          ? (doc.dueOn < (asAt ?? this.clock.today()) ? 'Overdue' : 'Pending')
          : deriveStatus({
              docRef: doc.taxInvoiceNo as string,
              gross: doc.gross,
              outstanding,
              dueOn: doc.dueOn,
            }, asAt ?? this.clock.today()),
    };
  }

  all(asAt?: string): readonly RegisterView[] {
    return [...this.docs.values()]
      .sort((a, b) => a.proformaNo.localeCompare(b.proformaNo))
      .map(d => this.view(d, asAt));
  }

  forFlat(flatNo: string, asAt?: string): readonly RegisterView[] {
    return this.all(asAt).filter(d => d.flatNo === flatNo);
  }

  /** The documents as stored, for serialising. Not a view: no derived fields. */
  rawDocuments(): readonly BillingDocument[] {
    return [...this.docs.values()].sort((a, b) => a.proformaNo.localeCompare(b.proformaNo));
  }

  /** The tax-invoice counter, so a restored register continues the series. */
  taxInvoiceSequenceValue(): number {
    return this.taxInvoiceSequence;
  }

  /**
   * Repopulates the register from a snapshot.
   *
   * Refuses to load into a register that already holds documents: merging two
   * sets silently is how a flat ends up with two live documents for one
   * period, which is the duplicate this whole mechanism exists to prevent.
   */
  restoreDocuments(documents: readonly BillingDocument[], taxInvoiceSequence: number): void {
    if (this.docs.size > 0) {
      throw new DocumentError(
        `Cannot restore into a register that already holds ${this.docs.size} documents.`,
      );
    }
    for (const doc of documents) {
      if (this.docs.has(doc.proformaNo)) {
        throw new DocumentError(`Snapshot has two documents numbered ${doc.proformaNo}.`);
      }
      const key = this.key(doc.flatNo, doc.period);
      const existing = this.byFlatPeriod.get(key);
      if (existing !== undefined && this.mustGet(existing).state !== 'cancelled' && doc.state !== 'cancelled') {
        throw new DocumentError(
          `Snapshot has two live documents for flat ${doc.flatNo} in ${doc.period} ` +
          `(${existing} and ${doc.proformaNo}).`,
        );
      }
      this.docs.set(doc.proformaNo, { ...doc, lines: doc.lines.map(l => ({ ...l })) });
      // A cancelled document must not claim the flat-and-period slot from a
      // live one, so only overwrite when the incoming document is live.
      if (existing === undefined || doc.state !== 'cancelled') {
        this.byFlatPeriod.set(key, doc.proformaNo);
      }
    }
    this.taxInvoiceSequence = Math.max(taxInvoiceSequence, 0);
  }

  /** True when this flat already has a live document for the period. */
  hasDocumentFor(flatNo: string, period: string): boolean {
    const no = this.byFlatPeriod.get(this.key(flatNo, period));
    if (no === undefined) return false;
    return this.mustGet(no).state !== 'cancelled';
  }
}
