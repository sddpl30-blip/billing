-- SocietyBooks schema, migration 001.
--
-- The invariants the engine enforces in TypeScript are enforced here as well.
-- Two reasons: a second writer that bypasses the application cannot corrupt
-- the books, and a constraint violation is caught by the database inside the
-- transaction rather than after a partial write.
--
-- Money is stored as BIGINT paise, never NUMERIC or DOUBLE. The engine works
-- in integer paise for the same reason: no two-decimal value is lost, and a
-- trial balance compares exactly.

BEGIN;

CREATE TABLE schema_migrations (
  version      TEXT PRIMARY KEY,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum     TEXT NOT NULL
);

-- --------------------------------------------------------------------------
-- Societies. Multi-tenant from the start: retrofitting a tenant column onto
-- a ledger means rewriting every row and every query.
-- --------------------------------------------------------------------------
CREATE TABLE societies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  -- 'demo' rows hold sample data. Kept in the same schema so the separation is
  -- a column that every query filters on, rather than two deployments that
  -- drift apart.
  mode          TEXT NOT NULL CHECK (mode IN ('demo', 'production')),
  registration_no TEXT,
  gstin         TEXT,
  state_code    TEXT,
  financial_year_start_month SMALLINT NOT NULL DEFAULT 4
                CHECK (financial_year_start_month BETWEEN 1 AND 12),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN societies.gstin IS
  'Left null until the association supplies its own. Never populated with a sample value: a GSTIN on a tax invoice is a legal assertion.';

-- --------------------------------------------------------------------------
-- Chart of accounts
-- --------------------------------------------------------------------------
CREATE TABLE accounts (
  society_id    UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  class         TEXT NOT NULL CHECK (class IN ('asset','liability','fund','income','expenditure')),
  grp           TEXT NOT NULL,
  is_cash       BOOLEAN NOT NULL DEFAULT false,
  control       TEXT CHECK (control IN ('resident','vendor')),
  PRIMARY KEY (society_id, code)
);

-- --------------------------------------------------------------------------
-- Flats and the people who own them
-- --------------------------------------------------------------------------
CREATE TABLE flats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  flat_no         TEXT NOT NULL,
  wing            TEXT,
  floor           SMALLINT,
  billing_area_sqft NUMERIC(10,2) CHECK (billing_area_sqft IS NULL OR billing_area_sqft > 0),
  -- Nullable on purpose. A flat with no recorded basis cannot be billed, and
  -- the application refuses rather than assuming one: the same rate over
  -- carpet and over super built-up area differs by roughly a third.
  area_basis      TEXT CHECK (area_basis IN ('carpet','built-up','super-built-up')),
  non_occupied    BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (society_id, flat_no)
);

CREATE TABLE owners (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  pan           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (society_id, email)
);

-- An owner may hold more than one flat, and a flat may change hands, so the
-- mapping is its own table with dates rather than a column on either side.
CREATE TABLE flat_ownership (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flat_id       UUID NOT NULL REFERENCES flats(id) ON DELETE RESTRICT,
  owner_id      UUID NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  role          TEXT NOT NULL CHECK (role IN ('owner','co-owner','tenant')),
  held_from     DATE NOT NULL,
  held_until    DATE,
  CHECK (held_until IS NULL OR held_until >= held_from)
);

-- One current owner per flat per role, enforced rather than hoped for: two
-- open ownership rows is how old dues attach to a new owner.
CREATE UNIQUE INDEX flat_ownership_one_current
  ON flat_ownership (flat_id, role)
  WHERE held_until IS NULL;

CREATE INDEX flat_ownership_by_owner ON flat_ownership (owner_id);

-- --------------------------------------------------------------------------
-- Users, roles, sessions
-- --------------------------------------------------------------------------
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  email           TEXT NOT NULL,
  -- A hash and its parameters. Never a PIN, and never anything reversible.
  password_hash   TEXT,
  owner_id        UUID REFERENCES owners(id) ON DELETE RESTRICT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ,
  UNIQUE (society_id, email)
);

COMMENT ON COLUMN users.password_hash IS
  'Null for an account that signs in by emailed one-time code only. The demo PIN mechanism has no column here: it is a demo-mode-only path in the application and cannot authorise anything in production mode.';

