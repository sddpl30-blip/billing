-- Migration 002: make the balance invariant impossible to break.
--
-- Migration 001 stores each entry's totals and constrains them equal, but
-- nothing yet ties those totals to the legs. A writer could insert an entry
-- claiming 10,000 on each side and then post legs that sum to something else.
-- A deferred constraint trigger closes that: it fires at COMMIT, so the legs
-- may be inserted in any order within the transaction, and the whole
-- transaction fails if the sums disagree.

BEGIN;

CREATE OR REPLACE FUNCTION check_entry_balances() RETURNS TRIGGER AS $$
DECLARE
  entry UUID;
  leg_debit BIGINT;
  leg_credit BIGINT;
  stated_debit BIGINT;
  stated_credit BIGINT;
  leg_count INT;
BEGIN
  entry := COALESCE(NEW.entry_id, OLD.entry_id);

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*)
    INTO leg_debit, leg_credit, leg_count
    FROM journal_postings WHERE entry_id = entry;

  SELECT total_debit, total_credit INTO stated_debit, stated_credit
    FROM journal_entries WHERE id = entry;

  IF stated_debit IS NULL THEN
    RAISE EXCEPTION 'posting references entry % which does not exist', entry;
  END IF;

  IF leg_count < 2 THEN
    RAISE EXCEPTION
      'entry % has % leg(s); a double-entry transaction needs at least two',
      entry, leg_count;
  END IF;

  IF leg_debit <> leg_credit THEN
    RAISE EXCEPTION
      'entry % does not balance: legs total % debit against % credit (out by %)',
      entry, leg_debit, leg_credit, leg_debit - leg_credit;
  END IF;

  IF leg_debit <> stated_debit OR leg_credit <> stated_credit THEN
    RAISE EXCEPTION
      'entry % states %/% but its legs total %/%',
      entry, stated_debit, stated_credit, leg_debit, leg_credit;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- DEFERRABLE INITIALLY DEFERRED: checked once at COMMIT rather than after each
-- row, which is the only way a multi-leg entry can be inserted at all.
CREATE CONSTRAINT TRIGGER journal_postings_balance
  AFTER INSERT OR UPDATE ON journal_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_balances();

-- An entry with no legs at all would otherwise pass, since the trigger above
-- only fires on a posting. This one fires on the entry.
CREATE OR REPLACE FUNCTION check_entry_has_legs() RETURNS TRIGGER AS $$
DECLARE
  leg_count INT;
BEGIN
  SELECT COUNT(*) INTO leg_count FROM journal_postings WHERE entry_id = NEW.id;
  IF leg_count < 2 THEN
    RAISE EXCEPTION
      'entry % was committed with % leg(s); at least two are required',
      NEW.id, leg_count;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_entries_have_legs
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_has_legs();

-- A control account's legs must name a party, as in the engine. Without it a
-- receivable balance cannot be attributed to a flat.
CREATE OR REPLACE FUNCTION check_control_party() RETURNS TRIGGER AS $$
DECLARE
  needs TEXT;
BEGIN
  SELECT control INTO needs FROM accounts
   WHERE society_id = NEW.society_id AND code = NEW.account_code;
  IF needs IS NOT NULL AND (NEW.party IS NULL OR btrim(NEW.party) = '') THEN
    RAISE EXCEPTION
      'account % is a % control account, so the posting must name a party',
      NEW.account_code, needs;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_postings_control_party
  BEFORE INSERT OR UPDATE ON journal_postings
  FOR EACH ROW EXECUTE FUNCTION check_control_party();

COMMIT;
