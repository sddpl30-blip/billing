-- Migration 010: going live — opening balances and the society's profile.
--
-- A society that starts using SocietyBooks part-way through its life brings
-- its position with it: what each flat owed or had paid ahead on the cut-over
-- date, and what the society held in the bank, in its funds and deposits, and
-- owed its vendors. Until now there was nowhere to put any of that, so the
-- first trial balance would have started at zero and every member's dues
-- would have been wrong from the first bill.
--
-- The design keeps the opening position inside the double-entry model rather
-- than beside it:
--
--  · The whole position posts as ONE journal entry (source_kind
--    'opening-balance'), so the deferred balance trigger from 002 refuses it
--    exactly as it refuses any other unbalanced entry, and the period lock
--    from 003 refuses it in a closed month.
--
--  · A flat's opening due becomes a billing document of its own, in state
--    'tax-invoice' and tagged with its batch. That is what makes it behave
--    "exactly like an invoice": the receipt allocator, the ageing report, the
--    dues screen and the flat statement all read documents in that state, so
--    an old arrear is settled oldest-first and ages like any bill without a
--    second code path. It is not a supply, so it carries no tax: a CHECK keeps
--    its estimated tax at zero and a trigger keeps it out of the GST register.
--
--  · An opening vendor payable becomes a booked vendor bill, so the existing
--    payment route can settle it against its own bill number.
--
--  · Entry is maker-checker: one person prepares a draft, another approves it,
--    and approval is what posts. At most one batch per society is live; a
--    correction is a reversal of the posted batch followed by a new one, both
--    of which stay in the ledger.

BEGIN;

-- --------------------------------------------------------------------------
-- The society's profile
-- --------------------------------------------------------------------------
ALTER TABLE societies ADD COLUMN tan TEXT;
ALTER TABLE societies ADD COLUMN address TEXT;
ALTER TABLE societies ADD COLUMN contact_email TEXT;
ALTER TABLE societies ADD COLUMN contact_phone TEXT;

ALTER TABLE societies ADD CONSTRAINT societies_tan_format
  CHECK (tan IS NULL OR tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$');

-- NOT VALID: a row written before this migration is not re-judged, but every
-- insert and update from now on is. The application validates the same rules
-- (and the GSTIN check digit, which SQL cannot sensibly express) first, so a
-- person sees a sentence rather than a constraint name.
ALTER TABLE societies ADD CONSTRAINT societies_state_code_format
  CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$') NOT VALID;
ALTER TABLE societies ADD CONSTRAINT societies_gstin_format
  CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$') NOT VALID;
-- A GSTIN begins with the code of the state it was issued in. One that does
-- not match the society's state is a typo or someone else's registration.
ALTER TABLE societies ADD CONSTRAINT societies_gstin_matches_state
  CHECK (gstin IS NULL OR state_code IS NULL OR left(gstin, 2) = state_code) NOT VALID;

COMMENT ON COLUMN societies.tan IS
  'Tax deduction account number, needed on every TDS challan and Form 16A. Null until the association supplies its own.';

-- --------------------------------------------------------------------------
-- Opening balance batches
-- --------------------------------------------------------------------------
CREATE TABLE opening_balance_batches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id        UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  -- 1 for the first attempt, 2 for the entry that replaces a reversed one.
  batch_no          SMALLINT NOT NULL CHECK (batch_no > 0),
  -- The date the balances are stated at: the last day before the cut-over,
  -- matching the trial balance they were agreed against. The entry is dated
  -- this day.
  as_at             DATE NOT NULL,
  state             TEXT NOT NULL DEFAULT 'draft'
                    CHECK (state IN ('draft','posted','reversed','discarded')),
  -- Whether the difference between debits and credits is posted to the
  -- general reserve as the balancing figure. Off, an unbalanced batch is
  -- refused.
  auto_balance      BOOLEAN NOT NULL DEFAULT false,
  note              TEXT,
  prepared_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  prepared_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by       UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at       TIMESTAMPTZ,
  posted_entry_id   UUID REFERENCES journal_entries(id),
  total_debit       BIGINT CHECK (total_debit IS NULL OR total_debit >= 0),
  total_credit      BIGINT CHECK (total_credit IS NULL OR total_credit >= 0),
  reversed_by       UUID REFERENCES users(id) ON DELETE RESTRICT,
  reversed_at       TIMESTAMPTZ,
  reversal_entry_id UUID REFERENCES journal_entries(id),
  reversal_reason   TEXT,
  UNIQUE (society_id, batch_no),
  -- Maker-checker: whoever prepared the figures cannot be whoever posts them.
  CONSTRAINT opening_balance_maker_is_not_checker
    CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  -- A posted batch names its approver and its entry, and it balanced.
  CHECK (state NOT IN ('posted','reversed') OR (
           approved_by IS NOT NULL AND approved_at IS NOT NULL
           AND posted_entry_id IS NOT NULL
           AND total_debit IS NOT NULL AND total_debit = total_credit AND total_debit > 0)),
  CHECK (state <> 'reversed' OR (
           reversed_by IS NOT NULL AND reversed_at IS NOT NULL
           AND reversal_entry_id IS NOT NULL
           AND reversal_reason IS NOT NULL AND length(btrim(reversal_reason)) > 0))
);

