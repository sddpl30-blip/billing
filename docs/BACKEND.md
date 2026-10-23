# The backend: what is built, what is proven, what is not

> **This is the report for the backend round.** The round after it connected
> the front end to this API, added PDFs, an SMTP client, credit and debit
> notes and administration, and brought the total to 566 checks.
> `docs/PRODUCTION-READINESS.md` is the current report; this one is kept
> because its account of *why* the stack is what it is still stands.

The brief was to build a real, secure, scalable backend for SocietyBooks and
actually run the checks, rather than stop at an architecture. This is the
account of that: what exists, what the tests prove, and what is blocked or
unfinished. The last section is the part worth reading if you only read one —
nothing here is production-ready in the sense of "point it at a real society
tomorrow", and the reasons are specific.

## Three facts about the environment, up front

These shaped every decision below, so they come first rather than as a footnote.

**1. The requirements PDF never reached this session.** The Mani Vista RWA
approach note has been promised five times and has not arrived. Everything
built against those requirements comes from the gap analysis you pasted and
from the ₹4.50 per square foot figure in it. Where the brief and the PDF differ,
the PDF wins, and this will need rechecking against it.

**2. `registry.npmjs.org` and `binaries.prisma.sh` are both unreachable.**
Nothing can be installed. The named stack — Prisma, Zod, a REST framework —
cannot be used, and code written against a library that cannot run cannot be
tested. `prisma generate` and `prisma validate` have never run, here or
anywhere in this repository.

What was done instead: `prisma/schema.prisma` exists as asked, with a header
stating plainly that Prisma has never validated it and listing what Prisma
cannot express (deferred constraint triggers, the period lock, the
control-party rule, the delete rules, multi-column CHECKs, partial unique
indexes). The executable migration path is `server/migrations/*.sql`, which is
applied, checksummed and tested. The API is built on node's own modules: a
router, a JSON validator, and a PostgreSQL client that speaks the wire protocol
directly — all of which run, and all of which are tested against a real
PostgreSQL 16.

**3. The docker daemon is unreachable.** `Dockerfile` and `docker-compose.yml`
are written from the project's real layout and have never been built. Treat the
first build as one that may need fixing.

## What runs, and what proves it

Every figure below is from a run on this machine, against PostgreSQL 16.13.

| suite | checks | what it runs against |
| --- | --- | --- |
| accounting engine, unit | 73 | pure functions |
| accounting engine, integration | 59 | a worked year |
| persistence and snapshots | 34 | the store |
| browser reload | 23 | Chromium, real `localStorage` |
| schema, migrations 001–002 | 35 | a live PostgreSQL |
| schema, migrations 003–004 | 66 | a live PostgreSQL |
| the PostgreSQL client | 23 | a real server, real transactions |
| `prisma/schema.prisma` structure | 9 | the file, not Prisma |
| **the HTTP API, end to end** | **143** | **a real server on a socket, a real database** |
| | **465** | |

`npm run test:backend` runs the last five. `npm test` and `npm run test:browser`
run the first four. All 465 pass; nothing is skipped and nothing is pending.

### The API suite is not a unit test

`server/api.test.mjs` starts the server the same way `main()` does, on an
ephemeral port, and drives it over HTTP with cookies and the CSRF header
against a real database. It seeds its own society per run, with its own address
space, because nothing financial can be deleted by design — so a repeated run
cannot tidy up after itself and must instead not collide with its own history.

It covers: sign-in and session revocation, CSRF, rate limiting, role isolation
and flat-level access, the billing run and its duplicate guard, maker-checker,
approval, release, conversion, cancellation by reversal, part payments,
overpayments into advances, idempotency under concurrency, GST approval and
refusal, vendor approval/booking/payment as three separate steps, TDS
withholding and remittance, statement import and matching, reconciliation,
helpdesk lifecycle, period close and the database's refusal to post into a
closed period, the job scheduler's retries and backoff, and a final consistency
sweep that checks the trial balance, the balance sheet, the receivable against
the sum per invoice, and that every entry in the database balances.

