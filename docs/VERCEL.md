# SocietyBooks on Vercel and Neon

Everything here assumes the two accounts you have and nothing else: **Vercel**
for the React app and the API, **Neon** for PostgreSQL, **Vercel Cron Jobs**
for the scheduled work. No VPS, no container host, no third service.

It works, with one real limitation that comes from Vercel's plans rather than
from this code — how often a scheduled job can run. That is set out in
*The scheduler* below, with what it means for a society and what to do about
it without paying for anything.

---

## What the deployment looks like

```
                         one Vercel project
   ┌───────────────────────────────────────────────────────────┐
   │  /                 the React app (static files from dist) │
   │  /api/*            one serverless function                │
   │                      → api/[...path].ts                   │
   │                      → server/src/serverless.ts           │
   │                      → the same routes, rules and ledger  │
   │                        as the standalone server           │
   │  /api/cron/run     called by Vercel Cron, bearer secret   │
   └───────────────────────────────┬───────────────────────────┘
                                   │  pooled DATABASE_URL (TLS, SCRAM)
                                   ▼
                            Neon PostgreSQL
                                   ▲
                                   │  direct DIRECT_URL
                     migrations, run by you, from your laptop
```

Three things to notice, because they are the whole design:

* **The API is the same server.** `api/[...path].ts` is twenty lines. It hands
  Vercel's request and response objects to the handler the standalone server
  uses, so there is no second copy of the routing, the CSRF check, the
  authorisation or the error mapping. The full API suite — 185 checks — runs
  over both transports; see *Test results* below.
* **Same origin.** The app and the API are served from one domain, so the
  session cookie is a first-party `SameSite=Strict` cookie, the CSRF
  double-submit works as designed, and there is no CORS configuration to get
  wrong. `VITE_API_BASE` stays empty.
* **Migrations are not in the request path and not in the build.** They are a
  step you run deliberately, against the direct Neon endpoint. Nothing in
  `vercel.json` can run one, and a test asserts that.

### One project or two

The recommendation is a **separate Vercel project for SocietyBooks**, with its
**Root Directory** set to `society`. Reasons:

* `govind-flax.vercel.app` serves ten demonstration apps from one build. Those
  are public demos; this one has a database, sessions and a scheduler. Mounting
  an API at the root of the demo site means every demo shares the domain that
  carries real session cookies.
* The root of that site is built by `build_site.sh`, which builds every app.
  SocietyBooks would be rebuilt and redeployed whenever an unrelated demo
  changed.
* Vercel's functions live in `<root>/api/`, so a monorepo deployment would
  need the function at the repository root, importing across apps.

The demonstration copy at `govind-flax.vercel.app/society/` keeps working
exactly as it does now — it has no backend and runs the sample society in the
browser, labelled as such. Nothing in this setup changes it.

If you would rather have one project, it can be done: move `api/` to the
repository root and point its import at `society/server/src/serverless`, then
set the cron path and the rewrite accordingly. Say so and I will do it.

---

## Step 1 — Neon: get the two connection strings

In the Neon console, open your project → **Connection Details**. You need the
string **twice**:

1. With **Pooled connection** ticked. The hostname has `-pooler` in it. This is
   `DATABASE_URL`, used by every request.
2. With it **unticked** — the direct hostname, no `-pooler`. This is
   `DIRECT_URL`, used only by migrations.

```
DATABASE_URL="postgresql://USER:PASSWORD@ep-xxxx-123456-pooler.REGION.aws.neon.tech/DBNAME?sslmode=verify-full"
DIRECT_URL="postgresql://USER:PASSWORD@ep-xxxx-123456.REGION.aws.neon.tech/DBNAME?sslmode=verify-full"
```

Why both: Neon's pooled endpoint is PgBouncer in transaction mode. It is the
right thing for serverless — many short-lived instances, few real connections —
and it cannot hold a session-level lock, which a migration takes. Pointing
migrations at the pooler is the classic way to get a half-applied schema.

Use `sslmode=verify-full`, not `require`. `require` encrypts the traffic
without establishing who is on the other end of it; `verify-full` checks the
certificate, and Neon's is from a public CA, so it verifies.

This project's client speaks TLS and SCRAM-SHA-256 directly, with channel
binding when the server offers it, and it uses only unnamed prepared
statements — which is what makes it safe behind a transaction-mode pooler.

### Check it before deploying anything

```bash
cd society
cp .env.example .env          # then paste the two URLs into .env
npm install
npm run db:check
```

`db:check` connects and reports what it actually got — host, user, whether the
traffic is encrypted, the cipher, the authentication mechanism, the server
version, and which migrations are applied. It also tells you if you have the
two URLs the wrong way round: it recognises a pooled hostname.

## Step 2 — Migrations, as their own step

```bash
npm run db:migrate          # applies what is pending, using DIRECT_URL
npm run db:verify           # re-reads every applied migration's checksum
```

