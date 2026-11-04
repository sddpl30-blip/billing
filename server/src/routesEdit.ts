/**
 * Corrections: every record the office can get wrong has an edit path that
 * keeps the audit trail, instead of cancel-and-redo.
 *
 *   POST /api/billing/documents/:id/edit     an unsent proforma: month, due date, or recalculate
 *   POST /api/billing/periods/:period/change-month   a whole run's unsent proformas to another month
 *   POST /api/flats/:id/edit                 a flat's area, basis, occupancy
 *   POST /api/owners/:id/correct             an owner's name, e-mail, phone (not a change of owner)
 *   POST /api/rates/:id/edit                 a rate that is still waiting for approval
 *
 * A proforma that was approved goes back to draft and to the treasurer for
 * approval again, so the checker always sees the figures they approve. An
 * issued tax invoice is not edited here: it is corrected with a credit or
 * debit note, which is what GST law requires.
 */

import type { PgPool, Queryable } from './pg';
import { badRequest, conflict, notFound, route, type RequestContext, type Reply, type RouteDefinition } from './http';
import { v } from './validate';
import { requirePermission, type Principal } from './rbac';
import { audit } from './audit';
import { migrationApplied, recalculateProforma } from './billing';
import { parseEmails } from './contactEmails';
import { canonicalPeriod } from '../../src/accounting/clock';
import { A, accountBalance, postEntry, type Leg } from './posting';
import { lockFlatBalance } from './series';
import { randomUUID } from 'node:crypto';
import { formatRupees } from '../../src/accounting/money';

export interface EditDependencies { readonly pool: PgPool }

const ok = (body: unknown): Reply => ({ status: 200, body });

function who(ctx: RequestContext): Principal {
  if (ctx.principal === null) throw new Error(`route ${ctx.path} read the principal but is not marked authenticated`);
  return ctx.principal;
}

/** Sends an approved proforma back to draft, with a fresh approval request from this editor. */
async function backToDraft(tx: Queryable, principal: Principal, documentId: string, state: string): Promise<void> {
  if (state === 'approved') {
    await tx.query(
      `UPDATE billing_documents SET state = 'draft', approved_by = NULL, approved_on = NULL WHERE id = $1`,
      [documentId],
    );
    await tx.query(
      `INSERT INTO approvals (society_id, subject_table, subject_id, requested_by)
       VALUES ($1, 'billing_documents', $2, $3)`,
      [principal.societyId, documentId, principal.userId],
    );
  } else {
    // Still waiting: the editor becomes the maker, so they cannot approve their own correction.
    await tx.query(
      `UPDATE approvals SET requested_by = $3
        WHERE society_id = $1 AND subject_table = 'billing_documents' AND subject_id = $2 AND decision IS NULL`,
      [principal.societyId, documentId, principal.userId],
    );
  }
}

