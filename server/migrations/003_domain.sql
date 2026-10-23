-- Migration 003: the rest of the domain.
--
-- Banking and reconciliation, the six receipt heads as first-class rows,
-- sinking funds and deposits, events, vendor contracts, GST and TDS registers,
-- helpdesk, document generation, notification delivery, committee approvals,
-- scheduled jobs and financial period locks.
--
-- Same rules as 001 and 002: money is BIGINT paise, every table carries
-- society_id, nothing financial can be deleted, and no column exists that
-- could hold a credential the system should never see.

BEGIN;

-- --------------------------------------------------------------------------
-- Society configuration, as versioned rows rather than columns
-- --------------------------------------------------------------------------
CREATE TABLE society_settings (
  society_id    UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  key           TEXT NOT NULL,
  value         JSONB NOT NULL,
  -- Who confirmed it, for the settings that are accounting or tax treatments.
  -- Null means nobody has, and the application refuses to rely on it.
  approved_by   UUID REFERENCES users(id),
  approved_on   DATE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  note          TEXT,
  PRIMARY KEY (society_id, key)
);

COMMENT ON COLUMN society_settings.approved_by IS
  'Null for any setting a CA has not signed off. The billing path refuses to use an unapproved tax treatment rather than defaulting to one.';

-- --------------------------------------------------------------------------
-- Towers
-- --------------------------------------------------------------------------
CREATE TABLE towers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,
  floors        SMALLINT CHECK (floors IS NULL OR floors > 0),
  UNIQUE (society_id, name)
);

ALTER TABLE flats ADD COLUMN tower_id UUID REFERENCES towers(id);

-- --------------------------------------------------------------------------
-- The six receipt heads, as rows
-- --------------------------------------------------------------------------
CREATE TABLE receipt_heads (
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  key             TEXT NOT NULL CHECK (key IN
                   ('maintenance','sinking','festival','rental','reimbursement','other')),
  label           TEXT NOT NULL,
  -- Where a collection under this head is credited.
  income_account  TEXT,
  fund_account    TEXT,
  taxable         BOOLEAN NOT NULL,
  -- True where a contribution credits the fund directly instead of income.
  credits_fund_directly BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (society_id, key),
  FOREIGN KEY (society_id, income_account) REFERENCES accounts(society_id, code),
  FOREIGN KEY (society_id, fund_account) REFERENCES accounts(society_id, code),
  -- A head must credit something.
  CHECK (income_account IS NOT NULL OR fund_account IS NOT NULL),
  -- And a head that credits the fund directly must name that fund.
  CHECK (NOT credits_fund_directly OR fund_account IS NOT NULL)
);

-- --------------------------------------------------------------------------
-- Invoice adjustments: credit and debit notes
-- --------------------------------------------------------------------------
CREATE TABLE invoice_adjustments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  document_id   UUID NOT NULL REFERENCES billing_documents(id) ON DELETE RESTRICT,
  note_no       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('credit','debit')),
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  amount        BIGINT NOT NULL CHECK (amount > 0),
  tax_amount    BIGINT NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  issued_on     DATE NOT NULL,
  approved_by   UUID REFERENCES users(id),
  posted_entry_id UUID REFERENCES journal_entries(id),
  UNIQUE (society_id, note_no),
  -- An adjustment that has been posted must say who approved it.
  CHECK (posted_entry_id IS NULL OR approved_by IS NOT NULL)
);

CREATE RULE invoice_adjustments_no_delete AS ON DELETE TO invoice_adjustments DO INSTEAD NOTHING;

-- --------------------------------------------------------------------------
-- Payments and receipt allocations
-- --------------------------------------------------------------------------
CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  receipt_no      TEXT NOT NULL,
  flat_id         UUID NOT NULL REFERENCES flats(id) ON DELETE RESTRICT,
  received_on     DATE NOT NULL,
  amount          BIGINT NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL,
  instrument_ref  TEXT,
  bank_account_id UUID,
  posted_entry_id UUID REFERENCES journal_entries(id),
  -- The caller's key, so a retried request cannot take the money twice.
  idempotency_key TEXT NOT NULL,
  recorded_by     UUID REFERENCES users(id),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (society_id, receipt_no),
  UNIQUE (society_id, idempotency_key)
);

