/**
 * Creating the association's real society, once.
 *
 * A fresh production database has the schema and nothing in it: no society,
 * no chart of accounts, no account anyone can sign in with. The seed fills a
 * database with demo data and refuses production on purpose, so this is the
 * other door — it creates one production society with the structure every
 * society needs, and its first account, the secretary's. Everything after
 * that (flats, owners, the other office-bearers, the rate, the GST treatment)
 * is done by the secretary in the app, through the same rules as any change.
 *
 * Two ways in, the same function behind both:
 *
 *   · `npm run db:bootstrap`, from a terminal, reading BOOTSTRAP_* variables
 *   · POST /api/setup, from the setup screen, behind SETUP_TOKEN
 *
 * Both refuse once a production society exists. There is exactly one first
 * time, and a second "first secretary" is not something a URL should be able
 * to create.
 */

import { CHART, RECEIPT_HEADS } from '../../src/accounting/accounts';
import type { PgPool, Queryable } from './pg';
import { hashPassword } from './security';
import { writeSetting, SETTING_KEYS } from './settings';
import { audit } from './audit';

/**
 * What any society needs before its first bill: the chart of accounts and the
 * receipt heads (both mirrored from the engine rather than retyped, so the
 * two cannot drift), the helpdesk categories, and the billing settings.
 *
 * GST starts off and unapproved. Whether the association charges it is a
 * determination its CA makes and its treasurer signs off in the app; the
 * billing run refuses a tax nobody has approved.
 */
