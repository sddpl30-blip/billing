# UAT (sandbox) environment for the payment gateway

The bank's sandbox payments must never reach the live books, and the ledger
cannot be cleaned afterwards (nothing posted is ever deleted). UAT is therefore
a separate Neon database and a separate Vercel project, with demo data only.

1. **Neon**: create a new project (`societybooks-uat`). Do not branch the live
   one: a branch copies the residents' names and e-mail addresses. Copy the
   pooled link (`DATABASE_URL`) and the direct link (`DIRECT_URL`), both
   `sslmode=verify-full` (see docs/NEON.md).
2. **Migrations** (all of 001 to the latest, from a terminal; the
   `docs/neon/*-apply.sql` files are only for an older database):
   `DIRECT_URL=... npm run db:migrate` then `npm run db:status`.
3. **Demo data**, from a terminal and only against the UAT link (the seed
   refuses `NODE_ENV=production`): `DATABASE_URL=<UAT pooled> SEED_PASSWORD=...
   npm run server:seed`. Check the link twice before running it.
4. **Vercel**: new project from the same repository, named `billing-uat`, with
   its own Production Branch (for example `uat`) so live deploys do not move it.
5. **Environment variables, in the UAT project only**: `DATABASE_URL`,
   `DIRECT_URL`, a new `SESSION_SECRET` and `CRON_SECRET` (`openssl rand -hex
   32`), `NODE_ENV=production`, an `EMAIL_PROVIDER` that can only reach test
   addresses (or `none`), and later the gateway's sandbox keys. Never copy the
   live Brevo key or the live database link. Never put a secret in a `VITE_`
   variable.
6. **Check**: `/api/health` is ok with the latest `schemaVersion`; the society
   is the demo one. Sign-in codes are e-mailed, and demo accounts use
   `@demo.invalid`, so add a test e-mail under Users & roles and sign in with it.
7. **Give the bank** the UAT project's fixed `*.vercel.app` address (preview
   URLs change on every deploy and cannot be whitelisted). Check Vercel's
   Deployment Protection does not block the gateway's callback.
8. **Fixed IP**: Vercel's outbound IP is dynamic. If the bank requires a fixed
   address for its API, use Vercel's static-IP option or a fixed-IP outbound
   proxy for the gateway calls only. Ask the bank first whether UAT needs it.
