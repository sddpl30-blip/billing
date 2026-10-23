-- Migration 007: one spelling for a billing period.
--
-- `billing_documents.period` is free text, and the duplicate-billing guard —
-- the partial unique index billing_documents_one_live_per_period — compares
-- it as text. The API accepted "Jul  2026" (two spaces) as a period, stored it
-- as written, and the index then saw it as a different month from "Jul 2026":
-- the same flat could be billed for July twice. The application now writes the
-- canonical form ("Jul 2026": three-letter month, one space, four-digit year);
-- this migration makes the database insist on it, so nothing that bypasses the
-- application can reintroduce the duplicate.
--
-- Two parts:
--
--  1. Existing rows are rewritten into the canonical form where that is safe —
--     a cancelled document, or a live one that would not then collide with
--     another live document for the same flat and month. A collision is the
--     very duplicate this guards against, and choosing which of two live
--     bills to keep is a decision for a person, not a migration, so those rows
--     are left as they are and reported with a NOTICE.
--
--  2. A trigger refuses a non-canonical period on INSERT, and on an UPDATE that
--     changes the period. A CHECK constraint would also refuse unrelated
--     updates (cancelling, converting) to any row step 1 had to leave alone,
--     which would make exactly those duplicates impossible to cancel.

BEGIN;

-- 1. Rewrite what can be rewritten.
WITH parsed AS (
  SELECT d.id, d.society_id, d.flat_id, d.state, d.period,
         initcap(lower(left(m[1], 3))) || ' ' || m[2] AS canonical
    FROM billing_documents d,
         LATERAL regexp_match(
           d.period,
           '^\s*(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+([0-9]{4})\s*$',
           'i'
         ) AS m
),
live_per_month AS (
  SELECT society_id, flat_id, canonical, count(*) AS live
    FROM parsed
   WHERE state <> 'cancelled'
   GROUP BY society_id, flat_id, canonical
)
UPDATE billing_documents d
   SET period = p.canonical
  FROM parsed p
  -- LEFT, because a cancelled row with no live sibling has no row here. It
  -- collides with nothing (the unique index ignores cancelled documents), so
  -- it is rewritten too.
  LEFT JOIN live_per_month l
    ON l.society_id = p.society_id AND l.flat_id = p.flat_id AND l.canonical = p.canonical
 WHERE d.id = p.id
   AND d.period <> p.canonical
   AND (p.state = 'cancelled' OR l.live = 1);

DO $$
DECLARE
  remaining INTEGER;
BEGIN
  SELECT count(*) INTO remaining
    FROM billing_documents
   WHERE period !~ '^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4}$';
  IF remaining > 0 THEN
    RAISE NOTICE
      '% billing document(s) keep a non-canonical period because rewriting them would '
      'collide with another live document for the same flat and month — a duplicate bill. '
      'Cancel the one that should not stand: SELECT id, flat_id, period, state FROM '
      'billing_documents WHERE period !~ ''^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4}$'';',
      remaining;
  END IF;
END;
$$;

-- 2. Refuse anything else from now on.
CREATE OR REPLACE FUNCTION check_billing_period_canonical() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.period IS NOT DISTINCT FROM OLD.period THEN
    RETURN NEW;
  END IF;
  IF NEW.period !~ '^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4}$' THEN
    RAISE EXCEPTION
      'billing period "%" is not written the one way a period is written, such as "Jul 2026" '
      '(three-letter month, one space, four-digit year); two spellings of one month would '
      'defeat the duplicate-billing check', NEW.period;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_documents_period_canonical
  BEFORE INSERT OR UPDATE OF period ON billing_documents
  FOR EACH ROW EXECUTE FUNCTION check_billing_period_canonical();

COMMENT ON COLUMN billing_documents.period IS
  'The billing month as "Jul 2026": three-letter month, one space, four-digit year. Enforced by trigger billing_documents_period_canonical, because the one-live-document-per-period index compares this as text.';

COMMIT;