export async function installSocietyStructure(
  tx: Queryable,
  societyId: string,
  options: { invoicePrefix: string; gstNote: string },
): Promise<void> {
  for (const entry of CHART) {
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

  for (const head of RECEIPT_HEADS) {
    // Which heads carry GST is a tax determination, not a fact about the head:
    // maintenance and rental are services, a sinking fund contribution is a
    // corpus collection. Whether any of it is charged still depends on the
    // society's approved treatment, which starts off.
    const taxable = head.key === 'maintenance' || head.key === 'rental' || head.key === 'other';
    // A sinking contribution is credited to the fund rather than to income, so
    // it never appears as surplus the committee could spend.
    const creditsFundDirectly = head.key === 'sinking';
    await tx.query(
      `INSERT INTO receipt_heads
         (society_id, key, label, income_account, fund_account, taxable, credits_fund_directly)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (society_id, key) DO UPDATE
          SET label = EXCLUDED.label, income_account = EXCLUDED.income_account,
              fund_account = EXCLUDED.fund_account, taxable = EXCLUDED.taxable,
              credits_fund_directly = EXCLUDED.credits_fund_directly`,
      [societyId, head.key, head.label, head.income, head.fund ?? null, taxable, creditsFundDirectly],
    );
  }

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

  await writeSetting(tx, {
    societyId,
    key: SETTING_KEYS.GST,
    value: { chargeGst: false, ratePercent: 0 },
    note: options.gstNote,
  });
  await writeSetting(tx, { societyId, key: SETTING_KEYS.INVOICE_PREFIX, value: options.invoicePrefix });
  await writeSetting(tx, { societyId, key: SETTING_KEYS.DUE_DAYS, value: 15 });
  await writeSetting(tx, { societyId, key: SETTING_KEYS.SINKING_PERCENT, value: 10 });
  await writeSetting(tx, { societyId, key: SETTING_KEYS.BILLING_DAY, value: 1 });
}

export interface BootstrapInput {
  readonly societyName: string;
  readonly registrationNo?: string;
  /** Only the association's own. Never a sample: it is a legal assertion. */
  readonly gstin?: string;
  readonly stateCode?: string;
  readonly invoicePrefix: string;
  readonly secretaryEmail: string;
  readonly secretaryPassword: string;
  /** The operating bank account, if known at setup. */
  readonly bank?: { readonly bankName: string; readonly last4: string; readonly ifsc: string };
  readonly requestId?: string;
}

export class AlreadyBootstrappedError extends Error {
  constructor() {
    super(
      'This database already has a production society. Setup runs once; the secretary ' +
      'adds everything else from the app.',
    );
    this.name = 'AlreadyBootstrappedError';
  }
}

/** Whether a production society exists yet. */
export async function needsBootstrap(db: Queryable): Promise<boolean> {
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM societies WHERE mode = 'production'`,
  );
  return r.rows[0]?.n === '0';
}

/**
 * Creates the production society and its secretary, inside `tx`.
 *
 * The table lock makes "is there one yet?" and "create it" a single step:
 * two setup requests at the same moment would otherwise both see none and
 * both create a society.
 */
export async function createProductionSociety(
  tx: Queryable,
  input: BootstrapInput,
): Promise<{ societyId: string; secretaryId: string }> {
  await tx.query('LOCK TABLE societies IN SHARE ROW EXCLUSIVE MODE');
  if (!(await needsBootstrap(tx))) throw new AlreadyBootstrappedError();

  const society = await tx.query<{ id: string }>(
    `INSERT INTO societies (name, mode, registration_no, gstin, state_code)
     VALUES ($1, 'production', $2, $3, $4)
     RETURNING id`,
    [input.societyName, input.registrationNo ?? null, input.gstin ?? null, input.stateCode ?? null],
  );
  const societyId = society.rows[0].id;

  await installSocietyStructure(tx, societyId, {
    invoicePrefix: input.invoicePrefix,
    gstNote:
      'Set at setup. No GST is charged until the treatment is entered and approved by ' +
      'someone other than the person who entered it.',
  });

  const user = await tx.query<{ id: string }>(
    `INSERT INTO users (society_id, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [societyId, input.secretaryEmail.trim().toLowerCase(), hashPassword(input.secretaryPassword)],
  );
  const secretaryId = user.rows[0].id;
  await tx.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'secretary')`, [secretaryId]);

  if (input.bank !== undefined) {
    // The operating account, mapped to the bank ledger the chart calls 1000.
    // Last four digits and IFSC only: the schema has no column for more.
    await tx.query(
      `INSERT INTO bank_accounts
         (society_id, label, bank_name, account_last4, ifsc, ledger_account, purpose)
       VALUES ($1, 'Operating account', $2, $3, $4, '1000', 'operating')`,
      [societyId, input.bank.bankName, input.bank.last4, input.bank.ifsc.toUpperCase()],
    );
  }

  await audit(tx, {
    societyId,
    actorUser: secretaryId,
    actorLabel: input.secretaryEmail,
    action: 'society.bootstrap',
    subjectTable: 'societies',
    subjectId: societyId,
    detail: {
      name: input.societyName,
      invoicePrefix: input.invoicePrefix,
      bankAccount: input.bank !== undefined,
    },
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });

  return { societyId, secretaryId };
}

export function bootstrapSociety(pool: PgPool, input: BootstrapInput) {
  return pool.transaction(tx => createProductionSociety(tx, input));
}

async function main(): Promise<void> {
  const { PgPool: Pool, connectionFromEnv } = await import('./pg');
  const env = process.env;
  const missing = ['BOOTSTRAP_SOCIETY_NAME', 'BOOTSTRAP_SECRETARY_EMAIL', 'BOOTSTRAP_SECRETARY_PASSWORD']
    .filter(key => (env[key] ?? '').trim() === '');
  if (missing.length > 0) {
    console.error(
      `Set ${missing.join(', ')}. Optional: BOOTSTRAP_INVOICE_PREFIX (default MV), ` +
      'BOOTSTRAP_REGISTRATION_NO, BOOTSTRAP_GSTIN, BOOTSTRAP_STATE_CODE.',
    );
    process.exit(2);
  }
  // The direct endpoint where there is one: a setup is a one-off write and
  // the pooler adds nothing to it.
  const pool = new Pool(connectionFromEnv(env, 'DIRECT_URL'), 1);
  try {
    const result = await bootstrapSociety(pool, {
      societyName: (env.BOOTSTRAP_SOCIETY_NAME as string).trim(),
      invoicePrefix: (env.BOOTSTRAP_INVOICE_PREFIX ?? 'MV').trim(),
      secretaryEmail: (env.BOOTSTRAP_SECRETARY_EMAIL as string).trim(),
      secretaryPassword: env.BOOTSTRAP_SECRETARY_PASSWORD as string,
      ...(env.BOOTSTRAP_REGISTRATION_NO ? { registrationNo: env.BOOTSTRAP_REGISTRATION_NO.trim() } : {}),
      ...(env.BOOTSTRAP_GSTIN ? { gstin: env.BOOTSTRAP_GSTIN.trim().toUpperCase() } : {}),
      ...(env.BOOTSTRAP_STATE_CODE ? { stateCode: env.BOOTSTRAP_STATE_CODE.trim() } : {}),
    });
    console.log(
      `\nCreated society ${result.societyId}.\n` +
      `Sign in as ${env.BOOTSTRAP_SECRETARY_EMAIL} with the password you set, then, from the\n` +
      'Office: add the flats and owners, the treasurer and manager accounts, the maintenance\n' +
      'rate (the treasurer approves it), and the bank account.\n',
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
