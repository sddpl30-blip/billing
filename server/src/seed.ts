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

import { CHART, RECEIPT_HEADS } from '../../src/accounting/accounts';
import { PgPool, connectionFromEnv } from './pg';
import { hashPassword } from './security';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { writeSetting, SETTING_KEYS } from './settings';
import type { Queryable } from './pg';

/**
 * The chart of accounts, and the receipt heads, come from the engine.
 *
 * Not retyped here. They were, and the two drifted immediately: the engine has
 * 5000 as water supply and this file had it as housekeeping, so a vendor bill
 * booked to "housekeeping" through the API would have shown up as water in
 * every report the engine renders, and a journal entry restored into the
 * client's ledger would have been refused for naming an account the engine
 * does not know. One definition, mirrored into the database.
 */
const ACCOUNTS = CHART;

const RECEIPT_HEAD_ROWS: ReadonlyArray<{
  key: string; label: string; income: string | null; fund: string | null;
  taxable: boolean; creditsFundDirectly: boolean;
}> = RECEIPT_HEADS.map(head => ({
  key: head.key,
  label: head.label,
  income: head.income,
  fund: head.fund ?? null,
  // Which heads carry GST is a tax determination, not a fact about the head:
  // maintenance and rental are services, a sinking fund contribution is a
  // corpus collection. Whether any of it is charged at all still depends on
  // the society's approved treatment, which starts off.
  taxable: head.key === 'maintenance' || head.key === 'rental' || head.key === 'other',
  // A sinking contribution is credited to the fund rather than to income, so
  // it never appears as surplus the committee could spend.
  creditsFundDirectly: head.key === 'sinking',
}));

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

    for (const entry of ACCOUNTS) {
      await tx.query(
        `INSERT INTO accounts (society_id, code, name, class, grp, is_cash, control)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (society_id, code) DO UPDATE
            SET name = EXCLUDED.name, class = EXCLUDED.class, grp = EXCLUDED.grp,
                is_cash = EXCLUDED.is_cash, control = EXCLUDED.control`,
        [
          societyId, entry.code, entry.name, entry.cls, entry.group,
          entry.isCash ?? false, entry.control ?? null,
        ],
      );
    }

    for (const head of RECEIPT_HEAD_ROWS) {
      await tx.query(
        `INSERT INTO receipt_heads
           (society_id, key, label, income_account, fund_account, taxable, credits_fund_directly)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (society_id, key) DO UPDATE
            SET label = EXCLUDED.label, income_account = EXCLUDED.income_account,
                fund_account = EXCLUDED.fund_account, taxable = EXCLUDED.taxable,
                credits_fund_directly = EXCLUDED.credits_fund_directly`,
        [societyId, head.key, head.label, head.income, head.fund, head.taxable, head.creditsFundDirectly],
      );
    }

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

    await tx.query(
      `INSERT INTO ticket_categories (society_id, key, label, sla_hours, escalate_to_role)
       VALUES ($1,'plumbing','Plumbing',24,'manager'),
              ($1,'electrical','Electrical',12,'manager'),
              ($1,'lift','Lift',6,'secretary'),
              ($1,'housekeeping','Housekeeping',48,'manager'),
              ($1,'security','Security',4,'secretary'),
              ($1,'billing','Billing query',72,'treasurer')
       ON CONFLICT (society_id, key) DO NOTHING`,
      [societyId],
    );

    // Settings. GST starts off and unapproved on purpose: the first thing a
    // demo should show is the system refusing to charge a tax nobody has
    // signed off, not a confident 18%.
    await writeSetting(tx, {
      societyId,
      key: SETTING_KEYS.GST,
      value: { chargeGst: false, ratePercent: 0 },
      note:
        'Demo default. No GST is charged and no treatment is approved. Charging requires a ' +
        'rate and a recorded sign-off.',
    });
    await writeSetting(tx, { societyId, key: SETTING_KEYS.INVOICE_PREFIX, value: 'MV' });
    await writeSetting(tx, { societyId, key: SETTING_KEYS.DUE_DAYS, value: 15 });
    await writeSetting(tx, { societyId, key: SETTING_KEYS.SINKING_PERCENT, value: 10 });
    await writeSetting(tx, { societyId, key: SETTING_KEYS.BILLING_DAY, value: 1 });

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
