/**
 * The API.
 *
 * Every route states the permission it needs and reads the flats the caller
 * may see from the principal, not from the request. A resident asking for
 * another flat's invoice is refused here, on the server, whatever the front
 * end sent.
 *
 * Money-moving routes take an Idempotency-Key header and that key reaches the
 * database as a unique constraint, so a retried request is a no-op rather than
 * a second payment.
 *
 * Nothing in this file claims an external effect. Releasing an invoice records
 * a dispatch attempt with `delivered` set by the provider's answer; with no
 * provider configured that is false, and the response says so.
 */

import type { PgPool } from './pg';
import type { Config } from './config';
import type { Logger } from './logger';
import type { AuthService } from './auth';
import type { EmailProvider } from './providers/email';
import type { BankApiProvider } from './providers/bank';
import { StatementFormatError, parseStatement } from './providers/bank';
import { badRequest, conflict, notFound, route, type RequestContext, type Reply, type RouteDefinition } from './http';
import { v } from './validate';
import {
  clearCookie, csrfCookie, sessionCookie, sha256, SESSION_COOKIE,
} from './security';
import {
  permissionsOf, readableFlats, requireFlatAccess, requirePermission,
  type Permission, type Principal,
} from './rbac';
import { audit, readAudit } from './audit';
import {
  A, accountBalance, bookVendorBill, convertToTaxInvoice, financialYearStart, outstandingDocuments,
  payVendor, recordReceipt, remitTds, reverseEntry, tdsQuarter,
} from './posting';
import { percentOf } from '../../src/accounting/money';
import { listDocuments, runBilling } from './billing';
import { cancellationCreditNote } from './documents';
import { allocateNumber, lockFlatBalance } from './series';
import { isoDateInIndia } from '../../src/accounting/clock';
import {
  ageing, balanceSheet, collectionSummary, gstSummary, incomeAndExpenditure, memberStatement,
  tdsSummary, trialBalance,
} from './reports';
import { gstTreatment, invoicePrefix, readSettings, writeSetting } from './settings';

export interface RouteDependencies {
  readonly pool: PgPool;
  readonly config: Config;
  readonly log: Logger;
  readonly auth: AuthService;
  readonly email: EmailProvider;
  readonly bankApi: BankApiProvider;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const created = (body: unknown): Reply => ({ status: 201, body });

/** The principal on an authenticated route. */
function who(ctx: RequestContext): Principal {
  if (ctx.principal === null) {
    // Unreachable through the router, which refuses an unauthenticated request
    // to a route marked authenticated. Thrown rather than asserted so a future
    // route that forgets the flag fails loudly instead of running as nobody.
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
 * The caller's idempotency key.
 *
 * Required, not optional, on anything that moves money. A client that does not
 * send one cannot be given at-most-once semantics, and silently generating one
 * server-side would defeat the purpose: the retry would get a fresh key and
 * take the money twice.
 */
function idempotencyKey(ctx: RequestContext): string {
  const header = ctx.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value.trim().length < 8) {
    throw badRequest(
      'This request needs an Idempotency-Key header of at least 8 characters. It is what ' +
      'makes a retry safe: the same key cannot take the money twice.',
    );
  }
  if (value.length > 200) throw badRequest('The Idempotency-Key header is too long.');
  return value.trim();
}

const today = (): string => isoDateInIndia(); // India's date, not UTC's: see clock.ts

/** `asAt` from the query string, defaulting to today. */
function asAtOf(ctx: RequestContext): string {
  const raw = ctx.query.get('asAt');
  if (raw === null) return today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw badRequest('asAt must be a date as YYYY-MM-DD.');
  return raw;
}

function dateRange(ctx: RequestContext): { from: string; to: string } {
  const to = ctx.query.get('to') ?? today();
  const from = ctx.query.get('from') ?? `${financialYearStart(to)}-04-01`; // the FY `to` is in
  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest(`${name} must be a date as YYYY-MM-DD.`);
  }
  if (from > to) throw badRequest('from is after to.');
  return { from, to };
}

export function createRoutes(deps: RouteDependencies): RouteDefinition[] {
  const { pool, config, auth } = deps;

  const cookieOptions = { secure: config.secureCookies, maxAgeSeconds: config.sessionTtlMinutes * 60 };

  // --- health and readiness ------------------------------------------------

  const health = route('GET', '/api/health', async () => {
    // Reports what it can prove. A database it cannot reach makes this
    // degraded, with the reason, rather than 200 with a cheerful body.
    // The driver's message goes to the log, not the body: this route needs no
    // sign-in, and a connection error can name the database host and user.
    let database: { reachable: boolean; detail?: string };
    try {
      const r = await pool.query<{ one: string }>('SELECT 1::text AS one');
      database = { reachable: r.rows[0]?.one === '1' };
    } catch (err) {
      deps.log.error('health check could not reach the database', {
        error: err instanceof Error ? err.message : 'unknown',
      });
      database = { reachable: false, detail: 'The database could not be reached.' };
    }

    const migrations = database.reachable
      ? (await pool.query<{ version: string }>(
          'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
        )).rows[0]?.version ?? null
      : null;

    // Whether the connection to the database is encrypted, and nothing else
    // about it. The host, the user and the cipher are behind a permission:
    // this endpoint is unauthenticated, and an unauthenticated endpoint should
    // not name the database server.
    const security = pool.connectionSecurity;

    return {
      status: database.reachable ? 200 : 503,
      body: {
        status: database.reachable ? 'ok' : 'degraded',
        mode: config.mode,
        database: {
          ...database,
          ...(security === null ? {} : { encrypted: security.encrypted }),
        },
        schemaVersion: migrations,
        // Named for what they do, so nothing reads as connected when it is not.
        providers: {
          otp: config.otpProvider,
          email: deps.email.name,
          emailDelivers: deps.email.delivers,
          bankApi: deps.bankApi.name,
        },
        pool: pool.stats,
      },
    };
  }, { authenticated: false });

  /**
   * The database connection, in detail, for whoever runs the deployment.
   *
   * Behind `report.read` because it names the host and the user. It carries no
   * password and no connection string — `describeConnection` reports whether a
   * password is configured, never what it is.
   */
  const databaseReport = route('GET', '/api/system/database', async (ctx) => {
    need(ctx, 'report.read');

    const server = await pool.query<{
      version: string; database: string; user: string; now: string;
    }>(
      `SELECT version() AS version, current_database() AS database,
              current_user AS user, now()::text AS now`,
    );
    const migrations = await pool.query<{ version: string; applied_at: string }>(
      'SELECT version, applied_at::text FROM schema_migrations ORDER BY version',
    );
    const security = pool.connectionSecurity;

    return ok({
      connection: pool.describe,
      // From the connection itself, not from the configuration.
      encrypted: security?.encrypted ?? null,
      cipher: security?.cipher ?? null,
      authMechanism: security?.authMechanism ?? null,
      server: {
        version: server.rows[0]?.version ?? null,
        database: server.rows[0]?.database ?? null,
        user: server.rows[0]?.user ?? null,
        time: server.rows[0]?.now ?? null,
      },
      migrations: migrations.rows.map(r => ({ version: r.version, appliedAt: r.applied_at })),
      pool: pool.stats,
    });
  });

  // --- authentication ------------------------------------------------------

  const requestCode = route('POST', '/api/auth/request-code', async (ctx) => {
    const input = ctx.body(v.object({ email: v.email() }));
    const result = await auth.startSignIn({ email: input.email, ip: ctx.ip });
    return ok(result);
  }, { authenticated: false, csrfExempt: true });

  const verifyCode = route('POST', '/api/auth/verify-code', async (ctx) => {
    const input = ctx.body(v.object({
      email: v.email(),
      code: v.string({ min: 6, max: 10, pattern: /^[0-9]+$/, patternName: 'digits' }),
    }));
    const userAgent = ctx.headers['user-agent'];
    const result = await auth.completeSignIn({
      email: input.email,
      code: input.code,
      ip: ctx.ip,
      ...(typeof userAgent === 'string' ? { userAgent } : {}),
    });
    return signedIn(result);
  }, { authenticated: false, csrfExempt: true });

  const passwordSignIn = route('POST', '/api/auth/password', async (ctx) => {
    const input = ctx.body(v.object({
      email: v.email(),
      password: v.string({ min: 8, max: 200 }),
    }));
    const userAgent = ctx.headers['user-agent'];
    const result = await auth.signInWithPassword({
      email: input.email,
      password: input.password,
      ip: ctx.ip,
      ...(typeof userAgent === 'string' ? { userAgent } : {}),
    });
    return signedIn(result);
  }, { authenticated: false, csrfExempt: true });

  function signedIn(result: {
    principal: Principal; sessionToken: string; csrfToken: string; expiresAt: string;
  }): Reply {
    return {
      status: 200,
      headers: {
        'Set-Cookie': [
          sessionCookie(result.sessionToken, cookieOptions),
          csrfCookie(result.csrfToken, cookieOptions),
        ],
      },
      body: {
        // The token itself is never in the body: it is in an HttpOnly cookie,
        // so a script that reads the response cannot read the session.
        user: {
          email: result.principal.email,
          roles: result.principal.roles,
          permissions: permissionsOf(result.principal),
          flatIds: result.principal.flatIds,
        },
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt,
      },
    };
  }

  const signOut = route('POST', '/api/auth/sign-out', async (ctx) => {
    await auth.signOut(ctx.cookies[SESSION_COOKIE]);
    return {
      status: 200,
      headers: {
        'Set-Cookie': [
          clearCookie(SESSION_COOKIE, config.secureCookies),
          clearCookie('sb_csrf', config.secureCookies),
        ],
      },
      body: { signedOut: true },
    };
  });

  const me = route('GET', '/api/auth/me', async (ctx) => {
    const principal = who(ctx);
    const flats = await pool.query<{ id: string; flat_no: string }>(
      principal.flatIds.length === 0
        ? 'SELECT id, flat_no FROM flats WHERE false'
        : `SELECT id, flat_no FROM flats WHERE id IN (${
            principal.flatIds.map((_, i) => `$${i + 1}`).join(',')
          }) ORDER BY flat_no`,
      [...principal.flatIds],
    );
    return ok({
      email: principal.email,
      societyId: principal.societyId,
      roles: principal.roles,
      permissions: permissionsOf(principal),
      flats: flats.rows.map(f => ({ id: f.id, flatNo: f.flat_no })),
    });
  });

  // --- reference data ------------------------------------------------------

  const listFlats = route('GET', '/api/flats', async (ctx) => {
    const principal = who(ctx);
    const visible = readableFlats(principal, 'invoice.read.any');
    const params: string[] = [principal.societyId];
    let filter = '';
    if (visible !== null) {
      if (visible.length === 0) return ok({ flats: [] });
      filter = ` AND f.id IN (${visible.map(id => {
        params.push(id);
        return `$${params.length}`;
      }).join(',')})`;
    }
    const result = await pool.query<{
      id: string; flat_no: string; wing: string | null; floor: string | null;
      billing_area_sqft: string | null; area_basis: string | null; non_occupied: string;
      owner: string | null;
    }>(
      `SELECT f.id, f.flat_no, f.wing, f.floor::text, f.billing_area_sqft::text,
              f.area_basis, f.non_occupied::text,
              (SELECT o.full_name FROM flat_ownership fo
                 JOIN owners o ON o.id = fo.owner_id
                WHERE fo.flat_id = f.id AND fo.role = 'owner' AND fo.held_until IS NULL
                LIMIT 1) AS owner
         FROM flats f
        WHERE f.society_id = $1${filter}
        ORDER BY f.flat_no`,
      params,
    );
    return ok({
      flats: result.rows.map(r => ({
        id: r.id,
        flatNo: r.flat_no,
        wing: r.wing,
        floor: r.floor === null ? null : Number(r.floor),
        billingAreaSqFt: r.billing_area_sqft === null ? null : Number(r.billing_area_sqft),
        areaBasis: r.area_basis,
        nonOccupied: r.non_occupied === 't' || r.non_occupied === 'true',
        owner: r.owner,
        // Said plainly, because a flat in this state cannot be billed and the
        // screen should show why rather than an empty row.
        billable: r.billing_area_sqft !== null && r.area_basis !== null,
      })),
    });
  });

  // --- settings and rates --------------------------------------------------

  const getSettings = route('GET', '/api/settings', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const rows = await readSettings(pool, principal.societyId);
    return ok({
      settings: rows.map(r => ({
        key: r.key,
        value: r.value,
        // Shown, not hidden: an unapproved treatment is the reason billing
        // will refuse, and the screen needs to be able to say so.
        approved: r.approvedBy !== null,
        approvedOn: r.approvedOn,
        note: r.note,
        updatedAt: r.updatedAt,
      })),
    });
  });

