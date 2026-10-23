# The backend

A PostgreSQL schema, an HTTP API, a job scheduler and the tests that run both
against a real database.

```sh
export PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=societybooks PGDATABASE=societybooks
export SESSION_SECRET="$(openssl rand -hex 32)"

node server/migrate.mjs            # apply pending migrations
node server/migrate.mjs status     # applied, pending, and anything that drifted
npm run server:seed                # a demo society (refuses NODE_ENV=production)
npm run server                     # the API on http://127.0.0.1:4000
npm run test:backend               # every backend check
```

## Layout

```
server/
  migrations/           001–006, applied in filename order, checksummed
  migrate.mjs           the runner
  schema.test.mjs       35 constraint tests
  schema-domain.test.mjs 66 constraint tests for migration 003
  pg.test.mjs           23 tests for the Postgres client
  documents.test.mjs    31 tests for the PDF writer and the SMTP builder
  api.test.mjs          177 HTTP tests against a live database
  frontend.test.mjs     36 tests of the browser data layer, in Chromium
  src/
    app.ts              wiring and the entry point
    config.ts           the environment, validated at startup
    pg.ts               a Postgres client over the wire protocol
    http.ts             routing, CSRF, errors, security headers
    routes.ts           the endpoints
    routesAdmin.ts      snapshot, PDFs, notes, notifications, users, flats
    snapshotView.ts     the books in the shape the client's engine takes
    auth.ts             sign-in, sessions, the principal
    rbac.ts             roles, permissions, flat-level access
    security.ts         password hashing, tokens, rate limiting, redaction
    validate.ts         schema validation for every request body
    posting.ts          double-entry posting, reusing src/accounting
    billing.ts          the billing run and document state
    reports.ts          every report, from the same postings
    pdf.ts              a PDF writer, written against the file format
    documents.ts        the tax invoice and the receipt
    settings.ts         society settings and their approval flags
    audit.ts            the audit trail
    jobs.ts             the scheduler, with retries and backoff
    seed.ts             demo data, with the chart from the engine
    providers/
      smtp.ts           an SMTP client — this one sends, given a host
      email.ts          the provider interface and the two that do not
      otp.ts            NOT CONNECTED
      bank.ts           statement parsing; no API connection
```

## What this is built on, and why

**No framework, no ORM, no validation library.** The npm registry is
unreachable from the machine this was written on (`registry.npmjs.org` returns
nothing, as does `binaries.prisma.sh`), so Express, Prisma and Zod could not be
installed — and code that cannot be run cannot be tested. Rather than write
against libraries and claim they work, the API is built on node's own modules:
a router, a JSON body reader with a size cap, a schema validator, and a
PostgreSQL client that speaks the wire protocol directly.

`prisma/schema.prisma` is in the repository as asked and carries a header
saying plainly that Prisma has never validated or generated from it. The
executable migration path is `server/migrations/*.sql`, which is applied and
tested. `prisma migrate` must not be used to create this schema: it cannot
express the deferred constraint triggers, the period lock, the control-party
rule, the delete rules or the partial unique indexes that the invariants
depend on.

**Why `psql` in the migration runner and the schema tests.** Same reason, and
it costs nothing there: what is being proved is the SQL and the ordering. The
API itself does not shell out — it uses `src/pg.ts`.

## The checks

| suite | what it covers | how to run |
| --- | --- | --- |
| 35 | schema constraints, migrations 001–002 | `node server/schema.test.mjs` |
| 66 | schema constraints, migration 003 | `node server/schema-domain.test.mjs` |
| 23 | the Postgres client: protocol, types, transactions | `npm run test:pg` |
| 9 | `prisma/schema.prisma` structure | `npm run test:prisma` |
| 31 | the PDF writer, money formatting, SMTP messages | `npm run test:documents` |
| 177 | the HTTP API, end to end | `npm run test:server` |
| 36 | the browser data layer, in Chromium | `npm run test:frontend` |

`api.test.mjs` starts a real server on an ephemeral port and drives it over
HTTP with cookies and CSRF, against a real PostgreSQL. It seeds its own society
on each run with a unique name and address space, because nothing financial can
be deleted by design — so a repeated run cannot clean up after itself and must
not collide with its own history instead.

`frontend.test.mjs` runs the compiled API client and server store in Chromium,
against the same server, behind a front door that serves the page and proxies
`/api` — one origin, because the session cookie is `SameSite=Strict` and a
cross-origin page would never send it. It covers what only a browser can: the
session cookie being unreadable to the page, the CSRF cookie being readable,
the engine rehydrating from the snapshot and agreeing with the server on what
is outstanding, and nothing being written to `localStorage` in server mode. The
React components are not in it — they need JSX and react itself, which cannot
be installed here.

## Setting it up locally

1. A PostgreSQL 16 server, and a database and role for it:

   ```sh
   createuser societybooks
   createdb -O societybooks societybooks
   ```

2. `cp .env.example .env` and fill in `SESSION_SECRET`. Nothing else is
   required for development.

3. Migrate, then seed:

   ```sh
   node server/migrate.mjs
   SEED_PASSWORD=some-local-password npm run server:seed
   ```

   The seed creates one society whose `mode` is `demo`, ten flats, their
   owners, one account per role, the chart of accounts, the six receipt heads,
   the ₹4.50 per square foot rate from the brief, and the ticket categories. It
   creates no GSTIN, no bank account number, no approved GST treatment and no
   real resident: the names are placeholders on the `.invalid` domain, so
   nothing can be emailed to a real address by accident.

