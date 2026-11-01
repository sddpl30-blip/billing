/**
 * Notices: the secretary's circulars to residents.
 *
 *   POST /api/notices   publish one (notice.send): on the notice board, and
 *                       optionally e-mailed to every current owner
 *   GET  /api/notices   the notice board, for anyone signed in
 *
 * Kept in the notifications table rather than a table of its own, so it needs
 * no migration: the board entry is one 'in-app' row, and each e-mail is an
 * ordinary queued 'email' row that the dispatch job sends like a bill. The
 * board row is marked sent at once, with 'in-app' as its provider, because
 * being on the board is its delivery; the e-mails are only ever marked sent
 * by a real provider's answer.
 */

import { randomUUID } from 'node:crypto';
import type { PgPool, Queryable } from './pg';
import type { EmailProvider } from './providers/email';
import { badRequest, route, type RequestContext, type Reply, type RouteDefinition } from './http';
import { v } from './validate';
import { requirePermission, type Principal } from './rbac';
import { audit } from './audit';

export interface NoticeDependencies {
  readonly pool: PgPool;
  readonly email: EmailProvider;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const created = (body: unknown): Reply => ({ status: 201, body });

function who(ctx: RequestContext): Principal {
  if (ctx.principal === null) throw new Error(`route ${ctx.path} read the principal but is not marked authenticated`);
  return ctx.principal;
}

export function createNoticeRoutes(deps: NoticeDependencies): RouteDefinition[] {
  const { pool } = deps;

  const publish = route('POST', '/api/notices', async (ctx) => {
    const principal = who(ctx);
    requirePermission(principal, 'notice.send');
    const input = ctx.body(v.object({
      title: v.string({ min: 3, max: 120 }),
      body: v.string({ min: 1, max: 4000 }),
      email: v.boolean(),
    }));
    const title = input.title.trim();
    const body = input.body.trim();
    const noticeId = randomUUID();

    const result = await pool.transaction(async (tx) => {
      const payload = { noticeId, title, body, by: principal.email };
      await tx.query(
        `INSERT INTO notifications
           (society_id, channel, template, to_address, subject, payload,
            state, provider, provider_message_id, sent_at)
         VALUES ($1, 'in-app', 'notice', 'notice-board', $2, $3::jsonb,
                 'sent', 'in-app', $4, now())`,
        [principal.societyId, title, JSON.stringify(payload), noticeId],
      );

      // Every current owner and co-owner with an address, once each.
      let queued = 0;
      if (input.email) {
        const owners = await tx.query<{ email: string; to_user: string | null }>(
          `SELECT DISTINCT ON (lower(o.email)) o.email, u.id AS to_user
             FROM owners o
             JOIN flat_ownership fo ON fo.owner_id = o.id AND fo.held_until IS NULL
             LEFT JOIN users u ON u.owner_id = o.id AND u.is_active = true
            WHERE o.society_id = $1 AND o.email IS NOT NULL AND o.email <> ''
            ORDER BY lower(o.email)`,
          [principal.societyId],
        );
        for (const owner of owners.rows) {
          await tx.query(
            `INSERT INTO notifications (society_id, channel, template, to_user, to_address, subject, payload)
             VALUES ($1, 'email', 'notice', $2, $3, $4, $5::jsonb)`,
            [
              principal.societyId, owner.to_user, owner.email, title,
              JSON.stringify({ ...payload, text: `${body}\n\n— Mani Vista Residents Association` }),
            ],
          );
          queued += 1;
        }
      }

      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'notice.publish',
        subjectTable: 'notifications',
        subjectId: noticeId,
        detail: { title, emailed: input.email, queued },
        requestId: ctx.requestId,
      });
      return { queued };
    });

    return created({
      id: noticeId,
      title,
      onBoard: true,
      emailsQueued: result.queued,
      emailDelivers: deps.email.delivers,
      note: !input.email
        ? 'Published on the notice board. No e-mail was asked for.'
        : deps.email.delivers
          ? `Published on the notice board, and ${result.queued} e-mail${result.queued === 1 ? '' : 's'} queued; the dispatch job sends them.`
          : `Published on the notice board. ${result.queued} e-mail${result.queued === 1 ? ' is' : 's are'} queued, but no e-mail service is set up, so none has been sent yet; they go out once one is.`,
    });
  });

  const board = route('GET', '/api/notices', async (ctx) => {
    const principal = who(ctx);
    const result = await pool.query<{ payload: string; sent_at: string }>(
      `SELECT payload::text, sent_at::text FROM notifications
        WHERE society_id = $1 AND channel = 'in-app' AND template = 'notice'
        ORDER BY sent_at DESC
        LIMIT 100`,
      [principal.societyId],
    );
    return ok({
      notices: result.rows.map(r => {
        const p = JSON.parse(r.payload) as { noticeId: string; title: string; body: string; by: string };
        return { id: p.noticeId, title: p.title, body: p.body, by: p.by, publishedAt: r.sent_at };
      }),
    });
  });

  /**
   * One e-mail to many residents: every current owner, everyone with a portal
   * login, or the owners of the flats named. E-mail only (nothing on the
   * notice board), queued as template 'bulk' with a batch id and sent by the
   * dispatcher, which the screen drives in small batches. Each address once.
   */
  const bulk = route('POST', '/api/emails/bulk', async (ctx) => {
    const principal = who(ctx);
    requirePermission(principal, 'notice.send');
    const input = ctx.body(v.object({
      subject: v.string({ min: 3, max: 150 }),
      body: v.string({ min: 1, max: 10000 }),
      audience: v.enumOf(['owners', 'portal-users', 'flats'] as const),
      flats: v.array(v.string({ min: 1, max: 20 }), { min: 1, max: 1000 }).optional(),
      /** Count only, send nothing: what the screen shows before "Send". */
      preview: v.boolean().optional(),
    }));
    if (input.audience === 'flats' && (input.flats === undefined || input.flats.length === 0)) {
      throw badRequest('Name at least one flat.');
    }

    const recipients = async (q: Queryable) => {
      if (input.audience === 'portal-users') {
        return (await q.query<{ email: string; to_user: string | null }>(
          `SELECT DISTINCT ON (lower(u.email)) u.email, u.id AS to_user
             FROM users u
            WHERE u.society_id = $1 AND u.is_active = true
              AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'resident')
            ORDER BY lower(u.email)`,
          [principal.societyId],
        )).rows;
      }
      const flatFilter = input.audience === 'flats'
        ? `AND upper(trim(f.flat_no)) = ANY (string_to_array($2, ','))`
        : '';
      const params = input.audience === 'flats'
        ? [principal.societyId, (input.flats ?? []).map(f => f.trim().toUpperCase()).join(',')]
        : [principal.societyId];
      return (await q.query<{ email: string; to_user: string | null }>(
        `SELECT DISTINCT ON (lower(o.email)) o.email, u.id AS to_user
           FROM owners o
           JOIN flat_ownership fo ON fo.owner_id = o.id AND fo.held_until IS NULL
           JOIN flats f ON f.id = fo.flat_id
           LEFT JOIN users u ON u.owner_id = o.id AND u.is_active = true
          WHERE o.society_id = $1 AND o.email IS NOT NULL AND o.email <> '' ${flatFilter}
          ORDER BY lower(o.email)`,
        params,
      )).rows;
    };

    if (input.preview === true) {
      const found = await recipients(pool);
      return ok({ recipients: found.length, sample: found.slice(0, 5).map(r => r.email) });
    }

    const batchId = randomUUID();
    const queued = await pool.transaction(async (tx) => {
      const found = await recipients(tx);
      const text = `${input.body.trim()}\n\n— Mani Vista Residents Association`;
      for (const r of found) {
        await tx.query(
          `INSERT INTO notifications (society_id, channel, template, to_user, to_address, subject, payload)
           VALUES ($1, 'email', 'bulk', $2, $3, $4, $5::jsonb)`,
          [principal.societyId, r.to_user, r.email, input.subject.trim(),
            JSON.stringify({ batchId, text, by: principal.email })],
        );
      }
      await audit(tx, {
        societyId: principal.societyId,
        actorUser: principal.userId,
        actorLabel: principal.email,
        action: 'email.bulk',
        subjectTable: 'notifications',
        subjectId: batchId,
        detail: { subject: input.subject.trim(), audience: input.audience, recipients: found.length },
        requestId: ctx.requestId,
      });
      return found.length;
    });

    return created({
      batchId,
      queued,
      emailDelivers: deps.email.delivers,
      note: queued === 0
        ? 'Nobody matched, so nothing was queued.'
        : deps.email.delivers
          ? `${queued} e-mail${queued === 1 ? '' : 's'} queued; sending now.`
          : `${queued} e-mail${queued === 1 ? ' is' : 's are'} queued, but no e-mail service is set up, so none has been sent.`,
    });
  });

  /** The last bulk sends: subject, when, by whom, and how many went, failed or wait. */
  const bulkHistory = route('GET', '/api/emails/bulk', async (ctx) => {
    const principal = who(ctx);
    requirePermission(principal, 'notice.send');
    const result = await pool.query<{
      batch: string; subject: string; by: string; first: string;
      sent: string; failed: string; queued: string;
    }>(
      `SELECT payload->>'batchId' AS batch, max(subject) AS subject, max(payload->>'by') AS by,
              min(queued_at)::text AS first,
              count(*) FILTER (WHERE state = 'sent')::text AS sent,
              count(*) FILTER (WHERE state = 'failed')::text AS failed,
              count(*) FILTER (WHERE state = 'queued')::text AS queued
         FROM notifications
        WHERE society_id = $1 AND template = 'bulk'
        GROUP BY payload->>'batchId'
        ORDER BY min(queued_at) DESC
        LIMIT 30`,
      [principal.societyId],
    );
    return ok({
      sends: result.rows.map(r => ({
        id: r.batch, subject: r.subject, by: r.by, queuedAt: r.first,
        sent: Number(r.sent), failed: Number(r.failed), waiting: Number(r.queued),
      })),
    });
  });

  return [publish, board, bulk, bulkHistory];
}
