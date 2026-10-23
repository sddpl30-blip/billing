/**
 * Going live: importing the member list, bringing the opening position into
 * the books, and keeping the society's own identity current.
 *
 * Kept apart from routes.ts and routesAdmin.ts for the same reason those two
 * are apart. The rules are the same: every route names its permission, every
 * write is audited, and a refusal says what to do next.
 */

import type { PgPool } from './pg';
import type { Config } from './config';
import type { Logger } from './logger';
import { HttpError, badRequest, notFound, route, type RequestContext, type Reply, type RouteDefinition } from './http';
import { v } from './validate';
import { ForbiddenError, hasPermission, requirePermission, type Permission, type Principal } from './rbac';
import { audit } from './audit';
import { sha256 } from './security';
import { FLAT_IMPORT_MAX_BYTES, importFlats } from './flatImport';
import {
  OPENING_CSV_MAX_BYTES, approveAndPost, discardDraft, parseOpeningCsv, readOpening, reverseOpening, saveDraft,
  type FlatLineInput, type OpeningProblem,
} from './openingBalances';
import { applyAdvance, flatsWithAdvances } from './advances';
import { readProfile, validateProfile, writeProfile } from './societyProfile';
import { isoDateInIndia } from '../../src/accounting/clock';

export interface OnboardingRouteDependencies {
  readonly pool: PgPool;
  readonly config: Config;
  readonly log: Logger;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const created = (body: unknown): Reply => ({ status: 201, body });

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

/** Empty or absent is "not recorded"; anything else is trimmed. */
const blankToNull = (value: string | undefined): string | null => {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
};

export function createOnboardingRoutes(deps: OnboardingRouteDependencies): RouteDefinition[] {
  const { pool } = deps;

  // --- the member list -----------------------------------------------------

  const importFlatsRoute = route('POST', '/api/flats/import', async (ctx) => {
    const principal = need(ctx, 'member.manage');
    const input = ctx.body(v.object({
      csv: v.string({ min: 1, max: FLAT_IMPORT_MAX_BYTES }),
      dryRun: v.boolean(),
      filename: v.string({ max: 300 }).optional(),
      /** When the imported owners' tenure begins. Today, unless the sheet is dated. */
      heldFrom: v.isoDate().optional(),
    }));
    const heldFrom = input.heldFrom ?? isoDateInIndia();

    const report = await pool.transaction(async (tx) => {
      // One import at a time per society: two at once would each see the
      // other's flats as absent and both try to create them.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`societybooks:flat-import:${principal.societyId}`]);
      const result = await importFlats(tx, {
        societyId: principal.societyId,
        csv: input.csv,
        dryRun: input.dryRun,
        heldFrom,
        actorUserId: principal.userId,
      });
      if (result.committed) {
        await audit(tx, {
          societyId: principal.societyId,
          actorUser: principal.userId,
          actorLabel: principal.email,
          action: 'member.import',
          subjectTable: 'flats',
          subjectId: 'csv-import',
          // Counts and the file's fingerprint, not its contents: the sheet
          // holds members' phone numbers and PANs, which have no place in an
          // append-only log.
          detail: {
            filename: input.filename ?? null,
            contentSha256: sha256(input.csv),
            rows: result.rows,
            flatsNew: result.flats.new,
            flatsUpdated: result.flats.updated,
            flatsUnchanged: result.flats.unchanged,
            accountsCreated: result.accounts.created,
            accountsLinked: result.accounts.linked,
            heldFrom,
          },
          requestId: ctx.requestId,
        });
      }
      return result;
    });

    return report.committed ? created(report) : ok(report);
  });

  // --- opening balances ------------------------------------------------------

  const readOpeningRoute = route('GET', '/api/opening-balances', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const view = await pool.transaction(tx => readOpening(tx, principal.societyId));
    return ok({
      ...view,
      canPrepare: hasPermission(principal, 'settings.manage'),
      canApprove: hasPermission(principal, 'period.close'),
      you: principal.email,
    });
  });

  const accountLine = v.object({
    accountCode: v.string({ pattern: /^[0-9]{4}$/, patternName: 'a four-digit account code' }),
    debitPaise: v.paise({ min: 0 }),
    creditPaise: v.paise({ min: 0 }),
    vendorId: v.uuid().optional(),
    reference: v.string({ max: 60 }).optional(),
    expenseAccount: v.string({ pattern: /^[0-9]{4}$/, patternName: 'a four-digit account code' }).optional(),
    memo: v.string({ max: 200 }).optional(),
  });
  const flatLine = v.object({
    flatNo: v.string({ min: 1, max: 20 }),
    duePaise: v.paise({ min: 0 }),
    advancePaise: v.paise({ min: 0 }),
    dueSince: v.isoDate().optional(),
  });

