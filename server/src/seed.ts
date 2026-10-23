/**
 * Development seed.
 *
 * Creates a society whose `mode` is 'demo', and nothing else. Every query in
 * the API filters on the society, so demo data and real data cannot mix even
 * though they share a schema — and this script refuses to run against a
 * production-mode society at all.
 *
 * What it deliberately does not create:
 *   · a GSTIN, or any tax registration — those are legal assertions
 *   · a bank account number, customer id, or any credential
 *   · an approved GST treatment — the demo starts with GST off and
 *     unapproved, so the refusal path is what you see first
 *   · real residents. The names are obviously placeholders.
 *
 * The maintenance rate is the ₹4.50 per square foot figure from the brief,
 * recorded with its authority given as demo data rather than as a resolution
 * that was passed.
 *
 *   node .server-build/server/src/seed.js
 */

import { PgPool, connectionFromEnv } from './pg';
import { hashPassword } from './security';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { installSocietyStructure } from './bootstrap';
import type { Queryable } from './pg';

/** Placeholder flats. Areas vary so the per-square-foot charge is visible. */
const FLATS: ReadonlyArray<[string, string, number, number]> = [
  // flat no, wing, floor, super built-up area
  ['A-101', 'A', 1, 1150], ['A-102', 'A', 1, 985],
  ['A-201', 'A', 2, 1150], ['A-202', 'A', 2, 985],
  ['B-101', 'B', 1, 1340], ['B-102', 'B', 1, 1150],
  ['B-201', 'B', 2, 1340], ['B-204', 'B', 2, 985],
  ['C-301', 'C', 3, 1620], ['C-302', 'C', 3, 1150],
];

const STAFF_ROLES: readonly string[] = ['manager', 'treasurer', 'secretary', 'auditor'];

export interface SeedResult {
  readonly societyId: string;
  readonly flats: ReadonlyArray<{ id: string; flatNo: string }>;
  readonly users: ReadonlyArray<{ id: string; email: string; role: string }>;
  readonly bankAccountId: string;
  readonly password: string;
}

/**
 * Seeds one demo society.
 *
 * Idempotent on the society name: a second run finds the existing society and
 * returns its ids rather than creating a parallel one.
 */
