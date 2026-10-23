# Connecting SocietyBooks to Neon

Everything in this file is implemented and tested against a PostgreSQL
configured the way Neon is — TLS required, SCRAM passwords, over TCP. What has
**not** happened is a connection to your Neon project: no credentials have
reached this repository, so nothing here reports a successful connection to
your database. The two commands that will tell you are at the end.

## What had to change first

Two things in this project could not have talked to Neon at all, whatever the
URL:

1. **The PostgreSQL client had no TLS.** Neon refuses an unencrypted
   connection. The client now negotiates TLS (`SSLRequest`, then a real TLS
   handshake) with libpq's `sslmode` levels — `disable`, `prefer`, `require`,
   `verify-full`.
2. **It could not do SCRAM-SHA-256.** Neon authenticates with it; the client
   said so and refused. It now implements SCRAM-SHA-256 and
   SCRAM-SHA-256-PLUS, including verifying the *server's* half of the proof —
   without that check, something in the middle that cannot verify your
   password can still claim the authentication succeeded.

Verified locally against PostgreSQL 16.13 with `ssl = on`,
`password_encryption = scram-sha-256` and a `pg_hba.conf` that rejects
unencrypted connections: TLS 1.3, `TLS_AES_256_GCM_SHA384`,
`SCRAM-SHA-256-PLUS`, and the whole 177-check API suite passing over it.

## Where to put your credentials

Neon gives you two connection strings. In the Neon console: **your project →
Connection Details**, then the *Connection string* box.

- Leave **Connection pooling** checked for the first one. The host has
  `-pooler` in it. This is `DATABASE_URL`.
- Untick it for the second. Same host without `-pooler`. This is `DIRECT_URL`.

Put them in **`society/.env`**, which is gitignored and never committed:

```sh
# society/.env  — never commit this file
DATABASE_URL="postgresql://USER:PASSWORD@ep-xxxx-xxxx-123456-pooler.REGION.aws.neon.tech/DBNAME?sslmode=verify-full"
DIRECT_URL="postgresql://USER:PASSWORD@ep-xxxx-xxxx-123456.REGION.aws.neon.tech/DBNAME?sslmode=verify-full"
SESSION_SECRET="run: openssl rand -hex 32"
```

Three notes on that, each of which matters:

- **`sslmode=verify-full`, not `require`.** Neon's certificate is from a public
  CA, so verification works, and `require` encrypts the traffic without
  establishing who is on the other end of it. Neon's own copy-paste string says
  `sslmode=require`; change it.
- **Drop `channel_binding=require` if you hit trouble, but try it first.** This
  client implements SCRAM-SHA-256-PLUS, so channel binding works and is
  stronger: it ties the password exchange to the TLS connection, so a proxy
  that terminates TLS cannot relay the handshake. Leaving the parameter out
  gets you binding anyway when the server offers it.
- **Both URLs, not one.** A pooled connection is right for the application's
  short queries and wrong for migrations, which take session-level locks a
  pooler does not hold across statements. `DIRECT_URL` is what
  `server/migrate.mjs` uses.

### For deployment rather than development

`.env` is for your machine. On a server, set the same variables wherever that
server's configuration lives — a systemd unit's `EnvironmentFile=`, the
`environment:` block in compose, your host's dashboard — and do not ship a
`.env`. The loader in this project deliberately lets an already-set variable
win over the file, so a stray `.env` cannot override what systemd set.

**Never in the front end.** `VITE_*` variables are compiled into the JavaScript
that browsers download. `DATABASE_URL` is not a `VITE_` variable and must never
become one: the browser talks to the API, and only the API talks to Neon. The
only thing the front end needs is `VITE_API_BASE`, which is a URL with no
credential in it.

## Then, in order

```sh
cd society
npm install                    # needed for Prisma; the rest runs without it

# 1. Can it connect, and how?
npm run db:check
```

`db:check` connects with both URLs and prints the server version, whether the
connection is encrypted and with what cipher, which SCRAM mechanism was used,
which database and user, and which migrations are applied. It prints no
password and no connection string. If it cannot connect it says which variable
it used and what the server or the network said.

Read its two warnings if they appear: one if `DIRECT_URL` is missing, one if
the two URLs look the wrong way round.

```sh
# 2. Create the schema on Neon, over the direct connection.
node server/migrate.mjs            # applies 001–006
node server/migrate.mjs status     # all applied, nothing pending, nothing changed
```

The runner applies each file once inside a transaction, records a SHA-256 of
it, and refuses to continue if a file that was already applied has since
changed. Safe to re-run: a second run applies nothing.

```sh
# 3. A society to sign into. Skip this for a production database.
SEED_PASSWORD=choose-one npm run server:seed
```

