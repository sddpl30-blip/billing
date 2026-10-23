# Deploy task: a prompt for Claude in Chrome

Copy everything between the two lines into Claude in Chrome (or any Claude
that can drive your browser) while you are signed in to Vercel and GitHub.
It sets up the Neon database through Vercel, the environment variables, the
schema and the deployment, then checks it. It never needs a terminal.

You stay in charge of two things: approving anything that costs money, and
keeping the generated secrets. It is told never to paste a secret into chat.

---

You are deploying a web app called SocietyBooks to Vercel, with a Neon
Postgres database created through Vercel's Neon integration. I am signed in to
Vercel and GitHub in this browser. Work through the steps in order. After each
step, tell me in one line what you did and what you saw. Stop and ask me if a
screen does not match what is described, if anything asks for payment or a
plan upgrade, or if a step fails twice.

Never paste a secret value (passwords, connection strings, generated keys)
into this chat. When you generate one, put it straight into the Vercel field
and tell me only that it is set.

Facts you need:
- GitHub repository: `sddpl30-blip/billing`
- Branch to deploy: `claude/loving-ritchie-nymqj1`
- The schema to load: https://github.com/sddpl30-blip/billing/blob/claude/loving-ritchie-nymqj1/prisma/migrations/0_init/migration.sql
  (use the "Raw" button to get the plain text)

**Step 1: the Vercel project.**
In Vercel, find the project that is connected to `sddpl30-blip/billing`. If
there is none, choose Add New → Project, import `sddpl30-blip/billing`, keep
the framework as Vite, and do not deploy yet if it lets you skip; if it
deploys anyway, that is fine. Open the project's Settings → Git and set
Production Branch to `claude/loving-ritchie-nymqj1`. Save.

**Step 2: the database.**
In the project, open the Storage tab → Create Database → Neon (Serverless
Postgres). Choose the free plan. Region: Singapore (or Mumbai if offered).
Connect it to this project for all environments (Production, Preview,
Development). When it is done, open Settings → Environment Variables and
confirm that `DATABASE_URL` and `DATABASE_URL_UNPOOLED` now exist. Do not
open or copy their values.

**Step 3: the other environment variables.**
In Settings → Environment Variables, add each of these for Production and
Preview:

| Name | Value |
|---|---|
| `SESSION_SECRET` | 64 random hexadecimal characters (see below) |
| `CRON_SECRET` | 32 random hexadecimal characters |
| `VITE_DATA_SOURCE` | `server` |
| `ALLOWED_ORIGIN` | the project's production URL, e.g. `https://billing-xyz.vercel.app`, with no slash at the end. Take it from the project's Domains or Overview page. |

To generate the random values without showing them in chat: open the browser
console on any page (F12 → Console) and run
`[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('')`
for SESSION_SECRET (gives 64 characters) and the same with `16` instead of
`32` for CRON_SECRET (gives 32 characters). Copy the output into the Vercel
field directly.

**Step 4: load the schema into the database.**
Open the database in Vercel's Storage tab and use "Open in Neon" (or go to
console.neon.tech and pick that project). Open the SQL Editor. Open the schema
link above, click Raw, select all the text and copy it. Paste it into the SQL
Editor and run it. It is about 1,570 lines and should finish without errors;
its last statement records nine migrations. Then run
`SELECT version FROM schema_migrations ORDER BY version;` and confirm nine
rows, the last being `009_bank_match_once.sql`. If the first run reports that
a table already exists, stop and tell me: the database is not empty and I
need to decide what to do.

**Step 5: deploy.**
In the project's Deployments tab, open the menu on the latest deployment and
choose Redeploy (without the build cache). Wait for it to finish. If the build
fails, open its log and tell me the first error line.

**Step 6: check it.**
Open `<production URL>/api/health` in a new tab. Tell me the values of
`status`, `database.reachable`, `database.encrypted` and `schemaVersion`.
Success looks like `"status":"ok"`, `reachable: true`, `encrypted: true` and
`schemaVersion: "009_bank_match_once.sql"`. If instead you see
`"error":"misconfigured"`, tell me the `detail` text (it names a variable,
never a value). Then open the production URL itself and tell me whether you
see the SocietyBooks sign-in screen.

When all six steps are done, give me a short summary: the production URL,
which variables are set (names only), the health result, and anything that
did not go as described.

---

## After it finishes

The site will show the sign-in screen, but a fresh production database has no
society and no accounts yet, so nobody can sign in. Creating the first society
and the secretary's account needs a bootstrap step that the project does not
have yet; ask for `db:bootstrap` to be built.
