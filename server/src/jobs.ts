/**
 * The background scheduler.
 *
 * Three pieces of work run on a clock: the monthly billing run, the conversion
 * of proformas that have reached their due date, and the notification queue.
 *
 * Claiming is done in the database with FOR UPDATE SKIP LOCKED, so two workers
 * can run against the same database without doing the same job twice, and the
 * `(kind, run_key)` unique constraint means a scheduler that fires twice for
 * July still bills July once.
 *
 * A failure is retried with exponential backoff and the error is kept. When
 * the attempts run out the job is marked failed with its last error rather
 * than disappearing: a billing run that never happened is something a
 * committee has to be able to see.
 */

import type { PgPool, Queryable } from './pg';
import type { Logger } from './logger';
import type { EmailProvider } from './providers/email';
import { convertToTaxInvoice } from './posting';
import { runBilling } from './billing';
import { generateDocument } from './documents';
import { gstTreatment, invoicePrefix } from './settings';
import { audit } from './audit';

export type JobKind = 'monthly-billing' | 'due-date-conversion' | 'notification-dispatch';

export interface Job {
  readonly id: string;
  readonly societyId: string | null;
  readonly kind: string;
  readonly runKey: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly payload: Record<string, unknown>;
}

export interface JobOutcome {
  readonly summary: Record<string, unknown>;
}

/** 1, 2, 4, 8… minutes, capped, so a provider outage is not hammered. */
export function backoffMinutes(attempts: number): number {
  const minutes = 2 ** Math.max(0, attempts - 1);
  return Math.min(minutes, 60);
}

export interface JobContext {
  readonly pool: PgPool;
  readonly log: Logger;
  readonly email: EmailProvider;
  readonly now: () => string;
}

type Handler = (job: Job, ctx: JobContext) => Promise<JobOutcome>;

const monthlyBilling: Handler = async (job, ctx) => {
  const societyId = job.societyId;
  if (societyId === null) throw new Error('a billing job must name a society');
  const period = job.payload.period;
  const requestedBy = job.payload.requestedBy;
  if (typeof period !== 'string' || typeof requestedBy !== 'string') {
    // Refused rather than defaulted. A billing run is not something to guess
    // the period of, and the maker in maker-checker cannot be invented.
    throw new Error('this job needs payload.period and payload.requestedBy');
  }

  return ctx.pool.transaction(async (tx) => {
    const run = await runBilling(tx, {
      societyId,
      period,
      issuedOn: typeof job.payload.issuedOn === 'string' ? job.payload.issuedOn : ctx.now(),
      requestedBy,
    });
    await audit(tx, {
      societyId,
      actorUser: requestedBy,
      actorLabel: `scheduler (${job.runKey})`,
      action: 'billing.run',
      subjectTable: 'billing_documents',
      subjectId: period,
      detail: { issued: run.issued.length, skipped: run.skipped.length },
    });
    return {
      summary: {
        period: run.period,
        issued: run.issued.length,
        skipped: run.skipped,
        grossPaise: run.totals.gross,
        posted: false,
      },
    };
  });
};

/**
 * Converts proformas whose due date has arrived.
 *
 * This is the other half of the lifecycle: a member who has not paid by the
 * due date still owes the money, so the receivable and the GST arise then.
 * Each document converts in its own transaction, so one failure does not undo
 * the rest of the batch.
 */