CREATE RULE payments_no_delete AS ON DELETE TO payments DO INSTEAD NOTHING;

-- Which document each slice of a receipt settled. The sum of a payment's
-- allocations plus what it holds as advance equals the payment.
CREATE TABLE receipt_allocations (
  id            BIGSERIAL PRIMARY KEY,
  payment_id    UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  document_id   UUID REFERENCES billing_documents(id) ON DELETE RESTRICT,
  -- Null document means the slice was held on account as an advance.
  amount        BIGINT NOT NULL CHECK (amount > 0),
  head          TEXT CHECK (head IN
                 ('maintenance','sinking','festival','rental','reimbursement','other')),
  allocated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX receipt_allocations_by_payment ON receipt_allocations (payment_id);
CREATE INDEX receipt_allocations_by_document ON receipt_allocations (document_id);
CREATE RULE receipt_allocations_no_delete AS ON DELETE TO receipt_allocations DO INSTEAD NOTHING;

-- A payment's allocations must add up to the payment, checked at commit so the
-- rows can be inserted in any order.
CREATE OR REPLACE FUNCTION check_payment_allocated() RETURNS TRIGGER AS $$
DECLARE
  pid UUID;
  allocated BIGINT;
  received BIGINT;
BEGIN
  pid := COALESCE(NEW.payment_id, OLD.payment_id);
  SELECT COALESCE(SUM(amount), 0) INTO allocated
    FROM receipt_allocations WHERE payment_id = pid;
  SELECT amount INTO received FROM payments WHERE id = pid;
  IF received IS NULL THEN
    RAISE EXCEPTION 'allocation references payment % which does not exist', pid;
  END IF;
  IF allocated <> received THEN
    RAISE EXCEPTION
      'payment % received % but its allocations total % (out by %)',
      pid, received, allocated, allocated - received;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER receipt_allocations_cover_payment
  AFTER INSERT OR UPDATE ON receipt_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_payment_allocated();

CREATE CONSTRAINT TRIGGER payments_are_allocated
  AFTER INSERT ON payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_payment_allocated();

-- --------------------------------------------------------------------------
-- Sinking fund and fixed deposits
-- --------------------------------------------------------------------------
CREATE TABLE fixed_deposits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  fd_ref          TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  -- Last four digits only. The full number is not needed to run a register and
  -- is one more thing to lose.
  account_last4   TEXT CHECK (account_last4 IS NULL OR account_last4 ~ '^[0-9]{4}$'),
  principal       BIGINT NOT NULL CHECK (principal > 0),
  rate_bps        INTEGER NOT NULL CHECK (rate_bps > 0),
  placed_on       DATE NOT NULL,
  matures_on      DATE NOT NULL,
  closed_on       DATE,
  interest_accrued BIGINT NOT NULL DEFAULT 0 CHECK (interest_accrued >= 0),
  fund            TEXT NOT NULL CHECK (fund IN ('sinking','festival','general')),
  UNIQUE (society_id, fd_ref),
  CHECK (matures_on > placed_on),
  CHECK (closed_on IS NULL OR closed_on >= placed_on)
);

COMMENT ON COLUMN fixed_deposits.rate_bps IS
  'Basis points, so 7.25% is 725 and no fractional rate is stored as a float.';

-- --------------------------------------------------------------------------
-- Events
-- --------------------------------------------------------------------------
CREATE TABLE events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,
  held_on       DATE,
  budget        BIGINT CHECK (budget IS NULL OR budget >= 0),
  -- Voluntary collections are not dues; billing never raises them.
  voluntary     BOOLEAN NOT NULL DEFAULT true,
  closed        BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (society_id, name, held_on)
);

CREATE TABLE event_contributions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  flat_id       UUID REFERENCES flats(id) ON DELETE RESTRICT,
  sponsor_name  TEXT,
  amount        BIGINT NOT NULL CHECK (amount > 0),
  received_on   DATE NOT NULL,
  payment_id    UUID REFERENCES payments(id),
  -- A contribution is from a flat or an outside sponsor, not neither.
  CHECK (flat_id IS NOT NULL OR sponsor_name IS NOT NULL)
);