  const saveOpening = route('POST', '/api/opening-balances/draft', async (ctx) => {
    const principal = need(ctx, 'settings.manage');
    const input = ctx.body(v.object({
      asAt: v.isoDate(),
      autoBalance: v.boolean(),
      dryRun: v.boolean(),
      note: v.string({ max: 500 }).optional(),
      /** The per-flat part as a file: flat_no, opening_due, opening_advance[, due_since]. */
      flatsCsv: v.string({ min: 1, max: OPENING_CSV_MAX_BYTES }).optional(),
      /** Or as lines, which is how the screen resends a draft it loaded. */
      flatLines: v.array(flatLine, { max: 5000 }).optional(),
      accountLines: v.array(accountLine, { max: 100 }),
    }));
    if (input.flatsCsv !== undefined && input.flatLines !== undefined) {
      throw badRequest('Send the per-flat part as a CSV or as lines, not both.');
    }

    let flatLines: FlatLineInput[] = (input.flatLines ?? []).map(l => ({ ...l, dueSince: l.dueSince ?? null }));
    let parseErrors: OpeningProblem[] = [];
    if (input.flatsCsv !== undefined) {
      const parsed = parseOpeningCsv(input.flatsCsv);
      flatLines = parsed.lines;
      parseErrors = parsed.errors;
    }

    const result = await pool.transaction(tx => saveDraft(tx, {
      societyId: principal.societyId,
      userId: principal.userId,
      userLabel: principal.email,
      requestId: ctx.requestId,
      asAt: input.asAt,
      autoBalance: input.autoBalance,
      note: blankToNull(input.note),
      flatLines,
      accountLines: input.accountLines,
      parseErrors,
      dryRun: input.dryRun,
    }));
    return input.dryRun
      ? ok({ dryRun: true, saved: false, ...result })
      : created({ dryRun: false, saved: true, ...result });
  });

  const discardOpening = route('POST', '/api/opening-balances/:id/discard', async (ctx) => {
    const principal = need(ctx, 'settings.manage');
    await pool.transaction(tx => discardDraft(tx, {
      societyId: principal.societyId, batchId: ctx.params.id,
      userId: principal.userId, userLabel: principal.email, requestId: ctx.requestId,
    }));
    return ok({ id: ctx.params.id, state: 'discarded' });
  });

  const approveOpening = route('POST', '/api/opening-balances/:id/approve', async (ctx) => {
    const principal = need(ctx, 'period.close');
    const result = await pool.transaction(tx => approveAndPost(tx, {
      societyId: principal.societyId, batchId: ctx.params.id,
      userId: principal.userId, userLabel: principal.email, requestId: ctx.requestId,
    }));
    return ok({ id: ctx.params.id, state: 'posted', ...result });
  });

  const reverseOpeningRoute = route('POST', '/api/opening-balances/:id/reverse', async (ctx) => {
    const principal = need(ctx, 'period.close');
    const input = ctx.body(v.object({ reason: v.text({ max: 500 }) }));
    const result = await pool.transaction(tx => reverseOpening(tx, {
      societyId: principal.societyId, batchId: ctx.params.id, reason: input.reason,
      userId: principal.userId, userLabel: principal.email, requestId: ctx.requestId,
    }));
    return ok({
      id: ctx.params.id, state: 'reversed', ...result,
      note: 'Reversed. Both entries stay in the ledger; enter the corrected opening balances as a new draft.',
    });
  });

  // --- applying advances -----------------------------------------------------

