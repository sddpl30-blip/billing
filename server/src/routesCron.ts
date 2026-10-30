/**
 * The scheduler, as an endpoint.
 *
 * A serverless platform has no process to keep a timer in. Between two
 * requests nothing of ours is running, so `startWorker` — a `setInterval` in a
 * long-lived process — has nothing to live in. The platform's own scheduler
 * calls a URL instead, and this is that URL.
 *
 * What it does *not* do is decide anything. A pass drains jobs that somebody
 * with `billing.run` already queued through `POST /api/jobs`; it never queues
 * one. That is deliberate: every job carries the user who asked for it, and
 * maker-checker depends on that being a real person. A cron that created
 * billing runs would be inventing the maker, and the approver would then be
 * approving a run nobody asked for.
 *
 * Three things make it safe to call twice, which matters because a platform
 * that gets no answer will retry:
 *
 *  · `claimJobs` takes its rows `FOR UPDATE SKIP LOCKED`, so two passes
 *    running at once take different jobs rather than the same one twice;
 *  · each job's work is keyed on `(kind, run_key)` and the business writes
 *    underneath it carry their own idempotency keys, so a repeat is refused
 *    by the database rather than posted twice;
 *  · a pass that is killed mid-flight leaves its job 'running', and the next
 *    pass returns it to the queue (`requeueStalled`).
 *
 * It is a GET because that is what Vercel's scheduler sends. A GET that
 * changes things is not something to be pleased about; the bearer secret and
 * the absence of any cookie handling are what keep it from being a hole.
 */

import { timingSafeEqual } from 'node:crypto';
import { route, type RouteDefinition } from './http';
import { ForbiddenError, hasPermission } from './rbac';
import { requeueStalled, runDueJobs, sendQueuedEmails, type RunSummary } from './jobs';
import type { PgPool } from './pg';
import type { Config } from './config';
import type { Logger } from './logger';
import type { EmailProvider } from './providers/email';
import { isoDateInIndia } from '../../src/accounting/clock';

export interface CronDependencies {
  readonly pool: PgPool;
  readonly config: Config;
  readonly log: Logger;
  readonly email: EmailProvider;
  /** Overridden in the tests, which must not wait for a real time budget. */
  readonly now?: () => number;
}

/**
 * How long a pass may keep working.
 *
 * Vercel kills a function at its plan's limit and the job it was holding is
 * then stuck until a later pass requeues it. So a pass stops *itself* with
 * room to spare, reports that it stopped early, and leaves the rest for the
 * next one. The queue is drained across passes, never in one heroic
 * invocation.
 */
const DEFAULT_BUDGET_MS = 25_000;

/** The window after which a 'running' job is presumed abandoned. */
const STALE_AFTER_MINUTES = 15;

const bearer = (header: string | string[] | undefined): string | null => {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match === null ? null : match[1].trim();
};

/** Constant-time, because a secret compared with `===` leaks by timing. */
const secretMatches = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