CREATE TABLE event_expenses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  description   TEXT NOT NULL,
  amount        BIGINT NOT NULL CHECK (amount > 0),
  incurred_on   DATE NOT NULL,
  vendor_id     UUID,
  posted_entry_id UUID REFERENCES journal_entries(id)
);

-- --------------------------------------------------------------------------
-- Vendors
-- --------------------------------------------------------------------------
CREATE TABLE vendors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,
  pan           TEXT CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  gstin         TEXT CHECK (gstin IS NULL OR length(gstin) = 15),
  -- Which section applies to this vendor's work, and whether they are a
  -- company: 194C is 2% for a company and 1% for an individual or HUF.
  tds_section   TEXT CHECK (tds_section IN ('194C','194J','194I','none')),
  payee_kind    TEXT CHECK (payee_kind IN ('company','individual-or-huf')),
  bank_last4    TEXT CHECK (bank_last4 IS NULL OR bank_last4 ~ '^[0-9]{4}$'),
  bank_ifsc     TEXT CHECK (bank_ifsc IS NULL OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  active        BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (society_id, name)
);

COMMENT ON TABLE vendors IS
  'No internet-banking credential has a column here, by design. Last four digits and IFSC are enough to identify an account on a payment advice.';

CREATE TABLE vendor_contracts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  title         TEXT NOT NULL,
  starts_on     DATE NOT NULL,
  ends_on       DATE NOT NULL,
  monthly_value BIGINT CHECK (monthly_value IS NULL OR monthly_value > 0),
  renewal_notice_days SMALLINT NOT NULL DEFAULT 30,
  CHECK (ends_on > starts_on)
);

CREATE TABLE vendor_bills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  bill_no         TEXT NOT NULL,
  bill_date       DATE NOT NULL,
  received_on     DATE,
  expense_account TEXT NOT NULL,
  gross           BIGINT NOT NULL CHECK (gross > 0),
  input_gst       BIGINT NOT NULL DEFAULT 0 CHECK (input_gst >= 0),
  tds_section     TEXT NOT NULL CHECK (tds_section IN ('194C','194J','194I','none')),
  tds_rate_bps    INTEGER NOT NULL DEFAULT 0 CHECK (tds_rate_bps >= 0),
  tds_amount      BIGINT NOT NULL DEFAULT 0 CHECK (tds_amount >= 0),
  net_payable     BIGINT NOT NULL CHECK (net_payable >= 0),
  -- Approval, booking and payment are distinct. 'approved' posts nothing.
  state           TEXT NOT NULL CHECK (state IN
                   ('awaiting-approval','approved','booked','rejected')),
  approved_by     UUID REFERENCES users(id),
  rejected_reason TEXT,
  posted_entry_id UUID REFERENCES journal_entries(id),
  UNIQUE (society_id, vendor_id, bill_no),
  FOREIGN KEY (society_id, expense_account) REFERENCES accounts(society_id, code),
  CHECK (tds_amount <= gross),
  CHECK (net_payable = gross - tds_amount),
  CHECK (state <> 'approved' OR approved_by IS NOT NULL),
  CHECK (state <> 'booked' OR (approved_by IS NOT NULL AND posted_entry_id IS NOT NULL)),
  CHECK (state <> 'rejected' OR rejected_reason IS NOT NULL)
);

CREATE TABLE vendor_payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  bill_id         UUID REFERENCES vendor_bills(id) ON DELETE RESTRICT,
  payment_ref     TEXT NOT NULL,
  paid_on         DATE NOT NULL,
  amount          BIGINT NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL,
  bank_account_id UUID,
  posted_entry_id UUID REFERENCES journal_entries(id),
  idempotency_key TEXT NOT NULL,
  UNIQUE (society_id, payment_ref),
  UNIQUE (society_id, idempotency_key)
);

CREATE RULE vendor_payments_no_delete AS ON DELETE TO vendor_payments DO INSTEAD NOTHING;