CREATE TABLE user_roles (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('resident','manager','treasurer','secretary','auditor')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by UUID REFERENCES users(id),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The token is stored hashed, so a database copy does not hand over live
  -- sessions.
  token_hash    TEXT NOT NULL UNIQUE,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  user_agent    TEXT,
  CHECK (expires_at > issued_at)
);

CREATE INDEX sessions_by_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Hashed, so the code cannot be read out of the database and used. The demo
  -- showed the code on screen; that is a demo-mode behaviour and this column
  -- deliberately cannot support it.
  code_hash     TEXT NOT NULL,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  attempts      SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  CHECK (expires_at > issued_at)
);

CREATE INDEX login_codes_live ON login_codes (user_id, expires_at) WHERE consumed_at IS NULL;

-- --------------------------------------------------------------------------
-- The ledger
-- --------------------------------------------------------------------------
CREATE TABLE journal_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id        UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  -- The application's own reference, kept so a restored snapshot and the
  -- database agree on entry identity.
  entry_ref         TEXT NOT NULL,
  entry_date        DATE NOT NULL,
  narration         TEXT NOT NULL CHECK (length(btrim(narration)) > 0),
  source_kind       TEXT NOT NULL,
  source_ref        TEXT,
  -- The duplicate guard, at the database. Two concurrent requests for the same
  -- business event cannot both succeed: the second violates this and its
  -- transaction rolls back whole.
  idempotency_key   TEXT NOT NULL,
  reversal_of       UUID REFERENCES journal_entries(id),
  reversed_by       UUID REFERENCES journal_entries(id),
  posted_by         UUID REFERENCES users(id),
  posted_by_label   TEXT NOT NULL,
  posted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Denormalised so the balance constraint can be deferred to statement end
  -- and checked without re-aggregating the legs.
  total_debit       BIGINT NOT NULL CHECK (total_debit > 0),
  total_credit      BIGINT NOT NULL CHECK (total_credit > 0),
  CONSTRAINT journal_entry_balances CHECK (total_debit = total_credit),
  UNIQUE (society_id, idempotency_key),
  UNIQUE (society_id, entry_ref)
);

CREATE INDEX journal_entries_by_date ON journal_entries (society_id, entry_date);
CREATE INDEX journal_entries_by_source ON journal_entries (society_id, source_kind, source_ref);

-- An entry is never deleted. A correction is a reversal, and this makes that
-- the only possibility rather than a convention.
CREATE RULE journal_entries_no_delete AS ON DELETE TO journal_entries DO INSTEAD NOTHING;

CREATE TABLE journal_postings (
  id            BIGSERIAL PRIMARY KEY,
  entry_id      UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  society_id    UUID NOT NULL,
  account_code  TEXT NOT NULL,
  debit         BIGINT NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit        BIGINT NOT NULL DEFAULT 0 CHECK (credit >= 0),
  -- Exactly one side, as in the engine. A leg carrying both is how a posting
  -- that looks balanced hides a second movement.
  CONSTRAINT posting_one_side CHECK ((debit = 0) <> (credit = 0)),
  party         TEXT,
  doc_ref       TEXT,
  memo          TEXT,
  FOREIGN KEY (society_id, account_code) REFERENCES accounts(society_id, code)
);

CREATE INDEX journal_postings_by_entry ON journal_postings (entry_id);
CREATE INDEX journal_postings_by_account ON journal_postings (society_id, account_code);
CREATE INDEX journal_postings_by_party ON journal_postings (society_id, account_code, party)
  WHERE party IS NOT NULL;
CREATE INDEX journal_postings_by_doc ON journal_postings (society_id, account_code, doc_ref)
  WHERE doc_ref IS NOT NULL;

CREATE RULE journal_postings_no_delete AS ON DELETE TO journal_postings DO INSTEAD NOTHING;

