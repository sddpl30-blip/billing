-- Applies migration 017 (tax invoices waiting for the treasurer's approval) to
-- a database that already has 001–016. Run it once in Neon's SQL Editor, on the
-- societybooks database. It records itself in schema_migrations with the
-- checksum the migration runner computes.
--
-- GENERATED from server/migrations/017_tax_invoice_requests.sql. Do not edit.

-- Migration 017: tax invoices waiting for the treasurer's approval.
--
-- When the society's conversion mode is "approval" (Office > Settings), a
-- payment no longer turns a proforma into a tax invoice by itself. It leaves a
-- request here: which proforma, which receipt(s), when and how much was paid.
-- The treasurer approves it (one or many at once); only then is the tax
-- invoice numbered and posted and its PDF e-mailed. The person who recorded
-- the payment cannot be the one who approves it. Nothing is ever deleted.

BEGIN;

CREATE TABLE tax_invoice_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  document_id   UUID NOT NULL UNIQUE REFERENCES billing_documents(id) ON DELETE RESTRICT,
  flat_id       UUID NOT NULL REFERENCES flats(id) ON DELETE RESTRICT,
  receipt_nos   TEXT NOT NULL,
  paid_on       DATE NOT NULL,
  paid_paise    BIGINT NOT NULL CHECK (paid_paise > 0),
  requested_by  UUID REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    UUID REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision      TEXT CHECK (decision IN ('approved')),
  tax_invoice_no TEXT,
  CHECK (decided_by IS NULL OR requested_by IS NULL OR decided_by <> requested_by),
  CHECK ((decision IS NULL) = (decided_at IS NULL))
);

CREATE INDEX tax_invoice_requests_open ON tax_invoice_requests (society_id, requested_at) WHERE decision IS NULL;

COMMENT ON TABLE tax_invoice_requests IS
  'A proforma whose payment has been recorded and whose tax invoice awaits the treasurer. Kept for ever.';

INSERT INTO schema_migrations (version, checksum) VALUES ('017_tax_invoice_requests.sql', 'd29a5fca0fe11f38');

COMMIT;