4. `npm run server`, then `curl localhost:4000/api/health`.

## Deploying it

The server needs three things: a PostgreSQL it can reach, `SESSION_SECRET`, and
the migrations applied. It refuses to start without the second, and says so
rather than falling back to a default.

```sh
# 1. the schema
DATABASE_URL=... node server/migrate.mjs

# 2. the server
NODE_ENV=production \
DATABASE_URL=... \
SESSION_SECRET=... \
ALLOWED_ORIGIN=https://your-host \
SECURE_COOKIES=true \
OTP_PROVIDER=none \
node .server-build/server/src/app.js
```

What production mode refuses, deliberately: a missing or under-32-character
`SESSION_SECRET`, `SECURE_COOKIES=false`, and `OTP_PROVIDER=local-dev` — which
writes one-time codes to the log instead of sending them.

Run it behind TLS. The session cookie is `Secure`, `HttpOnly` and
`SameSite=Strict`, and CSRF is a double-submit against a second cookie the
page can read; none of that survives plain HTTP.

`Dockerfile` and `docker-compose.yml` are in the repository and **have never
been built**: the machine this was written on has a docker binary and no
reachable daemon. They are written from the project's real layout, not from a
template, but treat the first build as one that may need fixing.

## Backups, and restoring from one

A ledger that cannot be restored is not a ledger. Both of these are plain
`pg_dump`; nothing in this schema needs special handling beyond that.

```sh
# Nightly, whole cluster, custom format so it can be restored selectively.
pg_dump --format=custom --no-owner --file="societybooks-$(date +%F).dump" societybooks

# Verify the dump is readable before trusting it. A backup nobody has restored
# is a hypothesis.
pg_restore --list "societybooks-$(date +%F).dump" > /dev/null

# Restore into a fresh database, then check it.
createdb societybooks_restored
pg_restore --dbname=societybooks_restored --no-owner "societybooks-2026-10-21.dump"
PGDATABASE=societybooks_restored node server/migrate.mjs status   # expect: all applied
```

After any restore, the one check worth running is the trial balance:

```sh
PGDATABASE=societybooks_restored psql -c "
  SELECT society_id, SUM(total_debit) = SUM(total_credit) AS ties
    FROM journal_entries GROUP BY society_id;"
```

Point-in-time recovery needs WAL archiving, which is a server configuration
rather than an application one: set `archive_mode = on` and an `archive_command`
in `postgresql.conf`. Without it the most you can lose is everything since the
last dump.

Three things to know before relying on a restore:

- **Nothing financial can be deleted, so a bad import cannot be tidied away.**
  Correct it with a reversal, or restore to a point before it.
- **The migration checksums travel with the data.** A restored database whose
  `schema_migrations` disagrees with the files on disk makes the runner refuse
  to go further, which is the intended behaviour: it means the two have
  diverged and somebody has to look.
- **`SESSION_SECRET` is not in the database.** Restoring with a different one
  invalidates every session and every outstanding login code. That is usually
  what you want after a restore.

## Design notes

**Money is `BIGINT` paise.** Never `NUMERIC`, never `DOUBLE PRECISION`. The
engine works in integer paise so a trial balance compares exactly, and the
column type has to agree or the exactness is lost at the boundary.

**Multi-tenant from the first migration.** Every table carries `society_id`,
and `societies.mode` separates demo rows from production ones in the same
schema — so the separation is a column every query filters on rather than two
deployments that drift apart.

**The balance invariant is a deferred constraint trigger.** A multi-leg entry
cannot be inserted at all if each row is checked as it arrives, so
`journal_postings_balance` is `DEFERRABLE INITIALLY DEFERRED` and fires at
COMMIT. It checks that the legs balance, that they agree with the entry's
stated totals, and that there are at least two of them.

**Nothing financial can be deleted.** `journal_entries`, `journal_postings`,
`payments`, `receipt_allocations`, the registers and `audit_log` carry
`DO INSTEAD NOTHING` delete rules. A correction is a reversal, and both entries
stay.

**Posting into a closed period is refused by the database.** `check_period_open`
is a trigger on `journal_entries`, so the lock holds against anything that
reaches the table, not only against the API.

**Maker-checker is a CHECK.** `approvals` refuses a decider who is the
requester, and no role holds both `billing.run` and `billing.approve`. Two
independent mechanisms, because either alone can be misconfigured.

**A send is only recorded when a provider confirms it.** `notifications` cannot
reach state `sent` without a provider and that provider's message id;
`dispatch_attempts.delivered` defaults to false. With no provider configured
the API returns `delivered: false` and says why.

**No credential has a column.** Not for a bank, not for a tax portal, not for a
vendor's account. `bank_accounts` holds the last four digits and an IFSC, which
is all a reconciliation needs. Nothing in this system can move money.

**Idempotency reaches the database.** Every money-moving endpoint takes an
`Idempotency-Key` header and it becomes a unique constraint, so two concurrent
retries cannot both post — one commits and the other's transaction rolls back
whole. There is a test for exactly that.
