# Production readiness

> **Superseded in part by [`AUDIT-2026-10.md`](AUDIT-2026-10.md)** — the frontend
> build and the Vercel function have since been fixed and verified, the Docker
> images fixed (CI builds them), and CI now runs every suite. Read that first.


What is built, what has been executed, and what is genuinely blocked. Written
after the run, not before: every figure below came from a command in this
repository on this machine, and where something has not been run it says so
instead of reading as tested.

**The short answer.** The backend and the front end's data layer are built,
wired together and tested against a real PostgreSQL and a real browser. Two
things stand between this and a society's real books, and neither is code:
nobody has run `npm install` and `vite build` here, so the React screens
themselves have never rendered; and the association's own decisions — its GST
treatment, its rate resolution, its email provider — have to be recorded by the
people accountable for them.

## The checks, as run

```
accounting unit          ALL 73 CHECKS PASSED
accounting integration   ALL 59 INTEGRATION CHECKS PASSED
persistence              ALL 34 PERSISTENCE CHECKS PASSED
browser store            ALL 23 BROWSER CHECKS PASSED      (Chromium, real reload)
prisma structure         ALL 9 PRISMA SCHEMA CHECKS PASSED  (structural, not prisma validate)
schema 001-002           ALL 35 DATABASE CHECKS PASSED      (live PostgreSQL 16.13)
schema 003-004           ALL 66 DOMAIN SCHEMA CHECKS PASSED (live PostgreSQL)
pg client                ALL 23 POSTGRES CLIENT CHECKS PASSED
documents                31 passed, 0 failed                (PDF writer, SMTP builder)
api                      177 passed, 0 failed               (real HTTP, real database)
frontend in chromium     36 passed, 0 failed                (real browser, real server)
                         ---
                         566 checks, 0 failures
```

Four typechecks, all clean: the front end against the declarations in `types/`
(`tsconfig.check.json`), the server, the engine, and the browser build.

`npm run test:all` runs the lot. It needs a PostgreSQL to point at and
Playwright for the two browser suites.

### Mutation testing

A suite that passes proves nothing until the code is broken on purpose. Twenty
deliberate breakages this round, introduced one at a time with the suite re-run
and the code restored:

Caught (18): the PDF's parentheses no longer escaped · western thousands
grouping instead of Indian · a placeholder GSTIN printed on a document · demo
data not marked on its face · every account seeing the whole society · a
resident given every entry · a resident given every flat's documents · credit
notes not netted off the GST summary · a note allowed against a proforma · a
note carrying an unapproved tax · a reprint re-deriving instead of reusing the
stored payload · one account holding both maker and checker · deactivation
leaving sessions alive · a flat accepted with an area and no basis · a new
owner added without ending the old tenure · the client no longer sending the
CSRF token · entries the engine refuses being swallowed · every invoice mapping
to Paid.

Three of those survived a first attempt and each was a real gap: the session
revocation was masked by the account also being inactive, the store's
"records refused" path had nothing to refuse it, and the legacy status mapping
was checked against the set of allowed values rather than against the engine's
own answer. All three now have tests that fail when the code is broken.

Not caught (2), and both are the same program: measuring the PDF's
cross-reference offsets and stream lengths in characters rather than bytes.
Everything in the file is written `latin1`, where one character is one byte by
definition, so `Buffer.byteLength(s, 'latin1')` and `s.length` cannot differ.
The byte form is kept because it stays correct if the encoding ever changes.

## What was built this round

**The front end now runs on the server.** The React screens read a store that
is either the API or the local demonstration, and they cannot tell which. The
server's snapshot arrives in the shape the accounting engine already
understands, the browser rehydrates the same `Ledger` and `BillingRegister` the
screens have always rendered, and every figure in them came from PostgreSQL.
Writes go to the API and the store refetches. There is no `localStorage` on the
server path, and a test in a real browser asserts that nothing was written
there.

