-- Migration 008: maker-checker on rates and settings, and job keys per society.
--
-- A rate or a society setting was approved by "someone with rate.approve",
-- with nothing to say who had entered it. One account holding both roles
-- could type a GST treatment and then sign it off. Each row now records who
-- proposed it, and the database refuses an approval by that same person.
--
-- Scheduled jobs were unique on (kind, run_key) across every society, so one
-- society could claim another's run key first and make its schedule fail.
-- The key now includes the society. NULLS NOT DISTINCT keeps the old
-- behaviour for jobs that belong to no society (PostgreSQL 15 and later).

BEGIN;

ALTER TABLE maintenance_rates
  ADD COLUMN requested_by UUID REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE maintenance_rates
  ADD CONSTRAINT maintenance_rates_maker_is_not_checker
  CHECK (requested_by IS NULL OR approved_by IS NULL OR requested_by <> approved_by);

ALTER TABLE society_settings
  ADD COLUMN requested_by UUID REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE society_settings
  ADD CONSTRAINT society_settings_maker_is_not_checker
  CHECK (requested_by IS NULL OR approved_by IS NULL OR requested_by <> approved_by);

ALTER TABLE scheduled_jobs DROP CONSTRAINT scheduled_jobs_kind_run_key_key;
ALTER TABLE scheduled_jobs
  ADD CONSTRAINT scheduled_jobs_society_kind_run_key_key
  UNIQUE NULLS NOT DISTINCT (society_id, kind, run_key);

COMMIT;
