# The API

Every route is under `/api`. Everything is JSON. Everything except health and
sign-in needs a session, and every write except sign-in needs a CSRF header.

## Signing in

```
POST /api/auth/password        { email, password }
POST /api/auth/request-code    { email }                 → issues a one-time code
POST /api/auth/verify-code     { email, code }
POST /api/auth/sign-out
GET  /api/auth/me
```

A successful sign-in sets two cookies:

- `sb_session` — `HttpOnly`, `SameSite=Strict`, `Secure` in production. The
  session token is never in the response body, so a script that can read the
  response cannot read the session.
- `sb_csrf` — readable by the page on purpose. Send its value back in the
  `X-CSRF-Token` header on every write. A cross-site form post can send the
  cookie but cannot set the header, which is the whole mechanism.

Roles and flat access are read from the database on every request, not carried
in the cookie, so revoking a role takes effect immediately.

`request-code` answers the same way whether or not the address is on file.
Telling a caller that an address is unknown turns the endpoint into a way to
enumerate the society's members.

**Codes are not delivered.** The OTP adapter has no provider behind it. In
development `OTP_PROVIDER=local-dev` writes the code to the log; in production
that setting is refused and `none` makes the server decline to issue codes at
all. The response's `delivered` field says which.

## Money, and idempotency

`POST /api/payments`, `POST /api/vendor-bills/:id/pay` and
`POST /api/tds/:quarter/remit` require an `Idempotency-Key` header of at least
8 characters. The key becomes a unique constraint in the database, so a retry
is a no-op and two concurrent requests with one key produce one payment — the
second's transaction rolls back whole and the response is `409`.

A missing key is `400`, not a generated one: a client that does not send a key
cannot be given at-most-once semantics, and inventing one server-side would
defeat the point, since the retry would get a different one.

## What the responses say about the outside world

Several responses carry a `posted` field and a `note`. They are there because
the version of this app before it had a backend reported things that had not
happened.

- A billing run returns `posted: false`. A proforma has no accounting effect.
- Releasing an invoice returns `delivered: false` and a reason when no email
  provider is configured. A `dispatch_attempts` row is still written, recording
  the attempt and the failure.
- Paying a vendor returns a note saying no transfer was initiated. Nothing in
  this system can instruct a bank.
- The GST report returns `filed: false`. There is no GSTN connection.
- A TDS remittance records a challan you supply. Nothing is filed with the
  income-tax portal.

## The snapshot the screens read

```
GET /api/books/snapshot?asAt=YYYY-MM-DD
```

The books in the shape the client's accounting engine already understands, so
the React screens run against the database without being rewritten: the
browser rehydrates the same `Ledger` and `BillingRegister` it used to build
from `localStorage`, and every figure in them came from the server.

Scoped to what the caller may see. With `invoice.read.any` — manager,
treasurer, secretary, auditor — the whole society. Without it, only the
caller's own flats: their documents, and the entries that touch them. A
resident gets the whole of each of their own entries, including its bank and
income legs, because those legs are the composition of their own invoice or
their own receipt; they get nothing about another flat and nothing about a
vendor.

The scope is `invoice.read.any` rather than `ledger.read` deliberately. Every
figure the screens show is derived from these postings, so an account that may
see every invoice has to be given the postings behind them or its screens show
zeroes. `ledger.read` gates browsing the journal itself, at
`/api/ledger/entries`, which is a different thing.

It also carries the society's own identity — name, registration number, GSTIN
— and each is null until the association records it. The screens print "not on
record" rather than a placeholder, because a registration number next to the
words "Society GSTIN" is a legal assertion.

## Documents

```
GET /api/billing/documents/:id/pdf?regenerate=true
GET /api/payments/:id/pdf
```

`application/pdf`, rendered by a PDF writer in this repository — there is no
PDF library here and none can be installed, so it emits the file format
directly with the base-14 fonts every reader has built in.

A document is rendered once from a payload that is then stored, so a reprint is
byte-identical: an invoice is a legal document and regenerating it from live
data would quietly reissue it with today's figures. The response says which it
was in `X-Document-Reprinted`. `?regenerate=true` renders afresh.

A resident may print their own flat's documents and no others. An unapproved
draft has nothing to print and says so.

What is not on these documents: a GSTIN, a registration number or a bank
account, unless the society has actually recorded one. A document from a
`demo`-mode society is marked as demonstration data on its face.

