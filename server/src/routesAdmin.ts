/**
 * The rest of the API: the snapshot the screens read, documents as PDFs,
 * credit and debit notes, the notification queue, and administration of
 * users, flats and owners.
 *
 * Kept apart from routes.ts so neither file becomes the place everything is
 * added to. Same rules in both: the permission is named on every route, flat
 * access comes from the principal, and nothing reports an effect it did not
 * have.
 */

import type { PgPool } from './pg';
import type { Config } from './config';
import type { Logger } from './logger';
import type { EmailProvider } from './providers/email';
import {
  badRequest, conflict, notFound, route,
  type RequestContext, type Reply, type RouteDefinition,
} from './http';
import { v } from './validate';
import { hashPassword } from './security';
import {
  ALL_ROLES, hasPermission, isValidRole, permissionsOf, requireFlatAccess, requirePermission,
  type Permission, type Principal, type Role,
} from './rbac';
import { audit } from './audit';
import { buildSnapshot } from './snapshotView';
import { generateDocument } from './documents';
import { A, accountBalance, postEntry, type Leg } from './posting';
import { allocateNumber, lockFlatBalance } from './series';
import { gstTreatment } from './settings';
import { insertFlat, recordHolder, upsertOwner } from './members';
import { formatRupees } from '../../src/accounting/money';
import { gstHalf } from '../../src/accounting/transactions';
import { isoDateInIndia } from '../../src/accounting/clock';

