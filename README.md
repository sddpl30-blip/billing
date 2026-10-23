# SocietyBooks — housing society billing and accounts

A resident-welfare-association (RWA) billing demo for an Indian housing
society. Three roles share one dataset:

- **Resident** — their own bill, its break-up (maintenance, sinking fund,
  water, parking, non-occupancy, late penalty, GST), payment history,
  receipts, advance deposits and a complaint ticket.
- **Manager** — invoice runs per wing, receivables ageing, reminders,
  member CRUD, vendor bills with TDS deducted at source, and the complaint
  queue.
- **Committee** — the books: general journal, trial balance, income &
  expenditure, receipts & payments, balance sheet, budget against actuals and
  the audit log. All of these are derived from the double-entry engine in
  `src/accounting/` — see `docs/ACCOUNTING-ENGINE.md`.

Manager and Committee are behind a PIN.

The October 2026 audit — what was found, what was fixed, and what is still
open — is in `docs/AUDIT-2026-10.md`.

## Running it

```
npm install
npm run dev      # http://localhost:3600
npm run build    # dist/
npm run typecheck        # app and engine, against the installed types
npm run typecheck:stubs  # the same, using types/ where node_modules is absent
npm run test:accounting  # 73 accounting checks
npm run demo:accounting  # prints a worked month and all four statements
npm run test:all         # everything: engine, database, API, both browser suites
```

`PUBLIC_BASE_PATH` sets the base URL, which is how the combined site serves
this under `/society/`.

## Two ways it runs

**On the server.** A PostgreSQL database behind a REST API: every figure is
read from it, every write goes through it, and the server decides what the
signed-in account may do. `VITE_DATA_SOURCE=server` selects this, and it is
what a real association would run. See `docs/DEPLOYMENT.md` to run it locally,
`docs/NEON.md` to point it at a hosted database, and `server/README.md` for the
schema and the API.

```
npm run db:check         # can it reach the database, and over what
node server/migrate.mjs  # the schema
npm run server:seed      # a demonstration society to sign into
npm run server           # the API on :4000
npm run test:all         # every check
```

**On Vercel and Neon, with no server to run.** The same API as one serverless
function, the app as static files beside it, and the scheduler as an endpoint
the platform calls. `api/index.js` hands Vercel's request to the handler
the standalone server uses, so the routes, the rules and the ledger are the
same code — the full API suite runs over both transports. `docs/VERCEL.md` is
the setup, start to finish; it also sets out what Vercel's plans mean for how
often scheduled work can run, and how to live inside the free one.

```
npm run db:migrate              # from your machine, against DIRECT_URL
npm run db:migrate:node         # the same, where psql is not installed
npm run test:serverless         # the function path
npm run test:server:serverless  # the whole API suite through it
npm run test:deploy             # vercel.json, the cron, the rewrite
```

**In the browser.** The same screens on the local accounting engine, with the
sample society in `localStorage` under the `gm_rwa_*` keys. This is what the
published demonstration is, it needs no backend, and it says so in a banner on
every screen. `VITE_DATA_SOURCE=demo` selects it; "Reset Sandbox" wipes it back
to the seed.

Left unset, the app asks the server whether it is there and falls back to the
demonstration. **Set `VITE_DATA_SOURCE=server` for anything real** — otherwise a
deployment whose API is down quietly shows sample figures, and a committee
reading invented numbers and believing them is the failure worth preventing.

## What is still not connected

| | |
| --- | --- |
| Email | An SMTP client is implemented and tested. It needs `SMTP_HOST`, `SMTP_FROM` and a password; with none configured nothing is sent and every response says `delivered: false`. |
| SMS / WhatsApp reminders | Not implemented. The adapter interface exists and refuses. |
| Payment checkout | Not implemented. Receipts record money the association has already received; nothing here takes a payment. |
| Banking | Statement import works from a CSV or MT940 file. There is no bank API connection, and no column anywhere in the schema for a bank credential. |
| GST / TDS filing | The registers and summaries are built and cross-checked against the ledger. Nothing is filed: there is no GSTN or TRACES connection. |
| Sign in with Google | Implemented for members already on file (no sign-up); off until `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. See `docs/GOOGLE-SIGN-IN.md`. |
| Google Sheets sync | Not implemented. Export produces a JSON file; invoices and receipts produce PDFs. |

The GST and TDS rates are society settings with an approval flag, not constants
in the code, and the billing path refuses to charge a tax nobody has signed
off. Whether GST applies to maintenance at all depends on the association's
turnover and the ₹7,500 per-member threshold — have a CA confirm the treatment
and record the sign-off before anyone bills from this. Two further choices sit
in the same `gst.treatment` setting, both off unless set: `sinkingFundTaxable`
(the Sinking Fund line carries GST at the maintenance rate, and the threshold is
tested on maintenance plus sinking fund) and `roundToRupee` (CGST and SGST are
each rounded to the nearest rupee, half up, per invoice and per note).

In the demonstration, residents, flats and amounts are invented placeholders on
the `.invalid` domain, and documents generated from it are marked
"demonstration data" on their face.
