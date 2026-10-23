/**
 * Importing the society's flats and owners from a spreadsheet.
 *
 * Going live means 200 flats, each with an area, a basis and an owner who
 * needs an account to sign in with. Typing those one at a time is a week of
 * evenings and a guarantee of typos, so the secretary uploads one CSV.
 *
 * The rules:
 *
 *  · Every row is checked before anything is written, and every problem is
 *    reported with its line number. A file with any error writes nothing:
 *    half a member list is worse than none, because nobody can tell which
 *    half arrived.
 *  · A dry run does all of that and reports what a commit would do — how many
 *    flats are new, changed or unchanged — without writing.
 *  · Flats are matched by number and owners by address, so importing the same
 *    file twice changes nothing the second time.
 *  · The writes go through members.ts, the same functions the single-flat
 *    routes use.
 */

import type { Queryable } from './pg';
import { HttpError } from './http';
import { readCsvTable } from './csv';
import {
  ensureCurrentHolder, ensureResidentUser, insertFlat, updateFlat, upsertOwner,
  type AreaBasisValue,
} from './members';

/** 200 flats is about 30 KB; this leaves room for a much larger society. */
export const FLAT_IMPORT_MAX_BYTES = 512 * 1024;
export const FLAT_IMPORT_MAX_ROWS = 2000;

/** The template's header, which is also the documented format. */
export const FLAT_IMPORT_COLUMNS = [
  'flat_no', 'tower', 'floor', 'area_sqft', 'area_basis',
  'owner_name', 'owner_email', 'owner_mobile',
  'co_owner_name', 'co_owner_email', 'owner_pan',
] as const;

const ALIASES: Record<string, readonly string[]> = {
  flat_no: ['flat', 'flat_number', 'flatno', 'unit', 'unit_no', 'unit_number', 'apartment', 'apartment_no'],
  tower: ['wing', 'block', 'building', 'tower_wing', 'tower_name'],
  floor: ['floor_no', 'level'],
  area_sqft: [
    'area', 'area_sq_ft', 'area_in_sq_ft', 'area_in_sqft', 'sqft', 'sq_ft', 'billing_area',
    'billing_area_sqft', 'billing_area_sq_ft', 'area_sft',
  ],
  area_basis: ['basis', 'area_type'],
  owner_name: ['owner', 'name', 'owner_full_name', 'member_name', 'member'],
  owner_email: ['email', 'e_mail', 'owner_e_mail', 'email_id', 'owner_email_id', 'email_address'],
  owner_mobile: ['mobile', 'phone', 'owner_phone', 'mobile_no', 'mobile_number', 'phone_no', 'contact', 'contact_no'],
  co_owner_name: ['coowner_name', 'co_owner', 'joint_owner_name', 'joint_owner'],
  co_owner_email: ['coowner_email', 'joint_owner_email', 'co_owner_e_mail'],
  owner_pan: ['pan', 'pan_no', 'pan_number', 'owner_pan_no'],
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export interface ImportProblem {
  readonly line: number;
  readonly flatNo?: string;
  readonly message: string;
}

export type RowAction = 'new' | 'updated' | 'unchanged';

export interface ImportReport {
  readonly dryRun: boolean;
  readonly committed: boolean;
  readonly rows: number;
  readonly columns: readonly string[];
  readonly ignoredColumns: readonly string[];
  readonly defaultAreaBasis: AreaBasisValue;
  readonly flats: { readonly new: number; readonly updated: number; readonly unchanged: number };
  readonly accounts: { readonly created: number; readonly linked: number };
  readonly errors: readonly ImportProblem[];
  /** What happens to each row, with the fields that change. */
  readonly changes: ReadonlyArray<{ line: number; flatNo: string; action: RowAction; what: readonly string[] }>;
}

interface Person {
  readonly name: string;
  readonly email: string;
  readonly mobile: string | null;
  readonly pan: string | null;
}

interface ParsedRow {
  readonly line: number;
  readonly flatNo: string;
  readonly wing: string | null;
  readonly floor: number | null;
  readonly area: number;
  readonly basis: AreaBasisValue;
  readonly owner: Person;
  readonly coOwner: Person | null;
}

function parseBasis(raw: string): AreaBasisValue | null {
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'carpet' || key === 'ca') return 'carpet';
  if (key === 'builtup' || key === 'bua' || key === 'built') return 'built-up';
  if (key === 'superbuiltup' || key === 'sbua' || key === 'super' || key === 'superarea' || key === 'saleable') {
    return 'super-built-up';
  }
  return null;
}

