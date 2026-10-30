/**
 * The welcome e-mail: "your portal is ready, here is how to sign in".
 *
 * Queued like any other e-mail (a notifications row, template 'welcome') and
 * sent by the dispatcher, so it is marked sent only on the provider's answer.
 * It never carries a password: an account with one is told to use the
 * password the office gave it, and one without is told to use Google with
 * this same address, or to ask the office.
 */

import type { Queryable } from './pg';

export interface WelcomeTarget {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly flats: readonly string[];
  readonly hasPassword: boolean;
}

/** Who to welcome: the given accounts, or every resident who has never signed in and was never welcomed. */
export async function welcomeTargets(
  tx: Queryable,
  input: { societyId: string; userIds?: readonly string[] },
): Promise<WelcomeTarget[]> {
  const params: string[] = [input.societyId];
  let filter: string;
  if (input.userIds !== undefined) {
    // One comma-joined text parameter: the driver sends no arrays.
    params.push(input.userIds.join(','));
    filter = `AND u.id::text = ANY (string_to_array($2, ','))`;
  } else {
    filter = `AND u.last_login_at IS NULL
              AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'resident')
              AND NOT EXISTS (SELECT 1 FROM notifications n
                               WHERE n.to_user = u.id AND n.template = 'welcome')`;
  }
  const rows = await tx.query<{
    id: string; email: string; full_name: string | null; flats: string | null; has_password: string;
  }>(
    `SELECT u.id, u.email, o.full_name,
            (SELECT string_agg(f.flat_no, ', ' ORDER BY f.flat_no)
               FROM flat_ownership fo JOIN flats f ON f.id = fo.flat_id
              WHERE fo.owner_id = u.owner_id AND fo.held_until IS NULL) AS flats,
            (u.password_hash IS NOT NULL)::text AS has_password
       FROM users u
       LEFT JOIN owners o ON o.id = u.owner_id
      WHERE u.society_id = $1 AND u.is_active = true ${filter}
      ORDER BY u.email`,
    params,
  );
  return rows.rows.map(r => ({
    userId: r.id,
    email: r.email,
    name: r.full_name,
    flats: r.flats === null ? [] : r.flats.split(', '),
    hasPassword: r.has_password === 't' || r.has_password === 'true',
  }));
}

export function welcomeMessage(input: {
  societyName: string; portalUrl: string; contactEmail: string | null; target: WelcomeTarget;
}): { subject: string; text: string } {
  const { target } = input;
  const lines = [
    `Dear ${target.name ?? 'Member'},`,
    '',
    `${input.societyName} now keeps its maintenance bills, receipts and notices online, and your account is ready.`,
    '',
    `Open: ${input.portalUrl}`,
    `Sign in as: ${target.email}`,
    ...(target.flats.length > 0 ? [`Flat: ${target.flats.join(', ')}`] : []),
    '',
    'How to sign in:',
    `- Press "Sign in with Google" and choose this same address, ${target.email}.`,
    ...(target.hasPassword
      ? ['- Or type this address and the password the office gave you.']
      : [`- If ${target.email} is not a Google account, ask the office to set a password for you.`]),
    '',
    'On your phone you can keep it as an app: in Chrome, menu (⋮) → Install app; on iPhone, Safari → Share → Add to Home Screen.',
    '',
    ...(input.contactEmail !== null ? [`Questions: ${input.contactEmail}`, ''] : []),
    `— ${input.societyName}`,
  ];
  return { subject: `Your ${input.societyName} portal is ready`, text: lines.join('\n') };
}
