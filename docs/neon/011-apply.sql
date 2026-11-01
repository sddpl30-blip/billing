-- Applies migration 011 (other sign-in addresses for a resident) to a
-- database that already has 001–010. Run it once in Neon's SQL Editor, on the
-- societybooks database. It records itself in schema_migrations with the
-- checksum the migration runner computes, so `npm run db:status:node` reads it
-- as applied.
--
-- GENERATED from server/migrations/011_login_emails.sql. Do not edit.

-- Migration 011: other addresses a resident may sign in with.
--
-- A member's Google account is not always the address the office has on
-- record: ramesh.kumar@gmail.com on the register, rameshkumar99@gmail.com on
-- the phone. Sign-in is by address alone, so without a way to say "this
-- address is also Ramesh" he is refused. This table is that statement, made
-- by the secretary for a resident's account and kept in the audit trail.
--
-- Office-bearers get none: an extra address on the treasurer's account would
-- let whoever controls that address sign in as the treasurer. The application
-- refuses it; the table only stores what was allowed.

BEGIN;

CREATE TABLE user_login_emails (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id  UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Lower-cased, as every address in this database is.
  email       TEXT NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),
  added_by    UUID REFERENCES users(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One owner per address, across every society, as for users' own addresses.
CREATE UNIQUE INDEX user_login_emails_one ON user_login_emails (email);
CREATE INDEX user_login_emails_user ON user_login_emails (user_id);

COMMENT ON TABLE user_login_emails IS
  'Extra addresses a resident may sign in with (Google or password). Added by the secretary, resident accounts only; each in the audit trail.';


INSERT INTO schema_migrations (version, checksum) VALUES ('011_login_emails.sql', '03b8ff5c00ba0fbc');

COMMIT;