## Credit and debit notes

```
POST /api/billing/documents/:id/notes   billing.cancel
GET  /api/billing/notes
```

A note adjusts what a member owes against an invoice already issued, so it sits
with the role that may cancel one. Only against a tax invoice: before
conversion there is no receivable to adjust, and the proforma should be changed
instead.

A credit note credits the receivable and takes the income back out; a debit
note is the mirror. `withTax` decides whether it carries tax, and a note that
would carry an unapproved tax is refused.

It is recorded in the GST register with positive figures and the kind of
document it is, because a return reports a note in its own table rather than as
a negative invoice. The summary nets them — see migration 006.

## Notifications

```
POST /api/billing/periods/:period/notify   billing.release
GET  /api/notifications
```

Queues a message per document for the period whose flat has a current owner
with an address, and reports the flats without one rather than dropping them.
The response is explicit that `sent` is 0: the dispatch job sends, and only a
provider's own acceptance moves a row to `sent` — the database will not accept
that state without a provider and its message id.

The dispatch job attaches the document, generated from the stored payload, so
what the member receives is the same bytes as the copy on file.

## Administration

```
GET  /api/users                      user.manage
POST /api/users                      user.manage
POST /api/users/:id/roles            user.manage
POST /api/users/:id/deactivate       user.manage
POST /api/flats                      member.manage
POST /api/flats/:id/owner            member.manage
```

An account cannot be given `manager` together with `treasurer` or `secretary`:
that one account could then raise a bill and approve it. Refused when the roles
are handed out, not only when they are used.

A role change takes effect at once — sessions carry no roles, they are read on
every request — and both sides of the change are in the audit trail.
Deactivating an account revokes every session and burns any outstanding login
code; a session that lives until its cookie expires is not deactivation. You
cannot deactivate your own account.

A flat needs its billing area and the basis together or neither: the same rate
over carpet and over super built-up area differs by about a third, so neither
can be assumed. A change of owner ends the previous holder's tenure the day
before the new one starts, and anything already outstanding stays against the
flat — a new owner does not inherit it and it is not cleared.

## Going live

```
POST /api/flats/import                       member.manage
GET  /api/opening-balances                   report.read
POST /api/opening-balances/draft             settings.manage
POST /api/opening-balances/:id/discard       settings.manage
POST /api/opening-balances/:id/approve       period.close
POST /api/opening-balances/:id/reverse       period.close
POST /api/advances/apply                     payment.record or billing.convert
GET  /api/society                            report.read
PUT  /api/society                            settings.manage
```

**Flat import.** `{ csv, dryRun, filename?, heldFrom? }`, at most 512 KB. The
header row names the columns, case-insensitively and with common spellings
accepted (`Flat No`, `Wing`, `Area (sq ft)`, `E-mail`, `Mobile`, …):

```
flat_no,tower,floor,area_sqft,area_basis,owner_name,owner_email,owner_mobile,co_owner_name,co_owner_email,owner_pan
```

`flat_no`, `area_sqft`, `owner_name` and `owner_email` are required;
`area_basis` defaults to the basis of the approved rate (super built-up if
none). Every row is checked first and each problem comes back with its line
number; a file with any problem writes nothing (400 on commit). A repeated flat
number or address within the file is a problem. Flats match by number and
owners by address, so importing the same file again reports every row
unchanged. Each owner and co-owner gets a resident account with no password —
they sign in by emailed code — linked to their owner record. The audit row
carries counts and the file's SHA-256, not its contents.

**Opening balances.** The draft takes `{ asAt, autoBalance, dryRun, note?,
accountLines[], flatsCsv? | flatLines? }`. The per-flat CSV is

```
flat_no,opening_due,opening_advance,due_since
```

in rupees (`due_since` optional, for ageing). A flat has a due or an advance,
not both. Account lines are balance-sheet accounts only, one side each; a
vendor payable (2000) names `vendorId`, `reference` (the bill number) and
`expenseAccount`. With `autoBalance` the difference posts to 3020 General
reserve as the balancing figure; without it an unbalanced batch saves but
cannot be approved. Approval — by someone other than whoever saved the draft —
posts one journal entry dated `asAt` (`source_kind` `opening-balance`): each
due becomes a document numbered `OB/<batch>/<n>` in state `tax-invoice` that
receipts settle oldest-first and ageing reports, each advance a credit on 2300,
each payable a booked vendor bill. No GST, and no GST register row (a trigger
refuses one). One batch per society may stand; a correction is
`/reverse` (refused once anything has been settled against an opening item)
and a new draft. It is refused while any other entry is dated on or before
`asAt`.

