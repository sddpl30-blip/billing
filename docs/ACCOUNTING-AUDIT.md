# Audit of the existing financial posting logic

State audited: commit `11fd089`, before the accounting engine. Everything
below was read out of the source and recomputed from `src/data.ts`; none of it
is inferred from the UI.

## 1. How much posting logic there actually is

Four call sites construct a `JournalEntry`, and five rows are seeded. That is
the whole of the accounting:

| Site | Trigger | Posting |
| --- | --- | --- |
| `App.tsx:334` | Resident pays | Dr Operating Cash Bank / Cr Maintenance Receivable |
| `App.tsx:371` | Advance deposit | Dr Operating Cash Bank / Cr Unearned Advance Revenue |
| `App.tsx:513` | Vendor bill approved | Dr Vendor Payable / Cr Operating Cash Bank |
| `App.tsx:523` | Vendor bill approved | Dr Vendor Payable / Cr TDS Withholdings Payable |

`JournalEntry` allows exactly one debit account and one credit account, so a
transaction with three legs — which a vendor bill with TDS is — cannot be
expressed. That type is the root cause of most of what follows.

## 2. Invalid postings

**2.1 No expense account is ever debited.** `App.tsx:509` carries the comment
`// 1. Debit Vendor Services Expense = Net Payable`, but the code on the next
line sets `debitAccount: 'Vendor Payable: ...'`. Grepping the whole app,
`Vendor Payable` is debited twice and **credited nowhere**. So approving a
vendor bill books no expense and leaves the payable with a debit balance equal
to the gross. Income & Expenditure cannot be derived even in principle,
because no expenditure has ever been recorded.

**2.2 Seed row `j-3` records a tax without the transaction it came from.**
`Dr Water Supply Vendor A/c ₹1,080 / Cr TDS Payable ₹1,080`. A vendor bill
needs three legs — Dr expense, Cr payable (net), Cr TDS (withheld). This row
posts only the third, debits a payable, and books no expense.

**2.3 Seed row `j-4` spends a fund instead of recording a cost.**
`Dr Lift Maintenance Reserve ₹15,400 / Cr Bank`. A repair is expenditure; this
charges it to a reserve, keeping ₹15,400 of real cost out of I&E.

**2.4 Seed row `j-5` contradicts its own narration.** Described as a
"Transfer to Sinking Surcharge Fund" but posted `Dr Bank / Cr Sinking Fund
Reserve` — which *increases* cash. That is the posting for a contribution
collected, not a transfer out. One of the two is wrong and the entry does not
say which.

**2.5 Receivable goes credit-side from the seed alone.** `j-1` bills ₹3,30,000
and `j-2` collects ₹3,79,500 against it.

**2.6 Partial payment closes the invoice.** `handleExecutePayment` posts the
amount actually tendered but sets `status: 'Paid'` unconditionally. ₹2,000
against a ₹10,620 invoice marks it settled and credits the receivable ₹2,000,
so the ledger and the invoice list disagree by ₹8,620 with no record of why.

**2.7 There is no chart of accounts.** Seven account names are invented across
five seed rows, as free-text strings. `Vendor Payable: ${vendorName}` mints a
new account per vendor at runtime. Nothing constrains a typo into an account.

### Seeded trial balance, recomputed

| Account | Balance (Dr +) | |
| --- | --- | --- |
| Operating Cash Bank A/c | ₹4,24,100 | |
| Lift Maintenance Reserve | ₹15,400 | a fund carrying an asset balance (2.3) |
| Water Supply Vendor A/c | ₹1,080 | a payable carrying an asset balance (2.2) |
| TDS Payable A/c | −₹1,080 | |
| Maintenance Receivable Account | −₹49,500 | an asset carrying a credit balance (2.5) |
| Sinking Fund Reserve | −₹60,000 | |
| Operating Income Fund | −₹3,30,000 | |
| **Sum** | **₹0** | |

The sum is zero, and that fact is worthless: every row is one debit and one
credit of the same amount, so the total cannot be anything but zero no matter
how wrong the accounts are. Three of the seven balances are on the wrong side
and no expense account exists at all.

## 3. Hardcoded financial figures in the reports

The three statements do not read the journal. `journal` appears in only three
places in `App.tsx`: a record count, and two list renders. Every figure in
Income & Expenditure and the Balance Sheet is either a literal or derived
straight from the invoice array.

