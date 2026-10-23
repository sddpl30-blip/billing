# The accounting engine

`src/accounting/` is a double-entry engine with no dependency on React,
localStorage, the DOM or `src/data.ts`. `adapter.ts` is the only file that
knows the demo's data shapes; replacing it with calls to a server is the whole
of what moving to Postgres requires.

```
npm run test:accounting   # 73 checks
npm run demo:accounting   # prints a month of postings and all four statements
npm run typecheck         # app + engine, engine under strict + noUnusedLocals
```

## Files

| File | What it holds |
| --- | --- |
| `money.ts` | Integer paise, Indian formatting, half-up percentages, `allocate` |
| `accounts.ts` | Chart of accounts, classes, normal balances, the six receipt heads |
| `journal.ts` | `Posting`, `JournalEntry`, validation, `Ledger`, reversal, subledgers |
| `transactions.ts` | The only sanctioned writes: billing, receipts, vendor bills, TDS, GST, funds |
| `reports.ts` | Trial balance, I&E, Receipts & Payments, Balance Sheet, cross-reconciliation |
| `budget.ts` | Budget (declared) against actuals (derived) |
| `config.ts` | Rates and policy, each with `effectiveFrom`, behind a CA sign-off gate |
| `adapter.ts` | Imports the demo's invoice and vendor arrays into a ledger |
| `uiReports.ts` | The one place paise become rupees, for the React screens |
| `selftest.ts` | The test suite |
| `demo.ts` | Prints a worked month |

## Design decisions worth knowing

**Money is integer paise.** Rupees as floats cannot represent most
two-decimal amounts, so a trial balance compared with `===` eventually fails
on drift alone. Rupees exist only at the edges: `fromRupees` in, `formatRupees`
out.

**A posting is rejected, not corrected.** `Ledger.post` refuses an entry that
does not balance, has fewer than two legs, names an account outside the chart,
carries a negative or fractional amount, puts a debit and a credit on one leg,
or omits the party on a control account. A rejected entry changes nothing.

**Every transaction carries an idempotency key** derived from the business
event (`bill:B-204:Jul 2026`, `receipt:RCT-101`). Posting the same key twice
throws, which is what makes re-running a monthly billing job safe.

**Nothing is ever deleted.** A correction is a reversal: the mirror image is
posted, the original keeps its place, and the two point at each other. A
reversal cannot itself be reversed, and an entry cannot be reversed twice.

**Statements are derived, and say so when they do not tie.** There is no
literal amount and no balancing line anywhere in `reports.ts`. The balance
sheet reports its `difference` rather than plugging it, and the UI shows a red
banner if it is ever non-zero.

**Booking and paying are separate.** `bookVendorBill` debits the expense at
gross, credits the payable net of tax and credits the TDS withheld.
`payVendorBill` is a different transaction and will not pay more than the
payable outstanding.

**Part payment is the normal case.** `receiveFromMember` applies the receipt
against the flat's outstanding receivable and credits anything beyond it to
member advances. Nothing marks an invoice "paid" — the receivable balance is
what is owed.

## The two choices the engine will not make for you

Both live in `config.ts` with no safe default, and
`assertConfigReviewed` throws until a CA has signed the config off:

1. **Whether GST applies to maintenance at all**, which turns on the
   association's turnover and the ₹7,500 per-member threshold.
2. **Whether sinking fund contributions go through income** and are then
   appropriated, or are credited to the fund directly. Both are used in
   practice and they give different surpluses and different balance sheets.

Every rate in `config.ts` is marked `DEMO VALUE — to be verified by a CA`, and
`outstandingConfirmations()` lists them for display on screen.

## How the tests are checked

Passing tests prove nothing on their own, so each one was checked against a
deliberately broken engine. 31 mutations were introduced one at a time —
plugging the balance sheet difference to zero, hardcoding `balanced: true`,
closing an invoice on a part payment, debiting the payable instead of the
expense, dropping the duplicate guard, rounding each allocation share
independently, truncating instead of rounding, ignoring the stated tax on an
import — and the suite must fail on every one. It does, on all 31.

Four of those mutations survived the first time. Three were tests asserting a
flag the code sets rather than the arithmetic behind it, which is why
`debitsEqualCredits`, `cashFlowCloses` and `assembleBalanceSheet` are exported:
on real ledger data those predicates are always true, so the only way to prove
they are computed is to call them with figures that do not tie. The fourth was
`statedTax`, which had no test at all.

One mutation also found a wrong assertion of mine rather than a wrong
implementation: `percentOf(₹150.05, 1%)` is 150.05 paise, which rounds *down*
to 150. The code was right and the test was wrong.

## What is not built

- **The engine is a read model over the existing arrays.** `App.tsx` still
  writes to `invoices` / `vendorInvoices` / `journal` through the old handlers;
  `buildStatements` derives the books from those arrays on every change. The
  statements are therefore real, but the write path is not in the engine yet.
  That is the next step and no screen will need to know when it happens.
- **No persistence.** A `Ledger` is in memory and rebuilt from the arrays on
  each render. There is no period close, no month-end lock, and no stored
  opening trial balance.
- **No GSTR-1 or GSTR-3B output, no TDS challan or quarterly return.** The
  liabilities those are built from exist and balance; the returns themselves
  do not.
- **No area-based billing.** `billMaintenance` takes amounts, not a rate times
  a billing area, and the member record still has no area field.
- **Opening balances are zero.** The adapter posts none, because the demo data
  contains no evidence of a prior position. The old reports showed ₹8,20,000 of
  cash and ₹60,80,000 of reserves; those were literals in the JSX, not
  transactions, so they were not carried over. Real opening balances go through
  `postOpeningBalances`, which rejects an opening position that does not
  balance rather than plugging it to a reserve.