**The identity is real.** `B-204` is gone from every expression that decided
what a resident sees. The flat comes from `/api/auth/me`, which reads the owner
record the account is linked to, so two members see two different sets of
bills. An account with no flat linked gets an empty list and the screen says
so — there is no fallback to somebody else's flat. Which of the three views
opens is decided by the roles the server granted, and the demo's PIN modal is
demo-only.

**One chart of accounts.** The seed takes it from the engine rather than
retyping it. They had already drifted: the engine has 5000 as water supply and
the seed had it as housekeeping, so a vendor bill booked to "housekeeping"
through the API would have shown as water in every report, and an entry
restored into the browser's ledger would have been refused for naming an
account the engine does not know.

**PDFs.** A tax invoice and a receipt, rendered by a PDF writer in this
repository — no library, because none can be installed here, so it emits the
file format directly with the base-14 fonts every reader has. The structural
test reads the cross-reference table back and checks that every offset points
at the object it claims. A document is rendered once from a payload that is
then stored, so a reprint is byte-identical; an invoice is a legal document and
regenerating it from live data would quietly reissue it with today's figures.

**Email that sends.** An SMTP client written against the protocol: EHLO,
STARTTLS, AUTH PLAIN or LOGIN, MAIL FROM, RCPT TO, DATA. It refuses to send
over a connection that never became encrypted unless that is turned off
deliberately. Quoted-printable encoding, soft line breaks that never split an
escape, dot-stuffing — all tested, because an unescaped line beginning with a
dot truncates a message at that point and nobody notices.

**Credit and debit notes, with the GST register corrected.** Migration 003 gave
the register `CHECK (cgst >= 0)`, which is right for an invoice and wrong for
the register: the first credit note was refused by it. Storing it as a negative
invoice would have been the smaller change and the wrong one — a return reports
a note in its own table with positive figures — so migration 006 records which
kind of document each row is and the summary nets them.

**Administration.** Users, roles, deactivation, flats and owners. An account
cannot be given manager together with treasurer or secretary, refused when the
roles are handed out rather than only when they are used. A change of owner
ends the previous tenure the day before the new one starts and leaves the
arrears against the flat.

**A typecheck that runs here.** `types/` holds hand-written declarations for
react, react-dom, lucide-react and recharts, and `tsconfig.check.json` uses
them, so "it compiles" is something someone can verify in this environment
rather than a claim. They are not a substitute for the real types, and the
README in that directory says so.

## The system by the numbers

| | |
| --- | --- |
| migrations | 6, applied and checksummed |
| tables | 49 |
| endpoints | 69 |
| server source | ~11,000 lines of TypeScript |
| front-end data layer | ~1,500 lines added |
| tests | ~5,600 lines, 566 checks |

## Genuinely blocked — credentials, approvals or a machine

Each of these is a decision or an account somebody has to provide. None is
waiting on code in this repository.

| blocked on | what is written | what unblocks it |
| --- | --- | --- |
| **npm registry** (`registry.npmjs.org` unreachable here) | the whole app, with four typechecks passing against hand-written declarations | `npm install`, then `npm run build` and `tsc --noEmit` against the real types. **The React screens have never rendered. This is the largest untested surface in the project.** |
| **Prisma** (`binaries.prisma.sh` unreachable) | `prisma/schema.prisma`, 48 models, with a header saying Prisma has never validated it | `prisma validate` and `prisma generate`. Expect corrections. The SQL migrations stay the source of truth — Prisma cannot express the deferred triggers, the period lock, the control-party rule, the delete rules or the partial unique indexes the invariants depend on. |
| **Docker daemon** (no reachable daemon here) | `Dockerfile`, `Dockerfile.web`, `docker-compose.yml`, `nginx.conf` | `docker compose up --build` on a machine with a daemon. Written from the project's real layout; expect the first build to need a fix. |
| **SMTP credentials** | a working SMTP client, tested on message construction, encoding and configuration | `SMTP_HOST`, `SMTP_FROM` and a password in a secret store. The protocol conversation itself has never run against a real server — only its message building is tested. |
| **An SMS/OTP provider** | the `OtpProvider` interface and two adapters that deliver nothing and say so | implementing the interface against a provider's API. Email sign-in over SMTP covers the same ground and is implemented; this is for SMS. |
| **A banking connection** | CSV and MT940 statement import, matching, reconciliation | a bank's API, and a decision about where its credential lives — not in this database, which has no column for one. |
| **GST and TDS filing** | the registers, and summaries cross-checked against the ledger | a GSTN/TRACES integration, and registrations this association has not recorded. `filed` is always false. |
| **The society's own GST treatment** | the setting, the approval flag, and a billing path that refuses to charge a tax nobody has signed off | the person accountable recording the sign-off. Until then billing runs and raises nothing taxable — deliberately. |
| **The rate resolution** | effective-dated rates with an approval flag, and ₹4.50/sq ft recorded as demonstration data | the committee's actual resolution, recorded and approved. A billing run refuses an unapproved rate. |
| **The requirements PDF** | everything built against the pasted gap analysis | the Mani Vista approach note. It has not reached this session — this is the sixth time — so anything taken from it needs rechecking against the document. |

