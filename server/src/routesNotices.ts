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
import type { PgPool } from './pg';
import type { EmailProvider } from './providers/email';
import { route, type RequestContext, type Reply, type RouteDefinition } from './http';
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

  return [publish, board];
}
