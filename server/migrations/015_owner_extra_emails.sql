-- Migration 015: more than one e-mail address for a flat's bills.
--
-- owners.email stays the owner's one primary address (it is unique, and it is
-- what sign-in links to). Further addresses that should also receive that
-- owner's bills are kept alongside, as a comma-separated list. Corrected from
-- the Flats & owners screen ("Edit contact"), which writes an audit line with
-- the old and new values. Additive: nothing reads it until it exists.

BEGIN;

ALTER TABLE owners
  ADD COLUMN extra_emails TEXT CHECK (extra_emails IS NULL OR length(extra_emails) <= 1000);

COMMENT ON COLUMN owners.extra_emails IS
  'Further e-mail addresses (comma-separated) that also receive this owner''s bills. owners.email is the primary one.';

COMMIT;