-- --------------------------------------------------------------------------
-- GST and TDS registers
-- --------------------------------------------------------------------------
CREATE TABLE gst_register (
  id              BIGSERIAL PRIMARY KEY,
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  document_id     UUID REFERENCES billing_documents(id),
  adjustment_id   UUID REFERENCES invoice_adjustments(id),
  tax_period      TEXT NOT NULL,
  invoice_no      TEXT NOT NULL,
  invoice_date    DATE NOT NULL,
  counterparty    TEXT NOT NULL,
  counterparty_gstin TEXT,
  -- B2B where the member supplied a GSTIN, B2C otherwise. Drives GSTR-1.
  supply_type     TEXT NOT NULL CHECK (supply_type IN ('B2B','B2C')),
  sac_code        TEXT,
  taxable_value   BIGINT NOT NULL CHECK (taxable_value >= 0),
  cgst            BIGINT NOT NULL DEFAULT 0 CHECK (cgst >= 0),
  sgst            BIGINT NOT NULL DEFAULT 0 CHECK (sgst >= 0),
  igst            BIGINT NOT NULL DEFAULT 0 CHECK (igst >= 0),
  rate_bps        INTEGER NOT NULL CHECK (rate_bps >= 0),
  reverse_charge  BOOLEAN NOT NULL DEFAULT false,
  -- An entry belongs to an invoice or an adjustment, exactly one.
  CHECK ((document_id IS NULL) <> (adjustment_id IS NULL)),
  -- Intra-state is CGST plus SGST; inter-state is IGST. Not both.
  CHECK ((igst = 0) OR (cgst = 0 AND sgst = 0))
);

CREATE INDEX gst_register_by_period ON gst_register (society_id, tax_period);
CREATE RULE gst_register_no_delete AS ON DELETE TO gst_register DO INSTEAD NOTHING;

CREATE TABLE tds_register (
  id              BIGSERIAL PRIMARY KEY,
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  bill_id         UUID REFERENCES vendor_bills(id),
  vendor_id       UUID NOT NULL REFERENCES vendors(id),
  section         TEXT NOT NULL CHECK (section IN ('194C','194J','194I')),
  quarter         TEXT NOT NULL CHECK (quarter ~ '^Q[1-4]-FY[0-9]{2}-[0-9]{2}$'),
  deducted_on     DATE NOT NULL,
  gross           BIGINT NOT NULL CHECK (gross > 0),
  rate_bps        INTEGER NOT NULL CHECK (rate_bps > 0),
  tds_amount      BIGINT NOT NULL CHECK (tds_amount > 0),
  -- Set when the challan is recorded. Null means still a liability.
  challan_no      TEXT,
  challan_date    DATE,
  remittance_entry_id UUID REFERENCES journal_entries(id),
  CHECK ((challan_no IS NULL) = (challan_date IS NULL))
);

CREATE INDEX tds_register_by_quarter ON tds_register (society_id, quarter);
CREATE INDEX tds_register_unremitted ON tds_register (society_id, section)
  WHERE challan_no IS NULL;
CREATE RULE tds_register_no_delete AS ON DELETE TO tds_register DO INSTEAD NOTHING;

-- --------------------------------------------------------------------------
-- Banking
-- --------------------------------------------------------------------------
CREATE TABLE bank_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  label           TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  -- Last four only, and IFSC. There is deliberately no column for a full
  -- account number, a customer id, a password, or an API secret: a
  -- reconciliation system needs none of them, and storing them makes this
  -- database worth attacking.
  account_last4   TEXT NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  ifsc            TEXT NOT NULL CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  ledger_account  TEXT NOT NULL,
  purpose         TEXT NOT NULL CHECK (purpose IN ('operating','sinking','festival','other')),
  active          BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (society_id, label),
  FOREIGN KEY (society_id, ledger_account) REFERENCES accounts(society_id, code)
);

ALTER TABLE payments ADD CONSTRAINT payments_bank_account_fk
  FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id);
ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_bank_account_fk
  FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id);

CREATE TABLE statement_imports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  format          TEXT NOT NULL CHECK (format IN ('csv','xlsx','mt940')),
  filename        TEXT NOT NULL,
  -- Hash of the file, so the same statement cannot be imported twice.
  content_sha256  TEXT NOT NULL,
  period_from     DATE,
  period_to       DATE,
  rows_total      INTEGER NOT NULL DEFAULT 0,
  rows_imported   INTEGER NOT NULL DEFAULT 0,
  rows_duplicate  INTEGER NOT NULL DEFAULT 0,
  rows_rejected   INTEGER NOT NULL DEFAULT 0,
  imported_by     UUID REFERENCES users(id),
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (society_id, bank_account_id, content_sha256)
);

