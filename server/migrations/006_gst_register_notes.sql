-- Migration 006: credit and debit notes in the GST register.
--
-- 003 assumed every row in `gst_register` was an invoice, and gave the tax
-- columns `CHECK (cgst >= 0)`. That is right for an invoice and wrong for the
-- register as a whole: a credit note reduces the output tax for its period,
-- and the first one raised was refused by that constraint.
--
-- Storing it as a negative invoice would have been the smaller change and the
-- wrong one. A return does not report a credit note as a negative invoice — it
-- reports it in its own table (CDNR), with positive figures and a reference to
-- the invoice it adjusts. So the row says which kind of document it is, keeps
-- its amounts positive, and the summary nets them.

BEGIN;

ALTER TABLE gst_register
  ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'invoice'
    CHECK (entry_kind IN ('invoice', 'credit-note', 'debit-note'));

COMMENT ON COLUMN gst_register.entry_kind IS
  'Which table of a return this row belongs to: B2B/B2C for an invoice, CDNR for a note. Amounts are always positive; a credit note reduces the period total by being subtracted, not by being stored negative.';

-- An adjustment row is a note, and an invoice row is not. Enforced, because
-- the two are already distinguishable by which id is set and a row that
-- disagreed with itself would misstate a return.
ALTER TABLE gst_register
  ADD CONSTRAINT gst_register_kind_matches_subject
  CHECK (
    (entry_kind = 'invoice' AND document_id IS NOT NULL)
    OR (entry_kind IN ('credit-note', 'debit-note') AND adjustment_id IS NOT NULL)
  );

CREATE INDEX gst_register_by_kind ON gst_register (society_id, tax_period, entry_kind);

COMMIT;
