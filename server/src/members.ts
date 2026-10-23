/**
 * Flats, owners and the accounts residents sign in with.
 *
 * The single-flat routes (POST /api/flats, POST /api/flats/:id/owner) and the
 * CSV import write the same rows by the same rules, so those rules live here
 * once. Two doors that each wrote ownership their own way is how one of them
 * forgets to close the outgoing owner's tenure.
 */

import type { Queryable } from './pg';
import { conflict } from './http';

export type AreaBasisValue = 'carpet' | 'built-up' | 'super-built-up';
export type HolderRole = 'owner' | 'co-owner' | 'tenant';

export interface FlatFields {
  readonly flatNo: string;
  readonly wing: string | null;
  readonly floor: number | null;
  readonly billingAreaSqFt: number | null;
  readonly areaBasis: AreaBasisValue | null;
  readonly nonOccupied: boolean;
}

export async function insertFlat(
  tx: Queryable,
  societyId: string,
  flat: FlatFields,
): Promise<string> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO flats (society_id, flat_no, wing, floor, billing_area_sqft, area_basis, non_occupied)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [
      societyId, flat.flatNo, flat.wing, flat.floor,
      flat.billingAreaSqFt, flat.areaBasis, flat.nonOccupied,
    ],
  );
  return inserted.rows[0].id;
}

/** Updates the descriptive fields of a flat. Its number is its identity and stays. */
export async function updateFlat(
  tx: Queryable,
  societyId: string,
  flatId: string,
  flat: Omit<FlatFields, 'flatNo' | 'nonOccupied'>,
): Promise<void> {
  await tx.query(
    `UPDATE flats SET wing = $3, floor = $4, billing_area_sqft = $5, area_basis = $6
      WHERE id = $1 AND society_id = $2`,
    [flatId, societyId, flat.wing, flat.floor, flat.billingAreaSqFt, flat.areaBasis],
  );
}

/**
 * Creates the owner for an address, or refreshes the name on the one that
 * exists. Owners are unique by address within a society, so the same person
 * holding two flats is one owner with two tenures.
 */
export async function upsertOwner(
  tx: Queryable,
  input: { societyId: string; fullName: string; email: string; phone?: string | null; pan?: string | null },
): Promise<string> {
  const owner = await tx.query<{ id: string }>(
    `INSERT INTO owners (society_id, full_name, email, phone, pan)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (society_id, email) DO UPDATE
        SET full_name = EXCLUDED.full_name,
            phone = COALESCE(EXCLUDED.phone, owners.phone),
            pan = COALESCE(EXCLUDED.pan, owners.pan)
     RETURNING id`,
    [input.societyId, input.fullName, input.email, input.phone ?? null, input.pan ?? null],
  );
  return owner.rows[0].id;
}

/**
 * Records who holds a flat from a date.
 *
 * With `replaceCurrent`, the outgoing holder's tenure ends the day before the
 * new one starts. Two open rows for one flat and role is how a previous
 * owner's arrears attach to the new one, and a partial unique index refuses
 * it — so the old tenure is closed before the insert, not after.
 */
export async function recordHolder(
  tx: Queryable,
  input: { flatId: string; ownerId: string; role: HolderRole; heldFrom: string; replaceCurrent: boolean },
): Promise<void> {
  if (input.replaceCurrent) {
    await tx.query(
      `UPDATE flat_ownership
          SET held_until = ($2::date - 1)
        WHERE flat_id = $1 AND role = $3 AND held_until IS NULL`,
      [input.flatId, input.heldFrom, input.role],
    );
  }
  await tx.query(
    `INSERT INTO flat_ownership (flat_id, owner_id, role, held_from)
     VALUES ($1,$2,$3,$4)`,
    [input.flatId, input.ownerId, input.role, input.heldFrom],
  );
}

/**
 * Makes `ownerId` the current holder in `role`, changing nothing if they
 * already are.
 *
 * Where someone else holds it, their tenure ends the day before `heldFrom` —
 * unless it only began on or after that date, in which case the earlier row
 * was a mistake made at setup (the sheet imported twice with a corrected
 * address, say) and is corrected in place rather than given a tenure that
 * ends before it starts.
 */
export async function ensureCurrentHolder(
  tx: Queryable,
  input: { flatId: string; ownerId: string; role: HolderRole; heldFrom: string },
): Promise<'unchanged' | 'added' | 'replaced' | 'corrected'> {
  const current = await tx.query<{ id: string; owner_id: string; held_from: string }>(
    `SELECT id, owner_id, held_from::text FROM flat_ownership
      WHERE flat_id = $1 AND role = $2 AND held_until IS NULL`,
    [input.flatId, input.role],
  );
  const row = current.rows[0];
  if (row === undefined) {
    await recordHolder(tx, { ...input, replaceCurrent: false });
    return 'added';
  }
  if (row.owner_id === input.ownerId) return 'unchanged';
  if (row.held_from >= input.heldFrom) {
    await tx.query('UPDATE flat_ownership SET owner_id = $1 WHERE id = $2', [input.ownerId, row.id]);
    return 'corrected';
  }
  await recordHolder(tx, { ...input, replaceCurrent: true });
  return 'replaced';
}

/**
 * The resident account for an owner's address: created without a password,
 * so its holder signs in by emailed code, and linked to the owner record —
 * which is what grants access to the owner's flats.
 *
 * An existing account for the address in this society is linked rather than
 * duplicated, and keeps any roles it has: a committee member who also owns a
 * flat is one person with one sign-in. An address already active in another
 * society is refused, because sign-in is by address alone (migration 005).
 */
export async function ensureResidentUser(
  tx: Queryable,
  input: { societyId: string; email: string; ownerId: string; grantedBy: string | null },
): Promise<'created' | 'linked' | 'unchanged'> {
  const existing = await tx.query<{ id: string; society_id: string; owner_id: string | null; is_active: string }>(
    `SELECT id, society_id, owner_id, is_active::text FROM users
      WHERE lower(email) = lower($1) AND (society_id = $2 OR is_active)
      ORDER BY (society_id = $2) DESC
      LIMIT 1`,
    [input.email, input.societyId],
  );
  const user = existing.rows[0];
  if (user !== undefined && user.society_id !== input.societyId) {
    throw conflict(`${input.email} already signs in to another society, so it cannot be given an account here.`);
  }

  let userId: string;
  let outcome: 'created' | 'linked' | 'unchanged';
  if (user === undefined) {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO users (society_id, email, password_hash, owner_id)
       VALUES ($1, lower($2), NULL, $3)
       RETURNING id`,
      [input.societyId, input.email, input.ownerId],
    );
    userId = inserted.rows[0].id;
    outcome = 'created';
  } else {
    userId = user.id;
    if (user.owner_id === input.ownerId) {
      outcome = 'unchanged';
    } else {
      await tx.query('UPDATE users SET owner_id = $1 WHERE id = $2', [input.ownerId, userId]);
      outcome = 'linked';
    }
  }

  const role = await tx.query(
    `INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, 'resident', $2)
     ON CONFLICT (user_id, role) DO NOTHING`,
    [userId, input.grantedBy],
  );
  if (outcome === 'unchanged' && role.rowCount === 1) outcome = 'linked';
  return outcome;
}