/** Ten digits starting 6–9, with any +91, leading 0, spaces or dashes removed. */
function parseMobile(raw: string): string | null {
  let digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9][0-9]{9}$/.test(digits) ? digits : null;
}

function parseFloor(raw: string): number | null | 'bad' {
  const text = raw.trim().toLowerCase();
  if (text === '') return null;
  if (text === 'g' || text === 'gf' || text === 'ground') return 0;
  if (!/^-?\d+$/.test(text)) return 'bad';
  const n = Number(text);
  return n >= -5 && n <= 200 ? n : 'bad';
}

function parseArea(raw: string): number | null {
  const text = raw.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text);
  return n > 0 && n <= 100_000 ? n : null;
}

/** Validates one row. Returns the problems found, or the parsed row. */
function parseRow(
  line: number, values: Readonly<Record<string, string>>, defaultBasis: AreaBasisValue,
): { row: ParsedRow } | { problems: string[] } {
  const problems: string[] = [];
  const get = (key: string): string => values[key] ?? '';

  const flatNo = get('flat_no');
  if (flatNo === '') problems.push('flat_no is empty');
  else if (flatNo.length > 20) problems.push('flat_no is longer than 20 characters');

  const wing = get('tower');
  if (wing.length > 10) problems.push('tower is longer than 10 characters');

  const floor = parseFloor(get('floor'));
  if (floor === 'bad') problems.push(`floor "${get('floor')}" is not a whole number (use G for ground)`);

  const area = parseArea(get('area_sqft'));
  if (get('area_sqft') === '') problems.push('area_sqft is empty: a flat without an area cannot be billed');
  else if (area === null) problems.push(`area_sqft "${get('area_sqft')}" is not a positive number of square feet`);

  let basis: AreaBasisValue | null = defaultBasis;
  if (get('area_basis') !== '') {
    basis = parseBasis(get('area_basis'));
    if (basis === null) {
      problems.push(`area_basis "${get('area_basis')}" is not carpet, built-up or super-built-up`);
    }
  }

  const person = (prefix: 'owner' | 'co_owner', required: boolean): Person | null => {
    const name = get(`${prefix}_name`);
    const email = get(`${prefix}_email`).toLowerCase();
    const label = prefix === 'owner' ? 'owner' : 'co-owner';
    if (!required && name === '' && email === '') return null;
    if (name === '') problems.push(`${label} name is empty`);
    else if (name.length > 200) problems.push(`${label} name is longer than 200 characters`);
    if (email === '') problems.push(`${label} email is empty: it is how they sign in`);
    else if (!EMAIL.test(email) || email.length > 320) problems.push(`${label} email "${email}" is not an email address`);
    let mobile: string | null = null;
    let pan: string | null = null;
    if (prefix === 'owner') {
      if (get('owner_mobile') !== '') {
        mobile = parseMobile(get('owner_mobile'));
        if (mobile === null) problems.push(`owner_mobile "${get('owner_mobile')}" is not a 10-digit Indian mobile number`);
      }
      if (get('owner_pan') !== '') {
        pan = get('owner_pan').toUpperCase();
        if (!PAN.test(pan)) problems.push(`owner_pan "${get('owner_pan')}" is not a PAN (five letters, four digits, a letter)`);
      }
    }
    return { name, email, mobile, pan };
  };
  const owner = person('owner', true) as Person;
  const coOwner = person('co_owner', false);
  if (coOwner !== null && coOwner.email !== '' && coOwner.email === owner.email) {
    problems.push('co_owner_email is the same as owner_email');
  }

  if (problems.length > 0) return { problems };
  return {
    row: {
      line, flatNo, wing: wing === '' ? null : wing, floor: floor as number | null,
      area: area as number, basis: basis as AreaBasisValue, owner, coOwner,
    },
  };
}

interface ExistingFlat {
  id: string; flat_no: string; wing: string | null; floor: string | null;
  billing_area_sqft: string | null; area_basis: string | null;
  owner_email: string | null; co_owner_email: string | null;
}
interface ExistingOwner { id: string; email: string; full_name: string; phone: string | null; pan: string | null }
interface ExistingUser { email: string; society_id: string; owner_email: string | null; resident: string }

/**
 * The basis a row without one is given: the basis of the society's current
 * approved rate, since a flat measured on any other basis would be refused at
 * billing, or super built-up where no rate has been approved yet.
 */