-- Once per society, at the database: at most one batch is being prepared or
-- stands posted. A second opening position next to a posted one would count
-- every balance twice.
CREATE UNIQUE INDEX opening_balance_one_live
  ON opening_balance_batches (society_id)
  WHERE state IN ('draft','posted');

CREATE RULE opening_balance_batches_no_delete AS
  ON DELETE TO opening_balance_batches DO INSTEAD NOTHING;

-- What each flat brought in. A flat either owed or had paid ahead on the
-- cut-over date, never both: the two are netted before entry.
CREATE TABLE opening_balance_flat_lines (
  id            BIGSERIAL PRIMARY KEY,
  batch_id      UUID NOT NULL REFERENCES opening_balance_batches(id) ON DELETE RESTRICT,
  flat_id       UUID NOT NULL REFERENCES flats(id) ON DELETE RESTRICT,
  due           BIGINT NOT NULL DEFAULT 0 CHECK (due >= 0),
  advance       BIGINT NOT NULL DEFAULT 0 CHECK (advance >= 0),
  -- Optional: since when the arrear has been due, so the ageing report shows
  -- a two-year-old arrear as 90+ rather than as last month's.
  due_since     DATE,
  -- The document the due became, set when the batch posts.
  document_id   UUID REFERENCES billing_documents(id),
  UNIQUE (batch_id, flat_id),
  CHECK ((due > 0) <> (advance > 0)),
  CHECK (due_since IS NULL OR due > 0)
);

-- The society-level balances: one row per account (or per vendor bill).
CREATE TABLE opening_balance_account_lines (
  id              BIGSERIAL PRIMARY KEY,
  batch_id        UUID NOT NULL REFERENCES opening_balance_batches(id) ON DELETE RESTRICT,
  society_id      UUID NOT NULL,
  account_code    TEXT NOT NULL,
  debit           BIGINT NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit          BIGINT NOT NULL DEFAULT 0 CHECK (credit >= 0),
  -- For a vendor payable: whose, and against which of their bills.
  vendor_id       UUID REFERENCES vendors(id) ON DELETE RESTRICT,
  reference       TEXT,
  -- For a vendor payable: what the bill was for, carried onto the booked bill.
  expense_account TEXT,
  memo            TEXT,
  -- True for the figure computed to make the batch balance.
  is_balancing    BOOLEAN NOT NULL DEFAULT false,
  vendor_bill_id  UUID REFERENCES vendor_bills(id),
  CONSTRAINT opening_account_line_one_side CHECK ((debit = 0) <> (credit = 0)),
  CHECK (vendor_id IS NULL OR (reference IS NOT NULL AND expense_account IS NOT NULL)),
  FOREIGN KEY (society_id, account_code) REFERENCES accounts(society_id, code),
  FOREIGN KEY (society_id, expense_account) REFERENCES accounts(society_id, code)
);

