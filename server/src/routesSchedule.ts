/**
 * Scheduling a period's release for a set time: the approach note's
 * "approved by the Treasurer, e-mailed at 6:00 am IST on the 1st".
 *
 *   POST /api/billing/periods/:period/schedule-release   { on: 'YYYY-MM-DD' }
 *   GET  /api/billing/scheduled-releases
 *   POST /api/billing/scheduled-releases/:id/cancel
 *
 * The release itself is the 'scheduled-release' job in jobs.ts. It runs at
 * the first scheduler pass at or after 06:00 IST on the chosen day: on the
 * standalone server that is within a minute; on Vercel it is the daily cron,
 * which vercel.json sets for 06:00 IST (on the Hobby plan Vercel may fire it
 * any time within that hour).
 */

import { badRequest, conflict, notFound, route, type RouteDefinition } from './http';
import { v } from './validate';
import { requirePermission, type Principal } from './rbac';
import { audit } from './audit';
import { canonicalPeriod, isoDateInIndia } from '../../src/accounting/clock';
import type { PgPool } from './pg';

export interface ScheduleDependencies {
  readonly pool: PgPool;
}

/** 06:00 India time on a date, as a timestamp the database compares exactly. */
export const sixAmInIndia = (on: string): string => `${on}T06:00:00+05:30`;

export function createScheduleRoutes(deps: ScheduleDependencies): RouteDefinition[] {
  const { pool } = deps;

  const need = (principal: Principal | null): Principal => {
    if (principal === null) throw new Error('route is authenticated');
    requirePermission(principal, 'billing.release');
    return principal;
  };

  const schedule = route('POST', '/api/billing/periods/:period/schedule-release', async (ctx) => {
    const principal = need(ctx.principal);
    const input = ctx.body(v.object({ on: v.isoDate() }));
    const period = canonicalPeriod(ctx.params.period);
    if (period === null) throw badRequest('That is not a billing period, e.g. "Oct 2026".');
    if (input.on < isoDateInIndia()) {
      throw badRequest('The release date has passed. Choose today or a later date.');
    }

    const result = await pool.transaction(async (tx) => {
      const counts = await tx.query<{ approved: string; drafts: string }>(
        `SELECT count(*) FILTER (WHERE state = 'approved')::text AS approved,
                count(*) FILTER (WHERE state = 'draft')::text AS drafts
           FROM billing_documents WHERE society_id = $1 AND period = $2`,
        [principal.societyId, period],
      );
      const approved = Number(counts.rows[0]?.approved ?? '0');
      const drafts = Number(counts.rows[0]?.drafts ?? '0');
      if (approved === 0 && drafts === 0) {
        throw conflict(`There are no proformas for ${period} to release. Run billing first.`);
      }

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO scheduled_jobs (society_id, kind, run_key, scheduled_for, payload)
         VALUES ($1, 'scheduled-release', $2, $3::timestamptz, $4::jsonb)
         ON CONFLICT (society_id, kind, run_key) DO NOTHING
         RETURNING id`,
        [
          principal.societyId, `release:${period}`, sixAmInIndia(input.on),
          JSON.stringify({ period, requestedBy: principal.userId }),
        ],
      );
      if (inserted.rows[0] === undefined) {
        throw conflict(
          `A release for ${period} is already scheduled or done. Cancel it first to choose another time.`,
        );
      }
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'billing.release.schedule',
        subjectTable: 'scheduled_jobs',
        subjectId: inserted.rows[0].id,
        detail: { period, on: input.on, approvedNow: approved, draftsNow: drafts },
        requestId: ctx.requestId,
      });
      return { id: inserted.rows[0].id, approved, drafts };
    });

    return {
      status: 201,
      body: {
        id: result.id,
        period,
        scheduledFor: sixAmInIndia(input.on),
        approvedNow: result.approved,
        draftsNow: result.drafts,
        note:
          'Releases and emails what is approved at that time. Anything still in draft then is ' +
          'left for its approver and listed in the result.',
      },
    };
  });

  const list = route('GET', '/api/billing/scheduled-releases', async (ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error('route is authenticated');
    requirePermission(principal, 'report.read');
    const rows = await pool.query<{
      id: string; run_key: string; scheduled_for: string; state: string;
      result: string | null; last_error: string | null; finished_at: string | null;
    }>(
      `SELECT id, run_key, scheduled_for::text, state, result::text, last_error, finished_at::text
         FROM scheduled_jobs
        WHERE society_id = $1 AND kind = 'scheduled-release'
        ORDER BY scheduled_for DESC
        LIMIT 50`,
      [principal.societyId],
    );
    return {
      status: 200,
      body: {
        releases: rows.rows.map(r => ({
          id: r.id,
          period: r.run_key.replace(/^release:/, ''),
          scheduledFor: r.scheduled_for,
          state: r.state,
          result: r.result === null ? null : JSON.parse(r.result),
          lastError: r.last_error,
          finishedAt: r.finished_at,
        })),
      },
    };
  });

  const cancel = route('POST', '/api/billing/scheduled-releases/:id/cancel', async (ctx) => {
    const principal = need(ctx.principal);
    const result = await pool.transaction(async (tx) => {
      const found = await tx.query<{ state: string; run_key: string }>(
        `SELECT state, run_key FROM scheduled_jobs
          WHERE id = $1 AND society_id = $2 AND kind = 'scheduled-release'
          FOR UPDATE`,
        [ctx.params.id, principal.societyId],
      );
      const job = found.rows[0];
      if (job === undefined) throw notFound('That scheduled release');
      if (job.state !== 'pending') throw conflict(`That release is already ${job.state}.`);
      // Removed rather than marked abandoned, so the period's key is free for
      // a new time; the audit row keeps the record that it was scheduled.
      await tx.query('DELETE FROM scheduled_jobs WHERE id = $1', [ctx.params.id]);
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'billing.release.cancel',
        subjectTable: 'scheduled_jobs',
        subjectId: ctx.params.id,
        detail: { period: job.run_key.replace(/^release:/, '') },
        requestId: ctx.requestId,
      });
      return { cancelled: true };
    });
    return { status: 200, body: result };
  });

  return [schedule, list, cancel];
}