async function societyDefaultBasis(tx: Queryable, societyId: string, on: string): Promise<AreaBasisValue> {
  const rate = await tx.query<{ area_basis: AreaBasisValue }>(
    `SELECT area_basis FROM maintenance_rates
      WHERE society_id = $1 AND approved_by IS NOT NULL AND effective_from <= $2::date
      ORDER BY effective_from DESC LIMIT 1`,
    [societyId, on],
  );
  return rate.rows[0]?.area_basis ?? 'super-built-up';
}

/**
 * Validates the file against the books and, unless it is a dry run or has
 * errors, writes it — all in the caller's transaction.
 */
export async function importFlats(
  tx: Queryable,
  input: {
    societyId: string; csv: string; dryRun: boolean; heldFrom: string;
    actorUserId: string | null;
  },
): Promise<ImportReport> {
  const table = readCsvTable(input.csv, {
    aliases: ALIASES,
    required: ['flat_no', 'area_sqft', 'owner_name', 'owner_email'],
    maxRows: FLAT_IMPORT_MAX_ROWS,
    maxBytes: FLAT_IMPORT_MAX_BYTES,
  });
  const defaultBasis = await societyDefaultBasis(tx, input.societyId, input.heldFrom);

  const errors: ImportProblem[] = [];
  const parsed: ParsedRow[] = [];
  const flatSeen = new Map<string, number>();
  const emailSeen = new Map<string, number>();

  for (const { line, values } of table.rows) {
    const result = parseRow(line, values, defaultBasis);
    const flatNo = values.flat_no ?? '';
    if ('problems' in result) {
      for (const message of result.problems) errors.push({ line, ...(flatNo ? { flatNo } : {}), message });
      continue;
    }
    const row = result.row;
    const flatKey = row.flatNo.toLowerCase();
    const earlier = flatSeen.get(flatKey);
    if (earlier !== undefined) {
      errors.push({ line, flatNo: row.flatNo, message: `flat ${row.flatNo} is also on line ${earlier}` });
    } else {
      flatSeen.set(flatKey, line);
    }
    // One address per row. The same person owning two flats is real, but in a
    // first import a repeated address is far more often a pasted row, and the
    // second flat is one "Change owner" away once the first is in.
    for (const person of [row.owner, row.coOwner]) {
      if (person === null) continue;
      const seen = emailSeen.get(person.email);
      if (seen !== undefined) {
        errors.push({
          line, flatNo: row.flatNo,
          message:
            `${person.email} is also on line ${seen}. Each address may appear once; if one person ` +
            `holds both flats, import one and add them to the other from "Change owner".`,
        });
      } else {
        emailSeen.set(person.email, line);
      }
    }
    parsed.push(row);
  }

  // What is already on record, read once rather than per row.
  const flats = await tx.query<ExistingFlat>(
    `SELECT f.id, f.flat_no, f.wing, f.floor::text, f.billing_area_sqft::text, f.area_basis,
            (SELECT o.email FROM flat_ownership fo JOIN owners o ON o.id = fo.owner_id
              WHERE fo.flat_id = f.id AND fo.role = 'owner' AND fo.held_until IS NULL) AS owner_email,
            (SELECT o.email FROM flat_ownership fo JOIN owners o ON o.id = fo.owner_id
              WHERE fo.flat_id = f.id AND fo.role = 'co-owner' AND fo.held_until IS NULL) AS co_owner_email
       FROM flats f WHERE f.society_id = $1`,
    [input.societyId],
  );
  const flatByNo = new Map(flats.rows.map(f => [f.flat_no.toLowerCase(), f]));

  const owners = await tx.query<ExistingOwner>(
    'SELECT id, lower(email) AS email, full_name, phone, pan FROM owners WHERE society_id = $1',
    [input.societyId],
  );
  const ownerByEmail = new Map(owners.rows.map(o => [o.email, o]));

  const emails = [...emailSeen.keys()];
  const users = emails.length === 0 ? { rows: [] as ExistingUser[] } : await tx.query<ExistingUser>(
    `SELECT lower(u.email) AS email, u.society_id, lower(o.email) AS owner_email,
            EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'resident')::text AS resident
       FROM users u LEFT JOIN owners o ON o.id = u.owner_id
      WHERE lower(u.email) = ANY($1::text[])
        AND (u.society_id = $2 OR u.is_active)`,
    [`{${emails.map(e => `"${e.replace(/["\\]/g, '')}"`).join(',')}}`, input.societyId],
  );
  const userByEmail = new Map<string, ExistingUser>();
  for (const u of users.rows) {
    // This society's row wins over another society's, which only matters for
    // the refusal below.
    if (!userByEmail.has(u.email) || u.society_id === input.societyId) userByEmail.set(u.email, u);
  }

  const changes: Array<{ line: number; flatNo: string; action: RowAction; what: string[] }> = [];
  let accountsCreated = 0;
  let accountsLinked = 0;

  for (const row of parsed) {
    const what: string[] = [];
    const existing = flatByNo.get(row.flatNo.toLowerCase());

    for (const person of [row.owner, row.coOwner]) {
      if (person === null) continue;
      const user = userByEmail.get(person.email);
      if (user !== undefined && user.society_id !== input.societyId) {
        errors.push({
          line: row.line, flatNo: row.flatNo,
          message: `${person.email} already signs in to another society, so it cannot be used here`,
        });
      }
      if (user === undefined || user.society_id !== input.societyId) {
        accountsCreated += 1;
        what.push(`account for ${person.email}`);
      } else if (user.owner_email !== person.email || user.resident !== 'true') {
        accountsLinked += 1;
        what.push(`link account ${person.email}`);
      }
      const owner = ownerByEmail.get(person.email);
      if (owner === undefined) {
        what.push(`new owner ${person.email}`);
      } else if (
        owner.full_name !== person.name
        || (person.mobile !== null && owner.phone !== person.mobile)
        || (person.pan !== null && owner.pan !== person.pan)
      ) {
        what.push(`owner details for ${person.email}`);
      }
    }

    if (existing === undefined) {
      changes.push({ line: row.line, flatNo: row.flatNo, action: 'new', what });
      continue;
    }
    if ((existing.wing ?? null) !== row.wing) what.push('tower');
    if ((existing.floor === null ? null : Number(existing.floor)) !== row.floor) what.push('floor');
    if (existing.billing_area_sqft === null || Number(existing.billing_area_sqft) !== row.area) what.push('area');
    if (existing.area_basis !== row.basis) what.push('area basis');
    if (existing.owner_email?.toLowerCase() !== row.owner.email) what.push('owner');
    if (row.coOwner !== null && existing.co_owner_email?.toLowerCase() !== row.coOwner.email) what.push('co-owner');
    changes.push({
      line: row.line, flatNo: existing.flat_no,
      action: what.length === 0 ? 'unchanged' : 'updated', what,
    });
  }

  errors.sort((a, b) => a.line - b.line);
  const count = (action: RowAction): number => changes.filter(c => c.action === action).length;
  const report = (committed: boolean): ImportReport => ({
    dryRun: input.dryRun,
    committed,
    rows: table.rows.length,
    columns: table.columns,
    ignoredColumns: table.ignored,
    defaultAreaBasis: defaultBasis,
    flats: { new: count('new'), updated: count('updated'), unchanged: count('unchanged') },
    accounts: { created: accountsCreated, linked: accountsLinked },
    errors,
    changes,
  });

  if (input.dryRun) return report(false);
  if (errors.length > 0) {
    throw new HttpError(
      400,
      `Nothing was imported: ${errors.length} ${errors.length === 1 ? 'problem' : 'problems'} in the file. ` +
      'Fix them and import again.',
      report(false),
    );
  }

  // The writes. Every row was checked above against the same transaction's
  // view of the books, so nothing here is expected to fail; if anything does,
  // the transaction rolls back whole.
  for (const row of parsed) {
    const existing = flatByNo.get(row.flatNo.toLowerCase());
    let flatId: string;
    if (existing === undefined) {
      flatId = await insertFlat(tx, input.societyId, {
        flatNo: row.flatNo, wing: row.wing, floor: row.floor,
        billingAreaSqFt: row.area, areaBasis: row.basis, nonOccupied: false,
      });
    } else {
      flatId = existing.id;
      await updateFlat(tx, input.societyId, flatId, {
        wing: row.wing, floor: row.floor, billingAreaSqFt: row.area, areaBasis: row.basis,
      });
    }

    const holders: Array<[Person, 'owner' | 'co-owner']> = [[row.owner, 'owner']];
    if (row.coOwner !== null) holders.push([row.coOwner, 'co-owner']);
    for (const [person, role] of holders) {
      const ownerId = await upsertOwner(tx, {
        societyId: input.societyId, fullName: person.name, email: person.email,
        phone: person.mobile, pan: person.pan,
      });
      await ensureCurrentHolder(tx, { flatId, ownerId, role, heldFrom: input.heldFrom });
      await ensureResidentUser(tx, {
        societyId: input.societyId, email: person.email, ownerId, grantedBy: input.actorUserId,
      });
    }
  }

  return report(true);
}