CREATE INDEX opening_balance_flat_lines_by_batch ON opening_balance_flat_lines (batch_id);
CREATE INDEX opening_balance_account_lines_by_batch ON opening_balance_account_lines (batch_id);

-- A draft's lines are replaced as it is edited. A posted batch's lines are the
-- record of what was posted and change no further.
CREATE OR REPLACE FUNCTION check_opening_lines_editable() RETURNS TRIGGER AS $$
DECLARE
  batch_state TEXT;
BEGIN
  SELECT state INTO batch_state FROM opening_balance_batches
   WHERE id = COALESCE(OLD.batch_id, NEW.batch_id);
  IF batch_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'opening balances that have been %; their lines cannot change. Reverse the batch and enter a new one',
      batch_state;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER opening_balance_flat_lines_editable
  BEFORE UPDATE OR DELETE ON opening_balance_flat_lines
  FOR EACH ROW EXECUTE FUNCTION check_opening_lines_editable();
CREATE TRIGGER opening_balance_account_lines_editable
  BEFORE UPDATE OR DELETE ON opening_balance_account_lines
  FOR EACH ROW EXECUTE FUNCTION check_opening_lines_editable();

-- --------------------------------------------------------------------------
-- Opening items in the billing and vendor registers
-- --------------------------------------------------------------------------
ALTER TABLE billing_documents
  ADD COLUMN opening_batch_id UUID REFERENCES opening_balance_batches(id);
-- An opening due is not a sale and carries no tax.
ALTER TABLE billing_documents ADD CONSTRAINT billing_documents_opening_untaxed
  CHECK (opening_batch_id IS NULL OR estimated_tax = 0);

COMMENT ON COLUMN billing_documents.opening_batch_id IS
  'Set on a flat''s opening due brought forward at cut-over. Such a document is a receivable carried in, not a supply: it has no GST and never appears in gst_register.';

ALTER TABLE vendor_bills
  ADD COLUMN opening_batch_id UUID REFERENCES opening_balance_batches(id);
ALTER TABLE vendor_bills ADD CONSTRAINT vendor_bills_opening_plain
  CHECK (opening_batch_id IS NULL OR (input_gst = 0 AND tds_amount = 0));

-- One flat's opening due is not cancelled on its own: that would reverse the
-- whole opening entry, which it points at. It is cancelled only as part of
-- reversing its batch.
CREATE OR REPLACE FUNCTION check_opening_document_state() RETURNS TRIGGER AS $$
DECLARE
  batch_state TEXT;
BEGIN
  IF OLD.opening_batch_id IS NULL OR NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;
  SELECT state INTO batch_state FROM opening_balance_batches WHERE id = OLD.opening_batch_id;
  IF NEW.state = 'cancelled' AND batch_state = 'reversed' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'document % is an opening balance brought forward, not a bill; correct it by reversing the opening balances and entering them again',
    OLD.proforma_no;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_documents_opening_state
  BEFORE UPDATE OF state ON billing_documents
  FOR EACH ROW EXECUTE FUNCTION check_opening_document_state();

-- No GST row for an opening due, nor for a note adjusting one. Enforced here
-- because the register is what a return is filed from.
CREATE OR REPLACE FUNCTION check_gst_register_not_opening() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM billing_documents d
     WHERE d.opening_batch_id IS NOT NULL
       AND (d.id = NEW.document_id
            OR d.id = (SELECT a.document_id FROM invoice_adjustments a WHERE a.id = NEW.adjustment_id))
  ) THEN
    RAISE EXCEPTION
      'an opening balance brought forward is not a supply, so it has no GST and no place in the GST register';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gst_register_not_opening
  BEFORE INSERT ON gst_register
  FOR EACH ROW EXECUTE FUNCTION check_gst_register_not_opening();

COMMIT;
