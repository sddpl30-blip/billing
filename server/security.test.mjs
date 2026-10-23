#!/usr/bin/env node
/**
 * Passwords, tokens, cookies and what reaches a log.
 *
 * All pure: no database, no server. These are the parts where a mistake is
 * invisible in use — a password hash that verifies anything, a cookie missing
 * a flag, a log line carrying the thing it was meant to hide — so they are
 * checked directly rather than through an endpoint.
 *
 *   node server/security.test.mjs
 */

const build = '../.server-build/server/src';
const {
  hashPassword, verifyPassword, hashToken, hashSubject, mintSessionToken, mintCsrfToken,
  mintLoginCode, verifyCode, sessionCookie, csrfCookie, clearCookie, csrfMatches,
  parseCookies, redact, isSensitiveKey, SESSION_COOKIE, CSRF_COOKIE,
} = await import(`${build}/security.js`);

let passed = 0;
const failures = [];
let suiteName = '';
const suite = (n) => { suiteName = n; console.log(`\n${n}`); };

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${suiteName} / ${name}\n       ${err.message}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}
function equal(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function truthy(value, what) {
  if (!value) throw new Error(`${what}: expected something truthy, got ${JSON.stringify(value)}`);
}
function matches(text, pattern, what) {
  if (!pattern.test(String(text))) {
    throw new Error(`${what}: ${JSON.stringify(String(text).slice(0, 200))} does not match ${pattern}`);
  }
}

// --- passwords --------------------------------------------------------------

suite('passwords');

check('a hash verifies its own password and nothing else', () => {
  const stored = hashPassword('a-committee-member-password');
  equal(verifyPassword('a-committee-member-password', stored), true, 'the right one');
  equal(verifyPassword('a-committee-member-passwore', stored), false, 'one character out');
  equal(verifyPassword('', stored), false, 'empty');
  equal(verifyPassword('a-committee-member-password ', stored), false, 'a trailing space');
});

check('the stored form carries no plaintext, and its parameters travel with it', () => {
  const stored = hashPassword('plaintext-canary-value');
  equal(stored.includes('plaintext-canary-value'), false, 'the password is not in the hash');
  // scrypt, the cost, and the salt — so a later change of cost does not
  // invalidate every existing password.
  matches(stored, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/, 'the format');
  const [, cost] = stored.split('$');
  truthy(Number(cost) >= 16384, `the scrypt cost is at least 16384, got ${cost}`);
});

check('the same password hashes differently every time', () => {
  // A per-password salt. Without it, two members with the same password have
  // the same hash, and one leak tells an attacker about both.
  const a = hashPassword('identical-password');
  const b = hashPassword('identical-password');
  truthy(a !== b, 'two hashes of one password differ');
  equal(verifyPassword('identical-password', a), true, 'and both verify');
  equal(verifyPassword('identical-password', b), true, 'and both verify');
});

check('a malformed stored hash is refused rather than throwing', () => {
  for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'scrypt$x$y$z$aa$bb', '$$$$$']) {
    equal(verifyPassword('anything', bad), false, `refused: ${JSON.stringify(bad)}`);
  }
});

// --- tokens -----------------------------------------------------------------

suite('tokens');

check('a session token is long, random and never repeats', () => {
  const tokens = new Set([...Array(200)].map(() => mintSessionToken()));
  equal(tokens.size, 200, 'all distinct');
  for (const token of tokens) {
    truthy(token.length >= 32, `at least 32 characters, got ${token.length}`);
    matches(token, /^[A-Za-z0-9_-]+$/, 'url-safe');
  }
});

check('what is stored is a keyed hash, not the token', () => {
  const token = mintSessionToken();
  const key = 'a-signing-key-of-sufficient-length-here';
  const stored = hashToken(token, key);
  equal(stored.includes(token), false, 'the token is not inside its hash');
  equal(hashToken(token, key), stored, 'the same token and key give the same hash');
  truthy(hashToken(token, `${key}x`) !== stored, 'a different key gives a different hash');
  truthy(hashToken(`${token}x`, key) !== stored, 'a different token gives a different hash');
});

check('a rate-limit subject is hashed, so the table is not a list of who tried', () => {
  const key = 'another-signing-key-of-sufficient-length';
  const hashed = hashSubject('member@example.invalid', key);
  equal(hashed.includes('member@example.invalid'), false, 'the address is not in it');
  equal(hashed.includes('example'), false, 'nor any part of it');
  equal(hashSubject('member@example.invalid', key), hashed, 'and it is stable');
});