The seed refuses to run with `NODE_ENV=production`, and refuses to touch a
society whose mode is `production`. It creates demonstration data — ten
placeholder flats on the `.invalid` domain, no GSTIN, no bank details, no
approved GST treatment.

```sh
# 4. The API, and then the app.
npm run server
curl -s localhost:4000/api/health

VITE_DATA_SOURCE=server VITE_API_BASE=http://127.0.0.1:4000 npm run dev
```

`GET /api/system/database`, with a treasurer or secretary session, reports the
connection in full: host, user, cipher, SCRAM mechanism, server version, the
applied migrations and the pool's state. Also with no password in it.

## Prisma

**Prisma is not installed in this repository and never has been.** There is no
`prisma` or `@prisma/client` dependency in `package.json`, no
`node_modules/.bin/prisma`, and `prisma/schema.prisma` carries a header saying
that `prisma generate`, `prisma validate` and `prisma migrate` have never been
run against it. So there is no Prisma version to report: it is a schema file,
not a working Prisma setup.

**There were also no Prisma migrations.** `prisma/migrations/` did not exist.
The migration path is and remains `server/migrations/*.sql`, applied by
`server/migrate.mjs`. That is not a stopgap: Prisma cannot express the deferred
constraint triggers that make an unbalanced journal entry impossible to commit,
the trigger that refuses a posting into a closed financial period, the
control-party rule, the `DO INSTEAD NOTHING` delete rules that make journal
entries and audit rows undeletable, or the partial unique indexes that stop a
flat being billed twice for one period. A schema created by `prisma migrate
dev` from the schema file would be missing every one of them.

So that Prisma can be used as a typed client over the result, there is now a
baseline:

```sh
npm run db:baseline                             # generate it
ADMIN_URL="$DIRECT_URL" node scripts/build-prisma-baseline.mjs --verify
```

`prisma/migrations/0_init/migration.sql` is the six SQL migrations
concatenated, plus the rows the SQL runner would have recorded — so a database
baselined through Prisma is consistent with both tools. It is generated, and
`--verify` proves it: it applies the baseline to one empty database, runs the
migration runner against another, dumps both schemas and compares them. They
match exactly (verified here against PostgreSQL 16.13).

To adopt it against a Neon database that already has the schema:

```sh
npx prisma migrate resolve --applied 0_init   # records it; executes nothing
npx prisma migrate status                      # clean
npx prisma db pull                             # refresh schema.prisma from Neon
npx prisma generate                            # the typed client
```

Use `prisma db pull`, never `prisma migrate dev`, on this database. And expect
`prisma validate` to find things in the hand-written schema file: it has never
seen a Prisma binary.

## Things about Neon specifically

- **Compute suspends when idle.** The first connection after a pause takes a
  few hundred milliseconds to a few seconds while it wakes. The client's
  connect timeout is 10 seconds by default; `PGCONNECT_TIMEOUT` (in seconds)
  changes it.
- **The pooler is PgBouncer in transaction mode.** This client uses the
  extended query protocol with *unnamed* prepared statements, which is
  compatible with transaction pooling; it keeps no prepared-statement cache and
  sets no session state, so there is nothing for the pooler to lose between
  statements. Its transactions pin one connection for their whole life, which
  is what transaction pooling supports.
- **Migrations through the pooler can appear to work and should not be run
  there.** Hence `DIRECT_URL`.
- **`psql` is needed for migrations**, because the runner shells out to it. On
  the server that runs them: `apt install postgresql-client-16`. The API itself
  needs no external binary.
- **Branches.** If you use a Neon branch for staging, it has its own two URLs;
  nothing in this project assumes a single project.

## If something fails

| what you see | what it means |
| --- | --- |
| `the server refused TLS and sslmode is "verify-full"` | not Neon on the other end — usually the wrong host or port, or a proxy. Nothing was sent; the password did not leave the process. |
| `password authentication failed` | the password in the URL is wrong, or it has been rotated in the Neon console. |
| `self-signed certificate` with `verify-full` | something is terminating TLS in front of Neon. Do not drop to `require` to make it go away; find out what it is. |
| `the server's SASL signature does not match` | the thing answering does not know the password. Treat it as hostile until you know otherwise. |
| `channel binding is required and not available` | `channel_binding=require` with `sslmode=disable`, or a server that does not offer `SCRAM-SHA-256-PLUS`. |
| `relation "schema_migrations" does not exist` | an empty database. Run `node server/migrate.mjs`. |
| `was applied with checksum X but the file is now Y` | a migration file changed after being applied. The database and the repository have diverged; do not force it. |
