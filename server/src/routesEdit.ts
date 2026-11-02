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
import { recalculateProforma } from './billing';
import { canonicalPeriod } from '../../src/accounting/clock';

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

  return [editDocument, changeMonth, editFlat, correctOwner, correctFlatOwner, editRate];
}