check('a login code is the configured length, all digits, and unpredictable', () => {
  for (const length of [6, 8, 10]) {
    const code = mintLoginCode(length);
    equal(code.length, length, `length ${length}`);
    matches(code, /^[0-9]+$/, 'digits only');
  }
  const codes = new Set([...Array(300)].map(() => mintLoginCode(6)));
  // Not proof of randomness, but a generator stuck on one value fails here.
  truthy(codes.size > 250, `${codes.size} distinct out of 300`);
});

check('a code verifies against its hash and not against another', () => {
  const key = 'yet-another-signing-key-of-enough-length';
  const code = mintLoginCode(6);
  const stored = hashToken(code, key);
  equal(verifyCode(code, stored, key), true, 'the right code');
  equal(verifyCode('000000', stored, key), code === '000000', 'a guess');
  equal(verifyCode(code, stored, `${key}x`), false, 'the wrong key');
});

// --- cookies ----------------------------------------------------------------

suite('cookies');

check('the session cookie is HttpOnly, SameSite=Strict and scoped', () => {
  const header = sessionCookie('a-token', { secure: true, maxAgeSeconds: 3600 });
  matches(header, new RegExp(`^${SESSION_COOKIE}=a-token`), 'the name and value');
  matches(header, /HttpOnly/, 'HttpOnly, so no script can read the session');
  matches(header, /SameSite=Strict/, 'SameSite=Strict');
  matches(header, /Secure/, 'Secure when asked for');
  matches(header, /Path=\//, 'a path');
  matches(header, /Max-Age=3600/, 'a lifetime');
});

check('Secure is left off only when explicitly not asked for', () => {
  const header = sessionCookie('a-token', { secure: false, maxAgeSeconds: 60 });
  equal(/Secure/.test(header), false, 'no Secure for local http');
  matches(header, /HttpOnly/, 'but still HttpOnly');
});

check('the CSRF cookie is readable by the page, on purpose', () => {
  const header = csrfCookie('a-csrf-token', { secure: true, maxAgeSeconds: 3600 });
  equal(/HttpOnly/.test(header), false, 'not HttpOnly: the page has to send it back');
  matches(header, /SameSite=Strict/, 'SameSite=Strict');
  matches(header, /Secure/, 'Secure');
});

check('clearing a cookie expires it rather than setting an empty one', () => {
  const header = clearCookie(SESSION_COOKIE, true);
  matches(header, /Max-Age=0/, 'Max-Age=0');
  matches(header, /HttpOnly/, 'still HttpOnly while being cleared');
});

check('the CSRF check refuses everything but an exact match', () => {
  const token = mintCsrfToken();
  equal(csrfMatches(token, token), true, 'a match');
  equal(csrfMatches(token, `${token}x`), false, 'a longer value');
  equal(csrfMatches(token, token.slice(0, -1)), false, 'a shorter value');
  equal(csrfMatches(token, undefined), false, 'a missing header');
  equal(csrfMatches(undefined, token), false, 'a missing cookie');
  equal(csrfMatches('', ''), false, 'two empty values must not match');
  equal(csrfMatches(undefined, undefined), false, 'nothing at all');
});

check('cookie parsing survives the shapes a browser sends', () => {
  const parsed = parseCookies('sb_session=abc; sb_csrf=d%2Fe; other=1');
  equal(parsed.sb_session, 'abc', 'a plain value');
  equal(parsed.sb_csrf, 'd/e', 'a percent-encoded value');
  equal(Object.keys(parseCookies(undefined)).length, 0, 'no header at all');
  equal(Object.keys(parseCookies('')).length, 0, 'an empty header');
});

// --- logging ----------------------------------------------------------------

suite('what reaches a log');

check('a secret-bearing string is redacted wherever it sits', () => {
  const line = redact({
    password: 'the-password',
    sessionToken: 'the-token',
    csrfToken: 'the-csrf',
    authorization: 'Bearer abc',
    cookie: 'sb_session=abc',
    smtpPassword: 'the-smtp-password',
    nested: { credentials: 'the-credentials', deeper: { secret: 'the-secret' } },
    list: [{ apiKey: 'the-key' }],
  });
  const text = JSON.stringify(line);
  for (const leaked of [
    'the-password', 'the-token', 'the-csrf', 'Bearer abc', 'sb_session=abc',
    'the-smtp-password', 'the-credentials', 'the-secret', 'the-key',
  ]) {
    equal(text.includes(leaked), false, `${leaked} must not appear`);
  }
  equal(line.password, '[redacted]', 'and the key is still there, marked');
});

check('a one-time code and a tax identifier are redacted', () => {
  const line = redact({ code: '123456', otp: '654321', pan: 'AAAPL1234C', gstin: '27AAAAA0000A1Z5' });
  const text = JSON.stringify(line);
  for (const leaked of ['123456', '654321', 'AAAPL1234C', '27AAAAA0000A1Z5']) {
    equal(text.includes(leaked), false, `${leaked} must not appear`);
  }
});

check('configuration an operator needs is NOT redacted', () => {
  // This is the bug these rules were rewritten for. Substring matching
  // redacted `secureCookies` (it contains "cookie"), `secretKeyLength` (it
  // contains "secret" — and it exists precisely so a startup line can prove a
  // secret is configured without printing it) and `otpProvider` (it contains
  // "otp" — and it says whether codes are being written to the log). The one
  // line an operator reads at startup was almost entirely "[redacted]".
  const line = redact({
    secureCookies: true,
    secretKeyLength: 64,
    otpProvider: 'local-dev',
    emailProvider: 'smtp',
    tokenTtlMinutes: 720,
    passwordConfigured: true,
    codeLength: 6,
    panRequired: false,
  });
  equal(line.secureCookies, true, 'whether cookies are Secure');
  equal(line.secretKeyLength, 64, 'the length of the signing key');
  equal(line.otpProvider, 'local-dev', 'which OTP provider is in use');
  equal(line.emailProvider, 'smtp', 'which email provider is in use');
  equal(line.tokenTtlMinutes, 720, 'a lifetime in minutes');
  equal(line.passwordConfigured, true, 'that a password is set');
  equal(line.codeLength, 6, 'a code length');
  equal(line.panRequired, false, 'a flag about PANs');
});

check('a secret-shaped key with a non-string value is left alone', () => {
  // A boolean or a number cannot carry a password, and redacting one loses
  // information without protecting anything.
  const line = redact({ password: true, secret: 0, tokenCount: 12 });
  equal(line.password, true, 'a boolean under a secret-shaped key');
  equal(line.secret, 0, 'a number under a secret-shaped key');
  equal(line.tokenCount, 12, 'a count');
});

check('the key rules are what they claim to be', () => {
  for (const key of [
    'password', 'passwd', 'smtpPassword', 'sessionToken', 'csrf_token', 'secret',
    'sessionSecret', 'apiKey', 'api_key', 'authorization', 'cookie', 'cookies',
    'credentials', 'privateKey', 'signature',
  ]) {
    equal(isSensitiveKey(key), true, `${key} is sensitive`);
  }
  for (const key of [
    'secureCookies', 'secretKeyLength', 'otpProvider', 'codeLength', 'tokenTtlMinutes',
    'passwordConfigured', 'invoiceNo', 'flatNo', 'amountPaise', 'provider',
  ]) {
    equal(isSensitiveKey(key), false, `${key} is not sensitive`);
  }
  // Whole-key only: these mean the data, not a setting about it.
  for (const key of ['code', 'otp', 'pin', 'pan', 'gstin', 'ifsc']) {
    equal(isSensitiveKey(key), true, `${key} alone is sensitive`);
  }
});

check('a very long string is truncated rather than filling the log', () => {
  const line = redact({ narration: 'x'.repeat(5000) });
  truthy(line.narration.length < 600, `truncated, got ${line.narration.length}`);
  matches(line.narration, /\[5000 chars\]$/, 'and says how long it was');
});

check('a cycle or a deep structure cannot hang the logger', () => {
  let deep = { bottom: true };
  for (let i = 0; i < 40; i++) deep = { deeper: deep };
  const line = redact(deep);
  equal(JSON.stringify(line).includes('[deep]'), true, 'it stops descending');

  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  // No stack overflow: the depth cap is what makes this safe.
  truthy(JSON.stringify(redact(cyclic)).length > 0, 'a cycle is handled');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