Fourteen literals, seven distinct, each written twice because the desktop
(`1774`–`1835`) and mobile (`3085`–`3142`) report blocks are duplicated:

| Figure | Appears as |
| --- | --- |
| ₹60,000 | "Capital Sinking reserve levies allocation" |
| ₹1,450 | "Compounded late payment interest penalty collected" |
| ₹49,000 | "Water supplier tank utility outgoings" |
| ₹1,52,600 | "Common guards security salaries & lift maintenance" |
| ₹8,20,000 | "Operating bank account cash assets balance" |
| ₹12,60,000 | "Accumulated Sinking Contributions Reserve Fund" |
| ₹48,20,000 | "Retained Corpus Trust Surcharge reserve Account" |

Plus the budget tab (`1883`), four rows of literal budget/realised/variance,
and two `₹3,79,500` strings in narrative text (`1677`, `2988`).

### Two figures that contradict themselves on screen

**Income & Expenditure is internally inconsistent by ₹41,238.** Under a
heading reading "MTD Accruals":

```
Operating Gross Revenue   ₹5,05,588   = collected + outstanding + 60000 + 1450
less expenses shown       ₹2,01,600
revenue − expenses        ₹3,03,988
NET SURPLUS as coded      ₹2,62,750   = collected + 60000 + 1450 − 49000 − 152600
difference                  ₹41,238   = outstanding, included in revenue, dropped from surplus
```

The revenue line is accrual, the surplus line is cash, and both are labelled
as the same basis.

**The Balance Sheet is out by ₹52,18,762 and shows no totals.**

```
Assets        ₹8,61,238   = 820000 + arrears
Liabilities   ₹60,80,000  = 1260000 + 4820000
out by        ₹52,18,762
```

Four labelled numbers in two columns with no total line, which is why nothing
flagged it.

**A budget variance is arithmetically wrong.** Covered Parking: ₹21,000
realised against ₹25,000 budgeted is −16.00%, printed as −16.03%.

## 4. Statements that do not exist

- `reportsSubState` is typed `'ie' | 'bs' | 'cf'`, but **no code branches on
  `'cf'`** and no button sets it. There is no Cash Flow statement, and no
  Receipts & Payments statement anywhere.
- The journal list labels every debit "Dr asset" and every credit
  "Cr liability", which is wrong whenever the leg is income or expenditure,
  and prints "Reconciled Balanced" on every row without checking anything.
- No general ledger, no account-wise view, no period close, no reversals.

## 5. Chart of accounts the engine needs

Derived from what the app already transacts plus the heads an RWA has to
report on. Two treatments are marked because they are judgement calls a CA
must confirm, not facts this code can decide.

**Assets** — Bank (operating), Bank (sinking fund), Cash on hand, Maintenance
receivable (control), Other receivables, Fixed deposits (sinking fund),
Accrued FD interest, GST input credit.

**Liabilities** — Vendor payables (control), TDS payable by section, CGST
output payable, SGST output payable, Member advances, Deposits held.

**Funds** — Sinking Fund, Festival & Event Fund, General reserve /
accumulated surplus.

**Income, one per receipt head** — Maintenance charges, Festival & event
collections, Common space rental, Reimbursable expense recoveries, Other
receipts, Late payment interest.

**Expenditure** — Water supply, Security, Lift maintenance, Repairs,
Common-area electricity, Housekeeping, Audit & professional fees, Bank
charges, Festival & event expenses, Depreciation.

### Two treatments requiring CA sign-off

1. **Sinking fund contributions: income, or a direct credit to the fund?**
   Charging them through I&E as income and then appropriating to the fund, or
   crediting the fund directly, give different surpluses and different
   balance sheets. Both are seen in practice. The engine takes this as a
   config flag and does not pick a default silently.
2. **Whether GST applies to maintenance at all**, which turns on the
   association's turnover and the ₹7,500 per-member threshold, and therefore
   on facts this code does not have.

Both sit in `src/accounting/config.ts` with `effectiveFrom` dates and are
marked as demo values pending confirmation.

## 6. Preserved during the rebuild

The engine is added alongside the existing code. `JournalEntry`, `src/data.ts`
and all four existing posting sites keep working until the replacements pass
their tests, so the app stays runnable at every commit.
