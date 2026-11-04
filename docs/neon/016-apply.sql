-- Applies migration 016 (an owner's GSTIN) to a database that already has
-- 001–015. Run it once in Neon's SQL Editor, on the societybooks database. It
-- records itself in schema_migrations with the checksum the migration runner
-- computes.
--
-- GENERATED from server/migrations/016_owner_gstin.sql. Do not edit.

-- Migration 016: an owner's GSTIN, for owners that are registered businesses.
--
-- Optional. When present it is printed with the owner's name under "Bill to" on
-- the proforma and the tax invoice. The application checks the state code and
-- the check character; the database checks the shape. Additive.

BEGIN;

ALTER TABLE owners
  ADD COLUMN gstin TEXT CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');

COMMENT ON COLUMN owners.gstin IS
  'The owner''s GSTIN when the owner is a registered business, printed under "Bill to" on proforma and tax invoices.';

INSERT INTO schema_migrations (version, checksum) VALUES ('016_owner_gstin.sql', 'd71b5ce16089c78b');

COMMIT;