export async function seed(
  pool: PgPool,
  input: { name?: string; password: string; emailDomain?: string },
): Promise<SeedResult> {
  const name = input.name ?? 'Mani Vista Residents Association (demo)';
  // Addresses are namespaced per seeded society, because migration 005 makes
  // an address identify at most one active account across the whole database —
  // deliberately, since sign-in is by address alone. Two demo societies
  // therefore cannot share manager@demo.invalid, and the test suite seeds its
  // own society on each run.
  const domain = input.emailDomain ?? 'demo.invalid';

  return pool.transaction(async (tx: Queryable) => {
    const existing = await tx.query<{ id: string; mode: string }>(
      'SELECT id, mode FROM societies WHERE name = $1',
      [name],
    );
    if (existing.rows[0]?.mode === 'production') {
      throw new Error(
        `"${name}" is a production society. The seed refuses to touch one: demo data in a ` +
        `real society's books is not something that can be cleanly undone.`,
      );
    }

    let societyId = existing.rows[0]?.id;
    if (societyId === undefined) {
      const society = await tx.query<{ id: string }>(
        `INSERT INTO societies (name, mode, registration_no, state_code)
         VALUES ($1, 'demo', NULL, NULL)
         RETURNING id`,
        [name],
      );
      societyId = society.rows[0].id;
    }

    // The chart of accounts, receipt heads, helpdesk categories and billing
    // settings: the same structure a real society gets at setup, from the one
    // function both use, so demo and production cannot be built differently.
    await installSocietyStructure(tx, societyId, {
      invoicePrefix: 'MV',
      gstNote:
        'Demo default. No GST is charged and no treatment is approved. Charging requires a ' +
        'rate and a recorded sign-off.',
    });

    const bank = await tx.query<{ id: string }>(
      `INSERT INTO bank_accounts
         (society_id, label, bank_name, account_last4, ifsc, ledger_account, purpose)
       VALUES ($1, 'Operating account', 'Demo Bank', '0000', 'DEMO0123456', '1000', 'operating')
       ON CONFLICT (society_id, label) DO UPDATE SET bank_name = EXCLUDED.bank_name
       RETURNING id`,
      [societyId],
    );

    // Users. The password is the caller's, not a constant in this file, and
    // the accounts live on the .invalid domain so nothing can be emailed to a
    // real address by accident.
    const passwordHash = hashPassword(input.password);
    const users: Array<{ id: string; email: string; role: string }> = [];

    const upsertUser = async (
      email: string, role: string, ownerId: string | null,
    ): Promise<string> => {
      const row = await tx.query<{ id: string }>(
        `INSERT INTO users (society_id, email, password_hash, owner_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (society_id, email) DO UPDATE
            SET password_hash = EXCLUDED.password_hash, owner_id = EXCLUDED.owner_id
         RETURNING id`,
        [societyId, email, passwordHash, ownerId],
      );
      const id = row.rows[0].id;
      await tx.query(
        `INSERT INTO user_roles (user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [id, role],
      );
      users.push({ id, email, role });
      return id;
    };

    for (const role of STAFF_ROLES) await upsertUser(`${role}@${domain}`, role, null);

    const flats: Array<{ id: string; flatNo: string }> = [];
    for (const [flatNo, wing, floor, area] of FLATS) {
      const flat = await tx.query<{ id: string }>(
        `INSERT INTO flats
           (society_id, flat_no, wing, floor, billing_area_sqft, area_basis)
         VALUES ($1,$2,$3,$4,$5,'super-built-up')
         ON CONFLICT (society_id, flat_no) DO UPDATE
            SET billing_area_sqft = EXCLUDED.billing_area_sqft,
                area_basis = EXCLUDED.area_basis
         RETURNING id`,
        [societyId, flatNo, wing, floor, area],
      );
      const flatId = flat.rows[0].id;
      flats.push({ id: flatId, flatNo });

      const email = `owner.${flatNo.toLowerCase().replace('-', '')}@${domain}`;
      const owner = await tx.query<{ id: string }>(
        `INSERT INTO owners (society_id, full_name, email)
         VALUES ($1,$2,$3)
         ON CONFLICT (society_id, email) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING id`,
        [societyId, `Owner of ${flatNo} (demo)`, email],
      );
      const ownerId = owner.rows[0].id;

      const held = await tx.query<{ id: string }>(
        `SELECT id FROM flat_ownership
          WHERE flat_id = $1 AND role = 'owner' AND held_until IS NULL`,
        [flatId],
      );
      if (held.rows[0] === undefined) {
        await tx.query(
          `INSERT INTO flat_ownership (flat_id, owner_id, role, held_from)
           VALUES ($1,$2,'owner', current_date - 365)`,
          [flatId, ownerId],
        );
      }

      await upsertUser(email, 'resident', ownerId);
    }

    // The rate from the brief: ₹4.50 per square foot of super built-up area.
    // Approved here because this is demo data and the demo has to be able to
    // bill; the authority line says exactly what it is.
    const treasurer = users.find(u => u.role === 'treasurer');
    await tx.query(
      `INSERT INTO maintenance_rates
         (society_id, rate_paise_per_sqft, area_basis, effective_from, authority,
          approved_by, approved_on)
       VALUES ($1, 450, 'super-built-up', current_date - 365,
               'Demo data. Not a resolution of any association.', $2, current_date - 365)
       ON CONFLICT (society_id, effective_from) DO NOTHING`,
      [societyId, treasurer?.id ?? null],
    );

    return {
      societyId,
      flats,
      users,
      bankAccountId: bank.rows[0].id,
      password: input.password,
    };
  });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (config.mode === 'production') {
    console.error(
      'refusing to seed with NODE_ENV=production. The seed creates demo data, and demo ' +
      'residents in a production deployment is not a mistake that can be tidied up later.',
    );
    process.exit(2);
  }
  const log = createLogger(config);
  const pool = new PgPool(connectionFromEnv(process.env));
  const password = process.env.SEED_PASSWORD ?? 'demo-password-change-me';

  try {
    const result = await seed(pool, { password });
    log.info('seeded', {
      societyId: result.societyId,
      flats: result.flats.length,
      users: result.users.length,
    });
    console.log(
      `\nDemo society ${result.societyId}\n` +
      `  ${result.flats.length} flats, ${result.users.length} accounts\n` +
      `  sign in with treasurer@demo.invalid and the password in SEED_PASSWORD\n` +
      `  GST is off and unapproved; the billing rate is approved demo data\n`,
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