const dueDateConversion: Handler = async (job, ctx) => {
  const societyId = job.societyId;
  if (societyId === null) throw new Error('a conversion job must name a society');
  const on = typeof job.payload.on === 'string' ? job.payload.on : ctx.now();

  const due = await ctx.pool.query<{ id: string; proforma_no: string }>(
    `SELECT id, proforma_no FROM billing_documents
      WHERE society_id = $1
        AND state IN ('approved','released')
        AND due_on <= $2::date
      ORDER BY due_on, proforma_no`,
    [societyId, on],
  );

  const converted: string[] = [];
  const refused: Array<{ proformaNo: string; why: string }> = [];

  for (const document of due.rows) {
    try {
      const result = await ctx.pool.transaction(async (tx) => {
        const gst = await gstTreatment(tx, societyId);
        const prefix = await invoicePrefix(tx, societyId);
        return convertToTaxInvoice(tx, {
          societyId,
          documentId: document.id,
          on,
          because: 'due-date-reached',
          postedBy: typeof job.payload.requestedBy === 'string' ? job.payload.requestedBy : null,
          postedByLabel: `scheduler (${job.runKey})`,
          gst,
          invoicePrefix: prefix,
        });
      });
      converted.push(result.taxInvoiceNo);
    } catch (err) {
      // Kept per document. An unapproved GST treatment refuses every
      // conversion, and the job's result says exactly that rather than
      // reporting a count of zero with no reason.
      refused.push({
        proformaNo: document.proforma_no,
        why: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  if (converted.length === 0 && refused.length > 0) {
    throw new Error(
      `none of ${refused.length} due ${refused.length === 1 ? 'proforma' : 'proformas'} could be ` +
      `converted; first reason: ${refused[0].why}`,
    );
  }

  return { summary: { on, converted, refused } };
};

/**
 * Sends what is queued, and records what the provider said.
 *
 * A notification only reaches 'sent' with a provider name and that provider's
 * message id, which the database enforces with a CHECK. With no provider
 * configured nothing is marked sent — the rows stay queued and the job says
 * so, which is the honest outcome rather than a dispatch report.
 */
const notificationDispatch: Handler = async (job, ctx) => {
  const societyId = job.societyId;
  if (societyId === null) throw new Error('a dispatch job must name a society');

  if (!ctx.email.delivers) {
    const waiting = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notifications
        WHERE society_id = $1 AND state = 'queued'`,
      [societyId],
    );
    return {
      summary: {
        sent: 0,
        failed: 0,
        queued: Number(waiting.rows[0]?.count ?? '0'),
        provider: ctx.email.name,
        delivered: false,
        why: 'no email provider is configured, so nothing was sent',
      },
    };
  }

  const queued = await ctx.pool.query<{
    id: string; to_address: string; subject: string | null; payload: string;
  }>(
    `SELECT id, to_address, subject, payload::text FROM notifications
      WHERE society_id = $1 AND state = 'queued' AND channel = 'email'
      ORDER BY queued_at
      LIMIT 100`,
    [societyId],
  );

  let sent = 0;
  let failed = 0;
  let attached = 0;
  for (const notification of queued.rows) {
    const payload = JSON.parse(notification.payload) as {
      text?: unknown; documentId?: unknown; reference?: unknown;
    };
    try {
      // The document itself, attached. Generated from the stored render
      // payload where one exists, so what the member receives is the same
      // bytes as the copy on file rather than a fresh render from data that
      // may have moved since.
      const attachments: Array<{ filename: string; contentType: string; body: Buffer }> = [];
      if (typeof payload.documentId === 'string') {
        try {
          const generated = await ctx.pool.transaction(async (tx) =>
            generateDocument(tx, {
              societyId,
              kind: 'tax-invoice',
              documentId: payload.documentId as string,
              asAt: ctx.now(),
            }));
          const reference = typeof payload.reference === 'string' ? payload.reference : 'document';
          attachments.push({
            filename: `${reference.replace(/[^A-Za-z0-9.-]/g, '-')}.pdf`,
            contentType: 'application/pdf',
            body: generated.pdf,
          });
          attached += 1;
        } catch (err) {
          // The message still goes, without it. A missing attachment is worth
          // noting; it is not a reason to withhold the notice.
          ctx.log.warn('could not attach the document to a notification', {
            notification: notification.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const delivery = await ctx.email.send({
        to: notification.to_address,
        subject: notification.subject ?? 'A message from your association',
        text: typeof payload.text === 'string' ? payload.text : JSON.stringify(payload),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      await ctx.pool.query(
        `UPDATE notifications
            SET state = 'sent', provider = $1, provider_message_id = $2,
                sent_at = now(), attempts = attempts + 1
          WHERE id = $3`,
        [delivery.provider, delivery.providerMessageId, notification.id],
      );
      sent += 1;
    } catch (err) {
      await ctx.pool.query(
        `UPDATE notifications
            SET state = 'failed', last_error = $1, attempts = attempts + 1
          WHERE id = $2`,
        [err instanceof Error ? err.message : 'send failed', notification.id],
      );
      failed += 1;
    }
  }

  return {
    summary: { sent, failed, attached, provider: ctx.email.name, delivered: sent > 0 },
  };
};

export const HANDLERS: Record<JobKind, Handler> = {
  'monthly-billing': monthlyBilling,
  'due-date-conversion': dueDateConversion,
  'notification-dispatch': notificationDispatch,
};

/**
 * Claims up to `limit` jobs that are due.
 *
 * SKIP LOCKED is what makes two workers safe: a row another worker is taking
 * is passed over rather than waited for.
 */
export async function claimJobs(
  tx: Queryable,
  input: { worker: string; limit: number },
): Promise<Job[]> {
  const result = await tx.query<{
    id: string; society_id: string | null; kind: string; run_key: string;
    attempts: string; max_attempts: string; payload: string;
  }>(
    `UPDATE scheduled_jobs
        SET state = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
      WHERE id IN (
              SELECT id FROM scheduled_jobs
               WHERE state = 'pending'
                 AND scheduled_for <= now()
                 AND (next_attempt_at IS NULL OR next_attempt_at <= now())
               ORDER BY scheduled_for
               LIMIT $2
               FOR UPDATE SKIP LOCKED
            )
      RETURNING id, society_id, kind, run_key, attempts::text, max_attempts::text, payload::text`,
    [input.worker, input.limit],
  );

  return result.rows.map(r => ({
    id: r.id,
    societyId: r.society_id,
    kind: r.kind,
    runKey: r.run_key,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  }));
}

export async function finishJob(
  pool: PgPool,
  job: Job,
  outcome: JobOutcome,
): Promise<void> {
  await pool.query(
    `UPDATE scheduled_jobs
        SET state = 'succeeded', result = $1::jsonb, finished_at = now(),
            locked_by = NULL, next_attempt_at = NULL
      WHERE id = $2`,
    [JSON.stringify(outcome.summary), job.id],
  );
}

export async function failJob(
  pool: PgPool,
  job: Job,
  error: unknown,
): Promise<{ willRetry: boolean; nextAttemptMinutes: number }> {
  const message = error instanceof Error ? error.message : String(error);
  const willRetry = job.attempts < job.maxAttempts;
  const minutes = backoffMinutes(job.attempts);

  if (willRetry) {
    await pool.query(
      `UPDATE scheduled_jobs
          SET state = 'pending', last_error = $1, locked_by = NULL,
              next_attempt_at = now() + ($2 || ' minutes')::interval
        WHERE id = $3`,
      [message, String(minutes), job.id],
    );
  } else {
    // Failed and kept, with the reason. Not deleted, and not left 'running'
    // where it would look like work in progress for ever.
    await pool.query(
      `UPDATE scheduled_jobs
          SET state = 'failed', last_error = $1, locked_by = NULL, finished_at = now()
        WHERE id = $2`,
      [message, job.id],
    );
  }

  return { willRetry, nextAttemptMinutes: minutes };
}

/**
 * Returns jobs whose worker died mid-flight to the queue.
 *
 * `claimJobs` marks a job 'running' and counts the attempt; nothing moves it
 * back if the process holding it never finishes. On a long-lived server that
 * means a restart mid-job leaves one row stuck. On a serverless platform it
 * is routine rather than rare: an invocation that exceeds its time limit is
 * killed where it stands, and the job it had claimed would sit in 'running'
 * for ever with no error recorded and nothing to retry it.
 *
 * The attempt is not refunded — it was spent, and a job that times out
 * repeatedly should exhaust its attempts and be reported rather than loop for
 * ever. `locked_at` older than the window is the only evidence available that
 * nobody is working on it, so the window must be comfortably longer than the
 * platform's own invocation limit.
 */
export async function requeueStalled(
  ctx: Pick<JobContext, 'pool' | 'log'>,
  input: { olderThanMinutes: number },
): Promise<{ requeued: number }> {
  const result = await ctx.pool.query<{ id: string; kind: string; run_key: string }>(
    `UPDATE scheduled_jobs
        SET state = 'pending', locked_by = NULL, locked_at = NULL,
            last_error = COALESCE(last_error, '') ||
              CASE WHEN COALESCE(last_error, '') = '' THEN '' ELSE ' | ' END ||
              'the worker holding this job stopped without finishing it'
      WHERE state = 'running'
        AND locked_at < now() - ($1 || ' minutes')::interval
     RETURNING id, kind, run_key`,
    [String(input.olderThanMinutes)],
  );

  for (const row of result.rows) {
    ctx.log.warn('requeued a job whose worker stopped', { kind: row.kind, runKey: row.run_key });
  }
  return { requeued: result.rows.length };
}

export interface RunSummary {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly retrying: number;
}

/** One pass of the worker. Called on a timer, and directly by the tests. */
export async function runDueJobs(
  ctx: JobContext,
  input: { worker: string; limit?: number } ,
): Promise<RunSummary> {
  const jobs = await ctx.pool.transaction(async (tx) =>
    claimJobs(tx, { worker: input.worker, limit: input.limit ?? 5 }));

  let succeeded = 0;
  let failed = 0;
  let retrying = 0;

  for (const job of jobs) {
    const handler = HANDLERS[job.kind as JobKind];
    if (handler === undefined) {
      await failJob(ctx.pool, job, new Error(`no handler for job kind "${job.kind}"`));
      failed += 1;
      continue;
    }
    try {
      const outcome = await handler(job, ctx);
      await finishJob(ctx.pool, job, outcome);
      ctx.log.info('job succeeded', { kind: job.kind, runKey: job.runKey, ...outcome.summary });
      succeeded += 1;
    } catch (err) {
      const decision = await failJob(ctx.pool, job, err);
      ctx.log.warn('job failed', {
        kind: job.kind,
        runKey: job.runKey,
        attempt: job.attempts,
        willRetry: decision.willRetry,
        retryInMinutes: decision.nextAttemptMinutes,
        error: err instanceof Error ? err.message : String(err),
      });
      if (decision.willRetry) retrying += 1;
      else failed += 1;
    }
  }

  return { claimed: jobs.length, succeeded, failed, retrying };
}

export interface Worker {
  stop(): void;
}

/** Starts the timer. `intervalMs` is how often a pass runs. */
export function startWorker(ctx: JobContext, input: { worker: string; intervalMs: number }): Worker {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const summary = await runDueJobs(ctx, { worker: input.worker });
      if (summary.claimed > 0) ctx.log.info('scheduler pass', { ...summary });
    } catch (err) {
      // A pass that cannot even claim — a database that is down — must not
      // stop the timer.
      ctx.log.error('scheduler pass failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const timer = setInterval(() => { void tick(); }, input.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
