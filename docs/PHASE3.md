# Phase 3 — persistence, and the database foundation

## Test results, as executed

| Suite | Result | Where it runs |
| --- | --- | --- |
| Engine typecheck, strict + noUnusedLocals | 0 errors | tsc |
| App typecheck | 0 errors | tsc against hand-written stubs |
| Unit | **ALL 73 PASSED** | node |
| Integration | **ALL 59 PASSED** | node |
| Persistence | **ALL 34 PASSED** | node |
| Browser | **ALL 23 PASSED** | Chromium, real page reload, real localStorage |
| Database | **ALL 35 PASSED** | PostgreSQL 16.13, real constraints |
| **Total** | **224 checks** | |
| Production build (`vite build`) | **could not run** | see below |

The 132 checks from Phase 2 are all still passing and unmodified in substance.

## Priority 1 — persistence. Done.

The ledger and the register are serialised to a versioned snapshot and restored
on load. What that cost, concretely:

**Restoring is not a replay.** `Ledger.restore` puts an entry back with its
original id, idempotency key and timestamps. Replaying the business
transactions would re-derive amounts from today's config and could change a
figure a member was already billed.

**The initialisation race is gone.** `createBooksStore` loads from the
repository *synchronously before it returns*, so there is no window in which a
screen can read an empty store. `App.tsx` holds it in `useState(() => ...)`
rather than `useMemo`, because useMemo is a hint React may discard and re-run,
and a second store over the same storage would be a second writer.

**Seed data imports once, ever.** `importSeedOnce(name, …)` records the name in
the snapshot, so a refresh does not import the demo invoices on top of what was
restored. It also declines when the ledger already holds postings, and declines
outright in production mode.

**Demo and production books cannot mix.** The snapshot carries its mode. Loading
demo books into a production store is refused with the reason, and an exported
demo file cannot be imported into production.

**A corrupt snapshot is refused, not loaded.** `validateSnapshot` reports every
problem — an entry that does not balance, an unknown account, an impossible
date, two entries with one idempotency key, two live documents for one flat and
period — and the unreadable value is left in storage rather than deleted, so a
human can recover it.

**Storage failure is visible.** A write that throws sets `saveError` and adds to
`problems`; `describe()` states plainly that the books are in this browser only,
reach no server and are not backed up.

**One invoice list.** `src/store/invoiceView.ts` merges register documents with
the legacy seed array. The register wins for any flat and period it holds, so a
bill never appears twice, and every row says whether it came from the register
(ledger behind it, status derived) or the seed (no postings, stored status).

## Priority 2 — the database. Schema done and executed; no API.

`server/migrations/` holds two migrations, applied to a real PostgreSQL 16.13
server in this session, with 35 tests proving the database enforces what the
engine enforces.

Proved against the live database: an unbalanced entry cannot be committed, an
entry's legs must agree with its stated totals, fewer than two legs is refused,
a control-account leg must name a party, an idempotency key is unique per
society and free to repeat across societies, a journal entry cannot be deleted,
an audit row cannot be deleted or edited, two live documents for one flat and
period are impossible, and two current owners of one flat are impossible.

Verified a second way: migration 001 alone was applied to a scratch database
and exactly the five checks that depend on migration 002's triggers failed,
with everything else still passing. The tests depend on the constraints they
claim to test.

**There is no HTTP API, and that is deliberate.** It would have to be written
against `pg`, which this environment cannot install — the npm registry returns
403 — so it could not be run or tested. An untested server handling money is
worth less than no server. `server/README.md` says what swapping the `psql()`
helper for a `pg` pool involves.

## Priority 3 — partially. Model, not enforcement.

The schema has the whole identity model: `owners`, `flats`, `flat_ownership`
with dates and a partial unique index for one current holder per role,
`users`, `user_roles` across all five roles, `sessions` with hashed tokens, and
`login_codes` with hashed codes.

`'B-204'` is now one named constant, `DEMO_RESIDENT_FLAT`, read by the ten
expressions that each had it written out. Wiring a real owner record is one
change rather than ten.

**Not done:** server-verified login, and permission enforcement on the server.
Both need the API. The OTP is still generated and displayed in the browser, and
the admin PINs are still `1111` and `2222` in the frontend. The schema
deliberately has no column that could store them.

## Priority 4 — not started.

No scheduled PI generation, no PDF invoices or receipts, no email delivery or
failure tracking. `dispatch_attempts` exists with `delivered BOOLEAN NOT NULL
DEFAULT false` and a `failure` column, so the tracking has somewhere to go.
Nothing in the application claims a delivery: release records
`channel: 'none-configured'`, `delivered: false`.

## Priority 5 — production build and UI end-to-end: not done

`vite build` **cannot run here.** There is no `node_modules` and the npm
registry returns 403, so react, react-dom, vite, tailwind, lucide-react and
recharts are not installable. The React screens have never been built or
rendered in this environment, in any phase.

What the browser suite does cover is real: Chromium, a real `http://` origin, a
real `localStorage`, and a real `page.reload()`. It drives the store and the
persistence layer exactly as the app does. It does not touch the React
components.

That suite was itself checked by breaking the code: with `repository.save`
removed, 10 of its 23 checks fail; with the load removed, 9 fail; with `docRef`
dropped from the snapshot, 6 fail.

One honest correction from this session: the first time I ran that mutation
check it reported the suite as catching the defect, and it was not — the test
did not build `.browser-build`, so both the sound and the broken run failed
identically on missing modules. `browser-test.mjs` now builds first, and the
mutation results above are from after that fix.

## Not claiming production readiness

Specifically not ready: no API, no server-side authorisation, no real login,
demo PINs still in the frontend, no backup or restore beyond a JSON export, no
period close or month-end lock, no GSTR-1/3B, no TDS challans or returns, no
bank reconciliation, no PDF documents, no email, and a UI that has never been
built.

## Remaining Mani Vista PDF requirements

**The PDF has still not reached this session.** Four messages have referred to
it; the uploads directory holds only the three zips from earlier work. Nothing
below is checked against it.

Blocked on the document:

| Requirement | What is unknown |
| --- | --- |
| Area basis for ₹4.50/sq ft | Carpet, built-up or super built-up — roughly a third between them. Placeholder in config, behind the approval gate, so it cannot bill. |
| The six receipt heads | Six accounts exist with names inferred from the brief; the PDF's definitions and which are taxable are not known. |
| GST applicability | Turns on turnover and the ₹7,500 threshold. A config flag. |
| Due day, dispatch schedule | `dueAfterDays: 10` is a placeholder. The 6:00 AM IST dispatch was mentioned second-hand. |
| Opening arrears and advances | Per-flat figures. `postOpeningBalances` refuses an opening position that does not balance; no figures entered. |
| Non-occupancy surcharge | Field exists on the flat and in the schema; rate and basis do not. |
| Sinking fund through income or direct to fund | Changes the surplus and the balance sheet. No default. |
| Society registration number and GSTIN | Nullable in the schema and never populated with a sample. |
| SLA targets for the helpdesk | 4/48/72 hours and five working days were mentioned second-hand. |
| MyGate CSV format, CESC consumer IDs | Neither integration started. |
