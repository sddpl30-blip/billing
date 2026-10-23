/**
 * Passwords, tokens, one-time codes and rate limiting.
 *
 * Nothing reversible is stored. A session token, a login code and a password
 * are each kept only as a hash, so a copy of the database does not hand over
 * live sessions, usable codes, or anything that can be replayed.
 */

import { createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Queryable } from './pg';

export class AuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
    this.name = 'AuthError';
  }
}

export class RateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// --- passwords -------------------------------------------------------------

/**
 * scrypt, from node's own crypto. Parameters are stored with the hash so they
 * can be raised later without invalidating every existing password.
 *
 * N=2^15 is a deliberate cost: it takes long enough to make offline guessing
 * expensive and not long enough to matter on a login.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 } as const;

export function hashPassword(password: string): string {
  if (password.length < 10) {
    throw new AuthError('A password must be at least 10 characters.', 400);
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return [
    'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), derived.toString('base64'),
  ].join('$');
}

/** Constant-time comparison, so a wrong password reveals nothing by timing. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.length, {
      N, r, p, maxmem: 128 * N * r * 2,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// --- tokens and codes ------------------------------------------------------

/** A session token. 32 random bytes, so guessing is not a strategy. */
export function mintSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hashes a token for storage, keyed with the server secret.
 *
 * HMAC rather than a plain hash: without the key, a stolen database cannot be
 * used to look up a token by hashing guesses, even for a short token.
 */
export function hashToken(token: string, secretKey: string): string {
  return createHmac('sha256', secretKey).update(token, 'utf8').digest('hex');
}

/**
 * A numeric one-time code.
 *
 * `randomInt` rather than Math.random: a login code from a predictable source
 * is not a login code. Leading zeros are kept, so every code is the same
 * length and the length does not leak the value.
 */
export function mintLoginCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

export function verifyCode(code: string, storedHash: string, secretKey: string): boolean {
  const candidate = Buffer.from(hashToken(code, secretKey), 'utf8');
  const expected = Buffer.from(storedHash, 'utf8');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/**
 * Hashes a rate-limit subject.
 *
 * The buckets table should not be a list of who tried to log in, so the email
 * or IP is keyed and hashed before it is stored.
 */
export function hashSubject(subject: string, secretKey: string): string {
  return createHmac('sha256', secretKey).update(subject.toLowerCase(), 'utf8').digest('hex');
}

/** A short, non-secret id for correlating a request across log lines. */
export function requestId(): string {
  return randomBytes(8).toString('hex');
}

/** Hash of a file's bytes, for deduplication and attachment integrity. */
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data as Uint8Array).digest('hex');
}

// --- rate limiting ---------------------------------------------------------

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

/**
 * A fixed-window counter, in the database rather than in memory.
 *
 * In memory it would reset on deploy and not be shared between instances,
 * which makes it decorative. The window start is truncated so concurrent
 * requests land on the same row, and the upsert does the counting atomically.
 */
export async function consumeRateLimit(
  tx: Queryable,
  input: {
    subject: string;
    action: string;
    limit: number;
    windowMinutes: number;
    secretKey: string;
    now?: Date;
  },
): Promise<RateLimitDecision> {
  const now = input.now ?? new Date();
  const windowMs = input.windowMinutes * 60_000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const subjectHash = hashSubject(input.subject, input.secretKey);

  const result = await tx.query<{ count: string }>(
    `INSERT INTO rate_limit_buckets (subject_hash, action, window_start, count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (subject_hash, action, window_start)
     DO UPDATE SET count = rate_limit_buckets.count + 1
     RETURNING count`,
    [subjectHash, input.action, windowStart.toISOString()],
  );

  const count = Number(result.rows[0]?.count ?? '1');
  const resetAt = windowStart.getTime() + windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now.getTime()) / 1000));

  return {
    allowed: count <= input.limit,
    remaining: Math.max(0, input.limit - count),
    retryAfterSeconds,
  };
}

/** Clears expired buckets. Called by the scheduler, not on the request path. */
export async function sweepRateLimits(tx: Queryable, olderThan: Date): Promise<number> {
  const r = await tx.query(
    'DELETE FROM rate_limit_buckets WHERE window_start < $1',
    [olderThan.toISOString()],
  );
  return r.rowCount;
}

// --- cookies ---------------------------------------------------------------

export interface CookieOptions {
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
}

export const SESSION_COOKIE = 'sb_session';
export const CSRF_COOKIE = 'sb_csrf';

/**
 * Builds a Set-Cookie for the session.
 *
 * HttpOnly so script cannot read it, SameSite=Strict so it is not sent on a
 * cross-site request at all, Secure in production, and Path=/ so it covers
 * the whole API.
 */