CREATE TABLE bank_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  import_id       UUID REFERENCES statement_imports(id),
  value_date      DATE NOT NULL,
  narration       TEXT NOT NULL,
  reference       TEXT,
  -- Signed: positive is money in.
  amount          BIGINT NOT NULL CHECK (amount <> 0),
  running_balance BIGINT,
  -- The deduplication key: the bank's own reference where it gives one, else a
  -- hash of date, amount and narration. Unique per account.
  dedupe_key      TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'unmatched'
                  CHECK (state IN ('unmatched','suggested','matched','suspense','ignored')),
  matched_payment_id UUID REFERENCES payments(id),
  matched_vendor_payment_id UUID REFERENCES vendor_payments(id),
  matched_by      UUID REFERENCES users(id),
  matched_at      TIMESTAMPTZ,
  suspense_reason TEXT,
  UNIQUE (society_id, bank_account_id, dedupe_key),
  -- A matched row points at exactly one side.
  CHECK (state <> 'matched' OR
         ((matched_payment_id IS NULL) <> (matched_vendor_payment_id IS NULL))),
  CHECK (state <> 'suspense' OR suspense_reason IS NOT NULL)
);

CREATE INDEX bank_transactions_open
  ON bank_transactions (society_id, bank_account_id, value_date)
  WHERE state IN ('unmatched','suggested','suspense');

CREATE TABLE bank_reconciliations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id        UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  bank_account_id   UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  as_at             DATE NOT NULL,
  statement_balance BIGINT NOT NULL,
  ledger_balance    BIGINT NOT NULL,
  unmatched_count   INTEGER NOT NULL DEFAULT 0,
  difference        BIGINT NOT NULL,
  reconciled_by     UUID REFERENCES users(id),
  reconciled_at     TIMESTAMPTZ,
  UNIQUE (society_id, bank_account_id, as_at),
  -- The difference is derived and must agree, so a reconciliation cannot be
  -- recorded as clean while the two sides disagree.
  CHECK (difference = statement_balance - ledger_balance),
  CHECK (reconciled_by IS NULL OR difference = 0)
);

COMMENT ON CONSTRAINT bank_reconciliations_check1 ON bank_reconciliations IS
  'A reconciliation can only be signed off when the difference is zero.';

-- Per-flat virtual accounts, for when a bank provides them.
CREATE TABLE virtual_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  flat_id         UUID NOT NULL REFERENCES flats(id) ON DELETE RESTRICT,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  virtual_ref     TEXT NOT NULL,
  upi_id          TEXT,
  provider        TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (society_id, virtual_ref),
  UNIQUE (society_id, flat_id, bank_account_id)
);

-- --------------------------------------------------------------------------
-- Helpdesk
-- --------------------------------------------------------------------------
CREATE TABLE ticket_categories (
  society_id    UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  -- The SLA, in hours, as a setting rather than a constant in code.
  sla_hours     INTEGER NOT NULL CHECK (sla_hours > 0),
  escalate_to_role TEXT CHECK (escalate_to_role IN
                    ('manager','treasurer','secretary')),
  PRIMARY KEY (society_id, key)
);

CREATE TABLE tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  ticket_no       TEXT NOT NULL,
  flat_id         UUID REFERENCES flats(id) ON DELETE RESTRICT,
  raised_by       UUID REFERENCES users(id),
  category        TEXT NOT NULL,
  description     TEXT NOT NULL CHECK (length(btrim(description)) > 0),
  priority        TEXT NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('emergency','high','normal','low')),
  state           TEXT NOT NULL DEFAULT 'open'
                  CHECK (state IN ('open','assigned','in-progress','resolved','confirmed','closed','reopened')),
  assigned_to_user UUID REFERENCES users(id),
  assigned_to_vendor UUID REFERENCES vendors(id),
  raised_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at          TIMESTAMPTZ NOT NULL,
  resolved_at     TIMESTAMPTZ,
  confirmed_at    TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  reopened_count  SMALLINT NOT NULL DEFAULT 0 CHECK (reopened_count >= 0),
  escalated_at    TIMESTAMPTZ,
  resolution_note TEXT,
  satisfaction    SMALLINT CHECK (satisfaction IS NULL OR satisfaction BETWEEN 1 AND 5),
  cost            BIGINT CHECK (cost IS NULL OR cost >= 0),
  UNIQUE (society_id, ticket_no),
  FOREIGN KEY (society_id, category) REFERENCES ticket_categories(society_id, key),
  CHECK (state <> 'resolved' OR (resolved_at IS NOT NULL AND resolution_note IS NOT NULL)),
  CHECK (state <> 'confirmed' OR confirmed_at IS NOT NULL),
  -- Assigned to a person or a vendor, not both.
  CHECK (assigned_to_user IS NULL OR assigned_to_vendor IS NULL)
);

