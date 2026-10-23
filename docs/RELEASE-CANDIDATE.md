# SocietyBooks — release candidate

Produced 22 October 2026. This is the single report for the final production
setup: what passed, what failed, and what is blocked on something only you can
supply. Every number below is from a command run on this machine, in this
session. Where something could not be run, it says so and says why, rather
than being reported as a pass.

Earlier rounds are documented in `docs/PRODUCTION-READINESS.md` (the backend),
`docs/NEON.md` (the database) and `docs/DEPLOYMENT.md` (hosting). This report
does not repeat them; it states the current state of the candidate.

## The verdict

The code is a complete, tested release candidate. 645 automated checks pass,
including 185 over a real PostgreSQL through the real HTTP layer, 36 in a real
Chromium against a real server, and a backup that was restored and audited.
Ten bugs were found and fixed in this round, three of them the kind that
quietly corrupts books — concurrent receipt numbering, a cancelled tax invoice
left in the GST register, and a back-dated bill charged at today's rate.

What is not done is not code. Six things are blocked on credentials, an
account, or a working package registry, and no amount of further work here
moves them. They are listed in **BLOCKED**, in the order I would do them.

Nothing in this round has been deployed, pushed, or pointed at a production
database. The changes are committed to the development branch and are waiting
for your approval.

---

## PASSED

### Automated checks — 645, all passing

| Suite | Checks | What it runs against |
|---|---|---|
| `test:accounting` | 73 | the double-entry engine, in isolation |
| `test:integration` | 59 | the engine driven through a full society's year |
| `test:persistence` | 34 | the engine's state across save and reload |
| `test:browser` | 23 | real Chromium, real reload, real localStorage |
| `test:prisma` | 9 | the Prisma schema against the migrations (structural) |
| `test:connection` | 12 (+1 skipped) | connection strings, pooled and direct |
| `schema.test` | 35 | PostgreSQL — constraints, triggers, deletions refused |
| `schema-domain.test` | 66 | PostgreSQL — the domain's own rules |
| `test:pg` | 23 | the PostgreSQL client against a live server |
| `test:documents` | 31 | PDF bytes and message composition |
| `test:security` | 22 | passwords, tokens, cookies, what reaches a log |
| `test:smtp` | 13 | a real SMTP dialogue over a loopback server |
| `test:wiring` | 7 | every path the app calls is a route the server serves |
| `api.test` | 185 | the HTTP API over PostgreSQL, end to end |
| `test:frontend` | 36 | Playwright: the app's own client code in a browser |
| `db:verify-backup` | 17 | a dump, restored, and audited in the copy |

Run them with `npm run test:all` (everything but the backup rehearsal) and
`npm run db:verify-backup`. The one skipped check needs a second PostgreSQL
version to compare against.

### 1. The database connection — verified, against a TLS + SCRAM server

`npm run db:check` reports, from an actual connection rather than from
configuration:

```
DATABASE_URL (application queries)
  connected
    host 127.0.0.1    port 55432    database societybooks    user sb_app
    passwordConfigured true    sslMode require    channelBinding prefer
    encrypted true
    cipher TLS_AES_256_GCM_SHA384 (TLSv1.3)
    authMechanism SCRAM-SHA-256-PLUS
    serverVersion PostgreSQL 16.13    serverSslEnabled on
    migrations 001 … 006, all applied
```