export interface AdminRouteDependencies {
  readonly pool: PgPool;
  readonly config: Config;
  readonly log: Logger;
  readonly email: EmailProvider;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const created = (body: unknown): Reply => ({ status: 201, body });
const today = (): string => isoDateInIndia(); // India's date, not UTC's: see clock.ts

function who(ctx: RequestContext): Principal {
  if (ctx.principal === null) {
    throw new Error(`route ${ctx.path} read the principal but is not marked authenticated`);
  }
  return ctx.principal;
}

function need(ctx: RequestContext, permission: Permission): Principal {
  const principal = who(ctx);
  requirePermission(principal, permission);
  return principal;
}

/**
 * Role sets that would make one account both maker and checker.
 *
 * Checked wherever roles are handed out — creating an account as well as
 * changing one — since a rule enforced on one of two doors is not enforced.
 */
function refuseCombinedRoles(roles: readonly Role[]): void {
  if (roles.includes('manager') && (roles.includes('treasurer') || roles.includes('secretary'))) {
    throw badRequest(
      'An account cannot hold manager together with treasurer or secretary: that one ' +
      'account could then raise a bill and approve it. Use two accounts.',
    );
  }
  if (roles.includes('secretary') && roles.includes('treasurer')) {
    // The secretary enters rates and settings and the treasurer approves
    // them; one account holding both could sign off its own figures.
    throw badRequest(
      'An account cannot hold secretary together with treasurer: the person who sets a ' +
      'rate and the person who approves it would be the same.',
    );
  }
}

export function createAdminRoutes(deps: AdminRouteDependencies): RouteDefinition[] {
  const { pool } = deps;

  // --- the snapshot the screens read --------------------------------------

  const snapshot = route('GET', '/api/books/snapshot', async (ctx) => {
    const principal = who(ctx);
    const asAt = ctx.query.get('asAt') ?? today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asAt)) throw badRequest('asAt must be YYYY-MM-DD.');
    const view = await pool.transaction(async (tx) =>
      buildSnapshot(tx, { principal, today: asAt }));
    return ok({
      ...view,
      permissions: permissionsOf(principal),
      email: principal.email,
      roles: principal.roles,
    });
  });

  // --- documents as PDFs ---------------------------------------------------

  const invoicePdf = route('GET', '/api/billing/documents/:id/pdf', async (ctx) => {
    const principal = who(ctx);

    const result = await pool.transaction(async (tx) => {
      const owner = await tx.query<{ flat_id: string; state: string; proforma_no: string }>(
        'SELECT flat_id, state, proforma_no FROM billing_documents WHERE id = $1 AND society_id = $2',
        [ctx.params.id, principal.societyId],
      );
      const document = owner.rows[0];
      if (document === undefined) throw notFound('That document');
      // A resident may print their own invoice and nobody else's.
      requireFlatAccess(principal, document.flat_id, 'invoice.read.any');
      if (document.state === 'draft') {
        throw conflict(
          'That document has not been approved, so there is nothing to print. An unapproved ' +
          'proforma is a working figure.',
        );
      }

      // Regenerating writes a new official copy that later reprints serve, so
      // it is staff work. A resident gets the copy on file.
      const regenerate = ctx.query.get('regenerate') === 'true';
      if (regenerate && !hasPermission(principal, 'invoice.read.any')) {
        throw conflict('Only the office can regenerate a document. Ask for a fresh copy.');
      }
      const asAt = ctx.query.get('asAt') ?? today();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asAt)) throw badRequest('asAt must be YYYY-MM-DD.');

      const generated = await generateDocument(tx, {
        societyId: principal.societyId,
        kind: document.state === 'tax-invoice' ? 'tax-invoice' : 'proforma',
        documentId: ctx.params.id,
        asAt,
        reprint: !regenerate,
      });
      return { generated, proformaNo: document.proforma_no };
    });

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition':
          `inline; filename="${result.proformaNo.replace(/[^A-Za-z0-9.-]/g, '-')}.pdf"`,
        // Says which it is, so a caller can tell a reprint from a first issue
        // without opening the file.
        'X-Document-Reprinted': String(result.generated.reprinted),
      },
      body: result.generated.pdf,
    };
  });

  const receiptPdf = route('GET', '/api/payments/:id/pdf', async (ctx) => {
    const principal = who(ctx);

    const result = await pool.transaction(async (tx) => {
      const owner = await tx.query<{ flat_id: string; receipt_no: string }>(
        'SELECT flat_id, receipt_no FROM payments WHERE id = $1 AND society_id = $2',
        [ctx.params.id, principal.societyId],
      );
      const payment = owner.rows[0];
      if (payment === undefined) throw notFound('That payment');
      requireFlatAccess(principal, payment.flat_id, 'payment.read.any');

      const generated = await generateDocument(tx, {
        societyId: principal.societyId,
        kind: 'receipt',
        paymentId: ctx.params.id,
        asAt: today(),
        reprint: !(ctx.query.get('regenerate') === 'true' && hasPermission(principal, 'payment.read.any')),
      });
      return { generated, receiptNo: payment.receipt_no };
    });

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition':
          `inline; filename="${result.receiptNo.replace(/[^A-Za-z0-9.-]/g, '-')}.pdf"`,
        'X-Document-Reprinted': String(result.generated.reprinted),
      },
      body: result.generated.pdf,
    };
  });

  // --- credit and debit notes ---------------------------------------------

  const issueNote = route('POST', '/api/billing/documents/:id/notes', async (ctx) => {
    // A note changes what a member owes against an invoice already issued, so
    // it sits with the same role that may cancel one.
    const principal = need(ctx, 'billing.cancel');
    const input = ctx.body(v.object({
      kind: v.enumOf(['credit', 'debit'] as const),
      amountPaise: v.paise({ min: 1 }),
      reason: v.text({ max: 500 }),
      on: v.isoDate(),
      /** Whether the note carries tax. A waiver of a taxed charge does. */
      withTax: v.boolean(),
    }));
    if (input.reason.trim() === '') throw badRequest('A note needs a reason.');

    const result = await pool.transaction(async (tx) => {
      const found = await tx.query<{
        flat_id: string; flat_no: string; tax_invoice_no: string | null; state: string; gross: string;
        issued_on: string;
      }>(
        `SELECT d.flat_id, f.flat_no, d.tax_invoice_no, d.state, d.gross::text, d.issued_on::text
           FROM billing_documents d JOIN flats f ON f.id = d.flat_id
          WHERE d.id = $1 AND d.society_id = $2`,
        [ctx.params.id, principal.societyId],
      );
      const document = found.rows[0];
      if (document === undefined) throw notFound('That document');
      if (document.state !== 'tax-invoice' || document.tax_invoice_no === null) {
        throw conflict(
          'A note can only be raised against a tax invoice. Before conversion there is no ' +
          'receivable to adjust — change the proforma instead.',
        );
      }
      if (input.on < document.issued_on) {
        throw badRequest(`A note cannot be dated before the invoice's ${document.issued_on}.`);
      }

      // The flat's balance lock before the note series, as for a receipt: the
      // cap below is computed from the invoice's balance, and a receipt
      // landing between that read and this note's posting would spend the
      // same balance twice.
      await lockFlatBalance(tx, { societyId: principal.societyId, flatId: document.flat_id });

      const gst = await gstTreatment(tx, principal.societyId);
      if (input.withTax && gst.chargeGst && !gst.approved) {
        throw conflict(
          'The GST treatment has not been confirmed, so a note cannot carry tax. Record the ' +
          'sign-off, or raise the note without tax.',
        );
      }
      // Each half at half the rate, as on the invoice itself, so a note's
      // CGST and SGST are equal and match the "@ 9%" it prints — and rounded
      // to the rupee where the society's treatment says invoices are.
      const half = input.withTax && gst.chargeGst
        ? gstHalf(input.amountPaise, gst.ratePercent, gst.roundToRupee)
        : 0;
      const cgst = half;
      const sgst = half;
      const tax = cgst + sgst;
      const total = input.amountPaise + tax;

      // A credit note reduces what the member owes, so it credits the
      // receivable and takes the income back out. A debit note is the mirror.
      const credit = input.kind === 'credit';

      // A credit note is capped. It was not, so a credit larger than what was
      // still owed on the invoice drove that invoice's receivable below zero
      // — money the society owes the member, recorded nowhere as owed.
      //
      // Two limits. It cannot credit more than the invoice ever charged
      // (gross, plus debit notes, less earlier credit notes): that is not an
      // adjustment of this invoice. Within that, whatever exceeds what is
      // still outstanding — because the member has already paid — goes to the
      // member's advance, where the next bill or a refund can take it, which
      // is what a receipt does with an overpayment.
      let toReceivable = total;
      let toAdvance = 0;
      if (credit) {
        const adjustments = await tx.query<{ net: string }>(
          `SELECT COALESCE(SUM(CASE WHEN kind = 'debit' THEN amount + tax_amount
                                    ELSE -(amount + tax_amount) END), 0)::text AS net
             FROM invoice_adjustments WHERE document_id = $1`,
          [ctx.params.id],
        );
        const creditable = Number(document.gross) + Number(adjustments.rows[0]?.net ?? '0');
        if (total > creditable) {
          throw badRequest(
            `A credit note of ${formatRupees(total)} is more than the ${formatRupees(creditable)} ` +
            `${document.tax_invoice_no} has charged, after earlier notes. A credit beyond that ` +
            `is not an adjustment of this invoice.`,
          );
        }
        const outstanding = await accountBalance(tx, {
          societyId: principal.societyId,
          code: A.MAINTENANCE_RECEIVABLE,
          docRef: document.tax_invoice_no,
        });
        toReceivable = Math.max(0, Math.min(total, outstanding));
        toAdvance = total - toReceivable;
      }

      const legs: Leg[] = [];
      if (toReceivable > 0) {
        legs.push({
          accountCode: A.MAINTENANCE_RECEIVABLE,
          debit: credit ? 0 : toReceivable,
          credit: credit ? toReceivable : 0,
          party: document.flat_no,
          docRef: document.tax_invoice_no,
          memo: `${input.kind} note on ${document.tax_invoice_no}`,
        });
      }
      if (toAdvance > 0) {
        legs.push({
          accountCode: A.MEMBER_ADVANCE,
          debit: 0,
          credit: toAdvance,
          party: document.flat_no,
          docRef: document.tax_invoice_no,
          memo: `credit note on ${document.tax_invoice_no} beyond what was outstanding`,
        });
      }
      legs.push(
        {
          accountCode: A.INC_MAINTENANCE,
          debit: credit ? input.amountPaise : 0,
          credit: credit ? 0 : input.amountPaise,
          docRef: document.tax_invoice_no,
          memo: input.reason.slice(0, 120),
        },
      );
      if (cgst > 0) {
        legs.push({
          accountCode: A.CGST_OUTPUT, debit: credit ? cgst : 0, credit: credit ? 0 : cgst,
          docRef: document.tax_invoice_no, memo: 'CGST',
        });
        legs.push({
          accountCode: A.SGST_OUTPUT, debit: credit ? sgst : 0, credit: credit ? 0 : sgst,
          docRef: document.tax_invoice_no, memo: 'SGST',
        });
      }

      const noteNo = await allocateNumber(
        tx,
        { societyId: principal.societyId, kind: 'note', scope: input.kind },
        async () => {
          const series = await tx.query<{ next: string }>(
            `SELECT COALESCE(MAX(NULLIF(regexp_replace(note_no, '^.*/', ''), '')::int), 0) + 1 AS next
               FROM invoice_adjustments WHERE society_id = $1 AND kind = $2`,
            [principal.societyId, input.kind],
          );
          return `${credit ? 'CN' : 'DN'}/${input.on.slice(0, 4)}/` +
            `${String(series.rows[0].next).padStart(4, '0')}`;
        },
      );

      const entryId = await postEntry(tx, {
        societyId: principal.societyId,
        entryDate: input.on,
        narration:
          `${credit ? 'Credit' : 'Debit'} note ${noteNo} on ${document.tax_invoice_no} ` +
          `— flat ${document.flat_no}: ${input.reason}`,
        sourceKind: credit ? 'advance-adjustment' : 'maintenance-billing',
        sourceRef: noteNo,
        idempotencyKey: `note:${noteNo}`,
        postedBy: principal.userId,
        postedByLabel: principal.email,
        legs,
      });
      if (entryId === null) throw conflict(`Note ${noteNo} has already been posted.`);

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO invoice_adjustments
           (society_id, document_id, note_no, kind, reason, amount, tax_amount,
            issued_on, approved_by, posted_entry_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          principal.societyId, ctx.params.id, noteNo, input.kind, input.reason,
          input.amountPaise, tax, input.on, principal.userId, entryId,
        ],
      );

      if (tax > 0) {
        // The register a return is built from has to carry the adjustment, or
        // the return and the ledger disagree by exactly the note.
        // Positive figures with the kind of document recorded, which is how a
        // return reports a note: its own table, not a negative invoice. The
        // summary nets them.
        await tx.query(
          `INSERT INTO gst_register
             (society_id, adjustment_id, entry_kind, tax_period, invoice_no, invoice_date,
              counterparty, supply_type, taxable_value, cgst, sgst, rate_bps)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'B2C',$8,$9,$10,$11)`,
          [
            principal.societyId, inserted.rows[0].id,
            credit ? 'credit-note' : 'debit-note',
            input.on.slice(0, 7), noteNo, input.on, document.flat_no,
            input.amountPaise, cgst, sgst,
            Math.round(gst.ratePercent * 100),
          ],
        );
      }

      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: `billing.note.${input.kind}`,
        subjectTable: 'invoice_adjustments',
        subjectId: inserted.rows[0].id,
        detail: { noteNo, amountPaise: input.amountPaise, taxPaise: tax, reason: input.reason },
        requestId: ctx.requestId,
      });

      return {
        id: inserted.rows[0].id, noteNo, entryId, taxPaise: tax, totalPaise: total,
        appliedToInvoicePaise: toReceivable, heldAsAdvancePaise: toAdvance,
      };
    });

    return created({ ...result, posted: true });
  });

  const listNotes = route('GET', '/api/billing/notes', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const result = await pool.query<{
      id: string; note_no: string; kind: string; reason: string; amount: string;
      tax_amount: string; issued_on: string; tax_invoice_no: string | null; flat_no: string;
    }>(
      `SELECT a.id, a.note_no, a.kind, a.reason, a.amount::text, a.tax_amount::text,
              a.issued_on::text, d.tax_invoice_no, f.flat_no
         FROM invoice_adjustments a
         JOIN billing_documents d ON d.id = a.document_id
         JOIN flats f ON f.id = d.flat_id
        WHERE a.society_id = $1
        ORDER BY a.issued_on DESC, a.note_no DESC
        LIMIT 500`,
      [principal.societyId],
    );
    return ok({
      notes: result.rows.map(r => ({
        id: r.id,
        noteNo: r.note_no,
        kind: r.kind,
        reason: r.reason,
        amountPaise: Number(r.amount),
        taxPaise: Number(r.tax_amount),
        issuedOn: r.issued_on,
        taxInvoiceNo: r.tax_invoice_no,
        flatNo: r.flat_no,
      })),
    });
  });

  // --- the notification queue ---------------------------------------------

  const queueNotices = route('POST', '/api/billing/periods/:period/notify', async (ctx) => {
    const principal = need(ctx, 'billing.release');
    const input = ctx.body(v.object({
      template: v.enumOf(['invoice-issued', 'payment-reminder'] as const),
    }));

    const result = await pool.transaction(async (tx) => {
      const documents = await tx.query<{
        id: string; proforma_no: string; tax_invoice_no: string | null; gross: string;
        due_on: string; flat_no: string; owner_email: string | null; to_user: string | null;
      }>(
        `SELECT d.id, d.proforma_no, d.tax_invoice_no, d.gross::text, d.due_on::text, f.flat_no,
                o.email AS owner_email, u.id AS to_user
           FROM billing_documents d
           JOIN flats f ON f.id = d.flat_id
           LEFT JOIN flat_ownership fo
                  ON fo.flat_id = d.flat_id AND fo.role = 'owner' AND fo.held_until IS NULL
           LEFT JOIN owners o ON o.id = fo.owner_id
           LEFT JOIN users u ON u.owner_id = o.id
          WHERE d.society_id = $1 AND d.period = $2
            AND d.state IN ('approved','released','tax-invoice')
          ORDER BY f.flat_no`,
        [principal.societyId, ctx.params.period],
      );

      let queued = 0;
      const withoutAnAddress: string[] = [];
      for (const document of documents.rows) {
        if (document.owner_email === null) {
          withoutAnAddress.push(document.flat_no);
          continue;
        }
        const reference = document.tax_invoice_no ?? document.proforma_no;
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO notifications
             (society_id, channel, template, to_user, to_address, subject, payload)
           VALUES ($1,'email',$2,$3,$4,$5,$6::jsonb)
           RETURNING id`,
          [
            principal.societyId, input.template, document.to_user, document.owner_email,
            input.template === 'invoice-issued'
              ? `Maintenance bill ${reference} — flat ${document.flat_no}, ${ctx.params.period}`
              : `Reminder: ${reference} is due on ${document.due_on}`,
            JSON.stringify({
              documentId: document.id,
              flatNo: document.flat_no,
              reference,
              period: ctx.params.period,
              dueOn: document.due_on,
              grossPaise: Number(document.gross),
              text:
                `Flat ${document.flat_no} — ${ctx.params.period}\n` +
                `Document: ${reference}\n` +
                `Amount: INR ${(Number(document.gross) / 100).toFixed(2)}\n` +
                `Due: ${document.due_on}\n\n` +
                (input.template === 'payment-reminder'
                  ? 'This is a reminder. If you have already paid, please ignore it.\n'
                  : 'The document is attached.\n'),
            }),
          ],
        );
        void inserted;
        queued += 1;
      }

      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'notification.queue',
        subjectTable: 'notifications',
        subjectId: ctx.params.period,
        detail: { template: input.template, queued, withoutAnAddress: withoutAnAddress.length },
        requestId: ctx.requestId,
      });

      return { queued, withoutAnAddress };
    });

    return created({
      ...result,
      // Queued is not sent. The worker sends, and only a provider's own
      // acceptance moves a row to 'sent'.
      sent: 0,
      provider: deps.email.name,
      providerDelivers: deps.email.delivers,
      note: deps.email.delivers
        ? 'Queued. The dispatch job sends them and records what the provider answered.'
        : `Queued, but no sending provider is configured (${deps.email.name}), so they will ` +
          'stay queued until one is. Nothing has been sent.',
    });
  });

  const listNotifications = route('GET', '/api/notifications', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const state = ctx.query.get('state');
    const params: Array<string | number> = [principal.societyId];
    let filter = '';
    if (state !== null) {
      params.push(state);
      filter = ` AND state = $${params.length}`;
    }
    const result = await pool.query<{
      id: string; channel: string; template: string; to_address: string; subject: string | null;
      state: string; attempts: string; provider: string | null; provider_message_id: string | null;
      last_error: string | null; queued_at: string; sent_at: string | null;
    }>(
      `SELECT id, channel, template, to_address, subject, state, attempts::text, provider,
              provider_message_id, last_error, queued_at::text, sent_at::text
         FROM notifications
        WHERE society_id = $1${filter}
        ORDER BY queued_at DESC
        LIMIT 500`,
      params,
    );
    return ok({
      notifications: result.rows.map(r => ({
        id: r.id,
        channel: r.channel,
        template: r.template,
        toAddress: r.to_address,
        subject: r.subject,
        state: r.state,
        attempts: Number(r.attempts),
        provider: r.provider,
        // The evidence. A row in state 'sent' without one cannot exist: the
        // database refuses it.
        providerMessageId: r.provider_message_id,
        lastError: r.last_error,
        queuedAt: r.queued_at,
        sentAt: r.sent_at,
      })),
    });
  });

  // --- users ---------------------------------------------------------------

  const listUsers = route('GET', '/api/users', async (ctx) => {
    const principal = need(ctx, 'user.manage');
    const result = await pool.query<{
      id: string; email: string; is_active: string; last_login_at: string | null;
      owner_name: string | null; roles: string | null; flats: string | null;
      has_password: string;
    }>(
      `SELECT u.id, u.email, u.is_active::text, u.last_login_at::text,
              o.full_name AS owner_name,
              (u.password_hash IS NOT NULL)::text AS has_password,
              (SELECT string_agg(r.role, ',' ORDER BY r.role) FROM user_roles r WHERE r.user_id = u.id) AS roles,
              (SELECT string_agg(f.flat_no, ',' ORDER BY f.flat_no)
                 FROM flat_ownership fo
                 JOIN flats f ON f.id = fo.flat_id
                WHERE fo.owner_id = u.owner_id AND fo.held_until IS NULL) AS flats
         FROM users u
         LEFT JOIN owners o ON o.id = u.owner_id
        WHERE u.society_id = $1
        ORDER BY u.email`,
      [principal.societyId],
    );
    return ok({
      users: result.rows.map(r => ({
        id: r.id,
        email: r.email,
        active: r.is_active === 't' || r.is_active === 'true',
        // Whether one is set, never the hash itself.
        hasPassword: r.has_password === 't' || r.has_password === 'true',
        lastLoginAt: r.last_login_at,
        ownerName: r.owner_name,
        roles: r.roles === null ? [] : r.roles.split(','),
        flats: r.flats === null ? [] : r.flats.split(','),
      })),
      availableRoles: ALL_ROLES,
    });
  });

  const addUser = route('POST', '/api/users', async (ctx) => {
    const principal = need(ctx, 'user.manage');
    const input = ctx.body(v.object({
      email: v.email(),
      roles: v.array(v.string({ min: 4, max: 20 }), { min: 1, max: 5 }),
      /** Links the account to an owner, which is what grants flat access. */
      ownerId: v.uuid().optional(),
      /** Optional: an account with none signs in by emailed code only. */
      password: v.string({ min: 12, max: 200 }).optional(),
    }));

    for (const role of input.roles) {
      if (!isValidRole(role)) throw badRequest(`"${role}" is not a role.`);
    }
    const roles = input.roles as Role[];
    // The maker-checker separation is a property of the role set, so it has to
    // be checked when the roles are handed out, not only when they are used.
    refuseCombinedRoles(roles);

    const result = await pool.transaction(async (tx) => {
      if (input.ownerId !== undefined) {
        const owner = await tx.query<{ id: string }>(
          'SELECT id FROM owners WHERE id = $1 AND society_id = $2',
          [input.ownerId, principal.societyId],
        );
        if (owner.rows[0] === undefined) throw notFound('That owner');
      }

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO users (society_id, email, password_hash, owner_id)
         VALUES ($1,$2,$3,$4)
         RETURNING id`,
        [
          principal.societyId, input.email,
          input.password === undefined ? null : hashPassword(input.password),
          input.ownerId ?? null,
        ],
      );
      const userId = inserted.rows[0].id;

      for (const role of roles) {
        await tx.query(
          'INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1,$2,$3)',
          [userId, role, principal.userId],
        );
      }

      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'user.create',
        subjectTable: 'users',
        subjectId: userId,
        // The password is not in the detail. `redact` would strip it anyway;
        // it is not put there in the first place.
        detail: { email: input.email, roles, linkedToOwner: input.ownerId ?? null },
        requestId: ctx.requestId,
      });

      return userId;
    });

    return created({
      id: result,
      email: input.email,
      roles,
      passwordSet: input.password !== undefined,
    });
  });

  const setRoles = route('POST', '/api/users/:id/roles', async (ctx) => {
    const principal = need(ctx, 'user.manage');
    const input = ctx.body(v.object({
      roles: v.array(v.string({ min: 4, max: 20 }), { min: 0, max: 5 }),
    }));
    for (const role of input.roles) {
      if (!isValidRole(role)) throw badRequest(`"${role}" is not a role.`);
    }
    const roles = input.roles as Role[];
    refuseCombinedRoles(roles);
    if (ctx.params.id === principal.userId) {
      // Otherwise whoever manages users can grant themselves anything.
      throw conflict('You cannot change your own roles. Ask another committee member.');
    }

    await pool.transaction(async (tx) => {
      const found = await tx.query<{ email: string }>(
        'SELECT email FROM users WHERE id = $1 AND society_id = $2',
        [ctx.params.id, principal.societyId],
      );
      if (found.rows[0] === undefined) throw notFound('That user');

      const before = await tx.query<{ role: string }>(
        'SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role',
        [ctx.params.id],
      );

      await tx.query('DELETE FROM user_roles WHERE user_id = $1', [ctx.params.id]);
      for (const role of roles) {
        await tx.query(
          'INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1,$2,$3)',
          [ctx.params.id, role, principal.userId],
        );
      }

      // Sessions carry no roles — they are read on every request — so a
      // changed role takes effect at once without revoking anything. Recorded
      // because a role change is exactly what an auditor looks for.
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'user.roles',
        subjectTable: 'users',
        subjectId: ctx.params.id,
        detail: {
          email: found.rows[0].email,
          from: before.rows.map(r => r.role),
          to: roles,
        },
        requestId: ctx.requestId,
      });
    });

    return ok({ id: ctx.params.id, roles });
  });

  const deactivateUser = route('POST', '/api/users/:id/deactivate', async (ctx) => {
    const principal = need(ctx, 'user.manage');
    const input = ctx.body(v.object({ reason: v.text({ max: 300 }) }));

    const result = await pool.transaction(async (tx) => {
      if (ctx.params.id === principal.userId) {
        throw badRequest('Deactivating your own account would lock you out of the books.');
      }
      const updated = await tx.query(
        `UPDATE users SET is_active = false
          WHERE id = $1 AND society_id = $2 AND is_active = true`,
        [ctx.params.id, principal.societyId],
      );
      if (updated.rowCount === 0) throw conflict('That account is not an active account here.');

      // Every session, ended now. Deactivating an account that stays signed in
      // until its cookie expires is not deactivating it.
      const sessions = await tx.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [ctx.params.id],
      );
      await tx.query(
        'UPDATE login_codes SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL',
        [ctx.params.id],
      );

      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'user.deactivate',
        subjectTable: 'users',
        subjectId: ctx.params.id,
        detail: { reason: input.reason, sessionsRevoked: sessions.rowCount },
        requestId: ctx.requestId,
      });
      return sessions.rowCount;
    });

    return ok({ id: ctx.params.id, active: false, sessionsRevoked: result });
  });

  // --- flats and owners ----------------------------------------------------

  const addFlat = route('POST', '/api/flats', async (ctx) => {
    const principal = need(ctx, 'member.manage');
    const input = ctx.body(v.object({
      flatNo: v.string({ min: 1, max: 20 }),
      wing: v.string({ min: 1, max: 10 }).optional(),
      floor: v.int({ min: -5, max: 200 }).optional(),
      billingAreaSqFt: v.int({ min: 1, max: 100_000 }).optional(),
      areaBasis: v.enumOf(['carpet', 'built-up', 'super-built-up'] as const).optional(),
      nonOccupied: v.boolean().optional(),
    }));
    // Area and basis go together. An area with no basis cannot be billed, and
    // the billing run refuses it rather than assuming one.
    if ((input.billingAreaSqFt === undefined) !== (input.areaBasis === undefined)) {
      throw badRequest(
        'Send the billing area and its basis together. The same rate over carpet and over ' +
        'super built-up area differs by about a third, so neither can be assumed.',
      );
    }

    const result = await pool.transaction(async (tx) => {
      const flatId = await insertFlat(tx, principal.societyId, {
        flatNo: input.flatNo,
        wing: input.wing ?? null,
        floor: input.floor ?? null,
        billingAreaSqFt: input.billingAreaSqFt ?? null,
        areaBasis: input.areaBasis ?? null,
        nonOccupied: input.nonOccupied ?? false,
      });
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'member.manage',
        subjectTable: 'flats',
        subjectId: flatId,
        detail: { ...input },
        requestId: ctx.requestId,
      });
      return flatId;
    });

    return created({
      id: result,
      flatNo: input.flatNo,
      billable: input.billingAreaSqFt !== undefined,
    });
  });

  const setOwner = route('POST', '/api/flats/:id/owner', async (ctx) => {
    const principal = need(ctx, 'member.manage');
    const input = ctx.body(v.object({
      fullName: v.text({ max: 200 }),
      email: v.email(),
      phone: v.string({ min: 6, max: 20 }).optional(),
      role: v.enumOf(['owner', 'co-owner', 'tenant'] as const),
      heldFrom: v.isoDate(),
      /** Ends the current holder's tenure the day before. A sale, or a move. */
      replaceCurrent: v.boolean(),
    }));

    const result = await pool.transaction(async (tx) => {
      const flat = await tx.query<{ flat_no: string }>(
        'SELECT flat_no FROM flats WHERE id = $1 AND society_id = $2',
        [ctx.params.id, principal.societyId],
      );
      if (flat.rows[0] === undefined) throw notFound('That flat');

      const ownerId = await upsertOwner(tx, {
        societyId: principal.societyId,
        fullName: input.fullName,
        email: input.email,
        phone: input.phone ?? null,
      });
      await recordHolder(tx, {
        flatId: ctx.params.id,
        ownerId,
        role: input.role,
        heldFrom: input.heldFrom,
        replaceCurrent: input.replaceCurrent,
      });

      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'member.manage',
        subjectTable: 'flat_ownership',
        subjectId: ctx.params.id,
        detail: {
          flatNo: flat.rows[0].flat_no,
          owner: input.email,
          role: input.role,
          heldFrom: input.heldFrom,
          replacedCurrent: input.replaceCurrent,
        },
        requestId: ctx.requestId,
      });

      return { ownerId, flatNo: flat.rows[0].flat_no };
    });

    return created({
      ...result,
      // Dues follow the flat, not the person. Said plainly because this is the
      // thing people expect to happen and it must not.
      note:
        'Recorded. Anything already outstanding stays against the flat: a change of owner ' +
        'does not move or clear it.',
    });
  });

  return [
    snapshot,
    invoicePdf, receiptPdf,
    issueNote, listNotes,
    queueNotices, listNotifications,
    listUsers, addUser, setRoles, deactivateUser,
    addFlat, setOwner,
  ];
}
