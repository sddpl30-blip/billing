# Phase 2 — engine integration and billing readiness

## The configuration bug, and how it happened

`npm run test:accounting` did not work as shipped. `tsconfig.accounting.json`
set `moduleResolution: "bundler"` with `module: "CommonJS"`, which TypeScript
5.8 — the version this project pins — rejects, because "bundler" requires
`module` to be `esnext` or `preserve`.

It passed here because the sandbox's `tsc` is 6.0.2, which accepts the pairing,
and the npm script invoked whatever `tsc` was on PATH. So the config was
verified against a compiler the project does not use.

Two changes, so it cannot recur:

- `moduleResolution` is now omitted entirely. Both compilers then pick their
  own default for CommonJS and both accept it.
- `scripts/test-accounting.mjs` prefers `node_modules/.bin/tsc` and prints a
  warning when it has to fall back to a `tsc` on PATH. That warning is what was
  missing. It also replaces an npm script that inlined a `node -e` call with
  four levels of quote escaping, which behaved differently on Windows.

## What the money now flows through

```
screens ──▶ src/store/booksStore.ts ──▶ BillingRegister ──▶ transactions ──▶ Ledger
                                              │                                 │
                                              └── document state ───────────────┘
                                                   status is DERIVED, never stored
```

The `invoices` array is still the document list the screens render, but it is
no longer the record of what is owed. The ledger is, and an invoice's status is
read back from it, so the two cannot disagree — which is what they did before.

## The twelve items

| # | Item | Where |
| --- | --- | --- |
| 1 | tsconfig fixed | `tsconfig.accounting.json`, `scripts/test-accounting.mjs` |
| 2 | Payment handler replaced | `App.tsx` `handleExecutePayment` → `books.recordMemberPayment` |
| 3 | Partial payment, derived status | `allocation.ts` `planAllocation`, `deriveStatus` |
| 4 | Vendor booking and payment split | `App.tsx` `handleVendorInvoiceStatus`, `handlePayVendor` |
| 5 | Advances on the member subledger | `booksStore.depositAdvance`, `applyAdvance` |
| 6 | Duplicate billing blocked twice | register flat+period key, plus the engine's idempotency key |
| 7 | Validated dates | `clock.ts`; 7 date literals removed from `App.tsx` |
| 8 | Billing area and effective rates | `types.ts`, `data.ts`, `rates.ts` |
| 9 | ₹4.50/sq ft and configurable GST | `rates.ts`, `config.ts` `maintenance` |
| 10 | PI approval, dispatch, conversion | `documents.ts`, `BillingWorkflow.tsx` |
| 11 | Reports read the live ledger | `uiReports.ts` `buildStatements({ ledger })`, reporting `source` |
| 12 | Integration tests | `integration.test.ts`, 59 checks |

## Two behaviours worth knowing

**A proforma posts nothing.** The receivable and the GST arise when it becomes
a tax invoice — on payment, or on its due date. That is why the register exists:
a document's state and the ledger have to move together.

**Nothing claims to have been sent.** `release` records a dispatch attempt with
`delivered: false` and `channel: 'none-configured'`, because there is no email
or messaging provider. A vendor payment says it was recorded in the books and
that no bank transfer was initiated. A TDS remittance says the liability is
cleared and that nothing was filed with any portal. One mutation test exists
purely to catch `delivered: false` being flipped to `true`.

## Test evidence

```
engine typecheck (strict, noUnusedLocals)   0 errors
app typecheck                               0 errors
npm run test:accounting                     ALL 73 CHECKS PASSED
npm run test:integration                    ALL 59 INTEGRATION CHECKS PASSED
hardcoded money or date literals in App.tsx 0
```

The suites were checked against a broken engine, as in Phase 1: 27 mutations
introduced one at a time, each of which must fail at least one suite. All 27 do.

Six survived the first attempt and each exposed a missing test:

| Mutation that survived | What the suite did not check |
| --- | --- |
| Allocation sort removed | insertion order already matched date order in the fixture |
| `deriveStatus` never returns `Overdue` | no unpaid past-due case |
| `outstandingOf` ignores the conversion check | no flat owing on one bill with a fresh proforma on another |
| Sinking fund percentage ignored | only the GST total was asserted, not the line |
| Targeted allocation ignores the cap | — |
| Estimated tax forced to zero | — |

The first four needed new tests, which are now in place.

## Remaining PDF requirements

**The requirements PDF has not reached this session.** It was referred to in
three messages and is not in the uploads directory, so nothing below is checked
against it. The ₹4.50/sq ft rate is implemented because it is stated in the
brief itself; everything else PDF-specific is parameterised rather than guessed.

### Blocked on the PDF

| Requirement | What is unknown |
| --- | --- |
| Area basis for ₹4.50/sq ft | Carpet, built-up or super built-up. The three differ by roughly a third. `config.maintenance.areaBasis` is a placeholder and `requireApprovedRate` refuses to bill from it. |
| The six receipt heads | Six accounts exist with the names inferred from the brief. The PDF's own definitions and which are taxable are not known. |
| GST applicability | Whether it applies at all turns on turnover and the ₹7,500 threshold. `gstOnMaintenance` is a flag. |
| Due day and dispatch schedule | `dueAfterDays: 10` is a placeholder. A 6:00 AM IST dispatch on the 1st was mentioned second-hand, not from the document. |
| Opening arrears and advances | Per-flat opening balances. `postOpeningBalances` exists and refuses an opening position that does not balance; no figures have been entered. |
| Non-occupancy surcharge | The field exists on `Resident`; the rate and basis do not. |
| Whether sinking fund routes through income | Changes the surplus and the balance sheet. A config flag with no default. |

### Not built, independent of the PDF

- **Persistence.** The ledger is in memory and rebuilt on reload. No period
  close, no month-end lock, no stored trial balance.
- **GSTR-1 and GSTR-3B.** The CGST/SGST liabilities exist and balance; no
  return, JSON export, B2B/B2C split or SAC summary.
- **TDS challans and quarterly returns.** The liability is tracked per section
  and `remitTds` clears it; no challan, no 26Q.
- **Bank statement import and reconciliation.** Nothing reads a statement.
- **Real authentication.** The OTP is still generated and displayed in the
  browser, and `DEMO_RESIDENT_FLAT` is still a constant — but it is now *one*
  constant instead of ten copies of `'B-204'`, so wiring a real owner record is
  a single change.
- **Admin PINs** are still `1111` and `2222` in the frontend.
- **Email, WhatsApp, payment gateway, MyGate, CESC.** None configured; every
  screen that would use one says so.
- **PDF tax invoices.** The invoice exporter still downloads a `.txt` mock.
- **200-flat import.** Twelve seeded flats, eleven with demo areas and one
  deliberately without, so the refusal path is exercised by the seed.

### Not verified

The app has not been opened in a browser. `vite build` cannot run here — the
npm registry returns 403, so there are no `node_modules` — which means the UI
changes are typechecked against hand-written stubs and have never rendered.
Every number above comes from the suites and from reading the source.
