/**
 * The schema versions this build of the server works with.
 *
 * Kept in code rather than read from server/migrations, because the
 * serverless bundle carries the compiled server and not the SQL files. The
 * deploy test checks both against the files in server/migrations, so neither
 * can be forgotten when a migration is added.
 *
 * Why it matters: a deployment whose code is ahead of its database works
 * until the first query that touches the new schema, and then fails with a
 * bare 500 — on the Neon database, the books snapshot did exactly that until
 * migration 010 was applied. Health says so instead.
 */

/** The newest migration: with it applied, every feature of this build works. */
export const EXPECTED_SCHEMA_VERSION = '011_login_emails.sql';

/**
 * The oldest schema the books can be opened on. Below it, health is degraded
 * and the app shows "the books cannot be opened", because core screens would
 * fail.
 *
 * Between this and EXPECTED_SCHEMA_VERSION, health stays ok and names the
 * pending migration: the migrations in that gap are additive, and every
 * feature that needs them checks for its table first and says which
 * migration to apply (011: linked sign-in addresses). Raise this only when a
 * migration is one the core screens read from.
 */
export const MINIMUM_SCHEMA_VERSION = '010_opening_balances.sql';