export function createEditRoutes(deps: EditDependencies): RouteDefinition[] {
  const { pool } = deps;

  const editDocument = route('POST', '/api/billing/documents/:id/edit', async (ctx) => {
    const principal = who(ctx);
    requirePermission(principal, 'billing.run');
    const input = ctx.body(v.object({
      period: v.period().optional(),
      dueOn: v.isoDate().optional(),
      recalculate: v.boolean().optional(),
      reason: v.text({ max: 300 }),
    }));
    if (input.reason.trim() === '') throw badRequest('Say why the bill is being corrected.');
    if (input.period === undefined && input.dueOn === undefined && input.recalculate !== true) {
      throw badRequest('Nothing to change: give a month, a due date, or ask to recalculate.');
    }
    const result = await pool.transaction(async (tx) => {
      const found = await tx.query<{ proforma_no: string; state: string; period: string; due_on: string; issued_on: string; gross: string }>(
        `SELECT proforma_no, state, period, due_on::text, issued_on::text, gross::text
           FROM billing_documents WHERE id = $1 AND society_id = $2 FOR UPDATE`,
        [ctx.params.id, principal.societyId],
      );
      const doc = found.rows[0];
      if (doc === undefined) throw notFound('That document');
      if (doc.state !== 'draft' && doc.state !== 'approved') {
        throw conflict(`${doc.proforma_no} is ${doc.state}. Only a proforma not yet sent can be edited; an issued invoice is corrected with a credit or debit note.`);
      }
      if (input.dueOn !== undefined) {
        if (input.dueOn < doc.issued_on) throw badRequest(`The due date cannot be before the bill date ${doc.issued_on}.`);
        await tx.query('UPDATE billing_documents SET due_on = $2 WHERE id = $1', [ctx.params.id, input.dueOn]);
      }
      let after = { period: doc.period, gross: Number(doc.gross) };
      if (input.period !== undefined || input.recalculate === true) {
        const r = await recalculateProforma(tx, {
          societyId: principal.societyId, documentId: ctx.params.id,
          ...(input.period === undefined ? {} : { period: input.period }),
        });
        after = { period: r.period, gross: r.gross };
      }
      await backToDraft(tx, principal, ctx.params.id, doc.state);
      await audit(tx, {
        societyId: principal.societyId, actorUser: principal.userId, actorLabel: principal.email,
        action: 'billing.edit', subjectTable: 'billing_documents', subjectId: ctx.params.id,
        detail: {
          reason: input.reason.trim(),
          period: { from: doc.period, to: after.period },
          dueOn: { from: doc.due_on, to: input.dueOn ?? doc.due_on },
          grossPaise: { from: Number(doc.gross), to: after.gross },
          wasApproved: doc.state === 'approved',
        },
        requestId: ctx.requestId,
      });
      return { proformaNo: doc.proforma_no, ...after, backToDraft: doc.state === 'approved' };
    });
    return ok({
      ...result,
      note: result.backToDraft
        ? `${result.proformaNo} corrected and sent back to the treasurer for approval again.`
        : `${result.proformaNo} corrected.`,
    });
  });

  const changeMonth = route('POST', '/api/billing/periods/:period/change-month', async (ctx) => {
    const principal = who(ctx);
    requirePermission(principal, 'billing.run');
    const input = ctx.body(v.object({ to: v.period(), reason: v.text({ max: 300 }) }));
    if (input.reason.trim() === '') throw badRequest('Say why the month is being changed.');
    const from = canonicalPeriod(ctx.params.period);
    const to = canonicalPeriod(input.to);
    if (from === null || to === null) throw badRequest('Give both months as in "Oct 2026".');
    if (from === to) throw badRequest('The new month is the same as the old one.');
    const outcome = await pool.transaction(async (tx) => {
      const docs = await tx.query<{ id: string; state: string; proforma_no: string; flat_no: string }>(
        `SELECT d.id, d.state, d.proforma_no, f.flat_no FROM billing_documents d JOIN flats f ON f.id = d.flat_id
          WHERE d.society_id = $1 AND d.period = $2 AND d.state IN ('draft','approved') AND d.opening_batch_id IS NULL
          ORDER BY f.flat_no FOR UPDATE OF d`,
        [principal.societyId, from],
      );
      if (docs.rows.length === 0) throw notFound(`Any unsent proforma for ${from}`);
      const clash = await tx.query<{ flat_no: string }>(
        `SELECT f.flat_no FROM billing_documents d JOIN flats f ON f.id = d.flat_id
          WHERE d.society_id = $1 AND d.period = $2 AND d.state <> 'cancelled' AND d.opening_batch_id IS NULL
            AND d.flat_id IN (SELECT flat_id FROM billing_documents WHERE society_id = $1 AND period = $3
                               AND state IN ('draft','approved') AND opening_batch_id IS NULL)`,
        [principal.societyId, to, from],
      );
      if (clash.rows.length > 0) {
        throw conflict(`${clash.rows.length} flat(s) already have a bill for ${to} (${clash.rows.slice(0, 5).map(r => r.flat_no).join(', ')}…). Cancel or edit those first.`);
      }
      let changedGross = 0;
      for (const d of docs.rows) {
        const r = await recalculateProforma(tx, { societyId: principal.societyId, documentId: d.id, period: to });
        changedGross += r.gross;
        await backToDraft(tx, principal, d.id, d.state);
      }
      await audit(tx, {
        societyId: principal.societyId, actorUser: principal.userId, actorLabel: principal.email,
        action: 'billing.change-month', subjectTable: 'billing_documents', subjectId: from,
        detail: { from, to, moved: docs.rows.length, reason: input.reason.trim(), grossPaise: changedGross },
        requestId: ctx.requestId,
      });
      return { moved: docs.rows.length, wasApproved: docs.rows.filter(d => d.state === 'approved').length };
    });
    return ok({
      from, to, ...outcome,
      note: `${outcome.moved} proformas moved from ${from} to ${to} and recalculated at ${to}'s rate. ` +
        'All are drafts again and go to the treasurer for approval. Their numbers are unchanged.',
    });
  });

  const editFlat = route('POST', '/api/flats/:id/edit', async (ctx) => {
    const principal = who(ctx);
    requirePermission(principal, 'member.manage');
    const input = ctx.body(v.object({
      billingAreaSqFt: v.int({ min: 1, max: 100_000 }).optional(),
      areaBasis: v.enumOf(['carpet', 'built-up', 'super-built-up'] as const).optional(),
      nonOccupied: v.boolean().optional(),
      reason: v.text({ max: 300 }),
    }));
    if (input.billingAreaSqFt === undefined && input.areaBasis === undefined && input.nonOccupied === undefined) {
      throw badRequest('Nothing to change.');
    }
    const result = await pool.transaction(async (tx) => {
      const before = await tx.query<{ flat_no: string; billing_area_sqft: string | null; area_basis: string | null; non_occupied: string }>(
        `SELECT flat_no, billing_area_sqft::text, area_basis, non_occupied::text FROM flats WHERE id = $1 AND society_id = $2 FOR UPDATE`,
        [ctx.params.id, principal.societyId],
      );
      const b = before.rows[0];
      if (b === undefined) throw notFound('That flat');
      await tx.query(
        `UPDATE flats SET billing_area_sqft = COALESCE($3, billing_area_sqft), area_basis = COALESCE($4, area_basis),
                          non_occupied = COALESCE($5, non_occupied) WHERE id = $1 AND society_id = $2`,
        [ctx.params.id, principal.societyId, input.billingAreaSqFt ?? null, input.areaBasis ?? null, input.nonOccupied ?? null],
      );
      const drafts = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM billing_documents WHERE flat_id = $1 AND state IN ('draft','approved') AND opening_batch_id IS NULL`,
        [ctx.params.id],
      );
      await audit(tx, {
        societyId: principal.societyId, actorUser: principal.userId, actorLabel: principal.email,
        action: 'flat.edit', subjectTable: 'flats', subjectId: ctx.params.id,
        detail: {
          flat: b.flat_no, reason: input.reason.trim(),
          area: { from: b.billing_area_sqft, to: input.billingAreaSqFt ?? b.billing_area_sqft },
          basis: { from: b.area_basis, to: input.areaBasis ?? b.area_basis },
        },
        requestId: ctx.requestId,
      });
      return { flat: b.flat_no, unsent: Number(drafts.rows[0]?.n ?? '0') };
    });
    return ok({
      ...result,
      note: result.unsent > 0
        ? `Flat ${result.flat} updated. It has ${result.unsent} unsent bill(s) still at the old figure: use Edit on each bill, "Recalculate", to apply the new area.`
        : `Flat ${result.flat} updated. Future bills use the new figure.`,
    });
  });

  const correctOwnerOf = async (ctx: RequestContext, ownerOf: (tx: Queryable, principal: Principal) => Promise<string>): Promise<Reply> => {
    const principal = who(ctx);
    requirePermission(principal, 'member.manage');
    const input = ctx.body(v.object({
      fullName: v.text({ max: 200 }).optional(),
      email: v.email().optional(),
      phone: v.string({ min: 6, max: 20 }).optional(),
      reason: v.text({ max: 300 }),
    }));
    if (input.fullName === undefined && input.email === undefined && input.phone === undefined) throw badRequest('Nothing to change.');
    const result = await pool.transaction(async (tx) => {
      const ownerId = await ownerOf(tx, principal);
      const before = await tx.query<{ full_name: string; email: string; phone: string | null }>(
        `SELECT full_name, email, phone FROM owners WHERE id = $1 AND society_id = $2 FOR UPDATE`,
        [ownerId, principal.societyId],
      );
      const b = before.rows[0];
      if (b === undefined) throw notFound('That owner');
      const email = input.email?.toLowerCase();
      if (email !== undefined && email !== b.email.toLowerCase()) {
        const taken = await tx.query(
          `SELECT 1 FROM owners WHERE society_id = $1 AND lower(email) = $2 AND id <> $3`,
          [principal.societyId, email, ownerId],
        );
        if (taken.rows.length > 0) throw conflict('Another owner already has that e-mail address.');
      }
      await tx.query(
        `UPDATE owners SET full_name = COALESCE($3, full_name), email = COALESCE($4, email), phone = COALESCE($5, phone)
          WHERE id = $1 AND society_id = $2`,
        [ownerId, principal.societyId, input.fullName?.trim() ?? null, email ?? null, input.phone ?? null],
      );
      await audit(tx, {
        societyId: principal.societyId, actorUser: principal.userId, actorLabel: principal.email,
        action: 'owner.correct', subjectTable: 'owners', subjectId: ownerId,
        detail: {
          reason: input.reason.trim(),
          name: { from: b.full_name, to: input.fullName?.trim() ?? b.full_name },
          emailChanged: email !== undefined && email !== b.email.toLowerCase(),
          phoneChanged: input.phone !== undefined && input.phone !== b.phone,
        },
        requestId: ctx.requestId,
      });
      return { name: input.fullName?.trim() ?? b.full_name };
    });
    return ok({
      ...result,
      note: 'Owner details corrected. Bills already raised keep working: they point to the flat, not to the name. ' +
        'If this owner signs in with the old e-mail, add the new one under Users & roles.',
    });
  };

  const correctOwner = route('POST', '/api/owners/:id/correct', ctx => correctOwnerOf(ctx, async () => ctx.params.id));

  /** The same correction, found through the flat the screens list. */
  const correctFlatOwner = route('POST', '/api/flats/:id/owner/correct', ctx => correctOwnerOf(ctx, async (tx, principal) => {
    const owner = await tx.query<{ owner_id: string }>(
      `SELECT fo.owner_id FROM flat_ownership fo JOIN flats f ON f.id = fo.flat_id
        WHERE fo.flat_id = $1 AND f.society_id = $2 AND fo.role = 'owner' AND fo.held_until IS NULL LIMIT 1`,
      [ctx.params.id, principal.societyId],
    );
    if (owner.rows[0] === undefined) throw notFound('A current owner for that flat');
    return owner.rows[0].owner_id;
  }));

  /**
   * Corrects how to reach the flat's current owner: e-mail address(es) and
   * phone. Not a sale or a move: no tenure, no ledger, no bill is touched.
   * The first address is the owner's primary one; any others also receive
   * the owner's bills. The audit line keeps the old and the new.
   */
  const editContact = route('POST', '/api/flats/:id/contact', async ctx => {
    const principal = who(ctx);
    requirePermission(principal, 'member.manage');
    const input = ctx.body(v.object({
      emails: v.string({ max: 1000 }).optional(),
      phone: v.string({ max: 20 }).optional(),
      reason: v.text({ max: 300 }).optional(),
    }));
    if (input.emails === undefined && input.phone === undefined) throw badRequest('Nothing to change.');
    let list: string[] | null = null;
    if (input.emails !== undefined) {
      try { list = parseEmails(input.emails); } catch (err) { throw badRequest(err instanceof Error ? err.message : 'Check the e-mail addresses.'); }
      if (list.length === 0) throw badRequest('Give at least one e-mail address.');
      if (list.length > 8) throw badRequest('At most eight addresses.');
    }
    const result = await pool.transaction(async (tx) => {
      const withExtra = await migrationApplied(tx, '015_owner_extra_emails.sql');
      const held = await tx.query<{ owner_id: string; flat_no: string }>(
        `SELECT fo.owner_id, f.flat_no FROM flat_ownership fo JOIN flats f ON f.id = fo.flat_id
          WHERE fo.flat_id = $1 AND f.society_id = $2 AND fo.role = 'owner' AND fo.held_until IS NULL LIMIT 1`,
        [ctx.params.id, principal.societyId],
      );
      if (held.rows[0] === undefined) throw notFound('A current owner for that flat');
      const ownerId = held.rows[0].owner_id;
      const before = await tx.query<{ email: string; extra: string | null; phone: string | null }>(
        `SELECT email, ${withExtra ? 'extra_emails' : 'NULL::text'} AS extra, phone
           FROM owners WHERE id = $1 AND society_id = $2 FOR UPDATE`,
        [ownerId, principal.societyId],
      );
      const b = before.rows[0];
      if (b === undefined) throw notFound('That owner');
      const wasEmails = [b.email, ...(b.extra === null || b.extra === '' ? [] : b.extra.split(/[,;]\s*/))];
      if (list !== null && list.length > 1 && !withExtra) {
        throw badRequest('More than one address needs database migration 015. Run docs/neon/015-apply.sql in Neon once.');
      }
      if (list !== null && list[0] !== b.email.toLowerCase()) {
        const taken = await tx.query<{ flat_no: string | null }>(
          `SELECT (SELECT f2.flat_no FROM flat_ownership fo2 JOIN flats f2 ON f2.id = fo2.flat_id
                    WHERE fo2.owner_id = o.id AND fo2.held_until IS NULL LIMIT 1) AS flat_no
             FROM owners o WHERE o.society_id = $1 AND lower(o.email) = $2 AND o.id <> $3`,
          [principal.societyId, list[0], ownerId],
        );
        if (taken.rows[0] !== undefined) {
          throw conflict(
            `${list[0]} is already the primary address of another owner` +
            `${taken.rows[0].flat_no === null ? '' : ` (flat ${taken.rows[0].flat_no})`}. ` +
            'Put it after another address as an additional one, or correct that owner first.',
          );
        }
      }
      if (list !== null) {
        await tx.query(
          withExtra
            ? 'UPDATE owners SET email = $3, extra_emails = $4 WHERE id = $1 AND society_id = $2'
            : 'UPDATE owners SET email = $3 WHERE id = $1 AND society_id = $2',
          withExtra
            ? [ownerId, principal.societyId, list[0], list.length > 1 ? list.slice(1).join(', ') : null]
            : [ownerId, principal.societyId, list[0]],
        );
      }
      if (input.phone !== undefined) {
        await tx.query('UPDATE owners SET phone = $3 WHERE id = $1 AND society_id = $2', [ownerId, principal.societyId, input.phone.trim() === '' ? null : input.phone.trim()]);
      }
      await audit(tx, {
        societyId: principal.societyId, actorUser: principal.userId, actorLabel: principal.email,
        action: 'owner.contact', subjectTable: 'owners', subjectId: ownerId,
        detail: {
          flat: held.rows[0].flat_no,
          ...(input.reason === undefined ? {} : { reason: input.reason.trim() }),
          ...(list === null ? {} : { emails: { from: wasEmails.join(', '), to: list.join(', ') } }),
          ...(input.phone === undefined ? {} : { phone: { from: b.phone, to: input.phone.trim() === '' ? null : input.phone.trim() } }),
        },
        requestId: ctx.requestId,
      });
      return { flat: held.rows[0].flat_no, emails: list };
    });
    return ok({
      ...result,
      note: `Contact for flat ${result.flat} updated. Nothing else changed: no ownership, no ledger entry. ` +
        'Bills already sent are not re-sent; use "Resend bill" on the flat.',
    });
  });

  const editRate = route('POST', '/api/rates/:id/edit', async (ctx) => {
    const principal = who(ctx);
    requirePermission(principal, 'settings.manage');
    const input = ctx.body(v.object({
      paisePerSqFt: v.paise({ min: 1 }).optional(),
      basis: v.enumOf(['carpet', 'built-up', 'super-built-up'] as const).optional(),
      effectiveFrom: v.isoDate().optional(),
      authority: v.text({ max: 300 }).optional(),
    }));
    const result = await pool.transaction(async (tx) => {
      const before = await tx.query<{ approved_by: string | null; rate_paise_per_sqft: string; effective_from: string }>(
        `SELECT approved_by, rate_paise_per_sqft::text, effective_from::text FROM maintenance_rates WHERE id = $1 AND society_id = $2 FOR UPDATE`,
        [ctx.params.id, principal.societyId],
      );
      const b = before.rows[0];
      if (b === undefined) throw notFound('That rate');
      if (b.approved_by !== null) {
        throw conflict('This rate is approved and may already have been billed. Record a corrected rate with a new effective date instead.');
      }
      await tx.query(
        `UPDATE maintenance_rates SET rate_paise_per_sqft = COALESCE($3, rate_paise_per_sqft), area_basis = COALESCE($4, area_basis),
                effective_from = COALESCE($5::date, effective_from), authority = COALESCE($6, authority)
          WHERE id = $1 AND society_id = $2`,
        [ctx.params.id, principal.societyId, input.paisePerSqFt ?? null, input.basis ?? null, input.effectiveFrom ?? null, input.authority ?? null],
      );
      await audit(tx, {
        societyId: principal.societyId, actorUser: principal.userId, actorLabel: principal.email,
        action: 'rate.edit', subjectTable: 'maintenance_rates', subjectId: ctx.params.id,
        detail: { ratePaise: { from: Number(b.rate_paise_per_sqft), to: input.paisePerSqFt ?? Number(b.rate_paise_per_sqft) } },
        requestId: ctx.requestId,
      });
      return {};
    });
    return ok({ ...result, note: 'The rate is corrected and still waits for the treasurer\'s approval.' });
  });

  /**
   * Corrects one flat's opening due without reversing the whole batch: a
   * dated adjustment entry between the flat's receivable and the same
   * balancing (reserve) account the opening entry used, with the document's
   * amount brought into line. The batch's own lines stay as posted (the database
   * locks them); the audit trail and the adjustment entry carry the change. The due cannot go below what the flat has
   * already paid against it. Every adjustment is audited.
   */
  const amendOpening = route('POST', '/api/billing/documents/:id/amend-opening', async (ctx) => {
    const principal = who(ctx);
    requirePermission(principal, 'billing.cancel');
    const input = ctx.body(v.object({ newDuePaise: v.paise({ min: 1 }), on: v.isoDate(), reason: v.text({ max: 500 }) }));
    if (input.reason.trim() === '') throw badRequest('Say why the opening due is being corrected.');
    const result = await pool.transaction(async (tx) => {
      const found = await tx.query<{
        flat_id: string; flat_no: string; tax_invoice_no: string | null; gross: string; batch: string | null; as_at: string | null;
      }>(
        `SELECT d.flat_id, f.flat_no, d.tax_invoice_no, d.gross::text, d.opening_batch_id AS batch, b.as_at::text
           FROM billing_documents d JOIN flats f ON f.id = d.flat_id
           LEFT JOIN opening_balance_batches b ON b.id = d.opening_batch_id
          WHERE d.id = $1 AND d.society_id = $2 FOR UPDATE OF d`,
        [ctx.params.id, principal.societyId],
      );
      const d = found.rows[0];
      if (d === undefined) throw notFound('That document');
      if (d.batch === null || d.tax_invoice_no === null) throw conflict('This is not an opening due. Correct an issued invoice with a credit or debit note.');
      if (d.as_at !== null && input.on < d.as_at) throw badRequest(`The correction cannot be dated before the opening date ${d.as_at}.`);
      await lockFlatBalance(tx, { societyId: principal.societyId, flatId: d.flat_id });

      const oldDue = Number(d.gross);
      const outstanding = await accountBalance(tx, { societyId: principal.societyId, code: A.MAINTENANCE_RECEIVABLE, docRef: d.tax_invoice_no });
      const paid = oldDue - outstanding;
      if (input.newDuePaise < paid) {
        throw badRequest(`${d.flat_no} has already paid ${formatRupees(paid)} against this due, so it cannot be corrected below that.`);
      }
      const diff = input.newDuePaise - oldDue;
      if (diff === 0) throw badRequest('That is the same amount as now.');

      const reserve = await tx.query<{ account_code: string }>(
        `SELECT account_code FROM opening_balance_account_lines WHERE batch_id = $1 AND is_balancing LIMIT 1`, [d.batch],
      );
      const balancing = reserve.rows[0]?.account_code ?? A.GENERAL_RESERVE;
      const up = diff > 0;
      const amount = Math.abs(diff);
      const legs: Leg[] = [
        { accountCode: A.MAINTENANCE_RECEIVABLE, debit: up ? amount : 0, credit: up ? 0 : amount, party: d.flat_no, docRef: d.tax_invoice_no, memo: `Opening due corrected: ${input.reason.slice(0, 80)}` },
        { accountCode: balancing, debit: up ? 0 : amount, credit: up ? amount : 0, docRef: d.tax_invoice_no, memo: 'Opening due correction' },
      ];
      const entryId = await postEntry(tx, {
        societyId: principal.societyId, entryDate: input.on,
        narration: `Opening due ${d.tax_invoice_no} (flat ${d.flat_no}) corrected from ${formatRupees(oldDue)} to ${formatRupees(input.newDuePaise)}: ${input.reason}`,
        sourceKind: 'opening-balance', sourceRef: `${d.tax_invoice_no}/adj-${randomUUID().slice(0, 8)}`,
        idempotencyKey: `opening-correction:${randomUUID()}`,
        postedBy: principal.userId, postedByLabel: principal.email, legs,
      });
      await tx.query('UPDATE billing_documents SET gross = $2 WHERE id = $1', [ctx.params.id, input.newDuePaise]);
      await tx.query('UPDATE billing_document_lines SET amount = $2 WHERE document_id = $1', [ctx.params.id, input.newDuePaise]);
      await audit(tx, {
        societyId: principal.societyId, actorUser: principal.userId, actorLabel: principal.email,
        action: 'opening.amend', subjectTable: 'billing_documents', subjectId: ctx.params.id,
        detail: { flat: d.flat_no, from: oldDue, to: input.newDuePaise, entryId, reason: input.reason.trim() },
        requestId: ctx.requestId,
      });
      return { flat: d.flat_no, from: oldDue, to: input.newDuePaise };
    });
    return ok({
      ...result,
      note: `Opening due for flat ${result.flat} corrected from ${formatRupees(result.from)} to ${formatRupees(result.to)}. The books and the bill both show the new figure, and the change is on the audit trail.`,
    });
  });

  return [editDocument, changeMonth, editFlat, correctOwner, correctFlatOwner, editContact, editRate, amendOpening];
}