CREATE INDEX tickets_open ON tickets (society_id, due_at)
  WHERE state IN ('open','assigned','in-progress','reopened');

CREATE TABLE ticket_events (
  id            BIGSERIAL PRIMARY KEY,
  ticket_id     UUID NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user    UUID REFERENCES users(id),
  actor_label   TEXT NOT NULL,
  from_state    TEXT,
  to_state      TEXT,
  note          TEXT
);

CREATE RULE ticket_events_no_delete AS ON DELETE TO ticket_events DO INSTEAD NOTHING;

CREATE TABLE attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  ticket_id       UUID REFERENCES tickets(id) ON DELETE RESTRICT,
  document_id     UUID REFERENCES billing_documents(id) ON DELETE RESTRICT,
  vendor_bill_id  UUID REFERENCES vendor_bills(id) ON DELETE RESTRICT,
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  byte_size       INTEGER NOT NULL CHECK (byte_size > 0),
  sha256          TEXT NOT NULL,
  -- Where the bytes live. Object storage in production; the filesystem in
  -- development. Never the database itself.
  storage_key     TEXT NOT NULL,
  uploaded_by     UUID REFERENCES users(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (society_id, storage_key),
  -- An attachment hangs off exactly one thing.
  CHECK ((ticket_id IS NOT NULL)::int
       + (document_id IS NOT NULL)::int
       + (vendor_bill_id IS NOT NULL)::int = 1)
);

-- --------------------------------------------------------------------------
-- Generated documents and notification delivery
-- --------------------------------------------------------------------------
CREATE TABLE generated_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  kind            TEXT NOT NULL CHECK (kind IN
                   ('tax-invoice','proforma','receipt','credit-note','debit-note','statement','report')),
  document_id     UUID REFERENCES billing_documents(id),
  payment_id      UUID REFERENCES payments(id),
  adjustment_id   UUID REFERENCES invoice_adjustments(id),
  content_type    TEXT NOT NULL DEFAULT 'application/pdf',
  byte_size       INTEGER CHECK (byte_size IS NULL OR byte_size > 0),
  sha256          TEXT,
  storage_key     TEXT,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The data the document was rendered from, so a reprint is byte-identical
  -- and a later rate change cannot alter a document already issued.
  render_payload  JSONB NOT NULL
);

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  channel         TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp','in-app')),
  template        TEXT NOT NULL,
  to_user         UUID REFERENCES users(id),
  to_address      TEXT NOT NULL,
  subject         TEXT,
  payload         JSONB NOT NULL,
  document_id     UUID REFERENCES generated_documents(id),
  state           TEXT NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued','sending','sent','failed','bounced','suppressed')),
  attempts        SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- The provider's own id, which is the only thing that makes 'sent' mean
  -- anything. Null with state 'sent' is not allowed.
  provider        TEXT,
  provider_message_id TEXT,
  last_error      TEXT,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  CHECK (state <> 'sent' OR (provider IS NOT NULL AND provider_message_id IS NOT NULL AND sent_at IS NOT NULL)),
  CHECK (state <> 'failed' OR last_error IS NOT NULL)
);

COMMENT ON CONSTRAINT notifications_check1 ON notifications IS
  'A notification cannot be marked sent without a provider and that provider''s message id. Nothing may record a delivery it cannot evidence.';

CREATE INDEX notifications_pending ON notifications (society_id, queued_at)
  WHERE state IN ('queued','sending');

