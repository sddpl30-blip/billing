-- Migration 009: a payment matches at most one statement line.
--
-- Nothing stopped the same receipt (or vendor payment) being matched to two
-- bank lines, which reconciles one movement of money twice and hides a line
-- that has no counterpart. The match route now checks; these indexes make
-- the database refuse it too, including two matches made at the same moment.

BEGIN;

CREATE UNIQUE INDEX bank_transactions_payment_matched_once
  ON bank_transactions (matched_payment_id)
  WHERE state = 'matched' AND matched_payment_id IS NOT NULL;

CREATE UNIQUE INDEX bank_transactions_vendor_payment_matched_once
  ON bank_transactions (matched_vendor_payment_id)
  WHERE state = 'matched' AND matched_vendor_payment_id IS NOT NULL;

COMMIT;