**Advances.** `{ on, flatId? }` sets each flat's advance against its open
invoices, oldest first: debit 2300, credit 1100 per invoice.

**Society profile.** GSTIN is checked for shape, its check character, and that
it begins with the state code; TAN is `AAAA99999A`. Changes are audited with
before and after. Documents generated afterwards carry the new details; one
already issued keeps what it was issued with.

## Reference

### Billing

| | |
| --- | --- |
| `POST /api/billing/run` | `billing.run`. Issues a period's proformas. Idempotent per flat and period: a second run skips what is already billed and says so per flat. |
| `GET /api/billing/documents` | `?period=&state=&asAt=`. A resident sees only their own flats. `paymentStatus` is derived from what has been allocated, never stored. |
| `POST /api/billing/documents/:id/approve` | `billing.approve`. Refused if the approver is the person who ran the billing — a CHECK on `approvals`, not an application rule. |
| `POST /api/billing/documents/:id/release` | `billing.release`. Records a dispatch attempt with whatever the provider actually said. |
| `POST /api/billing/documents/:id/convert` | `billing.convert`. This is where the receivable and the GST arise. Refuses an unapproved proforma and an unapproved tax treatment. |
| `POST /api/billing/documents/:id/cancel` | `billing.cancel`. A posted invoice is reversed, never unposted. |

### Receipts

| | |
| --- | --- |
| `POST /api/payments` | `payment.record`. Allocated oldest invoice first, or against one named invoice. Anything beyond the dues is credited to member advances, not left pushing the receivable the wrong way. |
| `GET /api/payments` | `payment.read.own` or `payment.read.any`, with the allocations. |
| `POST /api/payments/:id/reverse` | `payment.reverse`. Posts the mirror entry; both stay in the ledger. |
| `GET /api/flats/:id/dues` | The flat's open invoices, its advance, and what it actually owes net of that. |

### Vendors

| | |
| --- | --- |
| `GET`/`POST /api/vendors` | `report.read` to list, `vendor.manage` to add. Last four digits and IFSC only; there is no column for anything more. |
| `POST /api/vendors/:id/bills` | Enters a bill for approval and computes the withholding — 2% under 194C for a company, 1% for an individual or HUF, 10% under 194J and 194I. A lower-deduction certificate is an explicit `tdsRateBps` override, recorded on the bill. |
| `POST /api/vendor-bills/:id/approve` | `vendor.bill.approve`. Posts nothing. |
| `POST /api/vendor-bills/:id/book` | `vendor.bill.book`. Expense at gross, payable net of tax, TDS withheld. |
| `POST /api/vendor-bills/:id/pay` | `vendor.pay`. The only call that moves the bank. Refuses to pay more than is outstanding. |
| `POST /api/tds/:quarter/remit` | `tds.remit`. Clears the liability against a challan number you supply. |

Approval, booking and payment are three separate calls on purpose. The demo
collapsed them into one button, which is how an expense, a liability and a bank
movement all appeared the moment somebody clicked Approve.

### Banking

| | |
| --- | --- |
| `GET /api/bank-accounts` | With each account's ledger balance. |
| `POST /api/bank/imports` | `bank.import` (manager). CSV or MT940 text. The same file twice is refused on a content hash; a line already seen is skipped on a dedupe key. Posts nothing. |
| `GET /api/bank/transactions` | `?state=`. Each unmatched line comes with a suggestion — same amount within three days, not already matched — labelled as a suggestion. |
| `POST /api/bank/transactions/:id/match` | `bank.match`. One of `paymentId`, `vendorPaymentId` or `suspenseReason`. A match whose amount disagrees is refused. |
| `POST /api/bank/reconciliations` | `bank.reconcile`. Signed off only when the difference is zero, which the database also enforces. |

### Reports

All of these read the same `journal_postings`. Two reports can only disagree if
the ledger disagrees with itself, and a deferred trigger makes that impossible
to write.