If `psql` is not installed on your machine, use the runner that does not need
it — same files, same bookkeeping, this project's own client:

```bash
npm run db:migrate:node
npm run db:status:node
```

Both runners write the same `schema_migrations` rows and read each other's, so
you can use either at any time. Verified by applying each to an empty database
and comparing `pg_dump --schema-only`: identical.

Notes that matter:

* **Never in the build, never in a request.** A migration on cold start would
  race itself across instances. Run it from your machine, see it succeed, then
  deploy.
* **Nothing destructive.** Every migration so far only adds. A migration that
  dropped or rewrote data would need a backup first — `npm run db:verify-backup`
  rehearses exactly that: dump, restore into a copy, and audit the books in the
  copy.
* **Order with deploys.** Apply migrations *before* deploying code that needs
  them; the schema is additive, so the running version keeps working.

## Step 3 — Vercel: create the project

1. **Add New → Project**, import the repository.
2. **Root Directory**: `society`. This is the setting that makes everything
   else line up: `vercel.json`, `api/` and the Vite app are all inside it.
3. Framework preset: **Vite** (already declared in `vercel.json`).
4. Do **not** deploy yet — set the environment variables first, because the
   `VITE_` ones are read at build time.

## Step 4 — Environment Variables

In **Project → Settings → Environment Variables**. Set these for
**Production** (and Preview, if you want previews to work):

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | the **pooled** Neon string | every request |
| `DIRECT_URL` | the **direct** Neon string | migrations; harmless here, and `db:check` can then report both |
| `SESSION_SECRET` | `openssl rand -hex 32` | signs session tokens, hashes rate-limit subjects. The server refuses to start in production without it |
| `CRON_SECRET` | `openssl rand -hex 32` | Vercel sends it to your cron endpoints; they refuse everything else |
| `NODE_ENV` | `production` | turns on the production refusals: no local-dev providers, no insecure cookies |
| `SECURE_COOKIES` | `true` | refused as `false` in production anyway |
| `ALLOWED_ORIGIN` | `https://your-domain` | only used if you ever call the API cross-origin; same-origin needs no CORS |
| `VITE_DATA_SOURCE` | `server` | **build-time.** Makes an unreachable API an error on screen instead of a silent fall back to demonstration figures |
| `VITE_API_BASE` | *(empty)* | **build-time.** Empty means same origin |
| `EMAIL_PROVIDER` | `smtp`, or `none` until you have a mail provider | see *What is still not connected* |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_FROM_NAME` | your mail provider's | required when `EMAIL_PROVIDER=smtp` |
| `OTP_PROVIDER` | `none` | there is no SMS adapter yet; `none` makes the server decline to issue codes rather than pretend |

Leave these alone unless you have a reason:

| Variable | Default on Vercel | |
|---|---|---|
| `TRUST_PROXY` | true, because `VERCEL` is set | decides what the login rate limiter counts. Wrong either way is silent, which is why it is derived rather than asked for |
| `DB_POOL_MAX` | 2 | per instance. There may be many instances; a big pool in each spends Neon's connection limit on idle sockets |
| `CRON_BUDGET_MS` | 25000 | how long one scheduled pass works before stopping and leaving the rest to the next one |
| `RUN_WORKER` | not read in a function | the adapter never starts a worker |

**Never** put `DATABASE_URL`, `DIRECT_URL`, `SESSION_SECRET`, `CRON_SECRET` or
`SMTP_PASSWORD` in a variable whose name starts with `VITE_`. Those are
compiled into the JavaScript every browser downloads. A test fails if the
template or these instructions ever name one that way.

## Step 5 — Deploy, then check

Deploy. Then, with nothing but a browser:

* `https://your-domain/api/health` — reachable, and reports the schema version.
* `https://your-domain/` — the app. It should ask you to sign in rather than
  showing demonstration data. If it shows demo figures, `VITE_DATA_SOURCE` was
  not set at build time; set it and redeploy.
* Sign in. `GET /api/auth/me` tells you which roles and permissions the session
  holds.

