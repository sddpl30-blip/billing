/**
 * Sign in with Google.
 *
 *   GET /api/auth/google/status     whether the button should be offered
 *   GET /api/auth/google/start      redirects to Google's consent screen
 *   GET /api/auth/google/callback   Google redirects back here with a code
 *
 * The authorization-code flow with PKCE and a state value, both kept in a
 * short-lived signed cookie, so a callback the browser did not start here is
 * refused. The code is exchanged server-side for an ID token over TLS, direct
 * from Google's token endpoint — which is what lets the token be read without
 * verifying its signature separately (Google's own guidance for tokens received
 * this way); its audience, issuer, expiry and email_verified are still checked.
 *
 * There is no sign-up. The verified address must already belong to an active
 * account — a member added by the office, or a committee member — or the
 * sign-in is refused. Password sign-in is unchanged alongside it.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { route, type Reply, type RouteDefinition } from './http';
import { AuthError, RateLimitError, csrfCookie, sessionCookie } from './security';
import type { AuthService } from './auth';
import type { Config } from './config';
import type { Logger } from './logger';

export interface GoogleDependencies {
  readonly config: Config;
  readonly log: Logger;
  readonly auth: AuthService;
}

const STATE_COOKIE = 'sb_google';
const STATE_TTL_SECONDS = 600;

const b64url = (bytes: Buffer): string =>
  bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The claims of a Google ID token this flow relies on. */
interface IdTokenClaims {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly email?: unknown;
  readonly email_verified?: unknown;
}

function decodeIdToken(idToken: string): IdTokenClaims | null {
  const payload = idToken.split('.')[1];
  if (payload === undefined) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' ? parsed as IdTokenClaims : null;
  } catch {
    return null;
  }
}

export function createGoogleRoutes(deps: GoogleDependencies): RouteDefinition[] {
  const { config, log, auth } = deps;
  const google = config.google;
  const home = `${config.allowedOrigin.replace(/\/$/, '')}/`;

  const sign = (value: string): string =>
    b64url(createHmac('sha256', config.secretKey).update(`google-state:${value}`).digest());

  const stateCookie = (value: string, maxAge: number): string => {
    // Lax, not Strict: the callback is a top-level navigation from Google, and
    // a Strict cookie would not be sent on it. Scoped to these routes only.
    const parts = [`${STATE_COOKIE}=${value}`, 'Path=/api/auth/google', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (config.secureCookies) parts.push('Secure');
    return parts.join('; ');
  };

  /** Back to the app, with a reason it can show; the state cookie always goes. */
  const backWith = (problem: string): Reply => ({
    status: 302,
    headers: {
      Location: `${home}?login_error=${encodeURIComponent(problem)}`,
      'Set-Cookie': [stateCookie('', 0)],
    },
  });

  const status = route('GET', '/api/auth/google/status', async () => ({
    status: 200,
    body: { enabled: google !== null },
  }), { authenticated: false });

  const start = route('GET', '/api/auth/google/start', async () => {
    if (google === null) return { status: 404, body: { error: 'not_configured', message: 'Sign in with Google is not set up.' } };
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const expires = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
    const value = `${state}.${verifier}.${expires}`;

    const query = new URLSearchParams();
    query.set('client_id', google.clientId);
    query.set('redirect_uri', google.redirectUri);
    query.set('response_type', 'code');
    query.set('scope', 'openid email');
    query.set('state', state);
    query.set('code_challenge', challenge);
    query.set('code_challenge_method', 'S256');
    query.set('prompt', 'select_account');

    return {
      status: 302,
      headers: {
        Location: `${google.authUrl}?${query.toString()}`,
        'Set-Cookie': [stateCookie(`${value}.${sign(value)}`, STATE_TTL_SECONDS)],
      },
    };
  }, { authenticated: false });

  const callback = route('GET', '/api/auth/google/callback', async (ctx) => {
    if (google === null) return backWith('google_not_configured');
    if (ctx.query.get('error') !== null) return backWith('google_cancelled');
    const code = ctx.query.get('code');
    const state = ctx.query.get('state');

    // The state must be the one this browser was given at start, unexpired
    // and signed by this server.
    const [cState, verifier, expires, mac] = (ctx.cookies[STATE_COOKIE] ?? '').split('.');
    const expected = cState !== undefined && verifier !== undefined && expires !== undefined
      ? sign(`${cState}.${verifier}.${expires}`) : '';
    const macOk = mac !== undefined && mac.length === expected.length && expected !== ''
      && timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
    if (code === null || state === null || !macOk || state !== cState
        || Number(expires) < Math.floor(Date.now() / 1000)) {
      return backWith('google_state');
    }

    let claims: IdTokenClaims | null = null;
    try {
      const form = new URLSearchParams();
      form.set('code', code);
      form.set('client_id', google.clientId);
      form.set('client_secret', google.clientSecret);
      form.set('redirect_uri', google.redirectUri);
      form.set('grant_type', 'authorization_code');
      form.set('code_verifier', verifier as string);
      const response = await fetch(google.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      if (!response.ok) {
        log.warn('Google refused the code exchange', { status: response.status });
        return backWith('google_failed');
      }
      const body = JSON.parse(text) as { id_token?: unknown };
      claims = typeof body.id_token === 'string' ? decodeIdToken(body.id_token) : null;
    } catch (err) {
      log.error('Google code exchange failed', { error: err instanceof Error ? err.message : 'unknown' });
      return backWith('google_failed');
    }

    const issuerOk = claims?.iss === 'https://accounts.google.com' || claims?.iss === 'accounts.google.com';
    if (claims === null || !issuerOk || claims.aud !== google.clientId
        || typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)
        || claims.email_verified !== true || typeof claims.email !== 'string') {
      log.warn('a Google ID token failed its checks');
      return backWith('google_unverified');
    }

    try {
      const userAgent = ctx.headers['user-agent'];
      const result = await auth.signInWithVerifiedEmail({
        email: claims.email, provider: 'google', ip: ctx.ip,
        ...(typeof userAgent === 'string' ? { userAgent } : {}),
      });
      const cookieOptions = { secure: config.secureCookies, maxAgeSeconds: config.sessionTtlMinutes * 60 };
      return {
        status: 302,
        headers: {
          Location: home,
          'Set-Cookie': [
            sessionCookie(result.sessionToken, cookieOptions),
            csrfCookie(result.csrfToken, cookieOptions),
            stateCookie('', 0),
          ],
        },
      };
    } catch (err) {
      if (err instanceof RateLimitError) return backWith('google_rate_limited');
      if (err instanceof AuthError) return backWith('google_not_registered');
      throw err;
    }
  }, { authenticated: false });

  return [status, start, callback];
}
