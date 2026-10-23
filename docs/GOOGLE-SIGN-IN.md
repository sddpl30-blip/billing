# Sign in with Google

Members sign in with the Google account whose e-mail the society has on
record; committee members keep their e-mail and password. There is no
sign-up: a Google account whose address is not already an active account in
the app is refused, and nothing is created.

The button appears on the sign-in screen only when both variables below are
set. Without them the app behaves exactly as before.

## 1. Create the OAuth client (Google Cloud, once)

1. Open https://console.cloud.google.com/ and create (or pick) a project, e.g.
   "Mani Vista SocietyBooks".
2. **APIs & Services → OAuth consent screen** (shown as *Google Auth Platform*
   in newer consoles):
   - User type: **External**.
   - App name: `Mani Vista Residents Association`; support e-mail and
     developer contact: the society's own address.
   - Scopes: only `openid` and `email` (the defaults; add nothing else).
   - Publishing status: **In production** once you have tested it. While it is
     *Testing*, only the Google accounts listed as test users can sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Name: `SocietyBooks`.
   - Authorized JavaScript origins: `https://billing-five-kappa.vercel.app`
   - Authorized redirect URIs: `https://billing-five-kappa.vercel.app/api/auth/google/callback`
     (exactly this; a different domain or a trailing slash makes Google refuse).
4. Copy the **Client ID** and the **Client secret**. Keep the secret out of
   chat, e-mail and the repository.

## 2. Add the variables (Vercel, once)

Vercel → project `billing` → Settings → Environment Variables, for
Production:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the Client ID (ends `.apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | the Client secret |

`ALLOWED_ORIGIN` must already be `https://billing-five-kappa.vercel.app`; the
redirect URI is built from it. (`GOOGLE_REDIRECT_URI` overrides that, for a
custom domain.) Then redeploy.

## 3. Check

- `https://billing-five-kappa.vercel.app/api/auth/google/status` returns
  `{"enabled":true}`.
- The sign-in screen shows **Sign in with Google**.
- A member whose e-mail is on file is signed in; any other Google account sees
  "That Google account is not registered with the society".

## What members need

Their e-mail in the app (from the flat import or Users & roles) must be the
address of a Google account: a Gmail address, or a Google Workspace address.
A member whose address is not a Google account (Yahoo, Rediffmail, …) cannot
use the button; the office can either record a Google address for them or
give them a password.

## How it works

`server/src/routesGoogle.ts`: the authorization-code flow with PKCE and a
signed, ten-minute state cookie; the code is exchanged server-side with
Google's token endpoint, and the ID token's issuer, audience, expiry and
`email_verified` are checked before the address is looked up. Sessions are
the same as a password sign-in's.
