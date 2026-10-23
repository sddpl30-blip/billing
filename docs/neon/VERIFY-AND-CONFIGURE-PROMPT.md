# After setup: verify, close setup, finish configuration

A prompt for Claude in Chrome, signed in to Vercel and Neon. Paste everything
between the two lines. It has three parts and stops for your approval before
it changes anything.

---

You are finishing the deployment of SocietyBooks for Mani Vista Residents
Association. Site: https://billing-five-kappa.vercel.app. Vercel project:
`billing` (team ota11). Database: the `societybooks` database in the Neon
project behind neon-canary-ocean — never the `neondb` database.

Rules for the whole task:
- Never invent society information. Every value below is either given here
  or must be asked of me. If I have not given a value, stop and ask; if I say
  "skip", leave that field empty.
- Never show a password, token or connection string in chat.
- Before any change (deleting a variable, running SQL that writes, saving a
  setting, redeploying), describe exactly what you will do and wait for me to
  reply "approve". Read-only steps need no approval.
- After each part, report in a few lines what you saw.

## Part 1 — Verify the setup (read-only)

In Neon, open the SQL Editor, select the `societybooks` database in the
dropdown (check it twice), and run this. The first line makes the session
read-only, so none of it can change anything:

```sql
SET default_transaction_read_only = on;

-- 1. Exactly one production society, and its details
SELECT id, name, mode, registration_no, gstin, state_code, created_at
  FROM societies WHERE mode = 'production';

-- 2. Its accounts and roles (expect one secretary, active, with a password)
SELECT u.email, u.is_active, (u.password_hash IS NOT NULL) AS has_password,
       string_agg(r.role, ', ') AS roles
  FROM users u JOIN societies s ON s.id = u.society_id AND s.mode = 'production'
  LEFT JOIN user_roles r ON r.user_id = u.id
 GROUP BY u.email, u.is_active, u.password_hash;

-- 3. The structure setup creates (expect accounts > 20, receipt heads > 3,
--    ticket categories 6, settings 5)
SELECT (SELECT count(*) FROM accounts a WHERE a.society_id = s.id)          AS accounts,
       (SELECT count(*) FROM receipt_heads h WHERE h.society_id = s.id)     AS receipt_heads,
       (SELECT count(*) FROM ticket_categories t WHERE t.society_id = s.id) AS ticket_categories,
       (SELECT count(*) FROM society_settings x WHERE x.society_id = s.id)  AS settings,
       (SELECT count(*) FROM bank_accounts b WHERE b.society_id = s.id)     AS bank_accounts
  FROM societies s WHERE s.mode = 'production';

-- 4. GST starts off and unapproved (approved_by should be null)
SELECT key, value, approved_by, approved_on
  FROM society_settings x JOIN societies s ON s.id = x.society_id AND s.mode = 'production'
 ORDER BY key;

-- 5. The setup is in the audit trail
SELECT at, actor_label, action, detail
  FROM audit_log a JOIN societies s ON s.id = a.society_id AND s.mode = 'production'
 WHERE action = 'society.bootstrap';

-- 6. Schema version (expect 9 rows now, ending 009_bank_match_once.sql)
SELECT version FROM schema_migrations ORDER BY version;
```

Report: the society row (name, state code, whether GSTIN is empty), the
accounts list (emails and roles), the counts, the GST setting, whether the
audit row exists, and the migration list. If anything differs from the
expectations in the comments, stop and tell me.

## Part 2 — Close setup and bring the schema up to date (needs my approval)

Two changes go together, then one redeploy:

1. **Migration 010** — the app's new Society profile and Opening balances
   screens need it (it adds TAN/address/contact columns and the opening
   balance tables). Open
   https://github.com/sddpl30-blip/billing/blob/claude/loving-ritchie-nymqj1/docs/neon/010-apply.sql,
   click Raw, copy all of it. In Neon's SQL Editor (database `societybooks`,
   check twice; a new query tab, so the read-only setting from Part 1 is not
   in force) it is to be run once. It ends by recording
   `010_opening_balances.sql` in `schema_migrations`.
2. **Remove SETUP_TOKEN** — in Vercel → `billing` → Settings → Environment
   Variables, the `SETUP_TOKEN` variable is to be deleted (setup is complete
   and the route already refuses, but a secret nobody needs should be gone).
3. **Redeploy** — Deployments → latest → Redeploy without build cache.

Describe these three steps back to me and wait for "approve". Then do them in
that order. Afterwards check, and report:
- In Neon: `SELECT version FROM schema_migrations ORDER BY version;` now ends
  with `010_opening_balances.sql`.
- `https://billing-five-kappa.vercel.app/api/setup` returns
  `{"required":false,"open":false}`.
- `https://billing-five-kappa.vercel.app/api/health` shows `"status":"ok"`
  and `schemaVersion` `010_opening_balances.sql`.
- `https://billing-five-kappa.vercel.app/api/auth/me` returns a JSON 401
  (`"error":"unauthenticated"`), not a Vercel NOT_FOUND page.

## Part 3 — Remaining configuration (each value from me, each save approved)

I will sign in as the secretary myself (I type the password). Then, in the
app's **Office → Approvals & admin**, go through these in order. For each,
ask me for the values, show me what you will enter, wait for "approve", save,
and report what the screen says.

1. **Society profile** — GSTIN, TAN, registration no., address, contact
   e-mail and phone. Ask for each; leave any I skip empty. The state code is
   already `19` (West Bengal); the app refuses a GSTIN that does not start
   with `19`.
2. **Users & roles** — create the **treasurer** and **manager** accounts (and
   an **auditor** if I want one) with the e-mails I give. Do not create any
   account I have not named. One account may not be both secretary and
   treasurer, or manager with either — the app refuses that by design.
3. **Settings & GST** — from the Association's approach note (21 Oct 2026),
   confirm each with me before saving:
   - Charge GST: on, rate `18`, member threshold `7500`.
   - Round to the rupee: on (the note says GST is "rounded to the rupee per
     invoice").
   - GST on the Sinking Fund: **ask me** — the note says "committee to
     confirm".
   - Days to pay and billing day of month: **ask me** — the note does not fix
     them.
   - Sinking fund share (%): **ask me** — the note says "at the rate fixed by
     the AGM" without a figure.
   These will show "Pending approval"; the treasurer approves them later.
4. **Rates** — ₹4.50 per sq ft (from the note), effective from `2026-10-01`
   (October 2026 is the first billing month). **Ask me the area basis**
   (carpet / built-up / super built-up). Authority text:
   `Approach note 21 Oct 2026: Rs 4.50 per sq ft per month as decided by the Association`.
5. **Flats & owners** — only if I give you the CSV file: Import from CSV →
   preview → show me the counts and any row errors → wait for "approve" →
   import. Without a file, skip and list it as pending.
6. **Opening balances** — only if I give you the figures or the CSV; the
   secretary saves the draft, the treasurer approves it later. Without them,
   skip and list as pending.

Do not sign in as the treasurer or manager yourself. At the end, give me:
what was saved; what is pending the treasurer's approval (GST settings,
rate, opening balances); and what is still waiting on information from me.

---
