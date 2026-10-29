/**
 * Office accounts named in the deployment's settings, created once.
 *
 * For a committee that would rather type its office-bearers into Vercel than
 * into a setup form. Two variables:
 *
 *   OFFICE_ACCOUNTS        "a@x.com=secretary,b@y.com=treasurer,c@z.com=manager"
 *   OFFICE_START_PASSWORD  the starting password every listed account gets
 *
 * and, when no production society exists yet, BOOTSTRAP_SOCIETY_NAME (with the
 * optional BOOTSTRAP_INVOICE_PREFIX, _GSTIN, _STATE_CODE, _REGISTRATION_NO the
 * terminal bootstrap already reads), so the society is created with the
 * listed secretary.
 *
 * It only ever adds. An address that already has an account in the society —
 * active or deactivated — is left exactly as it is: its password, its roles,
 * whether it may sign in. So the variables cannot reset a password someone has
 * since changed, nor bring back an account the committee switched off. Each
 * listed account gets one role, so the maker-checker separation holds by
 * construction. Remove both variables once the accounts exist.
 */

import type { PgPool, Queryable } from './pg';
import type { Logger } from './logger';
import { hashPassword } from './security';
import { isValidRole, type Role } from './rbac';
import { audit } from './audit';
import { createProductionSociety, needsBootstrap } from './bootstrap';

export interface DeploymentAccounts {
  readonly accounts: readonly { email: string; role: Role }[];
  readonly password: string;
  readonly society: {
    name: string; invoicePrefix: string;
    gstin?: string; stateCode?: string; registrationNo?: string;
  } | null;
}

export type ParsedAccounts =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly problem: string }
  | { readonly kind: 'ok'; readonly spec: DeploymentAccounts };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reads the variables. A mistake is reported, never thrown: a typo must not take the site down. */
export function parseDeploymentAccounts(env: Record<string, string | undefined>): ParsedAccounts {
  const list = (env.OFFICE_ACCOUNTS ?? '').trim();
  const password = env.OFFICE_START_PASSWORD ?? '';
  if (list === '' && password === '') return { kind: 'none' };
  if (list === '') return { kind: 'invalid', problem: 'OFFICE_START_PASSWORD is set but OFFICE_ACCOUNTS is empty.' };
  if (password === '') return { kind: 'invalid', problem: 'OFFICE_ACCOUNTS is set but OFFICE_START_PASSWORD is empty.' };
  if (password.length < 12) {
    return { kind: 'invalid', problem: `OFFICE_START_PASSWORD is ${password.length} characters; at least 12 are needed.` };
  }

  const accounts: { email: string; role: Role }[] = [];
  for (const raw of list.split(/[,;\n]/)) {
    const entry = raw.trim();
    if (entry === '') continue;
    const at = entry.lastIndexOf('=');
    if (at < 0) return { kind: 'invalid', problem: `OFFICE_ACCOUNTS: "${entry}" should look like email=role.` };
    const email = entry.slice(0, at).trim().toLowerCase();
    const role = entry.slice(at + 1).trim().toLowerCase();
    if (!EMAIL.test(email)) return { kind: 'invalid', problem: `OFFICE_ACCOUNTS: "${email}" is not an e-mail address.` };
    if (!isValidRole(role)) return { kind: 'invalid', problem: `OFFICE_ACCOUNTS: "${role}" is not a role.` };
    if (accounts.some(a => a.email === email)) {
      return {
        kind: 'invalid',
        problem: `OFFICE_ACCOUNTS lists ${email} twice. One role per account: one account holding two ` +
          'could both make and check the same figures.',
      };
    }
    accounts.push({ email, role });
  }
  if (accounts.length === 0) return { kind: 'invalid', problem: 'OFFICE_ACCOUNTS names no accounts.' };
  if (accounts.filter(a => a.role === 'secretary').length > 1) {
    return { kind: 'invalid', problem: 'OFFICE_ACCOUNTS names more than one secretary.' };
  }

  const name = (env.BOOTSTRAP_SOCIETY_NAME ?? '').trim();
  const opt = (key: string) => {
    const value = (env[key] ?? '').trim();
    return value === '' ? undefined : value;
  };
  const gstin = opt('BOOTSTRAP_GSTIN')?.toUpperCase();
  const stateCode = opt('BOOTSTRAP_STATE_CODE');
  const registrationNo = opt('BOOTSTRAP_REGISTRATION_NO');
  return {
    kind: 'ok',
    spec: {
      accounts,
      password,
      society: name === '' ? null : {
        name,
        invoicePrefix: (opt('BOOTSTRAP_INVOICE_PREFIX') ?? 'MV').toUpperCase(),
        ...(gstin === undefined ? {} : { gstin }),
        ...(stateCode === undefined ? {} : { stateCode }),
        ...(registrationNo === undefined ? {} : { registrationNo }),
      },
    },
  };
}