-- --------------------------------------------------------------------------
-- The billing register
-- --------------------------------------------------------------------------
CREATE TABLE billing_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id        UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  proforma_no       TEXT NOT NULL,
  tax_invoice_no    TEXT,
  flat_id           UUID NOT NULL REFERENCES flats(id) ON DELETE RESTRICT,
  period            TEXT NOT NULL,
  estimated_tax     BIGINT NOT NULL CHECK (estimated_tax >= 0),
  gross             BIGINT NOT NULL CHECK (gross > 0),
  issued_on         DATE NOT NULL,
  due_on            DATE NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('draft','approved','released','tax-invoice','cancelled')),
  approved_by       UUID REFERENCES users(id),
  approved_on       DATE,
  converted_on      DATE,
  converted_because TEXT CHECK (converted_because IN ('payment-received','due-date-reached','manual')),
  posted_entry_id   UUID REFERENCES journal_entries(id),
  cancelled_by      UUID REFERENCES users(id),
  cancelled_reason  TEXT,
  UNIQUE (society_id, proforma_no),
  UNIQUE (society_id, tax_invoice_no),
  CHECK (due_on >= issued_on),
  CHECK (approved_on IS NULL OR approved_on >= issued_on),
  CHECK (converted_on IS NULL OR converted_on >= issued_on),
  -- A document past draft must name who approved it, and a cancellation must
  -- give a reason. Both were enforced only in the application before.
  CHECK (state = 'draft' OR state = 'cancelled' OR approved_by IS NOT NULL),
  CHECK (state <> 'cancelled' OR cancelled_reason IS NOT NULL),
  CHECK (state <> 'tax-invoice' OR (tax_invoice_no IS NOT NULL AND posted_entry_id IS NOT NULL))
);

-- The duplicate-billing guard. A partial unique index, so a cancelled document
-- frees the flat and period for a replacement while a live one does not.
CREATE UNIQUE INDEX billing_documents_one_live_per_period
  ON billing_documents (society_id, flat_id, period)
  WHERE state <> 'cancelled';

CREATE TABLE billing_document_lines (
  id            BIGSERIAL PRIMARY KEY,
  document_id   UUID NOT NULL REFERENCES billing_documents(id) ON DELETE CASCADE,
  head          TEXT NOT NULL CHECK (head IN ('maintenance','sinking','festival','rental','reimbursement','other')),
  amount        BIGINT NOT NULL CHECK (amount > 0),
  taxable       BOOLEAN NOT NULL,
  position      SMALLINT NOT NULL,
  UNIQUE (document_id, position)
);

CREATE TABLE dispatch_attempts (
  id            BIGSERIAL PRIMARY KEY,
  document_id   UUID NOT NULL REFERENCES billing_documents(id) ON DELETE CASCADE,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  by_user       UUID REFERENCES users(id),
  channel       TEXT NOT NULL,
  -- False until a provider confirms. A row recording a delivery that did not
  -- happen is worse than no row: a committee acts on it.
  delivered     BOOLEAN NOT NULL DEFAULT false,
  provider_id   TEXT,
  failure       TEXT,
  note          TEXT NOT NULL
);

CREATE INDEX dispatch_attempts_undelivered
  ON dispatch_attempts (document_id) WHERE delivered = false;

-- --------------------------------------------------------------------------
-- Rates, with dates
-- --------------------------------------------------------------------------
CREATE TABLE maintenance_rates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  rate_paise_per_sqft BIGINT NOT NULL CHECK (rate_paise_per_sqft > 0),
  area_basis      TEXT NOT NULL CHECK (area_basis IN ('carpet','built-up','super-built-up')),
  effective_from  DATE NOT NULL,
  authority       TEXT NOT NULL,
  -- A rate cannot bill until someone signs it off. Null here is what makes
  -- the application refuse.
  approved_by     UUID REFERENCES users(id),
  approved_on     DATE,
  UNIQUE (society_id, effective_from)
);

-- --------------------------------------------------------------------------
-- Audit log
-- --------------------------------------------------------------------------
CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  society_id    UUID NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user    UUID REFERENCES users(id),
  actor_label   TEXT NOT NULL,
  action        TEXT NOT NULL,
  subject_table TEXT,
  subject_id    TEXT,
  -- What changed, as JSON. Append-only.
  detail        JSONB,
  request_id    TEXT
);

CREATE INDEX audit_log_by_time ON audit_log (society_id, at DESC);
CREATE INDEX audit_log_by_subject ON audit_log (society_id, subject_table, subject_id);

CREATE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;

COMMIT;
