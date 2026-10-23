# Entering the approach note's decisions: a prompt for Claude in Chrome

Taken from *Mani Vista RWA — Approach Note for Smooth Transition* (21 Oct
2026). Only what the note actually decides is entered. What it leaves open
(flat list, sinking fund rate, due date, area basis, GSTIN) is listed at the
end and is not guessed.

Paste everything between the two lines into Claude in Chrome, on the site
https://billing-five-kappa.vercel.app, after the deployment with SETUP_TOKEN
is Ready.

---

You are setting up the SocietyBooks app at https://billing-five-kappa.vercel.app
for Mani Vista Residents Association, using decisions from its approach note.
Work in order. After each part, tell me in one line what you did and what the
screen showed. Never type or reveal a password, token or email address
yourself unless I give it to you in this chat; when a step needs one, stop
and let me type it. If a screen differs from what is described, stop and ask.

**Part A — Set up your society** (the screen the site shows first):
- Registered name: `Mani Vista Residents Association`
- Registration no.: leave blank
- Invoice prefix: `MV`
- GSTIN: leave blank (the note says registration is mandatory, but no GSTIN is
  given; it is added once issued)
- State code: `19` (West Bengal — the note says intra-state, West Bengal)
- Secretary's email and password: **stop and let me type them**
- Operating bank account: leave blank unless I give you the bank name, last
  four digits and IFSC
- Setup token: paste the SETUP_TOKEN from the clipboard
- Submit. Expect "The society is set up". Then sign in as the secretary —
  **let me type the password**.

**Part B — Settings** (Office → Approvals & admin → Settings & GST), as the
secretary:
- GST treatment: Charge GST = on, rate `18` (%), member threshold `7500`
  (₹ per flat per month). Note: the app splits 18% into 9% CGST + 9% SGST
  itself. Save. It will show "Pending approval" — that is expected: the
  treasurer approves it, not the secretary.
- Leave "Days to pay", "Sinking fund share (%)" and "Billing day of month"
  unchanged — the note does not fix them yet.

**Part C — Maintenance rate** (Office → Approvals & admin → Rates), as the
secretary:
- Add a rate: `₹4.50` per sq ft, effective from `2026-10-01` (October 2026 is
  the first billing month), authority text:
  `Approach note 21 Oct 2026; Rs 4.50 per sq ft per month as decided by the Association`.
- Area basis: **stop and ask me** — carpet, built-up or super built-up. The
  note says it must be exactly as fixed by the bye-laws or AGM and does not
  say which.
- It will show as awaiting approval; the treasurer approves it.

**Part D — Committee accounts** (Office → Approvals & admin → Users & roles),
as the secretary. For each, **ask me for the email**; do not invent one:
- Treasurer — role `treasurer` (approves GST, rates, billing batches)
- Manager — role `manager` (raises the monthly billing run, records receipts,
  imports bank statements)
- Auditor — role `auditor` (read-only), if I have one
Do not give one account both secretary and treasurer, or manager with either;
the app refuses those combinations by design.

**Part E — Approvals** (only after I sign in as the treasurer myself):
remind me to open Office → Approvals & admin and approve the GST treatment
and the ₹4.50 rate. Do not sign in as the treasurer yourself.

When finished, summarise: what was entered, what is pending approval, and
the list of open items below that I still need to supply.

---

## Not in the note, so not entered — needed before the first bill

| Item | Why it is needed | Where it goes |
|---|---|---|
| **Flat register** — 200 flats: flat no., tower, floor, billing area (sq ft), owner name(s), email, mobile | Every bill is area × ₹4.50; owners sign in by email | Office → Approvals & admin → Flats & owners |
| **Area basis** (carpet / built-up / super built-up) | Part C; wrong basis means wrong bills and wrong GST from day one | Rates |
| **Sinking Fund rate** fixed by the AGM | The app bills sinking fund as a % of maintenance (default 10%) | Settings → Sinking fund share (%) |
| **Payment due date** (e.g. the 10th) | Tax invoices are raised on the due date, paid or not | Settings → Days to pay (default 15 days from the invoice) |
| **GSTIN** and **TAN** | GSTIN goes on every tax invoice; TAN for TDS on vendor bills | Not editable in the app after setup yet — ask the developer |
| **Committee members' emails** | Treasurer and manager accounts | Users & roles |
| **Opening balances** as on 1 Oct 2026 (flat-wise dues/advances, Sinking Fund balance and FDs, event funds) | Agreed cut-over; owners dispute what they don't recognise | Not supported in the app yet — ask the developer |

## Where the note and the app differ today

- **GST on the Sinking Fund.** The note bills Sinking Fund with 18% GST
  ("committee to confirm"). The app treats it as not taxable unless the GST
  treatment's "Charge GST on the sinking fund too" box is ticked (Society
  settings → GST treatment); then the ₹7,500 exemption is tested on
  maintenance plus sinking fund. Ticking it needs the treasurer's approval.
- **Rounding.** The note rounds GST to the rupee per invoice; the app keeps
  paise unless "Round CGST and SGST to the rupee per invoice" is ticked in the
  same setting.
- **Interest on late payment** (with 18% GST) is not computed by the app yet.
- **Helpdesk targets** (Emergency 4 h, Common area 48 h, Plumbing/electrical
  72 h, Accounts query 5 working days) differ from the app's built-in
  categories, which cannot be edited from the screens yet.
- **Receipt series** (MV/RC, MV/SF, MV/EV, MV/RN, MV/RE, MV/OR) and the event
  module, Sinking Fund FD register, virtual accounts, GSTR-1/3B export, e-mail
  at 6 am and MyGate/CESC links are in the note's plan for Nov–Dec 2026 and
  are not in the app yet.