### Mutation testing: 33 of 34 deliberate breakages caught

A suite that passes proves nothing until you break the code and watch it fail.
Each of these was introduced one at a time, the suite re-run, and the code
restored:

permission check always passes · flat access never refuses · `readableFlats`
returns every flat · CSRF check removed · unapproved GST used anyway ·
unapproved proforma invoiced · GST halves rounded instead of allocated ·
overpayment not held as advance · allocation ignores what the invoice owes ·
vendor overpaid · duplicate-billing guard removed · unapproved rate billed
from · part payment reads as unpaid · trial balance always ties · balance sheet
always balances · collection rate hardcoded · GST agreement asserted ·
everything ages into one bucket · idempotency key not required · delivery
recorded without a provider · delivery claimed by default · approval without a
recorded maker · bank match ignores the amount · reconciliation signed off with
a difference · no TDS withheld · failed job never retried · no backoff ·
dispatch runs with no provider · rate-limit subject never repeats · password
verification always succeeds · a user granted every flat · income ignores its
debit side · statement ignores credits.

**Six survived the first attempt, and every one was a real gap.** Four were
tests reading back a flag the code sets — on sound data `tiesOut`, `balances`
and `agrees` are always true, so hardcoding `true` passed everything. Those are
now pure functions (`summariseTrialBalance`, `assembleBalanceSheet`,
`registerAgreesWithLedger`) tested with figures that deliberately do not tie.
The other two had no test at all: billing from an unapproved rate, and
approving a document with no recorded maker.

**One still survives, knowingly.** Removing the application's `if (!tb.tiesOut)`
guard before closing a period changes nothing, because the ledger cannot be
made not to tie — a deferred trigger refuses an unbalanced entry — so the
branch is unreachable from a test. The database CHECK that refuses a close
whose two sides disagree *is* tested directly. The application check is
redundant belt-and-braces, and the test says so where it would otherwise look
like an oversight.

## Two bugs the tests found in my own code

Worth stating, because both would have shipped.

**Rate limiting did nothing.** `consumeRateLimit` ran inside the same
transaction as the sign-in attempt, so a failed attempt rolled the counter back
along with the refusal it was counting. An attacker would have had unlimited
tries at a password or a one-time code. The limits are now consumed on the pool,
outside the transaction, and there is a test that loops until it gets a 429.

**Sign-in was ambiguous across societies.** Migration 001 made
`(society_id, email)` unique, which is right for a member list and wrong for
sign-in: the login path is given an address and nothing else, so with a demo
society and a real one in the same database, two rows could share an address and
`LIMIT 1` would pick one arbitrarily — signing a resident into the wrong
society's data. Migration 005 makes an address identify at most one active
account across the whole database.

A third, smaller one: the TDS register was storing a basis-point rate derived
back out of `tds / gross`, which is fractional whenever the deduction was
rounded. It now stores the rate the bill was raised at.

## What is implemented

**Schema.** 49 tables across five migrations, every one carrying `society_id`,
money as `BIGINT` paise throughout. Chart of accounts, flats, owners and dated
ownership, users, roles, sessions, login codes, the journal, the billing
register with its lifecycle, dispatch attempts, effective-dated rates with
approval, the audit trail, settings, towers, the six receipt heads, credit and
debit notes, payments with per-document allocations, deposits, events, vendors
with contracts and bills and payments, the GST and TDS registers, bank accounts
with statement imports and transactions and reconciliations, virtual accounts,
the helpdesk, generated documents, notifications, resolutions and approvals,
financial periods, scheduled jobs and rate-limit buckets.

The invariants are in the database, not only in the code: the balance check is
a deferred constraint trigger, the period lock is a trigger on
`journal_entries`, maker-checker is a CHECK that the decider is not the
requester, duplicate billing is a partial unique index, one current owner per
flat per role is another, and nothing financial can be deleted.

