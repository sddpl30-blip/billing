# Running SocietyBooks

Three ways: everything local without Docker, everything local with Docker, and
a production deployment. The commands are the ones that were run while writing
this, except where a line says otherwise — and where something has never been
executed here, it says so rather than reading as tested.

## What you need

- **Node 22** or newer.
- **PostgreSQL 16** or newer, reachable by the API.
- **npm install** to work. The environment this was built in has no reachable
  npm registry, so `node_modules` is absent here and the front end has never
  been built with Vite. Everything below the React components — the engine, the
  stores, the API client, the server — is compiled and tested with the
  TypeScript on PATH and the declarations in `types/`.

## Local, without Docker

```sh
cd society
npm install

# 1. a database
createuser societybooks
createdb -O societybooks societybooks
export PGHOST=/var/run/postgresql PGUSER=societybooks PGDATABASE=societybooks

# 2. the schema
node server/migrate.mjs            # applies 001–006
node server/migrate.mjs status     # what is applied, and anything that drifted

# 3. configuration
cp .env.example .env               # then set SESSION_SECRET
export SESSION_SECRET="$(openssl rand -hex 32)"

# 4. a society to look at
SEED_PASSWORD=some-local-password npm run server:seed

# 5. the API
npm run server                     # http://127.0.0.1:4000
curl -s localhost:4000/api/health | head

# 6. the app, in another terminal
VITE_DATA_SOURCE=server VITE_API_BASE=http://127.0.0.1:4000 npm run dev
```

The seed creates one society whose `mode` is `demo`: ten flats, their owners,
one account per role, the chart of accounts, the six receipt heads, the ₹4.50
per square foot rate and the ticket categories. Sign in as
`treasurer@demo.invalid` with whatever `SEED_PASSWORD` was.

It creates no GSTIN, no bank account number, no approved GST treatment and no
real resident. The first thing the app shows is the system refusing to charge a
tax nobody has signed off — which is the intended behaviour, not a setup
mistake. To get past it: set the treatment as the secretary, approve it as the
treasurer, then run a billing cycle as the manager.

### Pointing the app at the API

The app decides where its data comes from at build time, with two variables:

| | |
| --- | --- |
| `VITE_API_BASE` | `https://books.example.org`, or empty for the same origin as the app. |
| `VITE_DATA_SOURCE` | `server` — require the API; an unreachable one is an error on screen. `demo` — never contact it; run the sample society in the browser. Unset — try the server, fall back to the demonstration. |

**Set `VITE_DATA_SOURCE=server` for anything real.** Left unset, a deployment
whose API is down silently shows sample data, and a committee reading invented
figures and believing them is worse than an error message.

`window.SOCIETYBOOKS_API_BASE` overrides the base at runtime, so one build can
be pointed at a different server without rebuilding.

## Local, with Docker

**Never run here.** This machine has a docker binary and no reachable daemon,
so the two Dockerfiles and the compose file are written from the project's real
layout and have never been built. Expect the first build to need a fix.

```sh
export SESSION_SECRET="$(openssl rand -hex 32)"
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
docker compose up --build
# the app on http://localhost:8080, the API behind it at /api
```

Four services: `db` (PostgreSQL with a named volume), `migrate` (runs once and
exits; the API waits for it to succeed), `api`, and `web` (the built app behind
nginx, which also proxies `/api` to the API).

The API is deliberately not published on a host port. The web container reaches
it on the compose network, and an API on a public port with no TLS in front of
it is a session cookie travelling in the clear.

## Production

### 1. The schema first

```sh
DATABASE_URL=postgresql://user:pass@host:5432/societybooks node server/migrate.mjs
```

The runner applies each file once, records a SHA-256 of it, and refuses to
continue if a file that was already applied has changed since. That refusal is
the point: it means the database and the repository have diverged and somebody
has to look.

### 2. The API

```sh
NODE_ENV=production \
DATABASE_URL=postgresql://... \
SESSION_SECRET=<32+ characters, from a secret store> \
ALLOWED_ORIGIN=https://books.example.org \
SECURE_COOKIES=true \
OTP_PROVIDER=none \
EMAIL_PROVIDER=smtp SMTP_HOST=... SMTP_FROM=... SMTP_USER=... SMTP_PASSWORD=... \
node .server-build/server/src/app.js
```

Production mode refuses to start on any of these, rather than starting and
being quietly unsafe:

- `SESSION_SECRET` missing or shorter than 32 characters
- `SECURE_COOKIES=false`
- `OTP_PROVIDER=local-dev` — it writes one-time codes to the log
- `EMAIL_PROVIDER=local-dev` — it writes messages to the log
- `EMAIL_PROVIDER=smtp` with no `SMTP_HOST`

### 3. The app

`npm run build` produces `dist/`. Serve it as static files with the API under
`/api` on the same origin — `nginx.conf` in this repository is that
configuration. The session cookie is `SameSite=Strict`, so a browser will not
send it to a different origin: the app and the API have to look like one site.

### 4. TLS, and what has to be in front

Everything here assumes TLS terminates in front of the API. The session cookie
is `Secure`; CSRF is a double-submit against a second cookie the page can read.
Neither survives plain HTTP.

### 5. The background worker

The same process runs it unless `RUN_WORKER=false`. It is safe to run on
several instances: jobs are claimed with `FOR UPDATE SKIP LOCKED` and every job
has a unique business key, so a scheduler firing twice for July bills July
once.

What it does: the monthly billing run, converting proformas that have reached
their due date, and sending the notification queue. Nothing is sent while
`EMAIL_PROVIDER` is `none` — the job reports that rather than claiming a
dispatch.

### 6. What to watch

- `GET /api/health` — 200, or 503 with the reason. The schema version it is
  running against is in the body.
- `scheduled_jobs` where `state = 'failed'` — a billing run that never happened
  is something a committee has to be told about. There is no alerting here;
  wire this into whatever you already use.
- `notifications` where `state = 'failed'` — with `last_error`, which is kept.
- `bank_reconciliations` where `difference <> 0` — those are working papers,
  not sign-offs. The database refuses a sign-off while the two sides disagree.

## Backups

In `server/README.md`, with the restore steps and the one check worth running
afterwards (that the trial balance still ties). The short version: nightly
`pg_dump --format=custom`, verify the dump is readable, and rehearse a restore
into a fresh database before you need one.

## Secrets, and what this system deliberately cannot hold

`SESSION_SECRET`, the database password and the SMTP password belong in a
secret store, not in a file in the repository. `.env` is gitignored;
`.env.example` carries no values.

There is no column anywhere in this schema for a bank credential, a tax-portal
credential, or a vendor's full account number. `bank_accounts` holds the last
four digits and an IFSC, which is all a reconciliation needs. Nothing in this
system can move money: `payVendor` records a payment the society made, it does
not instruct a bank to make one.