## Not blocked, and not done

Work that could be done here and was not, in the order I would take it.

1. **The React screens have no tests of their own.** The data layer underneath
   them is covered in a real browser; the components are not. Playwright
   against a built app is the right next move, and it needs `npm install`.
2. **Vendor bill rejection has no endpoint.** The store says so plainly rather
   than pretending; the schema has the state and the reason column.
3. **Events, fixed deposits, virtual accounts and vendor contracts** have
   schemas and no endpoints.
4. **Attachments** have a table and no upload route. Where the bytes live —
   object storage, not the database — is a decision to make first.
5. **Reports are JSON only.** No CSV or XLSX export.
6. **No alerting.** A job in state `failed` is visible at `/api/jobs` and
   nothing shouts about it.
7. **No point-in-time recovery.** Backup and restore is documented
   `pg_dump`/`pg_restore` with a verification step; WAL archiving is a server
   setting nobody has set.
8. **One concurrency case is untested:** two people approving the same document
   at the same instant. The `approvals` UPDATE makes it safe and there is no
   test for it.

## What production still needs from whoever runs it

TLS in front of the API. `SESSION_SECRET` from a secret store, not a file. The
database password likewise. Log shipping. An alert on a failed job. A restore
rehearsed against a copy of real data before it is needed. And the three
decisions above — the tax treatment, the rate, the provider — recorded by the
people who are accountable for them.

The system is built so that none of those can be skipped quietly: it refuses to
charge an unapproved tax, refuses to bill from an unapproved rate, refuses to
start in production with a weak secret or a logging mail provider, and refuses
to record a delivery that no provider confirmed.

---

# Addendum: connecting to Neon

Added after the round above, when the target database became a Neon project.
The figures in this section were measured on this machine; the one thing that
has **not** happened is a connection to your Neon project, because no
credentials have reached this repository.

## What was in the way

Two things in this project could not have talked to Neon at all, whatever the
connection string said:

| | |
| --- | --- |
| **No TLS in the PostgreSQL client** | Neon refuses an unencrypted connection. The client now negotiates TLS with libpq's `sslmode` levels, and refuses to continue when `require` or `verify-full` cannot be satisfied — before the password leaves the process. |
| **No SCRAM-SHA-256** | Neon authenticates with it; the client said so in an error and gave up. It now implements SCRAM-SHA-256 and SCRAM-SHA-256-PLUS, and verifies the server's half of the proof — without that, something in the middle that cannot check your password can still claim the authentication worked. |

Verified against PostgreSQL 16.13 configured the way a hosted database is —
`ssl = on`, `password_encryption = scram-sha-256`, and a `pg_hba.conf` that
rejects unencrypted connections:

```
encrypted            true
cipher               TLS_AES_256_GCM_SHA384 (TLSv1.3)
authMechanism        SCRAM-SHA-256-PLUS
serverVersion        PostgreSQL 16.13
```

And the suites, re-run over that connection rather than over the local socket:

```
connection strings + TLS   18 passed, 0 failed
schema 001-002             ALL 35 DATABASE CHECKS PASSED
schema 003-006             ALL 66 DOMAIN SCHEMA CHECKS PASSED
pg client                  ALL 23 POSTGRES CLIENT CHECKS PASSED
api                        177 passed, 0 failed
frontend in chromium       36 passed, 0 failed
```

A fresh database was also created from scratch over that connection — all six
migrations applied by `node server/migrate.mjs` — so "create the schema"
is a thing that has been done here, not just described.

One protocol bug was found by these tests and fixed: with channel binding
turned off against a server that offers it, the client sent the gs2 header
`y,,` ("I support binding and you did not offer it"), which PostgreSQL
correctly rejects as a downgrade attempt. The honest header there is `n,,`.

## What is new

- **`npm run db:check`** — connects with both URLs and reports the server
  version, whether the connection is encrypted and with what cipher, which
  SCRAM mechanism was used, the database and user, and the applied migrations.
  No password, no connection string. It warns if `DIRECT_URL` is missing or if
  the two URLs look the wrong way round.
- **`DIRECT_URL`** — used by the migration runner and the schema suites. A
  migration takes session-level locks a pooler does not hold.
- **`GET /api/system/database`** — the same report, behind `report.read`.
  `/api/health` gained only `database.encrypted`: it is unauthenticated, and an
  unauthenticated endpoint should not name the database server.
- **A `.env` loader** — no dependency, and an already-set variable wins over
  the file, so a stray `.env` on a server cannot override what systemd set.
- **A verified Prisma baseline** — `prisma/migrations/0_init/migration.sql`,
  generated by `scripts/build-prisma-baseline.mjs`. `--verify` applies it to
  one empty database, runs the migration runner against another, dumps both
  schemas and compares: they match exactly. It ends by recording the SQL
  runner's own rows, so a database baselined through Prisma is consistent with
  both tools rather than with one.
- **Deployment for a VPS** — `deploy/` has a hardened systemd unit, the
  environment file it reads (root-owned, group-readable), and an nginx site
  with TLS. None of it has been run: no host has been named.
- **A static check that the front end holds no database credential** — part of
  the connection suite, scanning `src/`, `index.html` and the built browser
  modules for a connection string, `DATABASE_URL`, `SESSION_SECRET`, an SMTP
  password or a `.neon.tech` hostname, and asserting that the only environment
  the front end reads is `VITE_`-prefixed.

## Prisma, precisely

There is no Prisma version to report. `prisma` and `@prisma/client` are not
dependencies, nothing is installed, and `prisma/schema.prisma` has never been
through `prisma validate`. There were also no Prisma migrations: the directory
did not exist. The migration path is the SQL in `server/migrations/`, and it
should stay that way — Prisma cannot express the deferred constraint triggers,
the period lock, the control-party rule, the `DO INSTEAD NOTHING` delete rules
or the partial unique indexes the books' invariants depend on, so a schema
`prisma migrate dev` created would be missing all of them. Use `prisma db
pull` and `prisma generate` for a typed client over the schema the SQL
migrations build.

## The remaining blockers, for Neon specifically

1. **Your two connection strings.** Nothing has connected to your project.
   `docs/NEON.md` says exactly which box in the Neon console each comes from
   and which file they go in. Until they are set, `npm run db:check` exits 2
   and says there is nowhere to connect.
2. **`npm install`, for Prisma.** The baseline and the schema file are ready;
   `prisma migrate resolve --applied 0_init`, `db pull` and `generate` need the
   package, and the npm registry is unreachable from here.
3. **Which host you deploy on.** The VPS files assume Debian or Ubuntu with
   systemd and nginx. If it is Render, Railway, Fly or a cPanel host, the
   specifics change — tell me which and I will write them.
4. **Everything in the main report above still stands**: the React screens have
   never been rendered by Vite here, Docker has never built, and the society's
   GST treatment, rate resolution and email provider are decisions for the
   people accountable for them.