  const putSetting = route('PUT', '/api/settings/:key', async (ctx) => {
    const principal = need(ctx, 'settings.manage');
    const input = ctx.body(v.object({
      value: v.json(),
      note: v.text({ max: 500 }).optional(),
    }));

    await pool.transaction(async (tx) => {
      // Written without an approval. Approving is a separate call by a
      // different person, which is what keeps "the committee agreed 5%" and
      // "someone typed 5%" apart. Changing a value also drops any earlier
      // sign-off, in writeSetting.
      await writeSetting(tx, {
        societyId: principal.societyId,
        key: ctx.params.key,
        value: input.value,
        note: input.note ?? null,
        requestedBy: principal.userId,
      });
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'settings.manage',
        subjectTable: 'society_settings',
        subjectId: ctx.params.key,
        detail: { value: input.value },
        requestId: ctx.requestId,
      });
    });
    return ok({ key: ctx.params.key, value: input.value, approved: false });
  });

  const approveSetting = route('POST', '/api/settings/:key/approve', async (ctx) => {
    const principal = need(ctx, 'rate.approve');
    const input = ctx.body(v.object({
      on: v.isoDate(),
      note: v.text({ max: 500 }).optional(),
    }));

    const result = await pool.transaction(async (tx) => {
      const existing = await tx.query<{ value: string; approved_by: string | null; requested_by: string | null }>(
        `SELECT value::text, approved_by, requested_by FROM society_settings
          WHERE society_id = $1 AND key = $2`,
        [principal.societyId, ctx.params.key],
      );
      const row = existing.rows[0];
      if (row === undefined) throw notFound(`Setting ${ctx.params.key}`);
      if (row.approved_by === principal.userId) {
        throw conflict('That setting is already approved by this account.');
      }
      if (row.requested_by === principal.userId) {
        // Maker-checker: the person who typed the value cannot also be the
        // person who says the committee agreed to it.
        throw conflict('A setting has to be approved by someone other than the person who set it.');
      }
      await tx.query(
        `UPDATE society_settings SET approved_by = $1, approved_on = $2, note = COALESCE($3, note)
          WHERE society_id = $4 AND key = $5`,
        [principal.userId, input.on, input.note ?? null, principal.societyId, ctx.params.key],
      );
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'settings.approve',
        subjectTable: 'society_settings',
        subjectId: ctx.params.key,
        detail: { value: JSON.parse(row.value), on: input.on },
        requestId: ctx.requestId,
      });
      return { key: ctx.params.key, approved: true, approvedOn: input.on };
    });
    return ok(result);
  });

  const listRates = route('GET', '/api/rates', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const result = await pool.query<{
      id: string; rate_paise_per_sqft: string; area_basis: string; effective_from: string;
      authority: string; approved_by: string | null; approved_on: string | null;
    }>(
      `SELECT id, rate_paise_per_sqft::text, area_basis, effective_from::text, authority,
              approved_by, approved_on::text
         FROM maintenance_rates WHERE society_id = $1 ORDER BY effective_from DESC`,
      [principal.societyId],
    );
    return ok({
      rates: result.rows.map(r => ({
        id: r.id,
        paisePerSqFt: Number(r.rate_paise_per_sqft),
        ratePerSqFt: Number(r.rate_paise_per_sqft) / 100,
        basis: r.area_basis,
        effectiveFrom: r.effective_from,
        authority: r.authority,
        approved: r.approved_by !== null,
        approvedOn: r.approved_on,
      })),
    });
  });

  const addRate = route('POST', '/api/rates', async (ctx) => {
    const principal = need(ctx, 'settings.manage');
    const input = ctx.body(v.object({
      paisePerSqFt: v.paise({ min: 1 }),
      basis: v.enumOf(['carpet', 'built-up', 'super-built-up'] as const),
      effectiveFrom: v.isoDate(),
      authority: v.text({ max: 300 }),
    }));

    const result = await pool.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO maintenance_rates
           (society_id, rate_paise_per_sqft, area_basis, effective_from, authority, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [principal.societyId, input.paisePerSqFt, input.basis, input.effectiveFrom, input.authority,
         principal.userId],
      );
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'rate.add',
        subjectTable: 'maintenance_rates',
        subjectId: inserted.rows[0].id,
        detail: { ...input },
        requestId: ctx.requestId,
      });
      return inserted.rows[0].id;
    });

    return created({
      id: result,
      approved: false,
      // Said at the point of creation, because this is the step people forget
      // and the billing run's refusal is otherwise puzzling.
      note: 'Recorded but not approved. A billing run refuses to use an unapproved rate.',
    });
  });

  const approveRate = route('POST', '/api/rates/:id/approve', async (ctx) => {
    const principal = need(ctx, 'rate.approve');
    const input = ctx.body(v.object({ on: v.isoDate() }));

    await pool.transaction(async (tx) => {
      const found = await tx.query<{ effective_from: string; approved_by: string | null; requested_by: string | null }>(
        `SELECT effective_from::text, approved_by, requested_by FROM maintenance_rates
          WHERE id = $1 AND society_id = $2`,
        [ctx.params.id, principal.societyId],
      );
      const rate = found.rows[0];
      if (rate === undefined) throw notFound('That rate');
      if (rate.approved_by !== null) throw conflict('That rate is already approved.');
      if (rate.requested_by === principal.userId) {
        throw conflict('A rate has to be approved by someone other than the person who entered it.');
      }

      await tx.query(
        'UPDATE maintenance_rates SET approved_by = $1, approved_on = $2 WHERE id = $3',
        [principal.userId, input.on, ctx.params.id],
      );
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'rate.approve',
        subjectTable: 'maintenance_rates',
        subjectId: ctx.params.id,
        detail: { effectiveFrom: rate.effective_from, on: input.on },
        requestId: ctx.requestId,
      });
    });

    return ok({ id: ctx.params.id, approved: true });
  });

  // --- billing -------------------------------------------------------------

  const billingRun = route('POST', '/api/billing/run', async (ctx) => {
    const principal = need(ctx, 'billing.run');
    const input = ctx.body(v.object({
      period: v.period(),
      issuedOn: v.isoDate(),
      flatIds: v.array(v.uuid(), { max: 2000 }).optional(),
    }));

    const result = await pool.transaction(async (tx) => {
      const run = await runBilling(tx, {
        societyId: principal.societyId,
        period: input.period,
        issuedOn: input.issuedOn,
        requestedBy: principal.userId,
        ...(input.flatIds !== undefined ? { flatIds: input.flatIds } : {}),
      });
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'billing.run',
        subjectTable: 'billing_documents',
        subjectId: input.period,
        detail: {
          issued: run.issued.length,
          skipped: run.skipped.length,
          grossPaise: run.totals.gross,
        },
        requestId: ctx.requestId,
      });
      return run;
    });

    return created({
      ...result,
      // Said rather than implied: a proforma has no accounting effect, and the
      // committee should not read this response as "the month is billed".
      posted: false,
      note:
        'Proformas issued. Nothing has been posted to the ledger and no invoice has been ' +
        'sent: a proforma becomes a tax invoice on payment or on its due date.',
    });
  });

  const listBillingDocuments = route('GET', '/api/billing/documents', async (ctx) => {
    const principal = who(ctx);
    const visible = readableFlats(principal, 'invoice.read.any');
    if (visible === null) requirePermission(principal, 'invoice.read.any');
    else requirePermission(principal, 'invoice.read.own');

    const period = ctx.query.get('period');
    const state = ctx.query.get('state');
    const documents = await listDocuments(pool, {
      societyId: principal.societyId,
      asAt: asAtOf(ctx),
      flatIds: visible,
      ...(period !== null ? { period } : {}),
      ...(state !== null ? { state } : {}),
    });
    return ok({ documents });
  });

  const approveDocument = route('POST', '/api/billing/documents/:id/approve', async (ctx) => {
    const principal = need(ctx, 'billing.approve');
    const input = ctx.body(v.object({ on: v.isoDate() }));

    const result = await pool.transaction(async (tx) => {
      const found = await tx.query<{
        state: string; proforma_no: string; issued_on: string; approved_by: string | null;
      }>(
        `SELECT state, proforma_no, issued_on::text, approved_by FROM billing_documents
          WHERE id = $1 AND society_id = $2`,
        [ctx.params.id, principal.societyId],
      );
      const doc = found.rows[0];
      if (doc === undefined) throw notFound('That document');
      if (doc.state === 'cancelled') throw conflict('That document was cancelled.');
      if (doc.approved_by !== null) throw conflict('That document is already approved.');
      if (input.on < doc.issued_on) {
        throw badRequest(`An approval cannot be dated before the proforma's ${doc.issued_on}.`);
      }

      // The maker-checker decision. The CHECK on approvals refuses a decider
      // who is the requester, so this UPDATE is what fails — at the database —
      // if the person who ran the billing tries to approve their own run.
      const decision = await tx.query(
        `UPDATE approvals
            SET decided_by = $1, decided_at = now(), decision = 'approved'
          WHERE society_id = $2 AND subject_table = 'billing_documents'
            AND subject_id = $3 AND decision IS NULL`,
        [principal.userId, principal.societyId, ctx.params.id],
      );
      if (decision.rowCount === 0) {
        throw conflict('There is no pending approval request for that document.');
      }

      await tx.query(
        `UPDATE billing_documents SET state = 'approved', approved_by = $1, approved_on = $2
          WHERE id = $3`,
        [principal.userId, input.on, ctx.params.id],
      );
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'billing.approve',
        subjectTable: 'billing_documents',
        subjectId: ctx.params.id,
        detail: { proformaNo: doc.proforma_no, on: input.on },
        requestId: ctx.requestId,
      });
      return { proformaNo: doc.proforma_no };
    });

    return ok({ id: ctx.params.id, state: 'approved', ...result });
  });

  const releaseDocument = route('POST', '/api/billing/documents/:id/release', async (ctx) => {
    const principal = need(ctx, 'billing.release');
    const input = ctx.body(v.object({
      channel: v.enumOf(['email', 'in-app'] as const),
    }));

    const result = await pool.transaction(async (tx) => {
      const found = await tx.query<{
        proforma_no: string; state: string; period: string; gross: string;
        flat_no: string; owner_email: string | null;
      }>(
        `SELECT d.proforma_no, d.state, d.period, d.gross::text, f.flat_no,
                (SELECT o.email FROM flat_ownership fo
                   JOIN owners o ON o.id = fo.owner_id
                  WHERE fo.flat_id = d.flat_id AND fo.role = 'owner' AND fo.held_until IS NULL
                  LIMIT 1) AS owner_email
           FROM billing_documents d JOIN flats f ON f.id = d.flat_id
          WHERE d.id = $1 AND d.society_id = $2`,
        [ctx.params.id, principal.societyId],
      );
      const doc = found.rows[0];
      if (doc === undefined) throw notFound('That document');
      if (doc.state === 'draft') throw conflict('That document has not been approved yet.');
      if (doc.state === 'cancelled') throw conflict('That document was cancelled.');

      let delivered = false;
      let channel = input.channel;
      let providerId: string | null = null;
      let failure: string | null = null;
      let note: string;

      if (input.channel === 'email') {
        if (doc.owner_email === null) {
          channel = 'in-app';
          note = 'No current owner email on record, so nothing was emailed.';
          failure = 'no-recipient';
        } else if (!deps.email.delivers) {
          note =
            `No email provider is configured (${deps.email.name}), so nothing was sent. ` +
            `The document is available to the member in the app.`;
          failure = 'provider-not-configured';
        } else {
          try {
            const sent = await deps.email.send({
              to: doc.owner_email,
              subject: `Maintenance bill ${doc.proforma_no} — flat ${doc.flat_no}, ${doc.period}`,
              text:
                `Proforma ${doc.proforma_no} for flat ${doc.flat_no}, ${doc.period}.\n` +
                `Amount: ${(Number(doc.gross) / 100).toFixed(2)} INR.\n` +
                `This is a proforma invoice. A tax invoice is issued on payment or on the due date.`,
            });
            // Only now, and only because a provider said so.
            delivered = true;
            providerId = sent.providerMessageId;
            note = `Emailed via ${sent.provider}.`;
          } catch (err) {
            failure = err instanceof Error ? err.message : 'send failed';
            note = `The provider refused the message: ${failure}`;
          }
        }
      } else {
        note = 'Released in the app. Nothing was emailed.';
      }

      await tx.query(
        `INSERT INTO dispatch_attempts
           (document_id, by_user, channel, delivered, provider_id, failure, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ctx.params.id, principal.userId, channel, delivered, providerId, failure, note],
      );
      if (doc.state === 'approved') {
        await tx.query(`UPDATE billing_documents SET state = 'released' WHERE id = $1`, [ctx.params.id]);
      }
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'billing.release',
        subjectTable: 'billing_documents',
        subjectId: ctx.params.id,
        detail: { channel, delivered, failure },
        requestId: ctx.requestId,
      });

      return { delivered, channel, note };
    });

    return ok({ id: ctx.params.id, state: 'released', ...result });
  });

  const convertDocument = route('POST', '/api/billing/documents/:id/convert', async (ctx) => {
    const principal = need(ctx, 'billing.convert');
    const input = ctx.body(v.object({
      on: v.isoDate(),
      because: v.enumOf(['payment-received', 'due-date-reached', 'manual'] as const),
    }));

    const result = await pool.transaction(async (tx) => {
      const gst = await gstTreatment(tx, principal.societyId);
      const prefix = await invoicePrefix(tx, principal.societyId);
      const converted = await convertToTaxInvoice(tx, {
        societyId: principal.societyId,
        documentId: ctx.params.id,
        on: input.on,
        because: input.because,
        postedBy: principal.userId,
        postedByLabel: principal.email,
        gst,
        invoicePrefix: prefix,
      });
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'billing.convert',
        subjectTable: 'billing_documents',
        subjectId: ctx.params.id,
        detail: {
          taxInvoiceNo: converted.taxInvoiceNo,
          grossPaise: converted.gross,
          because: input.because,
        },
        requestId: ctx.requestId,
      });
      return converted;
    });

    return ok({ ...result, posted: true });
  });

  const cancelDocument = route('POST', '/api/billing/documents/:id/cancel', async (ctx) => {
    const principal = need(ctx, 'billing.cancel');
    const input = ctx.body(v.object({
      reason: v.text({ max: 500 }),
      on: v.isoDate(),
    }));
    if (input.reason.trim() === '') throw badRequest('A cancellation needs a reason.');

    const result = await pool.transaction(async (tx) => {
      const found = await tx.query<{
        state: string; proforma_no: string; posted_entry_id: string | null;
        flat_id: string; tax_invoice_no: string | null; gross: string;
      }>(
        `SELECT state, proforma_no, posted_entry_id, flat_id, tax_invoice_no, gross::text
           FROM billing_documents
          WHERE id = $1 AND society_id = $2`,
        [ctx.params.id, principal.societyId],
      );
      const doc = found.rows[0];
      if (doc === undefined) throw notFound('That document');
      if (doc.state === 'cancelled') throw conflict('That document is already cancelled.');

      let reversalId: string | null = null;
      let creditNoteNo: string | null = null;
      if (doc.posted_entry_id !== null) {
        // Nothing may be settled against it. The reversal takes the whole
        // gross back out of the receivable; if a receipt (or a note) has
        // already taken some of it, what is left is a receivable below zero —
        // the society owing the member money that no account records as an
        // advance. The browser's register refuses this, and so does this now:
        // the receipt is reversed or the note undone first, deliberately.
        //
        // Read under the flat's lock, so a receipt cannot land between this
        // check and the reversal.
        await lockFlatBalance(tx, { societyId: principal.societyId, flatId: doc.flat_id });
        const outstanding = await accountBalance(tx, {
          societyId: principal.societyId,
          code: A.MAINTENANCE_RECEIVABLE,
          docRef: doc.tax_invoice_no as string,
        });
        const gross = Number(doc.gross);
        if (outstanding !== gross) {
          const settled = gross - outstanding;
          throw conflict(
            settled > 0
              ? `${doc.tax_invoice_no} has ${settled} paise received or credited against it. ` +
                `Reverse that receipt or note first; cancelling now would reverse the whole ` +
                `${gross} paise and leave the member's account below zero.`
              : `${doc.tax_invoice_no} carries ${-settled} paise of debit notes beyond the ` +
                `invoice. Reverse those first; cancelling now would leave them standing ` +
                `against a cancelled invoice.`,
          );
        }

        // A posted invoice is not unposted. It is reversed, and both entries
        // stay in the ledger.
        reversalId = await reverseEntry(tx, {
          societyId: principal.societyId,
          entryId: doc.posted_entry_id,
          date: input.on,
          reason: `Cancellation of ${doc.proforma_no}: ${input.reason}`,
          postedBy: principal.userId,
          postedByLabel: principal.email,
        });

        // And the register follows the ledger.
        //
        // Reversing the entry took the output tax out of the books and left
        // the invoice's row in `gst_register`, so a return built from the
        // register overstated the period by exactly the cancelled invoice. In
        // GST terms a cancellation of an issued invoice *is* a credit note,
        // so that is what this records: an adjustment for the whole invoice,
        // posted by the reversal, and a register row that nets it off.
        creditNoteNo = await cancellationCreditNote(tx, {
          societyId: principal.societyId,
          documentId: ctx.params.id,
          reversalEntryId: reversalId,
          on: input.on,
          reason: input.reason,
          by: principal.userId,
        });
      }

      await tx.query(
        `UPDATE billing_documents
            SET state = 'cancelled', cancelled_by = $1, cancelled_reason = $2
          WHERE id = $3`,
        [principal.userId, input.reason, ctx.params.id],
      );
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'billing.cancel',
        subjectTable: 'billing_documents',
        subjectId: ctx.params.id,
        detail: {
          reason: input.reason,
          reversalEntryId: reversalId,
          creditNoteNo,
        },
        requestId: ctx.requestId,
      });
      return { reversalEntryId: reversalId, creditNoteNo };
    });

    return ok({ id: ctx.params.id, state: 'cancelled', ...result });
  });

  // --- money in ------------------------------------------------------------

  const recordPayment = route('POST', '/api/payments', async (ctx) => {
    const principal = need(ctx, 'payment.record');
    const key = idempotencyKey(ctx);
    const input = ctx.body(v.object({
      flatId: v.uuid(),
      amountPaise: v.paise({ min: 1 }),
      receivedOn: v.isoDate(),
      method: v.enumOf(['upi', 'neft', 'imps', 'cheque', 'cash', 'nach', 'card'] as const),
      instrumentRef: v.text({ max: 100 }).optional(),
      bankAccountId: v.uuid().optional(),
      againstDocumentId: v.uuid().optional(),
    }));

    const result = await pool.transaction(async (tx) => {
      const flat = await tx.query<{ flat_no: string }>(
        'SELECT flat_no FROM flats WHERE id = $1 AND society_id = $2',
        [input.flatId, principal.societyId],
      );
      if (flat.rows[0] === undefined) throw notFound('That flat');

      // The flat's balance lock first, before the receipt series. The receipt
      // series is per month, so it did not serialise two receipts for one
      // flat dated in different months: both read the same open invoice and
      // both allocated against it. See lockFlatBalance.
      await lockFlatBalance(tx, { societyId: principal.societyId, flatId: input.flatId });

      // A receipt number per month, with the series locked so two payments
      // taken at the same moment cannot be given the same number. Before the
      // lock, seven of eight concurrent payments were refused on the unique
      // index — see series.ts.
      const month = input.receivedOn.slice(0, 7);
      const receiptNo = await allocateNumber(
        tx,
        { societyId: principal.societyId, kind: 'receipt', scope: month },
        async () => {
          const next = await tx.query<{ next: string }>(
            `SELECT COALESCE(MAX(NULLIF(regexp_replace(receipt_no, '^.*/', ''), '')::int), 0) + 1 AS next
               FROM payments WHERE society_id = $1 AND receipt_no LIKE $2`,
            [principal.societyId, `RC/${month}/%`],
          );
          return `RC/${month}/${String(next.rows[0].next).padStart(4, '0')}`;
        },
      );

      const receipt = await recordReceipt(tx, {
        societyId: principal.societyId,
        flatId: input.flatId,
        flatNo: flat.rows[0].flat_no,
        amount: input.amountPaise,
        receivedOn: input.receivedOn,
        method: input.method,
        receiptNo,
        idempotencyKey: key,
        bankAccountId: input.bankAccountId ?? null,
        instrumentRef: input.instrumentRef ?? null,
        postedBy: principal.userId,
        postedByLabel: principal.email,
        ...(input.againstDocumentId !== undefined
          ? { againstDocumentId: input.againstDocumentId }
          : {}),
        // A payment for a proforma converts it, as the browser's register
        // does; see recordReceipt.
        conversion: {
          gst: await gstTreatment(tx, principal.societyId),
          invoicePrefix: await invoicePrefix(tx, principal.societyId),
        },
      });

      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'payment.record',
        subjectTable: 'payments',
        subjectId: receipt.paymentId,
        detail: {
          receiptNo: receipt.receiptNo,
          amountPaise: input.amountPaise,
          appliedToDues: receipt.appliedToDues,
          heldAsAdvance: receipt.heldAsAdvance,
          converted: receipt.converted.map(c => c.taxInvoiceNo),
        },
        requestId: ctx.requestId,
      });
      return receipt;
    });

    return created({
      ...result,
      // The receipt records money the society says it has received. Nothing
      // here contacted a bank or a payment gateway.
      note:
        'Recorded in the books. This is a receipt for money already received; no bank or ' +
        'gateway was contacted by this request.',
    });
  });

  const listPayments = route('GET', '/api/payments', async (ctx) => {
    const principal = who(ctx);
    const visible = readableFlats(principal, 'payment.read.any');
    if (visible === null) requirePermission(principal, 'payment.read.any');
    else requirePermission(principal, 'payment.read.own');

    const params: Array<string | number> = [principal.societyId];
    let filter = '';
    if (visible !== null) {
      if (visible.length === 0) return ok({ payments: [] });
      filter = ` AND p.flat_id IN (${visible.map(id => {
        params.push(id);
        return `$${params.length}`;
      }).join(',')})`;
    }
    params.push(Number(ctx.query.get('limit') ?? 200));

    const result = await pool.query<{
      id: string; receipt_no: string; flat_no: string; received_on: string; amount: string;
      method: string; instrument_ref: string | null; allocations: string;
    }>(
      `SELECT p.id, p.receipt_no, f.flat_no, p.received_on::text, p.amount::text, p.method,
              p.instrument_ref,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'documentId', a.document_id,
                         'taxInvoiceNo', d.tax_invoice_no,
                         'amount', a.amount,
                         'head', a.head))
                  FROM receipt_allocations a
                  LEFT JOIN billing_documents d ON d.id = a.document_id
                 WHERE a.payment_id = p.id
              ), '[]'::json)::text AS allocations
         FROM payments p JOIN flats f ON f.id = p.flat_id
        WHERE p.society_id = $1${filter}
        ORDER BY p.received_on DESC, p.receipt_no DESC
        LIMIT $${params.length}`,
      params,
    );

    return ok({
      payments: result.rows.map(r => ({
        id: r.id,
        receiptNo: r.receipt_no,
        flatNo: r.flat_no,
        receivedOn: r.received_on,
        amountPaise: Number(r.amount),
        method: r.method,
        instrumentRef: r.instrument_ref,
        allocations: JSON.parse(r.allocations),
      })),
    });
  });

  const reversePayment = route('POST', '/api/payments/:id/reverse', async (ctx) => {
    const principal = need(ctx, 'payment.reverse');
    const input = ctx.body(v.object({
      on: v.isoDate(),
      reason: v.text({ max: 500 }),
    }));

    const result = await pool.transaction(async (tx) => {
      const found = await tx.query<{ receipt_no: string; posted_entry_id: string | null }>(
        'SELECT receipt_no, posted_entry_id FROM payments WHERE id = $1 AND society_id = $2',
        [ctx.params.id, principal.societyId],
      );
      const payment = found.rows[0];
      if (payment === undefined) throw notFound('That payment');
      if (payment.posted_entry_id === null) throw conflict('That payment was never posted.');

      // The payment row stays, and so do its allocations. What changes is the
      // ledger, by a mirror entry — which is why a bounced cheque leaves a
      // visible history rather than a gap.
      const reversalId = await reverseEntry(tx, {
        societyId: principal.societyId,
        entryId: payment.posted_entry_id,
        date: input.on,
        reason: `Reversal of receipt ${payment.receipt_no}: ${input.reason}`,
        postedBy: principal.userId,
        postedByLabel: principal.email,
      });
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'payment.reverse',
        subjectTable: 'payments',
        subjectId: ctx.params.id,
        detail: { receiptNo: payment.receipt_no, reason: input.reason, reversalEntryId: reversalId },
        requestId: ctx.requestId,
      });
      return { receiptNo: payment.receipt_no, reversalEntryId: reversalId };
    });

    return ok(result);
  });

  const flatDues = route('GET', '/api/flats/:id/dues', async (ctx) => {
    const principal = who(ctx);
    requireFlatAccess(principal, ctx.params.id, 'invoice.read.any');

    const asAt = asAtOf(ctx);
    const flat = await pool.query<{ flat_no: string }>(
      'SELECT flat_no FROM flats WHERE id = $1 AND society_id = $2',
      [ctx.params.id, principal.societyId],
    );
    if (flat.rows[0] === undefined) throw notFound('That flat');
    const flatNo = flat.rows[0].flat_no;

    const [open, advance, receivable] = await Promise.all([
      outstandingDocuments(pool, { societyId: principal.societyId, flatId: ctx.params.id, asAt }),
      accountBalance(pool, { societyId: principal.societyId, code: A.MEMBER_ADVANCE, party: flatNo, asAt }),
      accountBalance(pool, { societyId: principal.societyId, code: A.MAINTENANCE_RECEIVABLE, party: flatNo, asAt }),
    ]);

    return ok({
      flatNo,
      asAt,
      outstandingPaise: receivable,
      advancePaise: advance,
      // What the member actually owes once an advance on account is applied.
      netPayablePaise: receivable - advance,
      invoices: open,
    });
  });

  // --- money out -----------------------------------------------------------

  /**
   * Statutory withholding rates, in basis points.
   *
   * Here as a documented default rather than a silent constant: 194C is 2% for
   * a company and 1% for an individual or HUF, 194J and 194I are 10%. A bill
   * may override the rate — a lower-deduction certificate is a real thing —
   * and the override is recorded on the bill, which is what the TDS register
   * then reports.
   */
  const TDS_RATE_BPS: Record<string, { company: number; 'individual-or-huf': number }> = {
    '194C': { company: 200, 'individual-or-huf': 100 },
    '194J': { company: 1000, 'individual-or-huf': 1000 },
    '194I': { company: 1000, 'individual-or-huf': 1000 },
  };

  const listVendors = route('GET', '/api/vendors', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const result = await pool.query<{
      id: string; name: string; category: string; pan: string | null; gstin: string | null;
      tds_section: string | null; payee_kind: string | null; bank_last4: string | null;
      active: string; payable: string;
    }>(
      `SELECT v.id, v.name, v.category, v.pan, v.gstin, v.tds_section, v.payee_kind,
              v.bank_last4, v.active::text,
              COALESCE((
                SELECT SUM(p.credit - p.debit)
                  FROM journal_postings p
                 WHERE p.society_id = v.society_id
                   AND p.account_code = $2
                   -- The party on a vendor-payable leg is the vendor's id, not
                   -- its name: a renamed vendor must not orphan its balance.
                   AND p.party = v.id::text
              ), 0)::text AS payable
         FROM vendors v WHERE v.society_id = $1 ORDER BY v.name`,
      [principal.societyId, A.VENDOR_PAYABLE],
    );
    return ok({
      vendors: result.rows.map(r => ({
        id: r.id,
        name: r.name,
        category: r.category,
        pan: r.pan,
        gstin: r.gstin,
        tdsSection: r.tds_section,
        payeeKind: r.payee_kind,
        // Last four only. There is no column here for anything more, and
        // nothing in this system can initiate a bank transfer.
        bankLast4: r.bank_last4,
        active: r.active === 't' || r.active === 'true',
        payablePaise: Number(r.payable),
      })),
    });
  });

  const addVendor = route('POST', '/api/vendors', async (ctx) => {
    const principal = need(ctx, 'vendor.manage');
    const input = ctx.body(v.object({
      name: v.text({ max: 200 }),
      category: v.text({ max: 100 }),
      pan: v.string({ min: 10, max: 10, pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/, patternName: 'a PAN' }).optional(),
      gstin: v.string({ min: 15, max: 15 }).optional(),
      tdsSection: v.enumOf(['194C', '194J', '194I', 'none'] as const),
      payeeKind: v.enumOf(['company', 'individual-or-huf'] as const),
      bankLast4: v.string({ min: 4, max: 4, pattern: /^[0-9]{4}$/, patternName: 'four digits' }).optional(),
      bankIfsc: v.string({ min: 11, max: 11, pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/, patternName: 'an IFSC' }).optional(),
    }));

    const id = await pool.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO vendors
           (society_id, name, category, pan, gstin, tds_section, payee_kind, bank_last4, bank_ifsc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          principal.societyId, input.name, input.category, input.pan ?? null,
          input.gstin ?? null, input.tdsSection, input.payeeKind,
          input.bankLast4 ?? null, input.bankIfsc ?? null,
        ],
      );
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'vendor.manage',
        subjectTable: 'vendors',
        subjectId: inserted.rows[0].id,
        detail: { name: input.name, tdsSection: input.tdsSection },
        requestId: ctx.requestId,
      });
      return inserted.rows[0].id;
    });
    return created({ id });
  });

  const addVendorBill = route('POST', '/api/vendors/:id/bills', async (ctx) => {
    const principal = need(ctx, 'vendor.manage');
    const input = ctx.body(v.object({
      billNo: v.text({ max: 100 }),
      billDate: v.isoDate(),
      receivedOn: v.isoDate().optional(),
      expenseAccount: v.string({ min: 3, max: 10, pattern: /^[0-9]{4}$/, patternName: 'an account code' }),
      grossPaise: v.paise({ min: 1 }),
      inputGstPaise: v.paise({ min: 0 }).optional(),
      /** Overrides the statutory rate, for a lower-deduction certificate. */
      tdsRateBps: v.int({ min: 0, max: 3000 }).optional(),
    }));

    const result = await pool.transaction(async (tx) => {
      const vendor = await tx.query<{ name: string; tds_section: string | null; payee_kind: string | null }>(
        'SELECT name, tds_section, payee_kind FROM vendors WHERE id = $1 AND society_id = $2',
        [ctx.params.id, principal.societyId],
      );
      const found = vendor.rows[0];
      if (found === undefined) throw notFound('That vendor');

      const section = found.tds_section ?? 'none';
      const kind = found.payee_kind ?? 'company';
      const statutory = section === 'none'
        ? 0
        : TDS_RATE_BPS[section]?.[kind as 'company' | 'individual-or-huf'] ?? 0;
      const rateBps = input.tdsRateBps ?? statutory;
      if (section === 'none' && rateBps > 0) {
        throw badRequest(
          `${found.name} is recorded as not subject to withholding, so a rate cannot be applied. ` +
          `Correct the vendor's TDS section first.`,
        );
      }
      // Withholding is on the value of the service, not on the GST charged on
      // it: CBDT circular 23/2017 excludes GST shown separately on the bill.
      // It was on the whole gross, so every vendor charging GST had 18% more
      // withheld than the law asks, and the TDS register over-stated their
      // credit. Rounded half-up to the paisa by the engine's `percentOf` —
      // this was a truncating Math.floor, so the server and the browser
      // withheld a paisa apart on the same bill.
      const inputGst = input.inputGstPaise ?? 0;
      if (inputGst > input.grossPaise) {
        throw badRequest('The input GST on a bill cannot be more than its gross.');
      }
      const tdsBase = input.grossPaise - inputGst;
      const tds = rateBps === 0 || tdsBase === 0 ? 0 : percentOf(tdsBase, rateBps / 100);
      const net = input.grossPaise - tds;

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO vendor_bills
           (society_id, vendor_id, bill_no, bill_date, received_on, expense_account,
            gross, input_gst, tds_section, tds_rate_bps, tds_amount, net_payable, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'awaiting-approval')
         RETURNING id`,
        [
          principal.societyId, ctx.params.id, input.billNo, input.billDate,
          input.receivedOn ?? null, input.expenseAccount, input.grossPaise,
          input.inputGstPaise ?? 0, section, rateBps, tds, net,
        ],
      );
      const billId = inserted.rows[0].id;

      // Maker-checker again: whoever entered the bill cannot approve it.
      await tx.query(
        `INSERT INTO approvals (society_id, subject_table, subject_id, requested_by)
         VALUES ($1, 'vendor_bills', $2, $3)`,
        [principal.societyId, billId, principal.userId],
      );
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'vendor.bill.enter',
        subjectTable: 'vendor_bills',
        subjectId: billId,
        detail: { billNo: input.billNo, grossPaise: input.grossPaise, tdsPaise: tds, rateBps },
        requestId: ctx.requestId,
      });

      return { id: billId, tdsPaise: tds, netPayablePaise: net, tdsRateBps: rateBps, state: 'awaiting-approval' };
    });

    return created({
      ...result,
      posted: false,
      note: 'Entered for approval. Nothing is in the ledger until the bill is booked.',
    });
  });

  const listVendorBills = route('GET', '/api/vendor-bills', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const state = ctx.query.get('state');
    const params: Array<string | number> = [principal.societyId];
    let filter = '';
    if (state !== null) {
      params.push(state);
      filter = ` AND b.state = $${params.length}`;
    }
    const result = await pool.query<{
      id: string; bill_no: string; vendor: string; bill_date: string; gross: string;
      tds_amount: string; net_payable: string; state: string; expense_account: string;
      paid: string;
    }>(
      `SELECT b.id, b.bill_no, v.name AS vendor, b.bill_date::text, b.gross::text,
              b.tds_amount::text, b.net_payable::text, b.state, b.expense_account,
              COALESCE((SELECT SUM(amount) FROM vendor_payments vp WHERE vp.bill_id = b.id), 0)::text AS paid
         FROM vendor_bills b JOIN vendors v ON v.id = b.vendor_id
        WHERE b.society_id = $1${filter}
        ORDER BY b.bill_date DESC`,
      params,
    );
    return ok({
      bills: result.rows.map(r => ({
        id: r.id,
        billNo: r.bill_no,
        vendor: r.vendor,
        billDate: r.bill_date,
        grossPaise: Number(r.gross),
        tdsPaise: Number(r.tds_amount),
        netPayablePaise: Number(r.net_payable),
        paidPaise: Number(r.paid),
        state: r.state,
        expenseAccount: r.expense_account,
      })),
    });
  });

  const approveVendorBill = route('POST', '/api/vendor-bills/:id/approve', async (ctx) => {
    const principal = need(ctx, 'vendor.bill.approve');

    await pool.transaction(async (tx) => {
      const found = await tx.query<{ state: string; bill_no: string }>(
        'SELECT state, bill_no FROM vendor_bills WHERE id = $1 AND society_id = $2',
        [ctx.params.id, principal.societyId],
      );
      const bill = found.rows[0];
      if (bill === undefined) throw notFound('That bill');
      if (bill.state !== 'awaiting-approval') {
        throw conflict(`That bill is ${bill.state}, so it cannot be approved now.`);
      }

      const decision = await tx.query(
        `UPDATE approvals SET decided_by = $1, decided_at = now(), decision = 'approved'
          WHERE society_id = $2 AND subject_table = 'vendor_bills'
            AND subject_id = $3 AND decision IS NULL`,
        [principal.userId, principal.societyId, ctx.params.id],
      );
      if (decision.rowCount === 0) {
        throw conflict('There is no pending approval request for that bill.');
      }

      await tx.query(
        `UPDATE vendor_bills SET state = 'approved', approved_by = $1 WHERE id = $2`,
        [principal.userId, ctx.params.id],
      );
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'vendor.bill.approve',
        subjectTable: 'vendor_bills',
        subjectId: ctx.params.id,
        detail: { billNo: bill.bill_no },
        requestId: ctx.requestId,
      });
    });

    return ok({
      id: ctx.params.id,
      state: 'approved',
      posted: false,
      note: 'Approved. Still not in the ledger: booking is the next, separate step.',
    });
  });

  const bookVendorBillRoute = route('POST', '/api/vendor-bills/:id/book', async (ctx) => {
    const principal = need(ctx, 'vendor.bill.book');
    const input = ctx.body(v.object({ on: v.isoDate() }));

    const entryId = await pool.transaction(async (tx) => {
      const id = await bookVendorBill(tx, {
        societyId: principal.societyId,
        billId: ctx.params.id,
        on: input.on,
        postedBy: principal.userId,
        postedByLabel: principal.email,
      });
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'vendor.bill.book',
        subjectTable: 'vendor_bills',
        subjectId: ctx.params.id,
        detail: { entryId: id, on: input.on },
        requestId: ctx.requestId,
      });
      return id;
    });

    return ok({
      id: ctx.params.id,
      state: 'booked',
      entryId,
      posted: true,
      note: 'Expense and payable recorded. The bank has not moved: paying is a separate step.',
    });
  });

  const payVendorBill = route('POST', '/api/vendor-bills/:id/pay', async (ctx) => {
    const principal = need(ctx, 'vendor.pay');
    const key = idempotencyKey(ctx);
    const input = ctx.body(v.object({
      amountPaise: v.paise({ min: 1 }),
      paidOn: v.isoDate(),
      method: v.enumOf(['neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash'] as const),
      paymentRef: v.text({ max: 100 }),
      bankAccountId: v.uuid().optional(),
    }));

    const entryId = await pool.transaction(async (tx) => {
      const id = await payVendor(tx, {
        societyId: principal.societyId,
        billId: ctx.params.id,
        amount: input.amountPaise,
        paidOn: input.paidOn,
        method: input.method,
        paymentRef: input.paymentRef,
        idempotencyKey: key,
        bankAccountId: input.bankAccountId ?? null,
        postedBy: principal.userId,
        postedByLabel: principal.email,
      });
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'vendor.pay',
        subjectTable: 'vendor_bills',
        subjectId: ctx.params.id,
        detail: { amountPaise: input.amountPaise, paymentRef: input.paymentRef, entryId: id },
        requestId: ctx.requestId,
      });
      return id;
    });

    return ok({
      entryId,
      posted: true,
      // The distinction the demo collapsed. This records a payment the society
      // made through its own bank; nothing here instructed a bank to pay.
      note:
        'Recorded as paid in the books. No transfer was initiated by this request: there is ' +
        'no banking connection in this system and no credential for one.',
    });
  });

  const remitTdsRoute = route('POST', '/api/tds/:quarter/remit', async (ctx) => {
    const principal = need(ctx, 'tds.remit');
    const key = idempotencyKey(ctx);
    const input = ctx.body(v.object({
      section: v.enumOf(['194C', '194J', '194I'] as const),
      challanNo: v.text({ max: 60 }),
      challanDate: v.isoDate(),
      bankAccountId: v.uuid().optional(),
    }));

    const result = await pool.transaction(async (tx) => {
      const remittance = await remitTds(tx, {
        societyId: principal.societyId,
        section: input.section,
        quarter: ctx.params.quarter,
        challanNo: input.challanNo,
        challanDate: input.challanDate,
        idempotencyKey: key,
        bankAccountId: input.bankAccountId ?? null,
        postedBy: principal.userId,
        postedByLabel: principal.email,
      });
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'tds.remit',
        subjectTable: 'tds_register',
        subjectId: `${input.section}:${ctx.params.quarter}`,
        detail: { amountPaise: remittance.amount, challanNo: input.challanNo },
        requestId: ctx.requestId,
      });
      return remittance;
    });

    return ok({
      ...result,
      note:
        'Recorded against the challan you supplied. Nothing was filed with the income-tax ' +
        'portal: this system has no connection to it.',
    });
  });

  // --- banking -------------------------------------------------------------

  const listBankAccounts = route('GET', '/api/bank-accounts', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const result = await pool.query<{
      id: string; label: string; bank_name: string; account_last4: string; ifsc: string;
      ledger_account: string; purpose: string; active: string; balance: string;
    }>(
      `SELECT b.id, b.label, b.bank_name, b.account_last4, b.ifsc, b.ledger_account,
              b.purpose, b.active::text,
              COALESCE((
                SELECT SUM(p.debit - p.credit) FROM journal_postings p
                 WHERE p.society_id = b.society_id AND p.account_code = b.ledger_account
              ), 0)::text AS balance
         FROM bank_accounts b WHERE b.society_id = $1 ORDER BY b.label`,
      [principal.societyId],
    );
    return ok({
      accounts: result.rows.map(r => ({
        id: r.id,
        label: r.label,
        bankName: r.bank_name,
        accountLast4: r.account_last4,
        ifsc: r.ifsc,
        ledgerAccount: r.ledger_account,
        purpose: r.purpose,
        active: r.active === 't' || r.active === 'true',
        ledgerBalancePaise: Number(r.balance),
      })),
    });
  });

  const importStatement = route('POST', '/api/bank/imports', async (ctx) => {
    const principal = need(ctx, 'bank.import');
    const input = ctx.body(v.object({
      bankAccountId: v.uuid(),
      format: v.enumOf(['csv', 'mt940'] as const),
      filename: v.text({ max: 300 }),
      content: v.text({ max: 900_000 }),
    }));

    let parsed: ReturnType<typeof parseStatement>;
    try {
      parsed = parseStatement(input.format, input.content);
    } catch (err) {
      // What is wrong with the file is the uploader's to fix, and the message
      // says what; it is not a server fault.
      if (err instanceof StatementFormatError) throw badRequest(err.message);
      throw err;
    }
    const digest = sha256(input.content);

    const result = await pool.transaction(async (tx) => {
      const account = await tx.query<{ id: string }>(
        'SELECT id FROM bank_accounts WHERE id = $1 AND society_id = $2',
        [input.bankAccountId, principal.societyId],
      );
      if (account.rows[0] === undefined) throw notFound('That bank account');

      const seen = await tx.query<{ id: string; imported_at: string }>(
        `SELECT id, imported_at::text FROM statement_imports
          WHERE society_id = $1 AND bank_account_id = $2 AND content_sha256 = $3`,
        [principal.societyId, input.bankAccountId, digest],
      );
      if (seen.rows[0] !== undefined) {
        // The same file, byte for byte. Refused rather than re-imported: the
        // transaction-level dedupe would catch most of it, but saying so is
        // more use than silently importing nothing.
        throw conflict(
          `That exact statement was already imported on ${seen.rows[0].imported_at}.`,
        );
      }

      const imported = await tx.query<{ id: string }>(
        `INSERT INTO statement_imports
           (society_id, bank_account_id, format, filename, content_sha256,
            period_from, period_to, rows_total, rows_rejected, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          principal.societyId, input.bankAccountId, input.format, input.filename, digest,
          parsed.periodFrom ?? null, parsed.periodTo ?? null,
          parsed.transactions.length + parsed.rejected.length,
          parsed.rejected.length, principal.userId,
        ],
      );
      const importId = imported.rows[0].id;

      let inserted = 0;
      let duplicate = 0;
      for (const transaction of parsed.transactions) {
        const row = await tx.query<{ id: string }>(
          `INSERT INTO bank_transactions
             (society_id, bank_account_id, import_id, value_date, narration, reference,
              amount, running_balance, dedupe_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (society_id, bank_account_id, dedupe_key) DO NOTHING
           RETURNING id`,
          [
            principal.societyId, input.bankAccountId, importId, transaction.valueDate,
            transaction.narration, transaction.reference ?? null, transaction.amount,
            transaction.runningBalance ?? null, transaction.dedupeKey,
          ],
        );
        if (row.rows[0] === undefined) duplicate += 1;
        else inserted += 1;
      }

      await tx.query(
        `UPDATE statement_imports SET rows_imported = $1, rows_duplicate = $2 WHERE id = $3`,
        [inserted, duplicate, importId],
      );
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'bank.import',
        subjectTable: 'statement_imports',
        subjectId: importId,
        detail: { filename: input.filename, inserted, duplicate, rejected: parsed.rejected.length },
        requestId: ctx.requestId,
      });

      return { importId, inserted, duplicate, rejected: parsed.rejected };
    });

    return created({
      ...result,
      // Importing a statement posts nothing. Matching is what connects a bank
      // line to a receipt, and that is a separate, deliberate act.
      posted: false,
      note: 'Statement lines recorded. Nothing has been posted: matching is the next step.',
    });
  });

  const listBankTransactions = route('GET', '/api/bank/transactions', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const state = ctx.query.get('state') ?? 'unmatched';
    const result = await pool.query<{
      id: string; value_date: string; narration: string; reference: string | null;
      amount: string; state: string; suggestion: string | null; suggestion_receipt: string | null;
    }>(
      `SELECT t.id, t.value_date::text, t.narration, t.reference, t.amount::text, t.state,
              s.id AS suggestion, s.receipt_no AS suggestion_receipt
         FROM bank_transactions t
         LEFT JOIN payments s
                ON s.society_id = t.society_id
               AND s.amount = t.amount
               AND s.received_on BETWEEN t.value_date - 3 AND t.value_date + 3
               AND NOT EXISTS (
                     SELECT 1 FROM bank_transactions o
                      WHERE o.matched_payment_id = s.id)
        WHERE t.society_id = $1 AND t.state = $2
        ORDER BY t.value_date DESC
        LIMIT 500`,
      [principal.societyId, state],
    );
    return ok({
      transactions: result.rows.map(r => ({
        id: r.id,
        valueDate: r.value_date,
        narration: r.narration,
        reference: r.reference,
        amountPaise: Number(r.amount),
        state: r.state,
        // A suggestion, named as one: same amount within three days and not
        // already matched. A human confirms it.
        suggestedPaymentId: r.suggestion,
        suggestedReceiptNo: r.suggestion_receipt,
      })),
    });
  });

  const matchBankTransaction = route('POST', '/api/bank/transactions/:id/match', async (ctx) => {
    const principal = need(ctx, 'bank.match');
    const input = ctx.body(v.object({
      paymentId: v.uuid().optional(),
      vendorPaymentId: v.uuid().optional(),
      suspenseReason: v.text({ max: 300 }).optional(),
    }));
    const chosen = [input.paymentId, input.vendorPaymentId, input.suspenseReason]
      .filter(x => x !== undefined).length;
    if (chosen !== 1) {
      throw badRequest('Send exactly one of paymentId, vendorPaymentId or suspenseReason.');
    }

    await pool.transaction(async (tx) => {
      const found = await tx.query<{ state: string; amount: string }>(
        'SELECT state, amount::text FROM bank_transactions WHERE id = $1 AND society_id = $2',
        [ctx.params.id, principal.societyId],
      );
      const line = found.rows[0];
      if (line === undefined) throw notFound('That bank line');
      if (line.state === 'matched') throw conflict('That line is already matched.');

      if (input.suspenseReason !== undefined) {
        await tx.query(
          `UPDATE bank_transactions SET state = 'suspense', suspense_reason = $1,
                  matched_by = $2, matched_at = now()
            WHERE id = $3`,
          [input.suspenseReason, principal.userId, ctx.params.id],
        );
      } else {
        const table = input.paymentId !== undefined ? 'payments' : 'vendor_payments';
        const id = input.paymentId ?? input.vendorPaymentId;
        const counterpart = await tx.query<{ amount: string }>(
          `SELECT amount::text FROM ${table} WHERE id = $1 AND society_id = $2`,
          [id as string, principal.societyId],
        );
        if (counterpart.rows[0] === undefined) throw notFound('That payment');
        // Signs differ: a member receipt is money in, a vendor payment money
        // out, and the statement line is signed.
        const expected = input.paymentId !== undefined
          ? Number(counterpart.rows[0].amount)
          : -Number(counterpart.rows[0].amount);
        if (expected !== Number(line.amount)) {
          throw conflict(
            `That line is ${line.amount} paise and the payment is ${expected} paise. ` +
            `A match that does not agree on the amount is not a match.`,
          );
        }
        await tx.query(
          `UPDATE bank_transactions
              SET state = 'matched', matched_payment_id = $1, matched_vendor_payment_id = $2,
                  matched_by = $3, matched_at = now()
            WHERE id = $4`,
          [input.paymentId ?? null, input.vendorPaymentId ?? null, principal.userId, ctx.params.id],
        );
      }

      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'bank.match',
        subjectTable: 'bank_transactions',
        subjectId: ctx.params.id,
        detail: { ...input },
        requestId: ctx.requestId,
      });
    });

    return ok({ id: ctx.params.id, matched: input.suspenseReason === undefined });
  });

  const reconcile = route('POST', '/api/bank/reconciliations', async (ctx) => {
    const principal = need(ctx, 'bank.reconcile');
    const input = ctx.body(v.object({
      bankAccountId: v.uuid(),
      asAt: v.isoDate(),
      statementBalancePaise: v.int({ min: -1_000_000_000_000, max: 1_000_000_000_000 }),
    }));

    const result = await pool.transaction(async (tx) => {
      const account = await tx.query<{ ledger_account: string }>(
        'SELECT ledger_account FROM bank_accounts WHERE id = $1 AND society_id = $2',
        [input.bankAccountId, principal.societyId],
      );
      const found = account.rows[0];
      if (found === undefined) throw notFound('That bank account');

      const ledgerBalance = await accountBalance(tx, {
        societyId: principal.societyId,
        code: found.ledger_account,
        asAt: input.asAt,
      });
      const unmatched = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM bank_transactions
          WHERE society_id = $1 AND bank_account_id = $2 AND value_date <= $3::date
            AND state IN ('unmatched','suggested','suspense')`,
        [principal.societyId, input.bankAccountId, input.asAt],
      );
      const difference = input.statementBalancePaise - ledgerBalance;

      // Signed off only when the difference is zero, and the database enforces
      // that too. A reconciliation that records a difference is a working
      // paper, not a sign-off.
      const signOff = difference === 0;
      await tx.query(
        `INSERT INTO bank_reconciliations
           (society_id, bank_account_id, as_at, statement_balance, ledger_balance,
            unmatched_count, difference, reconciled_by, reconciled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (society_id, bank_account_id, as_at) DO UPDATE
            SET statement_balance = EXCLUDED.statement_balance,
                ledger_balance = EXCLUDED.ledger_balance,
                unmatched_count = EXCLUDED.unmatched_count,
                difference = EXCLUDED.difference,
                reconciled_by = EXCLUDED.reconciled_by,
                reconciled_at = EXCLUDED.reconciled_at`,
        [
          principal.societyId, input.bankAccountId, input.asAt, input.statementBalancePaise,
          ledgerBalance, Number(unmatched.rows[0]?.count ?? '0'), difference,
          signOff ? principal.userId : null, signOff ? new Date().toISOString() : null,
        ],
      );
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'bank.reconcile',
        subjectTable: 'bank_reconciliations',
        subjectId: input.bankAccountId,
        detail: { asAt: input.asAt, differencePaise: difference, signedOff: signOff },
        requestId: ctx.requestId,
      });

      return {
        asAt: input.asAt,
        statementBalancePaise: input.statementBalancePaise,
        ledgerBalancePaise: ledgerBalance,
        differencePaise: difference,
        unmatchedCount: Number(unmatched.rows[0]?.count ?? '0'),
        signedOff: signOff,
      };
    });

    return ok(result);
  });

  // --- reports -------------------------------------------------------------

  const reportTrialBalance = route('GET', '/api/reports/trial-balance', async (ctx) => {
    const principal = need(ctx, 'report.read');
    return ok(await trialBalance(pool, { societyId: principal.societyId, asAt: asAtOf(ctx) }));
  });

  const reportBalanceSheet = route('GET', '/api/reports/balance-sheet', async (ctx) => {
    const principal = need(ctx, 'report.read');
    return ok(await balanceSheet(pool, { societyId: principal.societyId, asAt: asAtOf(ctx) }));
  });

  const reportIncomeExpenditure = route('GET', '/api/reports/income-expenditure', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const { from, to } = dateRange(ctx);
    return ok(await incomeAndExpenditure(pool, { societyId: principal.societyId, from, to }));
  });

  const reportAgeing = route('GET', '/api/reports/ageing', async (ctx) => {
    const principal = who(ctx);
    const visible = readableFlats(principal, 'report.read');
    if (visible === null) requirePermission(principal, 'report.read');
    else requirePermission(principal, 'invoice.read.own');
    return ok(await ageing(pool, {
      societyId: principal.societyId,
      asAt: asAtOf(ctx),
      flatIds: visible,
    }));
  });

  const reportCollections = route('GET', '/api/reports/collections', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const { from, to } = dateRange(ctx);
    return ok(await collectionSummary(pool, { societyId: principal.societyId, from, to }));
  });

  const reportGst = route('GET', '/api/reports/gst', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const period = ctx.query.get('taxPeriod') ?? today().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) throw badRequest('taxPeriod must be YYYY-MM.');
    const summary = await gstSummary(pool, { societyId: principal.societyId, taxPeriod: period });
    return ok({
      ...summary,
      filed: false,
      note:
        'A summary of what a return would be built from, cross-checked against the ledger. ' +
        'Nothing has been filed: there is no GSTN connection in this system.',
    });
  });

  const reportTds = route('GET', '/api/reports/tds', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const quarter = ctx.query.get('quarter') ?? tdsQuarter(today());
    return ok(await tdsSummary(pool, { societyId: principal.societyId, quarter }));
  });

  const reportStatement = route('GET', '/api/reports/statement/:flatId', async (ctx) => {
    const principal = who(ctx);
    requireFlatAccess(principal, ctx.params.flatId, 'invoice.read.any');
    const flat = await pool.query<{ flat_no: string }>(
      'SELECT flat_no FROM flats WHERE id = $1 AND society_id = $2',
      [ctx.params.flatId, principal.societyId],
    );
    if (flat.rows[0] === undefined) throw notFound('That flat');
    const to = ctx.query.get('to') ?? today();
    const from = ctx.query.get('from');
    return ok(await memberStatement(pool, {
      societyId: principal.societyId,
      flatNo: flat.rows[0].flat_no,
      to,
      ...(from !== null ? { from } : {}),
    }));
  });

  const readLedger = route('GET', '/api/ledger/entries', async (ctx) => {
    const principal = need(ctx, 'ledger.read');
    const { from, to } = dateRange(ctx);
    const result = await pool.query<{
      id: string; entry_ref: string; entry_date: string; narration: string;
      source_kind: string; source_ref: string | null; total_debit: string;
      reversal_of: string | null; reversed_by: string | null; posted_by_label: string;
      legs: string;
    }>(
      `SELECT e.id, e.entry_ref, e.entry_date::text, e.narration, e.source_kind, e.source_ref,
              e.total_debit::text, e.reversal_of, e.reversed_by, e.posted_by_label,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'accountCode', p.account_code, 'debit', p.debit, 'credit', p.credit,
                         'party', p.party, 'docRef', p.doc_ref, 'memo', p.memo)
                       ORDER BY p.id)
                  FROM journal_postings p WHERE p.entry_id = e.id
              ), '[]'::json)::text AS legs
         FROM journal_entries e
        WHERE e.society_id = $1 AND e.entry_date >= $2::date AND e.entry_date <= $3::date
        ORDER BY e.entry_date, e.posted_at
        LIMIT 1000`,
      [principal.societyId, from, to],
    );
    return ok({
      from,
      to,
      entries: result.rows.map(r => ({
        id: r.id,
        entryRef: r.entry_ref,
        date: r.entry_date,
        narration: r.narration,
        sourceKind: r.source_kind,
        sourceRef: r.source_ref,
        amountPaise: Number(r.total_debit),
        reversalOf: r.reversal_of,
        reversedBy: r.reversed_by,
        postedBy: r.posted_by_label,
        legs: JSON.parse(r.legs),
      })),
    });
  });

  const readAuditTrail = route('GET', '/api/audit', async (ctx) => {
    const principal = need(ctx, 'audit.read');
    const action = ctx.query.get('action');
    const subjectId = ctx.query.get('subjectId');
    const rows = await readAudit(pool, {
      societyId: principal.societyId,
      limit: Math.min(Number(ctx.query.get('limit') ?? 200), 1000),
      ...(action !== null ? { action } : {}),
      ...(subjectId !== null ? { subjectId } : {}),
    });
    return ok({ entries: rows });
  });

  // --- helpdesk ------------------------------------------------------------

  const createTicket = route('POST', '/api/tickets', async (ctx) => {
    const principal = need(ctx, 'ticket.create');
    const input = ctx.body(v.object({
      flatId: v.uuid(),
      category: v.string({ min: 2, max: 40 }),
      description: v.text({ max: 4000 }),
      priority: v.enumOf(['emergency', 'high', 'normal', 'low'] as const),
    }));
    requireFlatAccess(principal, input.flatId, 'ticket.read.any');
    if (input.description.trim() === '') throw badRequest('A ticket needs a description.');

    const result = await pool.transaction(async (tx) => {
      const category = await tx.query<{ sla_hours: string }>(
        'SELECT sla_hours::text FROM ticket_categories WHERE society_id = $1 AND key = $2',
        [principal.societyId, input.category],
      );
      const found = category.rows[0];
      if (found === undefined) throw badRequest(`"${input.category}" is not a ticket category.`);

      const ticketNo = await allocateNumber(
        tx,
        { societyId: principal.societyId, kind: 'ticket' },
        async () => {
          const next = await tx.query<{ next: string }>(
            `SELECT COALESCE(MAX(NULLIF(regexp_replace(ticket_no, '^.*-', ''), '')::int), 0) + 1 AS next
               FROM tickets WHERE society_id = $1`,
            [principal.societyId],
          );
          return `TKT-${String(next.rows[0].next).padStart(5, '0')}`;
        },
      );

      const inserted = await tx.query<{ id: string; due_at: string }>(
        `INSERT INTO tickets
           (society_id, ticket_no, flat_id, raised_by, category, description, priority, due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' hours')::interval)
         RETURNING id, due_at::text`,
        [
          principal.societyId, ticketNo, input.flatId, principal.userId, input.category,
          input.description, input.priority, found.sla_hours,
        ],
      );
      await tx.query(
        `INSERT INTO ticket_events (ticket_id, actor_user, actor_label, to_state, note)
         VALUES ($1,$2,$3,'open','Raised')`,
        [inserted.rows[0].id, principal.userId, principal.email],
      );
      return { id: inserted.rows[0].id, ticketNo, dueAt: inserted.rows[0].due_at };
    });

    return created(result);
  });

  const listTickets = route('GET', '/api/tickets', async (ctx) => {
    const principal = who(ctx);
    const visible = readableFlats(principal, 'ticket.read.any');
    if (visible === null) requirePermission(principal, 'ticket.read.any');
    else requirePermission(principal, 'ticket.read.own');

    const params: Array<string | number> = [principal.societyId];
    let filter = '';
    if (visible !== null) {
      if (visible.length === 0) return ok({ tickets: [] });
      filter = ` AND t.flat_id IN (${visible.map(id => {
        params.push(id);
        return `$${params.length}`;
      }).join(',')})`;
    }

    const result = await pool.query<{
      id: string; ticket_no: string; flat_no: string | null; category: string;
      description: string; priority: string; state: string; raised_at: string;
      due_at: string; resolved_at: string | null; overdue: string;
    }>(
      `SELECT t.id, t.ticket_no, f.flat_no, t.category, t.description, t.priority, t.state,
              t.raised_at::text, t.due_at::text, t.resolved_at::text,
              (t.resolved_at IS NULL AND t.due_at < now())::text AS overdue
         FROM tickets t LEFT JOIN flats f ON f.id = t.flat_id
        WHERE t.society_id = $1${filter}
        ORDER BY t.raised_at DESC
        LIMIT 500`,
      params,
    );
    return ok({
      tickets: result.rows.map(r => ({
        id: r.id,
        ticketNo: r.ticket_no,
        flatNo: r.flat_no,
        category: r.category,
        description: r.description,
        priority: r.priority,
        state: r.state,
        raisedAt: r.raised_at,
        dueAt: r.due_at,
        resolvedAt: r.resolved_at,
        // Derived from the clock and the SLA, not a stored flag that someone
        // has to remember to update.
        breachingSla: r.overdue === 't' || r.overdue === 'true',
      })),
    });
  });

  const assignTicket = route('POST', '/api/tickets/:id/assign', async (ctx) => {
    const principal = need(ctx, 'ticket.assign');
    const input = ctx.body(v.object({
      userId: v.uuid().optional(),
      vendorId: v.uuid().optional(),
      note: v.text({ max: 500 }).optional(),
    }));
    if ((input.userId === undefined) === (input.vendorId === undefined)) {
      throw badRequest('Assign to exactly one of a user or a vendor.');
    }

    await pool.transaction(async (tx) => {
      const found = await tx.query<{ state: string }>(
        'SELECT state FROM tickets WHERE id = $1 AND society_id = $2',
        [ctx.params.id, principal.societyId],
      );
      const ticket = found.rows[0];
      if (ticket === undefined) throw notFound('That ticket');
      if (ticket.state === 'closed') throw conflict('That ticket is closed.');

      await tx.query(
        `UPDATE tickets SET state = 'assigned', assigned_to_user = $1, assigned_to_vendor = $2
          WHERE id = $3`,
        [input.userId ?? null, input.vendorId ?? null, ctx.params.id],
      );
      await tx.query(
        `INSERT INTO ticket_events (ticket_id, actor_user, actor_label, from_state, to_state, note)
         VALUES ($1,$2,$3,$4,'assigned',$5)`,
        [ctx.params.id, principal.userId, principal.email, ticket.state, input.note ?? 'Assigned'],
      );
    });

    return ok({ id: ctx.params.id, state: 'assigned' });
  });

  const resolveTicket = route('POST', '/api/tickets/:id/resolve', async (ctx) => {
    const principal = need(ctx, 'ticket.resolve');
    const input = ctx.body(v.object({
      resolution: v.text({ max: 2000 }),
      costPaise: v.paise({ min: 0 }).optional(),
    }));
    if (input.resolution.trim() === '') throw badRequest('A resolution needs a note.');

    await pool.transaction(async (tx) => {
      const found = await tx.query<{ state: string }>(
        'SELECT state FROM tickets WHERE id = $1 AND society_id = $2',
        [ctx.params.id, principal.societyId],
      );
      const ticket = found.rows[0];
      if (ticket === undefined) throw notFound('That ticket');
      if (ticket.state === 'resolved' || ticket.state === 'confirmed' || ticket.state === 'closed') {
        throw conflict(`That ticket is already ${ticket.state}.`);
      }

      await tx.query(
        `UPDATE tickets
            SET state = 'resolved', resolved_at = now(), resolution_note = $1, cost = $2
          WHERE id = $3`,
        [input.resolution, input.costPaise ?? null, ctx.params.id],
      );
      await tx.query(
        `INSERT INTO ticket_events (ticket_id, actor_user, actor_label, from_state, to_state, note)
         VALUES ($1,$2,$3,$4,'resolved',$5)`,
        [ctx.params.id, principal.userId, principal.email, ticket.state, input.resolution],
      );
    });

    return ok({
      id: ctx.params.id,
      state: 'resolved',
      // The resident confirms. A ticket the staff closed on their own is not
      // evidence that the problem is gone.
      note: 'Marked resolved. It closes when the resident confirms.',
    });
  });

  const confirmTicket = route('POST', '/api/tickets/:id/confirm', async (ctx) => {
    const principal = need(ctx, 'ticket.confirm.own');
    const input = ctx.body(v.object({
      satisfied: v.boolean(),
      satisfaction: v.int({ min: 1, max: 5 }).optional(),
      note: v.text({ max: 1000 }).optional(),
    }));

    const result = await pool.transaction(async (tx) => {
      const found = await tx.query<{ state: string; flat_id: string | null; reopened_count: string }>(
        'SELECT state, flat_id, reopened_count::text FROM tickets WHERE id = $1 AND society_id = $2',
        [ctx.params.id, principal.societyId],
      );
      const ticket = found.rows[0];
      if (ticket === undefined) throw notFound('That ticket');
      if (ticket.flat_id !== null) {
        requireFlatAccess(principal, ticket.flat_id, 'ticket.read.any');
      }
      if (ticket.state !== 'resolved') {
        throw conflict(`That ticket is ${ticket.state}; only a resolved ticket can be confirmed.`);
      }

      if (input.satisfied) {
        await tx.query(
          `UPDATE tickets SET state = 'confirmed', confirmed_at = now(), satisfaction = $1
            WHERE id = $2`,
          [input.satisfaction ?? null, ctx.params.id],
        );
      } else {
        // Reopened, with the count kept: a ticket resolved three times and
        // reopened three times is a different story from one resolved once.
        await tx.query(
          `UPDATE tickets
              SET state = 'reopened', resolved_at = NULL, resolution_note = NULL,
                  reopened_count = reopened_count + 1
            WHERE id = $1`,
          [ctx.params.id],
        );
      }
      await tx.query(
        `INSERT INTO ticket_events (ticket_id, actor_user, actor_label, from_state, to_state, note)
         VALUES ($1,$2,$3,'resolved',$4,$5)`,
        [
          ctx.params.id, principal.userId, principal.email,
          input.satisfied ? 'confirmed' : 'reopened',
          input.note ?? (input.satisfied ? 'Confirmed by resident' : 'Reopened by resident'),
        ],
      );
      return input.satisfied ? 'confirmed' : 'reopened';
    });

    return ok({ id: ctx.params.id, state: result });
  });

  // --- financial periods ---------------------------------------------------

  const closePeriod = route('POST', '/api/periods/:period/close', async (ctx) => {
    const principal = need(ctx, 'period.close');
    const period = ctx.params.period;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw badRequest('A period is YYYY-MM.');

    const result = await pool.transaction(async (tx) => {
      const lastDay = new Date(Date.UTC(
        Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0,
      )).toISOString().slice(0, 10);

      // The trial balance it closes on, recorded. The CHECK on the table
      // refuses a close whose two sides do not agree, so a period cannot be
      // closed over a ledger that does not tie.
      const tb = await trialBalance(tx, {
        societyId: principal.societyId,
        asAt: lastDay,
      });
      if (!tb.tiesOut) {
        throw conflict(
          `The trial balance to ${lastDay} does not tie: ${tb.totalDebit} debit against ` +
          `${tb.totalCredit} credit. A period cannot be closed over that.`,
        );
      }

      await tx.query(
        `INSERT INTO financial_periods
           (society_id, period, starts_on, ends_on, state, closed_by, closed_at,
            trial_balance_debit, trial_balance_credit)
         VALUES ($1,$2,$3,$4,'closed',$5, now(), $6, $7)
         ON CONFLICT (society_id, period) DO UPDATE
            SET state = 'closed', closed_by = EXCLUDED.closed_by, closed_at = now(),
                trial_balance_debit = EXCLUDED.trial_balance_debit,
                trial_balance_credit = EXCLUDED.trial_balance_credit`,
        [
          principal.societyId, period, `${period}-01`, lastDay, principal.userId,
          tb.totalDebit, tb.totalCredit,
        ],
      );
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'period.close',
        subjectTable: 'financial_periods',
        subjectId: period,
        detail: { trialBalanceDebit: tb.totalDebit, trialBalanceCredit: tb.totalCredit },
        requestId: ctx.requestId,
      });
      return { period, closedOn: lastDay, trialBalancePaise: tb.totalDebit };
    });

    return ok({
      ...result,
      note: 'Closed. The database now refuses any posting dated in that period.',
    });
  });

  const reopenPeriod = route('POST', '/api/periods/:period/reopen', async (ctx) => {
    const principal = need(ctx, 'period.reopen');
    const input = ctx.body(v.object({ reason: v.text({ max: 500 }) }));
    if (input.reason.trim() === '') throw badRequest('Reopening a period needs a reason.');

    await pool.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE financial_periods
            SET state = 'reopened', reopened_by = $1, reopened_reason = $2
          WHERE society_id = $3 AND period = $4 AND state = 'closed'`,
        [principal.userId, input.reason, principal.societyId, ctx.params.period],
      );
      if (updated.rowCount === 0) {
        throw conflict(`${ctx.params.period} is not a closed period.`);
      }
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'period.reopen',
        subjectTable: 'financial_periods',
        subjectId: ctx.params.period,
        detail: { reason: input.reason },
        requestId: ctx.requestId,
      });
    });

    return ok({ period: ctx.params.period, state: 'reopened' });
  });

  const listPeriods = route('GET', '/api/periods', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const result = await pool.query<{
      period: string; state: string; closed_at: string | null;
      trial_balance_debit: string | null; reopened_reason: string | null;
    }>(
      `SELECT period, state, closed_at::text, trial_balance_debit::text, reopened_reason
         FROM financial_periods WHERE society_id = $1 ORDER BY period DESC`,
      [principal.societyId],
    );
    return ok({
      periods: result.rows.map(r => ({
        period: r.period,
        state: r.state,
        closedAt: r.closed_at,
        trialBalancePaise: r.trial_balance_debit === null ? null : Number(r.trial_balance_debit),
        reopenedReason: r.reopened_reason,
      })),
    });
  });

  // --- scheduled work ------------------------------------------------------

  const listJobs = route('GET', '/api/jobs', async (ctx) => {
    const principal = need(ctx, 'report.read');
    const result = await pool.query<{
      id: string; kind: string; run_key: string; scheduled_for: string; state: string;
      attempts: string; max_attempts: string; next_attempt_at: string | null;
      last_error: string | null; result: string | null; finished_at: string | null;
    }>(
      `SELECT id, kind, run_key, scheduled_for::text, state, attempts::text,
              max_attempts::text, next_attempt_at::text, last_error, result::text,
              finished_at::text
         FROM scheduled_jobs
        WHERE society_id = $1
        ORDER BY scheduled_for DESC
        LIMIT 200`,
      [principal.societyId],
    );
    return ok({
      jobs: result.rows.map(r => ({
        id: r.id,
        kind: r.kind,
        runKey: r.run_key,
        scheduledFor: r.scheduled_for,
        state: r.state,
        attempts: Number(r.attempts),
        maxAttempts: Number(r.max_attempts),
        nextAttemptAt: r.next_attempt_at,
        // Kept and shown. A job that failed five times and gave up is
        // something the committee needs to see, not something to hide.
        lastError: r.last_error,
        result: r.result === null ? null : JSON.parse(r.result),
        finishedAt: r.finished_at,
      })),
    });
  });

  const scheduleJob = route('POST', '/api/jobs', async (ctx) => {
    const input = ctx.body(v.object({
      kind: v.enumOf(['monthly-billing', 'due-date-conversion', 'notification-dispatch'] as const),
      runKey: v.string({ min: 3, max: 120 }),
      scheduledFor: v.isoDate(),
      payload: v.json({ maxBytes: 4000 }),
    }));
    // A job does what its kind does, so it needs the permission that work
    // needs when done by hand. Scheduling a conversion with `billing.run`
    // would otherwise turn proformas into tax invoices without the treasurer.
    const principal = need(ctx, input.kind === 'due-date-conversion' ? 'billing.convert' : 'billing.run');
    const payload = input.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw badRequest('payload must be an object.');
    }
    const fields = payload as Record<string, unknown>;
    for (const name of ['on', 'issuedOn'] as const) {
      const value = fields[name];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw badRequest(`payload.${name} must be a date as YYYY-MM-DD.`);
      }
    }
    if (input.kind === 'due-date-conversion' && typeof fields.on === 'string' && fields.on > today()) {
      // Conversion is for bills whose due date has passed. A date in the
      // future would convert bills that are not yet due.
      throw badRequest('payload.on cannot be after today.');
    }

    const result = await pool.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO scheduled_jobs (society_id, kind, run_key, scheduled_for, payload)
         VALUES ($1,$2,$3,$4::date,$5::jsonb)
         ON CONFLICT (society_id, kind, run_key) DO NOTHING
         RETURNING id`,
        [
          principal.societyId, input.kind, input.runKey, input.scheduledFor,
          JSON.stringify({ ...(input.payload as Record<string, unknown>), requestedBy: principal.userId }),
        ],
      );
      if (inserted.rows[0] === undefined) {
        // The business key already exists, so the work is already scheduled or
        // already done. Saying so is the right answer to a double submit.
        throw conflict(`${input.kind} is already scheduled for ${input.runKey}.`);
      }
      return inserted.rows[0].id;
    });

    return created({ id: result, kind: input.kind, runKey: input.runKey });
  });

  return [
    health, databaseReport,
    requestCode, verifyCode, passwordSignIn, signOut, me,
    listFlats, flatDues,
    getSettings, putSetting, approveSetting,
    listRates, addRate, approveRate,
    billingRun, listBillingDocuments, approveDocument, releaseDocument, convertDocument,
    cancelDocument,
    recordPayment, listPayments, reversePayment,
    listVendors, addVendor, addVendorBill, listVendorBills, approveVendorBill,
    bookVendorBillRoute, payVendorBill, remitTdsRoute,
    listBankAccounts, importStatement, listBankTransactions, matchBankTransaction, reconcile,
    reportTrialBalance, reportBalanceSheet, reportIncomeExpenditure, reportAgeing,
    reportCollections, reportGst, reportTds, reportStatement, readLedger, readAuditTrail,
    createTicket, listTickets, assignTicket, resolveTicket, confirmTicket,
    closePeriod, reopenPeriod, listPeriods,
    listJobs, scheduleJob,
  ];
}
