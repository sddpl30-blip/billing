-- Migration 005: one account per address, and the notification queue's index.
--
-- 001 made (society_id, email) unique, which is right for a society's member
-- list and wrong for signing in: the login path is given an address and
-- nothing else, so with a demo society and a production society in the same
-- database two rows could share an address and `LIMIT 1` would pick one of
-- them arbitrarily. A resident could be signed in against the wrong society's
-- data, which is the worst kind of bug to find late.
--
-- The fix is an index, not application code: an address identifies at most one
-- active account across the whole database.

BEGIN;

-- Addresses are stored lower-cased by the application; the index says so too,
-- so a row inserted by hand cannot slip a second 'Owner@...' past it.
CREATE UNIQUE INDEX users_one_active_email
  ON users (lower(email))
  WHERE is_active;

COMMENT ON INDEX users_one_active_email IS
  'Sign-in is by address alone, so an address must identify at most one active account across every society in this database. Deactivated accounts are excluded so a former resident''s address can be reused.';

-- The dispatch worker reads this every pass.
CREATE INDEX notifications_queued_email
  ON notifications (society_id, queued_at)
  WHERE state = 'queued' AND channel = 'email';

COMMIT;