export interface ProvisionResult {
  readonly societyCreated: boolean;
  readonly created: readonly string[];
  readonly alreadyThere: readonly string[];
  /** Why nothing could be done, when nothing was. */
  readonly problem?: string;
}

/** Creates what is missing, inside one transaction. Safe to run any number of times. */
export function provisionDeploymentAccounts(
  pool: PgPool, spec: DeploymentAccounts, log: Logger,
): Promise<ProvisionResult> {
  return pool.transaction(tx => provisionInTransaction(tx, spec, log));
}

/** The same, inside a transaction the caller holds. */
export async function provisionInTransaction(
  tx: Queryable, spec: DeploymentAccounts, log: Logger,
): Promise<ProvisionResult> {
  {
    // The same lock the setup form takes, so this and a setup request cannot
    // both decide there is no society yet.
    await tx.query('LOCK TABLE societies IN SHARE ROW EXCLUSIVE MODE');

    let societyCreated = false;
    if (await needsBootstrap(tx)) {
      const secretary = spec.accounts.find(a => a.role === 'secretary');
      if (spec.society === null || secretary === undefined) {
        return {
          societyCreated, created: [], alreadyThere: [],
          problem: 'No society exists yet. To create it from the deployment settings, set ' +
            'BOOTSTRAP_SOCIETY_NAME and list a secretary in OFFICE_ACCOUNTS.',
        };
      }
      await createProductionSociety(tx, {
        societyName: spec.society.name,
        invoicePrefix: spec.society.invoicePrefix,
        secretaryEmail: secretary.email,
        secretaryPassword: spec.password,
        ...(spec.society.gstin === undefined ? {} : { gstin: spec.society.gstin }),
        ...(spec.society.stateCode === undefined ? {} : { stateCode: spec.society.stateCode }),
        ...(spec.society.registrationNo === undefined ? {} : { registrationNo: spec.society.registrationNo }),
      });
      societyCreated = true;
    }

    const society = await tx.query<{ id: string }>(
      `SELECT id FROM societies WHERE mode = 'production' ORDER BY created_at LIMIT 1`,
    );
    const societyId = society.rows[0].id;

    const created: string[] = [];
    const alreadyThere: string[] = [];
    for (const account of spec.accounts) {
      const existing = await tx.query(
        'SELECT 1 FROM users WHERE society_id = $1 AND lower(email) = $2 LIMIT 1',
        [societyId, account.email],
      );
      if (existing.rows.length > 0) {
        // Includes the secretary the society was just created with.
        (societyCreated && account.role === 'secretary' ? created : alreadyThere).push(account.email);
        continue;
      }
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO users (society_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [societyId, account.email, hashPassword(spec.password)],
      );
      await tx.query(
        'INSERT INTO user_roles (user_id, role) VALUES ($1, $2)',
        [inserted.rows[0].id, account.role],
      );
      await audit(tx, {
        societyId,
        actorUser: null,
        actorLabel: 'deployment settings (OFFICE_ACCOUNTS)',
        action: 'user.create',
        subjectTable: 'users',
        subjectId: inserted.rows[0].id,
        detail: { email: account.email, roles: [account.role], startingPassword: true },
      });
      created.push(account.email);
    }

    if (created.length > 0) {
      log.info('office accounts created from the deployment settings', {
        societyCreated, created: created.length, alreadyThere: alreadyThere.length,
      });
    }
    return { societyCreated, created, alreadyThere };
  }
}
