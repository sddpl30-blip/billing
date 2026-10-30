/**
 * Roles, permissions and flat-level access.
 *
 * Every rule here runs on the server. The front end may hide a button; that is
 * presentation. This is the part that decides.
 */

export type Role = 'resident' | 'manager' | 'treasurer' | 'secretary' | 'auditor';

export const ALL_ROLES: readonly Role[] = [
  'resident', 'manager', 'treasurer', 'secretary', 'auditor',
];

/**
 * Every permission the API checks, named for what it allows rather than which
 * screen uses it.
 */
export type Permission =
  // Reading
  | 'invoice.read.own'
  | 'invoice.read.any'
  | 'payment.read.own'
  | 'payment.read.any'
  | 'report.read'
  | 'ledger.read'
  | 'audit.read'
  // Billing
  | 'billing.run'
  | 'billing.approve'
  | 'billing.release'
  | 'billing.convert'
  | 'billing.cancel'
  | 'rate.approve'
  // Money in
  | 'payment.record'
  | 'payment.reverse'
  // Money out
  | 'vendor.manage'
  | 'vendor.bill.approve'
  | 'vendor.bill.book'
  | 'vendor.pay'
  | 'tds.remit'
  // Banking
  | 'bank.import'
  | 'bank.match'
  | 'bank.reconcile'
  // Period
  | 'period.close'
  | 'period.reopen'
  // Helpdesk
  | 'ticket.create'
  | 'ticket.read.own'
  | 'ticket.read.any'
  | 'ticket.assign'
  | 'ticket.resolve'
  | 'ticket.confirm.own'
  // Administration
  | 'member.manage'
  | 'user.manage'
  | 'settings.manage';

/**
 * What each role may do.
 *
 * Written out per role rather than by inheritance, because "treasurer is a
 * manager plus extras" is the kind of shortcut that quietly grants a treasurer
 * something nobody decided they should have.
 *
 * Two deliberate absences:
 *   · nobody has both `billing.run` and `billing.approve` — that separation is
 *     the maker-checker rule, and granting both to one role would void it
 *   · `auditor` has no write permission at all
 */
const GRANTS: Record<Role, readonly Permission[]> = {
  resident: [
    'invoice.read.own',
    'payment.read.own',
    'ticket.create',
    'ticket.read.own',
    'ticket.confirm.own',
  ],

  manager: [
    'invoice.read.any',
    'payment.read.any',
    'report.read',
    'billing.run',
    'payment.record',
    'vendor.manage',
    'bank.import',
    'bank.match',
    'ticket.read.any',
    'ticket.assign',
    'ticket.resolve',
    'member.manage',
  ],

  treasurer: [
    'invoice.read.any',
    'payment.read.any',
    'report.read',
    'ledger.read',
    'billing.approve',
    'billing.release',
    'billing.convert',
    'billing.cancel',
    'rate.approve',
    'payment.reverse',
    'vendor.bill.approve',
    'vendor.bill.book',
    'vendor.pay',
    'tds.remit',
    'bank.match',
    'bank.reconcile',
    'period.close',
    'ticket.read.any',
  ],

  // No billing.approve: the committee decided bills are approved by the
  // treasurer alone. The secretary may still release what the treasurer
  // has approved.
  secretary: [
    'invoice.read.any',
    'payment.read.any',
    'report.read',
    'ledger.read',
    'billing.release',
    'period.reopen',
    'ticket.read.any',
    'ticket.assign',
    'member.manage',
    'user.manage',
    'settings.manage',
  ],

  auditor: [
    'invoice.read.any',
    'payment.read.any',
    'report.read',
    'ledger.read',
    'audit.read',
    'ticket.read.any',
  ],
};

/**
 * The same grants as sets, for O(1) lookup.
 *
 * Built by assignment rather than Object.fromEntries plus a cast: the cast
 * would compile even if a role were missing from the loop, and a role with no
 * grants silently denies everything.
 */
const GRANT_SETS: Record<Role, ReadonlySet<Permission>> = {
  resident: new Set(GRANTS.resident),
  manager: new Set(GRANTS.manager),
  treasurer: new Set(GRANTS.treasurer),
  secretary: new Set(GRANTS.secretary),
  auditor: new Set(GRANTS.auditor),
};

export interface Principal {
  readonly userId: string;
  readonly societyId: string;
  readonly email: string;
  readonly roles: readonly Role[];
  /** Flats this user may see. Empty for a user with no resident role. */
  readonly flatIds: readonly string[];
}

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return principal.roles.some(role => GRANT_SETS[role]?.has(permission) === true);
}

export function permissionsOf(principal: Principal): Permission[] {
  const out = new Set<Permission>();
  for (const role of principal.roles) {
    for (const p of GRANT_SETS[role] ?? []) out.add(p);
  }
  return [...out].sort();
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Throws unless the principal holds the permission.
 *
 * Named `requirePermission` rather than `require`: CommonJS emit reserves
 * `require` at module scope, so the shorter name compiled under --noEmit and
 * failed the moment anything was actually emitted.
 */
export function requirePermission(principal: Principal, permission: Permission): void {
  if (!hasPermission(principal, permission)) {
    // Names the permission, not the roles that would grant it: a probe should
    // not learn the authorisation model from the error.
    throw new ForbiddenError(`This account is not permitted to ${permission}.`);
  }
}

/**
 * Checks access to one flat's data.
 *
 * `*.read.any` sees every flat. Otherwise the flat must be one this user holds
 * — so a resident reading another flat's invoice is refused by the server,
 * whatever the request says. Returns nothing and throws on refusal, so a
 * caller cannot forget to check the result.
 */
export function requireFlatAccess(
  principal: Principal,
  flatId: string,
  anyPermission: Permission,
): void {
  if (hasPermission(principal, anyPermission)) return;
  if (principal.flatIds.includes(flatId)) return;
  throw new ForbiddenError('This account does not have access to that flat.');
}

/**
 * The flats a principal may read, or null for "every flat".
 *
 * Null rather than a list of all ids, so a query can skip the filter entirely
 * instead of building an IN clause over every flat in the society.
 */
export function readableFlats(
  principal: Principal,
  anyPermission: Permission,
): readonly string[] | null {
  return hasPermission(principal, anyPermission) ? null : principal.flatIds;
}

/**
 * Maker-checker: whether this principal may approve something they requested.
 *
 * Always false. The database enforces it too, with a CHECK that the decider is
 * not the requester; this is the same rule applied before the round trip so
 * the caller gets a clear message rather than a constraint violation.
 */
export function canSelfApprove(): boolean {
  return false;
}

/** Roles that may hold the checker side of a maker-checker pair. */
export const APPROVER_ROLES: readonly Role[] = ['treasurer', 'secretary'];

export function isValidRole(value: string): value is Role {
  return (ALL_ROLES as readonly string[]).includes(value);
}