export function sessionCookie(token: string, opts: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    `SameSite=${opts.sameSite ?? 'Strict'}`,
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * The CSRF cookie, which is deliberately NOT HttpOnly.
 *
 * The double-submit pattern needs the browser's script to read this value and
 * echo it in a header; the server then checks the two match. An attacker on
 * another origin can cause the cookie to be sent but cannot read it to set the
 * header, which is what makes the check work.
 */
export function csrfCookie(token: string, opts: CookieOptions): string {
  const parts = [
    `${CSRF_COOKIE}=${token}`,
    'Path=/',
    `SameSite=${opts.sameSite ?? 'Strict'}`,
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Expires a cookie rather than setting it to an empty value.
 *
 * `HttpOnly` is set even for the CSRF cookie, which is readable while it is
 * live. The deletion carries no value to read, and keeping the attribute means
 * a cleared session cookie is never briefly scriptable: a response that both
 * clears and (through some later bug) fails to expire the cookie still leaves
 * it out of reach of a page script.
 */
export function clearCookie(name: string, secure: boolean): string {
  const parts = [`${name}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function decodeCookieValue(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined || header === '') return {};
  const out: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // Percent-decoded, because the browser's own encoding is what arrives
    // here and the client reads cookies with decodeURIComponent. Without this
    // the two sides disagree about any value holding a reserved character,
    // and a CSRF check would fail for a reason nothing in the logs explains.
    // A malformed sequence is kept verbatim rather than throwing away the
    // whole header.
    if (name !== '') out[name] = decodeCookieValue(value);
  }
  return out;
}

export function mintCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Constant-time, because a CSRF check that leaks by timing is not one. */
export function csrfMatches(cookieValue: string | undefined, headerValue: string | undefined): boolean {
  if (cookieValue === undefined || headerValue === undefined) return false;
  if (cookieValue === '' || headerValue === '') return false;
  const a = Buffer.from(cookieValue, 'utf8');
  const b = Buffer.from(headerValue, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- safe logging ----------------------------------------------------------

/**
 * Keys whose string values never appear in a log, wherever they are nested.
 *
 * Matched against the key's camelCase or snake_case segments, not as a
 * substring of the whole key. Substring matching redacted the wrong things:
 * `secureCookies` (a boolean saying whether cookies are Secure),
 * `secretKeyLength` (a number, included specifically so a startup line can
 * prove a secret is configured without printing it) and `otpProvider` (which
 * says whether codes are being written to the log) all came out as
 * `[redacted]`, so the one line an operator reads at startup told them
 * nothing.
 */
const SENSITIVE_SEGMENTS = [
  'password', 'passwd', 'secret', 'token', 'credential', 'credentials',
  'authorization', 'auth', 'signature', 'proof', 'hash',
];

/**
 * Markers that are only ever written as two words joined together.
 *
 * `apiKey` splits into `api` + `key`, and neither half can go in the segment
 * list: `key` alone would redact `secretKeyLength` and `keyCount`. So these are
 * matched against the whole key with its punctuation and case removed, which
 * catches `apiKey`, `api_key` and `API-KEY` alike.
 */
const SENSITIVE_JOINED = [
  'apikey', 'privatekey', 'secretkey', 'signingkey', 'sessiontoken',
  'accesstoken', 'refreshtoken', 'bearertoken', 'cookie', 'cookies',
];

/**
 * Trailing words that turn a secret's name into a fact about it.
 *
 * `secretKeyLength` is a number, `passwordConfigured` a boolean,
 * `otpProvider` the name of a provider — each exists so a startup line can
 * show that a secret is set without printing it. A key ending in one of these
 * describes a secret rather than carrying one, so it stays legible.
 */
const DESCRIBES_RATHER_THAN_CARRIES = [
  'length', 'count', 'configured', 'provider', 'ttl', 'minutes', 'seconds',
  'days', 'hours', 'required', 'enabled', 'present', 'set', 'source', 'kind',
  'type', 'mode', 'algorithm', 'version', 'age', 'expires', 'expiry', 'at',
];

/**
 * Keys that are sensitive only when that is the whole key.
 *
 * 'code' and 'otp' are the one-time code; 'pan' and 'gstin' are a member's or
 * the society's tax identifiers. As segments of a longer name they usually
 * mean something else — `otpProvider`, `codeLength`, `panRequired` — and
 * redacting those hides configuration rather than data.
 */
const SENSITIVE_WHOLE = ['code', 'otp', 'pin', 'pan', 'gstin', 'ifsc', 'accountnumber'];

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_WHOLE.includes(normalised)) return true;
  if (SENSITIVE_JOINED.includes(normalised)) return true;

  // camelCase and snake_case both split into words here.
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(part => part.toLowerCase())
    .filter(part => part !== '');

  const last = segments[segments.length - 1];
  if (last !== undefined && DESCRIBES_RATHER_THAN_CARRIES.includes(last)) return false;

  return segments.some(segment => SENSITIVE_SEGMENTS.includes(segment));
}

/**
 * Redacts anything that should not reach a log line.
 *
 * Applied to every structured log payload rather than relied on at call sites,
 * because the one call site that forgets is the one that matters.
 */
export { isSensitiveKey };

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 512 ? `${value.slice(0, 512)}…[${value.length} chars]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      // Only a string or a buffer can carry a secret. A boolean saying
      // whether something is enabled, or a number giving a length, is
      // configuration an operator needs to see — and redacting it loses the
      // information without protecting anything.
      const redactable = typeof inner === 'string' || inner instanceof Uint8Array;
      out[key] = redactable && isSensitiveKey(key)
        ? '[redacted]'
        : redact(inner, depth + 1);
    }
    return out;
  }
  return '[unserialisable]';
}
