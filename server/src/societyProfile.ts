/**
 * The society's own identity: its registered name and its tax registrations.
 *
 * Every tax invoice and receipt prints these, and the app's header shows them,
 * so they are read from the `societies` row each time a document is generated
 * or the books are loaded — never copied into settings or code. A document
 * already issued keeps the identity it was issued under (documents.ts stores
 * the payload it rendered), which is how a reprint stays the same document.
 */

import type { Queryable } from './pg';
import { notFound } from './http';

export interface SocietyProfile {
  readonly name: string;
  readonly mode: 'demo' | 'production';
  readonly registrationNo: string | null;
  readonly gstin: string | null;
  readonly stateCode: string | null;
  readonly tan: string | null;
  readonly address: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
}

export type ProfileField = Exclude<keyof SocietyProfile, 'mode'>;

const COLUMN: Record<ProfileField, string> = {
  name: 'name',
  registrationNo: 'registration_no',
  gstin: 'gstin',
  stateCode: 'state_code',
  tan: 'tan',
  address: 'address',
  contactEmail: 'contact_email',
  contactPhone: 'contact_phone',
};

export async function readProfile(tx: Queryable, societyId: string): Promise<SocietyProfile> {
  const result = await tx.query<{
    name: string; mode: string; registration_no: string | null; gstin: string | null;
    state_code: string | null; tan: string | null; address: string | null;
    contact_email: string | null; contact_phone: string | null;
  }>(
    `SELECT name, mode, registration_no, gstin, state_code, tan, address, contact_email, contact_phone
       FROM societies WHERE id = $1`,
    [societyId],
  );
  const row = result.rows[0];
  if (row === undefined) throw notFound('That society');
  return {
    name: row.name,
    mode: row.mode as SocietyProfile['mode'],
    registrationNo: row.registration_no,
    gstin: row.gstin,
    stateCode: row.state_code,
    tan: row.tan,
    address: row.address,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
  };
}

const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The GSTIN's fifteenth character is a check digit over the first fourteen
 * (the GSTN's published mod-36 scheme). Checking it catches a transposed or
 * mistyped character before it is printed on every invoice the society issues.
 */
export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARSET.indexOf(first14[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARSET[(36 - (sum % 36)) % 36];
}

/** State codes as the GST system numbers them: 01–38, and 97 for other territory. */
function isStateCode(code: string): boolean {
  if (!/^[0-9]{2}$/.test(code)) return false;
  const n = Number(code);
  return (n >= 1 && n <= 38) || n === 97;
}

/**
 * Checks a proposed profile and returns every problem, keyed by field. The
 * database checks the formats again (migration 010); this is where a person
 * is told which field and why.
 */
export function validateProfile(p: Omit<SocietyProfile, 'mode'>): Array<{ field: ProfileField; message: string }> {
  const problems: Array<{ field: ProfileField; message: string }> = [];
  if (p.name.trim().length < 3) problems.push({ field: 'name', message: 'The registered name must be at least 3 characters.' });
  if (p.name.length > 200) problems.push({ field: 'name', message: 'The registered name must be at most 200 characters.' });
  if (p.registrationNo !== null && p.registrationNo.length > 100) {
    problems.push({ field: 'registrationNo', message: 'The registration number must be at most 100 characters.' });
  }
  if (p.stateCode !== null && !isStateCode(p.stateCode)) {
    problems.push({ field: 'stateCode', message: 'The state code is two digits, 01 to 38 (West Bengal is 19).' });
  }
  if (p.gstin !== null) {
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(p.gstin)) {
      problems.push({
        field: 'gstin',
        message:
          'A GSTIN is 15 characters: the two-digit state code, the 10-character PAN, an entity ' +
          'number, Z, and a check character — for example 19AAAAA0000A1Z5.',
      });
    } else if (gstinCheckDigit(p.gstin.slice(0, 14)) !== p.gstin[14]) {
      problems.push({
        field: 'gstin',
        message: 'That GSTIN\'s last character does not match the rest of it; a character is probably mistyped.',
      });
    } else if (p.stateCode === null) {
      problems.push({ field: 'stateCode', message: 'Give the state code with the GSTIN; the two must agree.' });
    } else if (p.gstin.slice(0, 2) !== p.stateCode) {
      problems.push({
        field: 'gstin',
        message: `The GSTIN begins ${p.gstin.slice(0, 2)}, but the state code is ${p.stateCode}. A GSTIN starts with the code of the state that issued it.`,
      });
    }
  }
  if (p.tan !== null && !/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(p.tan)) {
    problems.push({ field: 'tan', message: 'A TAN is four letters, five digits and a letter, such as CALM12345B.' });
  }
  if (p.address !== null && p.address.length > 500) {
    problems.push({ field: 'address', message: 'The address must be at most 500 characters.' });
  }
  if (p.contactEmail !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.contactEmail)) {
    problems.push({ field: 'contactEmail', message: 'The contact email is not an email address.' });
  }
  if (p.contactPhone !== null && !/^\+?[0-9][0-9\s-]{5,18}$/.test(p.contactPhone)) {
    problems.push({ field: 'contactPhone', message: 'The contact phone should be digits, with an optional + and spaces.' });
  }
  return problems;
}

/** Writes the profile and returns which fields changed, from and to. */
export async function writeProfile(
  tx: Queryable,
  societyId: string,
  before: SocietyProfile,
  next: Omit<SocietyProfile, 'mode'>,
): Promise<Array<{ field: ProfileField; from: string | null; to: string | null }>> {
  const changes = (Object.keys(COLUMN) as ProfileField[])
    .filter(field => before[field] !== next[field])
    .map(field => ({ field, from: before[field], to: next[field] }));
  if (changes.length === 0) return [];
  const sets = changes.map((c, i) => `${COLUMN[c.field]} = $${i + 2}`).join(', ');
  await tx.query(`UPDATE societies SET ${sets} WHERE id = $1`, [societyId, ...changes.map(c => c.to)]);
  return changes;
}
