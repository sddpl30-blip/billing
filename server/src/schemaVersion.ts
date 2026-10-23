/**
 * The newest migration this build of the server expects to find applied.
 *
 * Kept in code rather than read from server/migrations, because the
 * serverless bundle carries the compiled server and not the SQL files. The
 * deploy test checks it against the newest file in server/migrations, so it
 * cannot be forgotten when a migration is added.
 *
 * Why it matters: a deployment whose code is ahead of its database works
 * until the first query that touches the new schema, and then fails with a
 * bare 500 — on the Neon database, the books snapshot did exactly that until
 * migration 010 was applied. Health says so instead.
 */
export const EXPECTED_SCHEMA_VERSION = '010_opening_balances.sql';
