-- Migration 014: requests to add or reverse a receipt (an advance is a receipt
-- on a flat with nothing due), under maker-checker.
--
-- One person prepares a request, with a mandatory reason; a different person
-- (the treasurer) approves or rejects it. Only on approval does the receipt
-- get recorded, or its posting get reversed by a mirror entry. Nothing is
-- deleted: the request, the receipt, the reversal and the decision all stay.
-- The database refuses a decider who is the requester.

BEGIN;

CREATE TABLE receipt_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  kind            TEXT NOT NULL CHECK (kind IN ('add','reverse')),
  flat_id         UUID REFERENCES flats(id) ON DELETE RESTRICT,
  amount_paise    BIGINT CHECK (amount_paise IS NULL OR amount_paise > 0),
  received_on     DATE,
  method          TEXT CHECK (method IS NULL OR method IN ('upi','neft','imps','cheque','cash','nach','card')),
  instrument_ref  TEXT,
  bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  payment_id      UUID REFERENCES payments(id) ON DELETE RESTRICT,
  effective_on    DATE,
  reason          TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
  requested_by    UUID NOT NULL REFERENCES users(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by      UUID REFERENCES users(id),
  decided_at      TIMESTAMPTZ,
  decision        TEXT CHECK (decision IN ('approved','rejected')),
  decision_note   TEXT,
  result_payment_id UUID REFERENCES payments(id) ON DELETE RESTRICT,
  reversal_entry_id UUID,
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK (decision IS DISTINCT FROM 'rejected' OR decision_note IS NOT NULL),
  CHECK (kind <> 'add' OR (flat_id IS NOT NULL AND amount_paise IS NOT NULL AND received_on IS NOT NULL AND method IS NOT NULL)),
  CHECK (kind <> 'reverse' OR (payment_id IS NOT NULL AND effective_on IS NOT NULL))
);

CREATE INDEX receipt_requests_open ON receipt_requests (society_id, requested_at DESC) WHERE decision IS NULL;
CREATE INDEX receipt_requests_payment ON receipt_requests (payment_id) WHERE payment_id IS NOT NULL;

COMMENT ON TABLE receipt_requests IS
  'A prepared request to add or reverse a receipt, decided by someone other than the preparer. Kept for ever.';

COMMIT;