From a terminal, with the secret:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-domain/api/cron/status
```

That reports the queue without running anything, which is the cheapest way to
know the secret and the routing are right.

---

## The scheduler

There is no process to keep a timer in, so the worker is replaced by an
endpoint the platform calls: `GET /api/cron/run`, declared in `vercel.json`.

```json
"crons": [{ "path": "/api/cron/run", "schedule": "17 1 * * *" }]
```

**What it does and does not do.** A pass drains jobs that somebody with
`billing.run` already queued through `POST /api/jobs`. It never queues one.
That is deliberate: every job carries the user who asked for it, and
maker-checker depends on that being a real person. A cron that created billing
runs would be inventing the maker, and the approver would be approving
something nobody asked for.

**Why it is safe to be called twice.** Vercel retries a cron that does not
answer, and two passes can overlap:

* jobs are claimed `FOR UPDATE SKIP LOCKED`, so two passes take different jobs;
* each job is keyed on `(kind, run_key)`, and the financial writes underneath
  carry their own idempotency keys — a repeat is refused by the database rather
  than posted twice;
* a pass killed mid-flight leaves its job `running`, and the next pass returns
  it to the queue after fifteen minutes, keeping the spent attempt so a job
  that always times out is eventually reported rather than looping.

**The time budget.** A pass stops itself after `CRON_BUDGET_MS` (25s by
default, against a 60s function limit) and says so in its reply. The queue is
drained across passes rather than in one heroic invocation.

### Does your plan support the precision this needs?

This is the one place where the platform genuinely constrains the product, so
here is the straight answer.

* **Vercel Hobby: one run per day, and loosely timed** — a daily schedule can
  fire anywhere within its hour. Hobby is also for non-commercial use, which
  matters if the society is paying you.
* **Vercel Pro: down to one run per minute**, timed to the minute.

What that means for a society, job by job:

| Work | Natural frequency | Fine on Hobby? |
|---|---|---|
| Monthly billing run | once a month, queued by the treasurer | **Yes.** A daily pass picks it up the same night |
| Due-date conversion (proforma → tax invoice) | once a day | **Yes.** This is exactly a daily job |
| Notification dispatch (invoices, receipts, reminders by email) | as soon as possible | **No.** A bill released at 10am would not be emailed until the next early morning |

So: billing and accounting are unaffected. Only the *delivery* of email is
delayed, and only on Hobby.

**What to do about it without paying for anything.** `POST /api/jobs/drain`
runs one bounded pass, authenticated as a normal session and requiring
`billing.run` — the same permission that queued the work. A treasurer who has
just released a bill run can send the invoices immediately instead of waiting
for the nightly cron. It cannot create work, only carry out what is queued, so
it does not step around maker-checker.

That makes Hobby workable: the nightly cron is the safety net, and the person
who just did something can flush the queue themselves.

**When Pro is worth it.** If you want invoices to go out within minutes with
nobody pressing anything, change the schedule to `*/5 * * * *` and let the
cron do it. That is a plan change, not a code change — and it is the only
thing in this whole deployment that money fixes. (The schedule in
`vercel.json` is deliberately daily so that a Hobby deployment is not rejected
outright; Vercel refuses a too-frequent schedule at deploy time.)

Cron schedules are UTC. `17 1 * * *` is 06:47 IST.

---

## Test results

Run against a local PostgreSQL configured to behave like Neon — TLS required,
plaintext refused, SCRAM-SHA-256 with channel binding — because no Neon
credentials exist in the environment these were run in.

| Suite | Checks | Notes |
|---|---|---|
| `api.test` over a socket | 185 | the standalone server |
| `api.test` over the serverless adapter | 185 | `SB_TEST_TRANSPORT=serverless`; the same checks, through a stand-in for Vercel's runtime |
| `serverless.test` | 18 | what only the function path can get wrong |
| `deploy.test` | 17 | `vercel.json`, the cron, the rewrite, the migration guards |

`serverless.test` covers, among others: a body the platform has already read
(and an oversized one, and one that is not JSON); the caller's address coming
from `x-forwarded-for` so the login rate limiter counts people rather than the
proxy — and being *ignored* when the proxy is not trusted; twenty requests
served by one instance opening no more connections than the pool allows; the
cron secret being required and nothing else doing; a stalled job being
requeued and run; and a deployment with no `SESSION_SECRET` answering legibly
instead of a blank 500.

## What is still not connected

* **Email.** The SMTP client is written and tested against a real SMTP dialogue
  (STARTTLS, AUTH LOGIN and PLAIN, the terminating dot) but there are no
  provider credentials, so nothing has been delivered to a real address. Until
  `SMTP_HOST` and friends are set, `EMAIL_PROVIDER=none` and every response
  says nothing was sent rather than claiming a delivery. **This is what stops
  members signing in by one-time code.**
* **SMS.** No adapter. Email sign-in covers the same ground.
* **Neon itself.** No credentials in this environment, so nothing here has run
  against your actual database. Step 1 is where that is proved, by a command
  that reports what it connected to.
* **The society's own registrations** — GSTIN, TAN, bank details — and the real
  register of flats and owners. No placeholder is printed on any document.

## If something is wrong after a deploy

| What you see | What it is |
|---|---|
| `{"error":"misconfigured"}` with a variable named | that variable is missing; set it and redeploy |
| HTML instead of JSON from `/api/...` | the SPA rewrite is matching the API — check `rewrites` in `vercel.json` |
| `503 cron_not_configured` from the cron | `CRON_SECRET` is not set in the environment |
| `401` from the cron | the secret does not match what Vercel sends |
| Demonstration figures on screen | `VITE_DATA_SOURCE` was not `server` at build time |
| A slow first request after a quiet night | Neon suspends an idle compute; the first connection wakes it |
| `429` on sign-in for everyone at once | `TRUST_PROXY` is off, so every caller shares the proxy's address |