-- --------------------------------------------------------------------------
-- Committee approvals and resolutions
-- --------------------------------------------------------------------------
CREATE TABLE resolutions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  reference       TEXT NOT NULL,
  passed_on       DATE NOT NULL,
  meeting_kind    TEXT NOT NULL CHECK (meeting_kind IN ('committee','agm','sgm')),
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  UNIQUE (society_id, reference)
);

CREATE TABLE approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  subject_table   TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  -- Maker-checker: whoever prepared it cannot be whoever approves it.
  requested_by    UUID NOT NULL REFERENCES users(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by      UUID REFERENCES users(id),
  decided_at      TIMESTAMPTZ,
  decision        TEXT CHECK (decision IN ('approved','rejected')),
  reason          TEXT,
  resolution_id   UUID REFERENCES resolutions(id),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK (decision <> 'rejected' OR reason IS NOT NULL)
);

COMMENT ON CONSTRAINT approvals_check ON approvals IS
  'Maker-checker, at the database: the requester cannot be the approver.';

CREATE INDEX approvals_pending ON approvals (society_id, subject_table)
  WHERE decision IS NULL;

-- --------------------------------------------------------------------------
-- Financial period locks
-- --------------------------------------------------------------------------
CREATE TABLE financial_periods (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  -- 'YYYY-MM' for a month.
  period        TEXT NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  starts_on     DATE NOT NULL,
  ends_on       DATE NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open'
                CHECK (state IN ('open','closing','closed','reopened')),
  closed_by     UUID REFERENCES users(id),
  closed_at     TIMESTAMPTZ,
  reopened_by   UUID REFERENCES users(id),
  reopened_reason TEXT,
  trial_balance_debit  BIGINT,
  trial_balance_credit BIGINT,
  UNIQUE (society_id, period),
  CHECK (ends_on >= starts_on),
  CHECK (state <> 'closed' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK (state <> 'reopened' OR (reopened_by IS NOT NULL AND reopened_reason IS NOT NULL)),
  -- A closed period records the trial balance it closed on, and it must tie.
  CHECK (state <> 'closed' OR
         (trial_balance_debit IS NOT NULL AND trial_balance_debit = trial_balance_credit))
);

-- Posting into a closed period is refused by the database, not only by the
-- application. This is the lock.
CREATE OR REPLACE FUNCTION check_period_open() RETURNS TRIGGER AS $$
DECLARE
  period_state TEXT;
  label TEXT;
BEGIN
  label := to_char(NEW.entry_date, 'YYYY-MM');
  SELECT state INTO period_state FROM financial_periods
   WHERE society_id = NEW.society_id AND period = label;

  IF period_state IN ('closed', 'closing') THEN
    RAISE EXCEPTION
      'cannot post into % because that period is %; reopen it or post to an open period',
      label, period_state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_period_open
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION check_period_open();

-- --------------------------------------------------------------------------
-- Scheduled jobs
-- --------------------------------------------------------------------------
CREATE TABLE scheduled_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    UUID REFERENCES societies(id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL,
  -- The business key for this run, so a scheduler firing twice does the work
  -- once. 'monthly-billing:2026-07' can only exist once.
  run_key       TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','running','succeeded','failed','abandoned')),
  attempts      SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  SMALLINT NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  -- When to try again, set by the backoff.
  next_attempt_at TIMESTAMPTZ,
  locked_by     TEXT,
  locked_at     TIMESTAMPTZ,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  result        JSONB,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  UNIQUE (kind, run_key),
  CHECK (state <> 'failed' OR last_error IS NOT NULL),
  CHECK (state <> 'running' OR locked_by IS NOT NULL)
);

CREATE INDEX scheduled_jobs_due ON scheduled_jobs (state, scheduled_for)
  WHERE state IN ('pending', 'running');

-- --------------------------------------------------------------------------
-- Rate limiting, for login and OTP
-- --------------------------------------------------------------------------
CREATE TABLE rate_limit_buckets (
  -- The subject: an email, an IP, a user id. Hashed by the application so the
  -- table is not a list of who tried to log in.
  subject_hash  TEXT NOT NULL,
  action        TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  count         INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
  PRIMARY KEY (subject_hash, action, window_start)
);

CREATE INDEX rate_limit_buckets_sweep ON rate_limit_buckets (window_start);

COMMIT;
