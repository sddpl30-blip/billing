/**
 * An owner's e-mail addresses. `owners.email` is the primary one (unique, and
 * what sign-in links to); migration 015 adds `extra_emails`, a comma-separated
 * list of further addresses that also receive the owner's bills.
 */

import { migrationApplied } from './billing';
import type { Queryable } from './pg';

const ADDRESS = /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/;

/** Splits "a@x.com; b@y.com, c@z.com" into lowercase, de-duplicated addresses. Throws on one that is not an address. */
export function parseEmails(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.split(/[,;\s]+/)) {
    const address = piece.trim().toLowerCase();
    if (address === '') continue;
    if (address.length > 254 || !ADDRESS.test(address)) throw new Error(`"${piece.trim()}" is not an e-mail address.`);
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

/** The SQL for "every address that receives this owner's bills", for an owners row aliased `alias`. */
export async function ownerMailSql(tx: Queryable, alias = 'o'): Promise<string> {
  return (await migrationApplied(tx, '015_owner_extra_emails.sql'))
    ? `(${alias}.email || COALESCE(', ' || NULLIF(${alias}.extra_emails, ''), ''))`
    : `${alias}.email`;
}

/** The recipients in a stored address list ("a, b"), for a provider that wants them one by one. */
export const recipientsOf = (to: string): string[] =>
  to.split(/[,;]+/).map(a => a.trim()).filter(a => a !== '');