**API.** 56 endpoints over auth, flats, settings, rates, billing, payments,
vendors, TDS, banking, reports, helpdesk, periods and jobs. Session cookies are
`HttpOnly`/`SameSite=Strict`/`Secure`, CSRF is a double-submit, every body is
validated with unknown keys rejected, every money-moving route takes an
`Idempotency-Key` that becomes a database constraint, and every write records an
audit row.

**Accounting.** The engine from the earlier phases is reused, not
reimplemented: `allocate`, `percentOf` and `areaCharge` are imported, so the
rupee arithmetic, the exact GST split and the refusal of a basis mismatch are
the same code the 132 engine checks cover. What the server adds is where the
result goes — one atomic transaction — and reading balances in SQL, which the
engine cannot do because its ledger is in memory.

**Jobs.** A scheduler claiming with `FOR UPDATE SKIP LOCKED`, a unique business
key per run, exponential backoff capped at an hour, and a failed job kept with
its last error rather than disappearing.

## What is blocked

| | why | what it would take |
| --- | --- | --- |
| Prisma, Zod, any framework | the registry is unreachable | a machine with npm; the SQL migrations stay the source of truth either way |
| `prisma generate` / `validate` | the same | run them, and expect the schema file to need corrections |
| `vite build`, and the React screens rendering | no `node_modules`; this has not run in any phase | `npm install` |
| the Docker build | no reachable daemon | a machine with docker |
| OTP and email delivery | **NOT CONNECTED.** Both adapters exist; neither has a provider. The development one writes to the log and reports `delivers: false`, which is why nothing claims a send | implement the interface against a provider's API and give it a credential |
| any banking connection | **NOT CONNECTED**, and there is deliberately no column anywhere for a credential. Statement import works from a file | a bank's API, and a decision about where its credential lives — not this database |
| GST and TDS filing | **NOT CONNECTED.** The reports are what a return would be built from, cross-checked against the ledger. `filed` is always false | a GSTN/TRACES integration, and registrations this system does not have |
| the Mani Vista requirements | the PDF has not arrived | the PDF |

## What is incomplete

Honest list, in the order I would do them.

1. **The front end still talks to `localStorage`.** This is the big one. The
   backend is complete and tested and *nothing in the React app calls it yet*.
   Phase 3 made the browser store durable and correct; replacing it with
   `fetch` against these endpoints is the next task, and until it happens the
   screens and the server are two separate systems.
2. **No PDF generation.** `generated_documents` stores a render payload so a
   reprint is byte-identical, and nothing writes one yet. An invoice PDF needs
   a library, which needs npm.
3. **No user administration endpoints.** Users and roles are created by the
   seed and by SQL. `user.manage` exists as a permission with nothing behind it.
4. **Credit and debit notes** have a table, a maker-checker CHECK and no
   endpoint.
5. **Events, deposits, virtual accounts and vendor contracts** have schemas and
   no endpoints. They were in the brief's list of domains; the money paths came
   first.
6. **Attachments** have a table and no upload route. Deciding where bytes live
   (object storage, not the database) comes before writing it.
7. **No PITR.** Backup and restore is documented `pg_dump`/`pg_restore` with a
   verification step; WAL archiving is a server setting nobody has set.
8. **Reports are JSON only.** No CSV or XLSX export.
9. **One concurrency case is untested:** two different people approving the same
   document at the same instant. The `approvals` UPDATE makes it safe, and
   there is no test for it.

## What production would still need

Beyond the incomplete list: TLS termination, a real secret store for
`SESSION_SECRET` rather than a file, log shipping, an alert on a job in state
`failed`, a restore actually rehearsed against a copy of real data, and
somebody's decision on the GST treatment recorded as an approval by the person
who is accountable for it. The system refuses to charge a tax nobody has signed
off, which means that decision cannot be skipped — but it also means billing
does nothing until it is made.