```
GET /api/reports/trial-balance?asAt=
GET /api/reports/balance-sheet?asAt=
GET /api/reports/income-expenditure?from=&to=
GET /api/reports/ageing?asAt=
GET /api/reports/collections?from=&to=
GET /api/reports/gst?taxPeriod=YYYY-MM
GET /api/reports/tds?quarter=Q2-FY26-27
GET /api/reports/statement/:flatId?from=&to=
GET /api/ledger/entries?from=&to=          ledger.read
GET /api/audit                             audit.read
```

`trialBalance.tiesOut` and `balanceSheet.balances` are comparisons of two
independently summed figures, not flags anything sets. The collection rate is
collected over billed in basis points — not a percentage a screen can choose.
`gstSummary.agrees` compares the GST register against the output-tax accounts,
because a return filed from a register that has drifted from the books is the
kind of thing nobody finds until an assessment.

### Settings, rates and periods

| | |
| --- | --- |
| `GET /api/settings` | With an `approved` flag on each. |
| `PUT /api/settings/:key` | `settings.manage`. Writing a value does not approve it, and changing a value drops any earlier sign-off: approving 5% does not approve 18%. |
| `POST /api/settings/:key/approve` | `rate.approve`, and a different person. |
| `GET`/`POST /api/rates` | Effective-dated, in paise per square foot, with the area basis the rate is expressed against. |
| `POST /api/rates/:id/approve` | A billing run refuses an unapproved rate. |
| `POST /api/periods/:period/close` | `period.close`. Records the trial balance it closed on, and refuses if that does not tie. Afterwards the database refuses any posting dated in that period. |
| `POST /api/periods/:period/reopen` | `period.reopen`, with a reason. |

### Helpdesk

```
POST /api/tickets                      ticket.create, own flat only
GET  /api/tickets                      own or any, by role
POST /api/tickets/:id/assign           ticket.assign — a person or a vendor, not both
POST /api/tickets/:id/resolve          ticket.resolve
POST /api/tickets/:id/confirm          the resident's call: confirmed, or reopened
```

The due date comes from the category's SLA in hours, and `breachingSla` is
derived from the clock — not a flag somebody has to remember to set.

### Scheduled work

```
GET  /api/jobs
POST /api/jobs    { kind, runKey, scheduledFor, payload }
```

`kind` is `monthly-billing`, `due-date-conversion` or `notification-dispatch`.
`(kind, runKey)` is unique, so a scheduler that fires twice for July bills July
once. A failure is retried with exponential backoff — 1, 2, 4, 8 minutes,
capped at an hour — and when the attempts run out the job is marked failed with
its last error rather than disappearing.

### Health

```
GET /api/health
```

`200` with the schema version and what each provider actually is; `503` with
the reason when the database is unreachable.

## Errors

| status | when |
| --- | --- |
| 400 | the body failed validation; the detail lists every problem, not just the first. An unexpected field is an error, not ignored — a client sending `amountRupees` where the API wants `amountPaise` is told, not charged a hundredth of what it meant. |
| 401 | no session, or a bad one |
| 403 | the permission is named; `csrf_failed` for a missing or mismatched token |
| 404 | no such route, or no such thing |
| 405 | the right path with the wrong verb |
| 409 | a conflict, a replayed idempotency key, or a rule the books rely on — including the messages the database's own triggers raise, which are passed through because they say what was refused and why |
| 413 | a body over 1 MB |
| 429 | rate limited, with `Retry-After` |
| 500 | ours. The message says nothing about internals; the detail is in the log under the same `X-Request-Id`. |

## Roles

| | resident | manager | treasurer | secretary | auditor |
| --- | --- | --- | --- | --- | --- |
| see own invoices and receipts | ✓ | ✓ | ✓ | ✓ | ✓ |
| see every flat's | | ✓ | ✓ | ✓ | ✓ |
| run a billing cycle | | ✓ | | | |
| approve a bill | | | ✓ | ✓ | |
| record a receipt | | ✓ | | | |
| reverse one | | | ✓ | | |
| enter a vendor bill | | ✓ | | | |
| approve, book and pay one | | | ✓ | | |
| import and match a statement | | ✓ | ✓ | | |
| sign off a reconciliation | | | ✓ | | |
| close a period | | | ✓ | | |
| reopen one | | | | ✓ | |
| manage settings and users | | | | ✓ | |
| read the audit trail | | | | | ✓ |

Two absences are deliberate. No role holds both `billing.run` and
`billing.approve` — that separation is the maker-checker rule, and granting
both to one role would void it. And `auditor` holds no write permission at all.
