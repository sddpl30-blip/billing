-- Applies migration 012 (opening dues no longer block a month's bill; bank
-- details for proforma invoices) to a database that already has 001–011. Run
-- it once in Neon's SQL Editor, on the societybooks database. It records
-- itself in schema_migrations with the checksum the migration runner
-- computes, so `npm run db:status:node` reads it as applied.
--
-- GENERATED from server/migrations/012_opening_dues_and_pi_details.sql. Do not edit.

-- Migration 012: opening dues stop blocking a month's bill, and the details a
-- proforma invoice prints.
--
-- 1. An opening due brought forward (OB/…) is stored with the period of the
--    opening date. With a cut-over on 1 Oct 2026 that is "Oct 2026", and the
--    one-live-document-per-period index then refused October's proforma for
--    every flat that had arrears: the billing run skipped them as "already
--    billed for Oct 2026". An opening due is not a month's bill, so the index
--    now covers bills only.
--
-- 2. The bank details printed on a proforma invoice (bank, branch, full
--    account number, IFSC), kept with the society's profile. A bank account
--    record holds only the last four digits, which is not enough to pay into.

BEGIN;

DROP INDEX billing_documents_one_live_per_period;
CREATE UNIQUE INDEX billing_documents_one_live_per_period
  ON billing_documents (society_id, flat_id, period)
  WHERE state <> 'cancelled' AND opening_batch_id IS NULL;

ALTER TABLE societies
  ADD COLUMN pay_bank_name   TEXT,
  ADD COLUMN pay_branch      TEXT,
  ADD COLUMN pay_account_no  TEXT CHECK (pay_account_no IS NULL OR pay_account_no ~ '^[0-9]{6,20}$'),
  ADD COLUMN pay_ifsc        TEXT CHECK (pay_ifsc IS NULL OR pay_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');

COMMENT ON COLUMN societies.pay_account_no IS
  'The account members pay into, printed in full on proforma invoices. Entered by the office in the society profile.';


INSERT INTO schema_migrations (version, checksum) VALUES ('012_opening_dues_and_pi_details.sql', '1b087ac6a91c060e');

COMMIT;