  const applyAdvances = route('POST', '/api/advances/apply', async (ctx) => {
    const principal = who(ctx);
    // A ledger adjustment between a member's own accounts. The office records
    // receipts and the treasurer converts bills; either may set an advance
    // against a bill that has been raised.
    if (!hasPermission(principal, 'payment.record') && !hasPermission(principal, 'billing.convert')) {
      throw new ForbiddenError('Applying an advance needs the right to record payments or to convert bills.');
    }
    const input = ctx.body(v.object({
      on: v.isoDate(),
      /** One flat; all flats holding an advance when absent. */
      flatId: v.uuid().optional(),
    }));

    const results = await pool.transaction(async (tx) => {
      let targets: Array<{ flatId: string; flatNo: string }>;
      if (input.flatId !== undefined) {
        const flat = await tx.query<{ flat_no: string }>(
          'SELECT flat_no FROM flats WHERE id = $1 AND society_id = $2',
          [input.flatId, principal.societyId],
        );
        if (flat.rows[0] === undefined) throw notFound('That flat');
        targets = [{ flatId: input.flatId, flatNo: flat.rows[0].flat_no }];
      } else {
        targets = await flatsWithAdvances(tx, principal.societyId, input.on);
      }
      const applied = [];
      for (const t of targets) {
        const result = await applyAdvance(tx, {
          societyId: principal.societyId, flatId: t.flatId, flatNo: t.flatNo, on: input.on,
          postedBy: principal.userId, postedByLabel: principal.email,
        });
        if (result.appliedPaise > 0) applied.push(result);
      }
      if (applied.length > 0) {
        await audit(tx, {
          societyId: principal.societyId,
          actorUser: principal.userId,
          actorLabel: principal.email,
          action: 'advance.apply',
          subjectTable: 'journal_entries',
          subjectId: input.flatId ?? 'all-flats',
          detail: {
            on: input.on,
            flats: applied.length,
            appliedPaise: applied.reduce((s, a) => s + a.appliedPaise, 0),
          },
          requestId: ctx.requestId,
        });
      }
      return applied;
    });

    return ok({
      on: input.on,
      flats: results.length,
      appliedPaise: results.reduce((s, r) => s + r.appliedPaise, 0),
      applications: results,
    });
  });

  // --- the society's profile ---------------------------------------------------

  const getSociety = route('GET', '/api/society', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const profile = await readProfile(pool, principal.societyId);
    return ok({ ...profile, canEdit: hasPermission(principal, 'settings.manage') });
  });

  const putSociety = route('PUT', '/api/society', async (ctx) => {
    const principal = need(ctx, 'settings.manage');
    const input = ctx.body(v.object({
      name: v.string({ min: 1, max: 200 }),
      registrationNo: v.string({ max: 100 }).optional(),
      gstin: v.string({ max: 20 }).optional(),
      stateCode: v.string({ max: 2 }).optional(),
      tan: v.string({ max: 20 }).optional(),
      address: v.string({ max: 500 }).optional(),
      contactEmail: v.string({ max: 320 }).optional(),
      contactPhone: v.string({ max: 20 }).optional(),
    }));
    const upper = (s: string | undefined): string | null => blankToNull(s)?.toUpperCase().replace(/\s+/g, '') ?? null;
    const next = {
      name: input.name.trim().replace(/\s+/g, ' '),
      registrationNo: blankToNull(input.registrationNo),
      gstin: upper(input.gstin),
      stateCode: blankToNull(input.stateCode),
      tan: upper(input.tan),
      address: blankToNull(input.address),
      contactEmail: blankToNull(input.contactEmail)?.toLowerCase() ?? null,
      contactPhone: blankToNull(input.contactPhone),
    };
    const problems = validateProfile(next);
    if (problems.length > 0) {
      throw new HttpError(400, problems.map(p => p.message).join(' '), problems);
    }

    const result = await pool.transaction(async (tx) => {
      const before = await readProfile(tx, principal.societyId);
      const changes = await writeProfile(tx, principal.societyId, before, next);
      if (changes.length > 0) {
        await audit(tx, {
          societyId: principal.societyId,
          actorUser: principal.userId,
          actorLabel: principal.email,
          action: 'society.profile',
          subjectTable: 'societies',
          subjectId: principal.societyId,
          // The society's own registrations are printed on every invoice it
          // issues, so recording their before and after discloses nothing; the
          // log's redaction of a bare `gstin` key is aimed at members' data,
          // which is why the values sit under neutral keys here.
          detail: { changes },
          requestId: ctx.requestId,
        });
      }
      return { profile: await readProfile(tx, principal.societyId), changes };
    });

    return ok({
      ...result.profile,
      canEdit: true,
      changed: result.changes.map(c => c.field),
      note: result.changes.length === 0
        ? 'Nothing changed.'
        : 'Saved. Documents generated from now on carry these details; one already issued keeps the details it was issued with.',
    });
  });

  return [
    importFlatsRoute,
    readOpeningRoute, saveOpening, discardOpening, approveOpening, reverseOpeningRoute,
    applyAdvances,
    getSociety, putSociety,
  ];
}