This is **not** Neon — no Neon credentials exist in this environment (see
BLOCKED #1). It is a local PostgreSQL deliberately reconfigured to behave the
way Neon does: TLS required, plaintext refused, SCRAM-SHA-256 password
authentication with channel binding. That is the whole of what the client has
to get right to talk to Neon, and all of it is exercised:

* TLS negotiated over the PostgreSQL SSLRequest handshake, TLS 1.3.
* SCRAM-SHA-256 **and** SCRAM-SHA-256-PLUS, including the server-signature
  check and the `tls-server-end-point` binding.
* The three failure modes, each producing the right error rather than a
  silent fallback: a wrong password, plaintext refused by the server, and a
  certificate that does not verify under `sslmode=verify-full`.

### 2. Migrations — applied, and verified on an empty database

A fresh database (`rc_fresh`) was created and migrated from nothing:

```
applying 001_initial.sql ... ok      applying 004_fix_allocation_guard.sql ... ok
applying 002_balance_guard.sql ... ok applying 005_login_identity.sql ... ok
applying 003_domain.sql ... ok        applying 006_gst_register_notes.sql ... ok
Applied 6 migration(s).
```

`npm run db:verify` then re-reads every applied migration and compares its
checksum against the file, so a migration edited after being applied is
reported rather than ignored.

The Prisma baseline was rebuilt (`npm run db:baseline`) and **proved
equivalent**: the baseline was applied to one empty database, the migration
runner to another, and `pg_dump --schema-only` of the two compared. The only
difference is pg_dump's own random `\restrict` token. The two paths produce
the same schema.

### 3. Frontend to backend — every connection, two ways

* 36 Playwright checks run the app's own `src/api` and `src/store` code inside
  Chromium against the real server, for two roles: sign-in, the CSRF
  double-submit, a read, a write, the engine rehydrated from
  `/api/books/snapshot` and tied out against the server's own numbers, a
  payment that reaches the database and survives a refresh, a replayed
  idempotency key refused *in the browser*, a PDF that is really a PDF, and
  sign-out ending the session. One check asserts **nothing** is written to
  localStorage in server mode.
* The new `test:wiring` suite closes the gap the browser tests leave: every
  `/api/...` path anywhere in `src/` is matched against the server's route
  table, including the ones no test clicks (document PDFs, TDS remittance,
  vendor-bill payment). It also fails if a route is declared and never
  mounted, if two routes collide, if any client URL is plain `http`, or if a
  connection string or `SMTP_PASSWORD` is ever referenced in client code.

### 4. Bugs fixed in this round — ten, with a test each

Each of these now has a test that fails when the fix is removed (see
*Mutation testing* below).

1. **Concurrent numbering (payments, receipts, invoices, tickets).** Document
   numbers came from `MAX(...) + 1` under READ COMMITTED. Measured: of eight
   simultaneous payments for different flats, **one succeeded and seven were
   refused**. Series are now serialised with transaction-scoped advisory
   locks (`server/src/series.ts`), which keeps numbering gapless — a sequence
   would leave holes, and a gap in a receipt series is a question from an
   auditor. Re-measured: 8 of 8, with eight distinct consecutive numbers;
   also 6 of 6 tickets and 6 of 6 concurrent invoice conversions.
2. **A cancelled tax invoice stayed in the GST register.** Cancellation
   reversed the ledger entry but left the GST register untouched, so the
   register and the output-tax accounts disagreed by exactly that invoice's
   tax. Found by the backup sweep, not by a test: 55 societies each off by
   46,575 paise. Cancellation now also raises a credit note in the register,
   which is what GST actually requires.
3. **Back-dated billing charged today's rate.** Billing July in September,
   with a new rate approved from August, charged August's rate. The rate is
   now the one in force during the month being billed.
4. **Logs were over-redacted.** Substring matching turned `secureCookies`,
   `secretKeyLength` and `otpProvider` into `[redacted]`, so the one line an
   operator reads at startup told them nothing.
5. **Logs were also under-redacted.** `apiKey` and `privateKey` were not
   caught, because splitting camelCase gives `api` + `key` and `key` cannot
   be a marker on its own. Found by the new security suite.
6. **A cleared session cookie was not `HttpOnly`.**
7. **Cookie values were not percent-decoded** on the server while the client
   decoded them — the two sides disagreed about any value with a reserved
   character in it.
8. **An empty `DIRECT_URL` was taken literally.** `DIRECT_URL=` — which is
   what a `.env` copied from the example holds — meant "configured, and
   empty": no URL reached psql, and a migration would have run against
   whatever the local `PG*` variables pointed at, reporting success. Fixed in
   the client, the migration runner and the backup script.
9. **The backup rehearsal crashed on a unix-socket URL** before reporting
   anything, because `new URL` refuses an empty host.
10. **The SMTP client sent an IP address as the TLS server name**, which
    RFC 6066 forbids and Node will stop accepting.

### 5. SMTP and OTP — the adapter is real, and now proven

The SMTP client is written here (no package registry — see BLOCKED #2), and
until this round only its message composition was tested. It now holds a full
SMTP dialogue against a loopback server, every byte real protocol: the
greeting, EHLO and its multi-line extension list, STARTTLS and the second
EHLO, `AUTH LOGIN` and `AUTH PLAIN`, the envelope, DATA and the terminating
dot, and the server's queue id kept as the evidence of delivery. Also proven:
a dot alone on a line in the body does not end the message early; a refused
recipient throws with the server's own 550; `SMTP_REQUIRE_TLS` refuses to send
over a plaintext server and does not even start the envelope; implicit TLS on
port 465 works and does not then send STARTTLS; and a certificate that does
not verify stops the send instead of continuing in the clear.

No SMTP or OTP credentials exist in this environment. The configuration
refuses to pretend otherwise: in production, `EMAIL_PROVIDER` and
`OTP_PROVIDER` default to `none`, `EMAIL_PROVIDER=smtp` without `SMTP_HOST` is
a startup error, and `local-dev` (which writes codes and messages to the log)
logs a warning saying exactly that. See BLOCKED #3.

### 6. Builds

* **Backend, production build: PASSED.** `npm run server:build` compiles the
  server with no errors.
* **Whole project, typecheck: PASSED.** `tsc -p tsconfig.check.json` — server,
  engine, React app, store and API client — exits 0.
* **Frontend, production build: BLOCKED.** See BLOCKED #2.

### 7. Backups, permissions, data security, reconciliation

* **Backup: rehearsed, not assumed.** `npm run db:verify-backup` takes a real
  `pg_dump` custom-format archive, lists it with `pg_restore`, restores it
  into a fresh database, and then runs 17 checks **on the copy**: row counts
  match, every entry balances and agrees with its totals, no entry is missing
  its legs, the trial balance ties per society, receipts equal their
  allocations, the receivable agrees per document, the GST register agrees
  with the output-tax accounts, no flat has two live documents for a period,
  one current owner per flat and role, vendor bills net to their payable,
  nothing claims a delivery without provider evidence, the constraints and
  triggers came across, and a journal entry still cannot be deleted in the
  copy. All 17 pass.
* **Role permissions.** Enforced in the API and again in the database.
  Covered by the API suite: an unauthenticated read is 401; a write with no
  session, no CSRF header or the wrong CSRF token is refused; a resident can
  read their own flat and not another, sees only their own flat in a listing
  and only their own ageing, and can raise a ticket on their own flat and not
  somebody else's; a manager sees the whole society but cannot read the audit
  trail, while an auditor can read it and holds no write permission at all.
  Maker-checker: no role holds both `billing.run` and `billing.approve`, a
  manager cannot approve a bill they could have raised, the person who
  entered a vendor bill cannot approve it, and the database enforces
  `decided_by <> requested_by` independently of the roles.
* **Data security.** 22 checks: scrypt password hashing (format, cost ≥ 16384,
  per-password salt, malformed hashes refused rather than throwing), session
  tokens random and stored only as a keyed hash, login subjects hashed so the
  address is not in the rate-limit table, the session cookie `HttpOnly` +
  `SameSite=Strict` + `Secure`, the CSRF cookie readable by design, constant-
  time CSRF comparison, and redaction of everything secret-shaped in a log
  line while leaving an operator's configuration legible.
* **Financial reconciliation.** Bank import refuses the same file twice and
  refuses a match whose amount disagrees; a reconciliation with a difference
  cannot be signed off; a period cannot be closed over a ledger that does not
  tie, and once closed the database refuses a posting into it; TDS is
  withheld at the stored rate and cannot be remitted twice.

### 8. Mutation testing — eight breakages, eight caught

Every piece of new code in this round was broken on purpose, one change at a
time, with the suite re-run and the code restored:

| Breakage | Result |
|---|---|
| the series lock is not taken | 4 checks fail |
| the credit note never reaches the GST register | 3 fail |
| billing uses today's rate, not the month's | 1 fails |
| a cleared cookie is not `HttpOnly` | 1 fails |
| a cookie value is not percent-decoded | 1 fails |
| joined markers (`apiKey`) stop being sensitive | 2 fail |
| configuration about a secret is redacted again | 1 fails |
| an empty `DIRECT_URL` is taken literally | 1 fails |

Baseline before and after: 185 / 22 / 12, all passing. Nothing survived.

---

## FAILED

**One, and it is data rather than code.** Run against the long-lived local
test database — which holds rows written by dozens of test runs over several
days, including runs from before bug #2 above was fixed — the backup sweep
reports two failures:

```
FAIL the receivable equals what is outstanding per document
     receivable postings with no document reference: expected 0, got 1
FAIL the GST register agrees with the output-tax accounts
     societies where the register and the ledger disagree: expected 0, got 56
```

Both are residue, and both are accounted for:

* the 56 disagreements are the cancelled-invoice bug, in rows written before
  the fix. Nothing repairs historical rows except a correcting entry, and
  there is no production data here to correct.
* the one posting with no document reference comes from a deliberately broken
  build during an earlier mutation run (mutant M11, the duplicate-billing
  guard). Its narration, amount and reason match that test case exactly.

Run against a database whose rows were all written by the fixed code — a
fresh database, migrated from nothing, then driven by the full API suite —
the same sweep reports **17 passed, 0 failed**. That is the evidence that the
fix works end to end, and it is also the reason this is listed as failed
rather than quietly re-run: a sweep that finds old damage is the sweep doing
its job.

Nothing else failed. No suite has a failing check, and no check is skipped
except the one noted above, which needs a second PostgreSQL version.

---

## BLOCKED

These need something from you. Each says exactly what, and where it goes.

### 1. Neon credentials — nothing to connect to

No Neon connection string exists in this environment, and I will not invent
one. The code is finished and proven against a server configured to behave
like Neon (see PASSED #1); what is missing is the URL.

From the Neon console, **Connection Details**, take both strings:

```
# .env, or your host's environment settings — never in the repository
DATABASE_URL="postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/DB?sslmode=require"
DIRECT_URL="postgresql://USER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/DB?sslmode=require"
```

The pooled one (`-pooler`) is for the application; the direct one is for
migrations, because a pooler does not hold the session-level locks a migration
takes. `npm run db:check` tells you whether you have them the right way round
— it recognises a pooled hostname and says so. `.env` is already in
`.gitignore`, and `.env.example` lists every variable with no values in it.

Then, in order: `npm run db:check` → `npm run db:migrate` → `npm run db:verify`
→ `npm run db:check` again. Full walkthrough in `docs/NEON.md`.

### 2. No package registry — three things cannot run here

`registry.npmjs.org` and `binaries.prisma.sh` both return `000` from this
machine, and the Docker daemon is unreachable. So:

* **`vite build` cannot run.** `npm run build` ends in `sh: 1: vite: not
  found`; there is no `node_modules` and nothing to install it from. The app's
  TypeScript is fully typechecked (`tsc -p tsconfig.check.json`, 0 errors) and
  its own client code is exercised in a real browser, so this is a packaging
  step rather than an unknown. It also already runs where it matters: the
  frontend source is **byte-for-byte unchanged in this round**, and the last
  Vercel build of exactly this frontend succeeded. Run `npm install && npm run
  build` on any machine with a registry — or let Vercel do it, which it
  already does.
* **The Prisma CLI cannot run.** `prisma migrate` and `prisma generate` need
  the engine binaries. The Prisma schema is checked structurally against the
  migrations (9 checks) and the baseline is proved equivalent by schema diff,
  but `prisma validate` itself has not been run. The SQL migration runner
  (`npm run db:migrate`) does not need Prisma and is what applied all six
  migrations above.
* **Docker cannot be built or run here.** `Dockerfile.web`, `nginx.conf` and
  the compose setup are written and reviewed but unbuilt.

### 3. SMTP and OTP credentials — nothing is being sent

No mail or SMS provider credentials exist here, so no invoice, receipt or
one-time code has been sent to a real address, and the system is configured
not to claim otherwise. **This is the one blocker that stops members from
using the system**, because sign-in by one-time code needs a way to deliver
the code.

For email, set in your host's environment:

```
EMAIL_PROVIDER=smtp
SMTP_HOST=            # e.g. smtp.yourprovider.com
SMTP_PORT=587         # 465 for implicit TLS
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=            # the address members will see
SMTP_FROM_NAME=       # the society's name
SMTP_REQUIRE_TLS=true # leave this on
```

For one-time codes there is no SMS provider adapter yet — only email delivery
and the development provider that writes codes to the log. If codes should go
by SMS, name the provider (MSG91, Twilio, Gupshup) and I will write that
adapter; it is a day's work against their HTTP API, and it needs their
credentials to test.

### 4. API hosting — not named

The frontend has a home: Vercel, at `govind-flax.vercel.app/society/`, built
by `build_site.sh`, and it works today in demonstration mode. The **API** has
nowhere to live yet. You have not told me what you have, so I have not
assumed.

Written and ready, in `deploy/`: a systemd unit, an environment file example,
an nginx site with TLS and the proxy headers the server expects, and a README
with the sequence. It expects a Linux host with Node 22, a hostname and a
certificate. Tell me the host — a VPS, Railway, Render, Fly, a container on
your existing server — and I will finish the specifics for it.

Note that `VITE_DATA_SOURCE=server` and `VITE_API_BASE` must point at that
API's URL for the deployed frontend to leave demonstration mode. Until then
the Vercel site keeps showing demonstration data, which is the correct
behaviour and is labelled as such on screen.

### 5. The society's own registrations and real data

Not invented, by your instruction, and all of it a startup error or a visible
warning rather than a default:

* **GSTIN** — the society's own number, if it is registered. No placeholder is
  printed on any document; a document refuses to carry one.
* **TAN** and the TDS rates you actually deduct at.
* **Bank account** details for the receipt footer and reconciliation.
* **The real register**: flats, areas, owners, tenants, opening balances. The
  importer exists; the data has to come from the society's records.

Until these are in, every demonstration figure on screen is marked as
demonstration data.

### 6. My approval boundary

Nothing has been deployed, no code has been pushed, no production data has
been touched, and no payment has been executed. This round's work is committed
to `claude/project-slug-deploy-wjvdis` and is waiting for you to say push.

---

## The ten tasks, one by one

| # | Task | State |
|---|---|---|
| 1 | Connect and verify the Neon database | **BLOCKED** on credentials (#1). Verified against a TLS + SCRAM PostgreSQL that behaves as Neon does; the client path is proven. |
| 2 | Run migrations safely, verify the schema | **PASSED** — six migrations applied to an empty database, checksums verified, Prisma baseline proved equivalent by schema diff. Not yet run against Neon (#1). |
| 3 | Test all frontend-to-backend API connections | **PASSED** — 36 browser checks against a real server, plus a static sweep asserting every path the app calls is a mounted route. |
| 4 | Fix remaining bugs | **PASSED** — ten fixed, each with a test that fails without the fix. |
| 5 | Configure SMTP/OTP, flag what is missing | **BLOCKED** on credentials (#3). The SMTP client now holds a real dialogue, STARTTLS included; nothing is being delivered and nothing claims to be. |
| 6 | Production builds | **Backend PASSED**, whole-project typecheck PASSED, **frontend BLOCKED** on the registry (#2). |
| 7 | All automated tests and browser E2E | **PASSED** — 645 checks, 0 failing; 8 of 8 mutants caught. |
| 8 | Backups, permissions, security, reconciliation | **PASSED** — backup restored and audited (17 checks on the copy); see PASSED #7. One sweep failure on the legacy test database, explained under FAILED. |
| 9 | Prepare deployment on existing hosting | **Frontend PASSED** (Vercel, live). **API BLOCKED** on naming a host (#4). |
| 10 | One report, PASSED / FAILED / BLOCKED | This document. |

## What I would do next, in order

1. Put the two Neon URLs in the environment and run
   `db:check → db:migrate → db:verify → db:check`. (#1)
2. Set the SMTP variables so one-time codes can reach members. (#3)
3. Name the API host; I will finish `deploy/` for it and set
   `VITE_DATA_SOURCE=server` and `VITE_API_BASE` on Vercel. (#4)
4. `npm install && npm run build` wherever there is a registry, to produce the
   frontend bundle. (#2)
5. Give me the society's registrations and the real register, or confirm the
   first month runs on demonstration data. (#5)
6. Say the word, and I push.

---

# Addendum: Vercel + Neon, with no server to run

Added 22 October 2026, after the release candidate above. The deployment target
is now settled: **Vercel** for the React app and the API, **Neon** for
PostgreSQL, **Vercel Cron Jobs** for scheduled work. No VPS, no container host.
`docs/VERCEL.md` is the setup, start to finish. This is what changed, what was
tested, and what is left.

## What this cost in code

Less than it sounds, because the server was already built with the socket at
the edge rather than through the middle. `createApp` returned a plain
`(req, res)` handler all along; the standalone entry point wrapped it in
`createServer`.

* **`api/[...path].js`** — the one function, twenty lines. Everything under
  `/api/` arrives here.
* **`server/src/serverless.ts`** — the adapter: builds the app once per
  instance, hands the platform's request to the same handler, and answers a
  misconfigured deployment legibly instead of with an empty 500.
* **`server/src/routesCron.ts`** — the scheduler as three endpoints.
* No change to any route, any posting rule, the ledger, the GST or TDS
  arithmetic, the approval chain, or the schema. The standalone server and its
  worker still exist and still work; a test asserts they do, so nobody running
  this on a server is stranded.

## What the platform forced, and what was done about it

**The body is already read.** Vercel buffers the request before calling the
function, so the stream has ended by then and waiting on it hangs until the
invocation times out. The handler now takes the text it was handed and falls
back to the socket only when nothing was. The stand-in used in the tests
reproduces this faithfully — the request object it passes has been consumed —
and the mutant that removes the fix **times out** rather than failing, which is
exactly what it would do in production.

**The caller's address is in a header.** Behind a proxy, every request appears
to come from the proxy. The login rate limiter counted that, which means one
person guessing passwords would have locked out the whole society. It now reads
the left-most `X-Forwarded-For` entry, and only where the header can be
believed: `TRUST_PROXY` defaults to true when `VERCEL` is set and false
otherwise, because believing it on a bare socket lets a caller rotate out of
the bucket at will. Both failures are silent, which is why it is derived rather
than asked for.

**There is nowhere for a timer to live.** `setInterval` in a process the
platform freezes between requests does nothing. `GET /api/cron/run` replaces
it, behind a bearer secret compared in constant time, refusing everyone while
`CRON_SECRET` is unset. A pass stops itself after 25 seconds and says so,
leaving the rest to the next one.

**A function can be killed mid-job.** `claimJobs` marks a job `running` and
counts the attempt; nothing moved it back if the worker holding it died. On a
server that needed a restart to happen; on serverless it is routine. A pass now
returns jobs abandoned for more than fifteen minutes to the queue, keeping the
spent attempt so a job that always times out is reported rather than looping.
This was a latent bug in the standalone server too.

**Many instances, one database.** `DB_POOL_MAX` defaults to 2 when `VERCEL` is
set rather than 8: there may be many instances, and a large pool in each spends
Neon's connection limit on idle sockets. Reuse is tested — twenty requests
through one instance open no more connections than the pool allows. The client
uses only unnamed prepared statements and holds no session state, which is what
makes it safe behind Neon's transaction-mode pooler.

**A cron that gets no answer is called again.** Already safe, and now stated
and tested: jobs are claimed `FOR UPDATE SKIP LOCKED`, each is keyed on
`(kind, run_key)`, and the financial writes underneath carry idempotency keys.

## Does the free plan support the scheduling this needs?

Asked directly, so answered directly.

* **Hobby: one cron run per day**, fired anywhere within its hour. Hobby is
  also non-commercial use, which matters if the society is paying you.
* **Pro: down to one run per minute.**

What that means here: monthly billing is queued by a treasurer and picked up by
the nightly pass — fine. Due-date conversion is a daily job by nature — fine.
Only **email dispatch** suffers: a bill released at ten in the morning would
not be sent until the small hours.

So rather than telling you to buy Pro, `POST /api/jobs/drain` runs one bounded
pass as a normal signed-in session, requiring `billing.run` — the same
permission that queues the work. Whoever just released the bills can send them
immediately. It cannot create work, only carry out what is queued, so it does
not step around maker-checker; a resident and an auditor are both refused, and
it needs the CSRF header like any other write.

**Hobby is therefore workable**: the nightly cron is the safety net and the
person who just acted can flush the queue. Pro buys unattended minute-level
dispatch, and it is a schedule change in `vercel.json`, not a code change. The
committed schedule is deliberately daily so a Hobby deployment is not rejected
outright — Vercel refuses a too-frequent schedule at deploy time, which fails
the whole deployment rather than just the cron.

## Test results — 873 checks, 0 failing

| Suite | Checks | Against |
|---|---|---|
| `test:accounting` | 73 | the engine |
| `test:integration` | 59 | a full society's year |
| `test:persistence` | 34 | save and reload |
| `test:browser` | 23 | real Chromium |
| `test:prisma` | 9 | schema vs migrations |
| `test:connection` | 12 (+1 skipped) | connection strings, pooled and direct |
| `schema.test` | 35 | PostgreSQL constraints |
| `schema-domain.test` | 66 | the domain's rules |
| `test:pg` | 23 | the PostgreSQL client |
| `test:documents` | 31 | PDF bytes, message composition |
| `test:security` | 22 | passwords, tokens, cookies, logs |
| `test:smtp` | 13 | a real SMTP dialogue |
| `test:wiring` | 7 | every client path is a mounted route |
| **`test:deploy`** | **19** | `vercel.json`, the cron, the rewrite, the migration guards |
| `api.test` (socket) | 188 | the standalone server |
| **`test:serverless`** | **18** | what only the function path can get wrong |
| **`api.test` (serverless)** | **188** | the same suite through the adapter |
| `test:frontend` | 36 | Playwright, the app's own client code |
| `db:verify-backup` | 17 | a dump, restored, audited in the copy |

Run with `npm run test:all` and `npm run db:verify-backup`.

The 188 API checks were then run a **third** time: through the serverless
adapter against a TLS + SCRAM-SHA-256 connection — the shape of a Neon
connection — and passed. The backup rehearsal was then run over that
database, and the books written through the serverless path restore and
audit clean: 17 of 17.

**Mutation testing: fourteen breakages of the new code, fourteen caught.**

| Breakage | Result |
|---|---|
| the adapter reads a stream that has ended | **times out** (as it would on Vercel) |
| the forwarded address is never used | 1 fails |
| the forwarded address is always believed | 1 fails |
| the cron secret is not checked | 1 fails |
| an unset cron secret is treated as a secret | 1 fails |
| a job still being worked on is requeued too | 3 fail |
| a pass never requeues an abandoned job | 1 fails |
| the app is rebuilt on every request | 3 fail |
| a pre-read body has no size limit | 1 fails |
| anyone signed in may run the queue | 1 fails |
| the migration runner accepts a pooler | 1 fails |
| the SPA rewrite swallows the API | 1 fails |
| a cron schedule the free plan refuses | 1 fails |
| a timer is started inside a function | 1 fails |

## Migrations stay a step you take

Not in the build, not in a request, and a test asserts both. `npm run
db:migrate` uses `DIRECT_URL` and refuses to run against a pooled hostname —
a pooler in transaction mode cannot hold the locks a migration takes.

Added for a laptop without psql: **`npm run db:migrate:node`**, the same files
and the same `schema_migrations` bookkeeping over this project's own client,
with a session-level advisory lock so two deploys cannot race. Proved
equivalent: each runner applied to an empty database, `pg_dump --schema-only`
of the two compared — identical but for pg_dump's own random token. Each
runner reads the other's rows, and a re-run is a no-op.

## Bugs found and fixed in this round

1. **The login rate limiter would not have worked on Vercel** — every caller
   shared the proxy's address.
2. **A job abandoned by a killed worker was never retried** — latent on a
   server, routine on serverless.
3. **The one file the whole deployment goes through was not type-checked** —
   no tsconfig included `api/`. It is in `tsconfig.server.json` now, with a
   test that fails if it falls out again.
4. **An already-parsed body had no size limit** — the 1 MB cap was applied
   while reading the socket, which the function never does.

## What is BLOCKED, and it is the same five things

Nothing about Vercel changed what is missing. In the order I would do them:

1. **Neon credentials.** Nothing here has connected to your database. Step 1
   of `docs/VERCEL.md` is a command that reports what it actually connected to.
2. **SMTP credentials.** Still the one blocker that stops members using the
   system, because sign-in by code needs delivery.
3. **`npm install` and the frontend production build.** `registry.npmjs.org`
   does not resolve from this machine — `npm error network request to
   https://registry.npmjs.org/@tailwindcss%2fvite failed, reason: getaddrinfo
   ENOTFOUND` — so `vite build` cannot run here and neither can `vercel build`.
   The frontend source is unchanged in this round and the last Vercel build of
   it succeeded; Vercel runs `npm install && npm run build` itself.
4. **The society's registrations and real register** — GSTIN, TAN, bank
   details, flats and owners.
5. **Your approval to deploy.** Nothing has been deployed or pushed.

## The settings only you can make

1. Neon → Connection Details → copy the string **twice**: pooled
   (`-pooler` in the hostname) as `DATABASE_URL`, direct as `DIRECT_URL`.
2. Run `npm run db:check`, then `npm run db:migrate`, then `npm run db:verify`,
   from your machine.
3. Vercel → **Add New Project** → import the repo → **Root Directory:
   `society`**.
4. Vercel → Settings → Environment Variables: `DATABASE_URL`, `DIRECT_URL`,
   `SESSION_SECRET` (`openssl rand -hex 32`), `CRON_SECRET`
   (`openssl rand -hex 32`), `NODE_ENV=production`, `VITE_DATA_SOURCE=server`,
   `VITE_API_BASE` empty, and the `SMTP_*` set when you have a mail provider.
5. Deploy, then check `/api/health`, sign in, and
   `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/status`.
6. Decide Hobby or Pro on the scheduling question above. Hobby works.
