# Pay online (ICICI gateway): design

Status: design only. Nothing here is built or visible to residents until the
bank's UAT kit arrives, it passes the tests below, and the Secretary says
"go live". Parts that depend on the bank's API are marked **[kit]**.

## What the resident sees

**Bill and Pay Rooms.** Where the app shows "Pay Now" today (the resident's
bill, and the Pay Rooms tab), a resident with a payable bill sees **Pay online**.
Staff keep today's "record a receipt" action. The button is hidden while the
setting `payments.onlineEnabled` is off (the default), so no one ever meets a
button that does nothing.

**Before checkout** (one screen, then the redirect):

    Pay Rs 9,600.00 for flat 27WC (PI MVRA/PI/2026-27/106)
    Amount is taken from your bill and cannot be changed here.
    Links: Terms and Conditions | Refund and Cancellation Policy | Privacy Policy
    [ ] I agree to the Terms and Refund Policy
    [ Pay online ]   (disabled until the box is ticked)

The tick is recorded with the order (time, flat, user) and is required by the
server, not only by the screen.

**Status page** (`/pay/status/<order>`), three states, always read from the
server's record of the order, never from the browser's return trip:

| State | Heading | Text |
|---|---|---|
| Success | Payment received | Amount, date, receipt no., gateway reference; "A receipt is e-mailed to you." |
| Failed | Payment not completed | Reason if the bank gave one; "No money was taken, or it will be returned by your bank in 5 to 7 working days." Button: Try again |
| Pending | Payment is being confirmed | **"Please do not pay again."** Checks itself for a minute; "We will e-mail you the receipt when the bank confirms." |

## Server

- **Order**: `POST /api/payments/online/orders {documentId}`. The amount is read
  from the database (the bill's outstanding, net of any advance), never from the
  request. Rate limited per user and flat. Needs the consent flag. Creates a row
  in `payment_orders` (our order id, flat, document, amount in paise, state
  `created`) and returns the bank's redirect. **[kit: how the redirect is built]**
- **Callback**: `POST /api/payments/online/callback`, server to server. It is
  trusted only after: (1) signature verified with the key from the environment,
  (2) order id is one we issued, (3) amount equals the order's amount, (4) the
  bank's own status API confirms it. Any mismatch is stored in
  `payment_gateway_events` and ignored. **[kit: signature, status API]**
- **Receipt**: success posts through the existing receipt code (method
  "Online payment (ICICI)", gateway reference stored), inside one transaction
  with the order's state change, keyed on the order id so a repeated callback
  makes no second receipt. It honours the "Tax invoice on payment" setting
  exactly as a manual receipt does, writes the audit line, and e-mails the
  receipt to every address the owner has.
- **Pending sweep**: orders still `created` or `pending` are re-checked against
  the bank's status API every few minutes for 24 hours, then listed as
  exceptions. (A Vercel cron faster than the current daily one depends on the
  Vercel plan; otherwise an external scheduler calls the cron route with its
  secret.)
- **Refund**: Secretary requests (reason mandatory), Treasurer approves (not the
  same person), the bank's refund API returns it to the original source, the
  books get a mirror entry (the receipt is reversed, never deleted) and the
  owner is e-mailed. **[kit: refund API]**
- **Secrets**: keys only in environment variables, never in the repo or any
  `VITE_` variable. Card data is never seen or stored: the resident pays on the
  bank's page.

## Office > Online payments

A table of every order (date, flat, amount, state, gateway reference, receipt
no.) with filters (date, flat, state) and CSV export; an Exceptions list
(pending over 24 hours, amount mismatches, callbacks that failed verification);
a reconciliation view that matches the bank's settlement report to orders and
highlights what does not match; and the refund requests with their approval.
**[kit: settlement report format]**

## Data (migration 018, additive)

`payment_orders`, `payment_gateway_events` (every callback and status check, raw
and verified), `payment_refunds`. Nothing is ever deleted.

## Tests before live (results sent to the Secretary)

Success; failure; the resident closing the window mid-payment (order stays
pending, then resolves); the same callback twice (one receipt); a wrong amount;
a tampered signature; the callback arriving before the browser returns; a
refund (request, approval, mirror entry, e-mail); a settlement report with a
mismatch. All against the separate UAT environment (docs/UAT-SETUP.md).

## Going live

Only on the Secretary's explicit "go live": the setting is switched on, live
keys are added to the production environment, and one small real payment is
made and refunded first.

## Fixed IP

Vercel's outbound address is dynamic. If the bank requires a fixed address for
its API, the gateway calls (order, status, refund) go out through a fixed-IP
proxy or Vercel's static-IP option. The bank's callback to us needs no IP rule:
it is verified by signature and by asking the bank's status API.
