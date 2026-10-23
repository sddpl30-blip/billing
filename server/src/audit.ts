/**
 * The audit trail.
 *
 * Every write endpoint records what it did, who did it and which request it
 * came from. The table is append-only at the database (a DO INSTEAD NOTHING
 * delete rule), so this is a trail rather than a log that can be tidied.
 *
 * Detail goes through `redact` on the way in. An audit row describing a
 * sign-in should say that one happened, not carry the code that was used.
 */

import type { Queryable } from './pg';
import { redact } from './security';

export interface AuditEntry {
  readonly societyId: string;
  readonly actorUser: string | null;
  readonly actorLabel: string;
  /** `billing.approve`, `payment.record` — the permission-shaped name. */
  readonly action: string;
  readonly subjectTable?: string;
  readonly subjectId?: string;
  readonly detail?: Record<string, unknown>;
  readonly requestId?: string;
}

export async function audit(tx: Queryable, entry: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log
       (society_id, actor_user, actor_label, action, subject_table, subject_id, detail, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      entry.societyId,
      entry.actorUser,
      entry.actorLabel,
      entry.action,
      entry.subjectTable ?? null,
      entry.subjectId ?? null,
      entry.detail === undefined ? null : JSON.stringify(redact(entry.detail)),
      entry.requestId ?? null,
    ],
  );
}

export interface AuditRow {
  readonly at: string;
  readonly actorLabel: string;
  readonly action: string;
  readonly subjectTable: string | null;
  readonly subjectId: string | null;
  readonly detail: unknown;
  readonly requestId: string | null;
}

export async function readAudit(
  tx: Queryable,
  input: { societyId: string; limit: number; action?: string; subjectId?: string },
): Promise<AuditRow[]> {
  const conditions = ['society_id = $1'];
  const params: Array<string | number | null> = [input.societyId];
  if (input.action !== undefined) {
    params.push(input.action);
    conditions.push(`action = $${params.length}`);
  }
  if (input.subjectId !== undefined) {
    params.push(input.subjectId);
    conditions.push(`subject_id = $${params.length}`);
  }
  params.push(input.limit);

  const result = await tx.query<{
    at: string; actor_label: string; action: string; subject_table: string | null;
    subject_id: string | null; detail: string | null; request_id: string | null;
  }>(
    `SELECT at::text, actor_label, action, subject_table, subject_id,
            detail::text, request_id
       FROM audit_log
      WHERE ${conditions.join(' AND ')}
      ORDER BY at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );

  return result.rows.map(r => ({
    at: r.at,
    actorLabel: r.actor_label,
    action: r.action,
    subjectTable: r.subject_table,
    subjectId: r.subject_id,
    detail: r.detail === null ? null : JSON.parse(r.detail),
    requestId: r.request_id,
  }));
}