export function createCronRoutes(deps: CronDependencies): RouteDefinition[] {
  const { pool, config, log, email } = deps;
  const clock = deps.now ?? (() => Date.now());

  const budgetMs = (() => {
    const raw = Number(process.env.CRON_BUDGET_MS ?? '');
    return Number.isInteger(raw) && raw >= 1000 && raw <= 280_000 ? raw : DEFAULT_BUDGET_MS;
  })();

  /**
   * The guard.
   *
   * Returns null when the request may proceed, or the reply to send instead.
   * Unconfigured is 503 and not 401: "this deployment has no scheduler" is a
   * different thing from "your secret is wrong", and an operator reading the
   * cron's failure needs to be able to tell them apart.
   */
  const refuse = (presented: string | null) => {
    if (config.cronSecret === null) {
      log.error('a scheduled run was called but CRON_SECRET is not set', {
        hint: 'set CRON_SECRET in the deployment environment; the endpoint stays closed until then',
      });
      return {
        status: 503,
        body: {
          error: 'cron_not_configured',
          message:
            'This deployment has no scheduler secret, so scheduled runs are refused. Set ' +
            'CRON_SECRET in the environment.',
        },
      };
    }
    if (presented === null || !secretMatches(presented, config.cronSecret)) {
      // No detail. The only thing a caller learns from this is that they are
      // not the scheduler.
      log.warn('a scheduled run was refused', { presented: presented === null ? 'nothing' : 'a secret' });
      return { status: 401, body: { error: 'unauthenticated', message: 'Not the scheduler.' } };
    }
    return null;
  };

  const runPasses = async (worker: string): Promise<{
    passes: number;
    totals: RunSummary;
    requeued: number;
    stoppedBecause: 'queue is empty' | 'the time budget ran out';
  }> => {
    const startedAt = clock();
    const { requeued } = await requeueStalled({ pool, log }, {
      olderThanMinutes: STALE_AFTER_MINUTES,
    });

    const totals = { claimed: 0, succeeded: 0, failed: 0, retrying: 0 };
    let passes = 0;
    let stoppedBecause: 'queue is empty' | 'the time budget ran out' = 'queue is empty';

    for (;;) {
      if (clock() - startedAt > budgetMs) {
        stoppedBecause = 'the time budget ran out';
        break;
      }
      const summary = await runDueJobs(
        // India's date, as the standalone scheduler uses; see clock.ts.
        { pool, log, email, now: () => isoDateInIndia() },
        { worker, limit: 5 },
      );
      passes += 1;
      totals.claimed += summary.claimed;
      totals.succeeded += summary.succeeded;
      totals.failed += summary.failed;
      totals.retrying += summary.retrying;
      if (summary.claimed === 0) break;
    }

    return { passes, totals, requeued, stoppedBecause };
  };

  const run = route('GET', '/api/cron/run', async (ctx) => {
    const refusal = refuse(bearer(ctx.headers.authorization));
    if (refusal !== null) return refusal;

    // Named after the invocation, so `locked_by` in the job table says which
    // run held a job rather than just "worker".
    const worker = `cron:${ctx.requestId}`;
    const result = await runPasses(worker);

    // E-mail queued from the screens (notices, welcome messages) that their
    // own send did not finish: swept here, in batches, while time remains.
    let emailsSent = 0;
    if (email.delivers) {
      const waiting = await pool.query<{ society_id: string }>(
        `SELECT DISTINCT society_id FROM notifications WHERE state = 'queued' AND channel = 'email'`,
      );
      const startedAt = clock();
      for (const row of waiting.rows) {
        for (;;) {
          if (clock() - startedAt > budgetMs / 2) break;
          const batch = await sendQueuedEmails(
            { pool, log, email, now: () => isoDateInIndia() }, row.society_id, 20,
          );
          emailsSent += batch.sent;
          if (batch.sent + batch.failed === 0 || batch.remaining === 0) break;
        }
      }
    }

    ctx.log.info('scheduled run', {
      worker,
      passes: result.passes,
      ...result.totals,
      requeued: result.requeued,
      stoppedBecause: result.stoppedBecause,
    });

    return {
      status: 200,
      body: {
        ran: true,
        worker,
        passes: result.passes,
        requeued: result.requeued,
        ...result.totals,
        stoppedBecause: result.stoppedBecause,
        emailsSent,
        budgetMs,
      },
    };
  }, { authenticated: false, csrfExempt: true });

  /**
   * What the scheduler would do, without doing it.
   *
   * For checking that the secret and the schedule are right after a deploy,
   * which otherwise means waiting for a cron to fire and then reading a log.
   */
  const status = route('GET', '/api/cron/status', async (ctx) => {
    const refusal = refuse(bearer(ctx.headers.authorization));
    if (refusal !== null) return refusal;

    const due = await pool.query<{ kind: string; due: string; running: string; stalled: string }>(
      `SELECT kind,
              COUNT(*) FILTER (
                WHERE state = 'pending' AND scheduled_for <= now()
                  AND (next_attempt_at IS NULL OR next_attempt_at <= now())
              )::text AS due,
              COUNT(*) FILTER (WHERE state = 'running')::text AS running,
              COUNT(*) FILTER (
                WHERE state = 'running' AND locked_at < now() - ($1 || ' minutes')::interval
              )::text AS stalled
         FROM scheduled_jobs
        GROUP BY kind
        ORDER BY kind`,
      [String(STALE_AFTER_MINUTES)],
    );

    return {
      status: 200,
      body: {
        platform: config.platform,
        budgetMs,
        staleAfterMinutes: STALE_AFTER_MINUTES,
        emailProvider: config.emailProvider,
        queue: due.rows.map(r => ({
          kind: r.kind,
          due: Number(r.due),
          running: Number(r.running),
          stalled: Number(r.stalled),
        })),
      },
    };
  }, { authenticated: false, csrfExempt: true });

  /**
   * The same pass, run by a person instead of a schedule.
   *
   * This exists because of a platform limit rather than a business need. On
   * Vercel's Hobby plan a cron may run only once a day, so a notification
   * queued at ten in the morning would sit until the small hours. A treasurer
   * who has just released a bill run can drain the queue themselves instead of
   * waiting.
   *
   * It takes a session and the CSRF header like any other write, and it needs
   * `billing.run` — the permission that queues this work in the first place.
   * It cannot create work, only carry out what is already queued, so it
   * cannot step around maker-checker: a run still has to have been asked for
   * by someone and approved by someone else.
   */
  const drain = route('POST', '/api/jobs/drain', async (ctx) => {
    const principal = ctx.principal;
    if (principal === null || !hasPermission(principal, 'billing.run')) {
      throw new ForbiddenError('Running the queue needs billing.run.');
    }

    const worker = `manual:${principal.userId}:${ctx.requestId}`;
    const result = await runPasses(worker);

    ctx.log.info('queue drained by hand', {
      worker,
      passes: result.passes,
      ...result.totals,
      requeued: result.requeued,
    });

    return {
      status: 200,
      body: {
        ran: true,
        passes: result.passes,
        requeued: result.requeued,
        ...result.totals,
        stoppedBecause: result.stoppedBecause,
      },
    };
  });

  return [run, status, drain];
}
