/**
 * Sign-in, sessions and the principal.
 *
 * Nothing here trusts the client. A session is a random token whose HMAC is
 * stored; the roles and the flats a user may see are read from the database on
 * every request, not carried in the cookie, so revoking a role takes effect at
 * once rather than at the next sign-in.
 */

import type { PgPool, Queryable } from './pg';
import type { Config } from './config';
import type { Logger } from './logger';
import type { OtpProvider } from './providers/otp';
import {
  AuthError, RateLimitError, consumeRateLimit, hashToken, mintCsrfToken, mintLoginCode,
  hashPassword, mintSessionToken, verifyCode, verifyPassword,
} from './security';
import { isValidRole, type Principal, type Role } from './rbac';
import { badRequest } from './http';

export interface SignInStart {
  readonly accepted: true;
  /** What the member should be told. Never the code itself. */
  readonly message: string;
  /** Whether a provider actually delivered it. False while none is configured. */
  readonly delivered: boolean;
}

export interface SignInResult {
  readonly principal: Principal;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export class AuthService {
  constructor(
    private readonly pool: PgPool,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly otp: OtpProvider,
  ) {}

  /**
   * Issues a one-time code.
   *
   * Always reports the same thing whether or not the address is on file:
   * telling a caller that an email is unknown turns this endpoint into a way
   * to enumerate the society's members.
   */
  async startSignIn(input: { email: string; ip: string }): Promise<SignInStart> {
    const sameMessage =
      'If that address belongs to a member, a one-time code has been sent to it. ' +
      'It is valid for a few minutes.';

    // Two buckets: one per address, one per source address, so a single client
    // cannot grind through a list of emails and a single email cannot be
    // targeted from many clients.
    //
    // Consumed on the pool, deliberately outside the transaction below. Inside
    // it the increment would be rolled back along with the refusal it was
    // counting, and a limit that only counts successful attempts is not a
    // limit: an attacker would get unlimited tries at a wrong code.
    for (const [subject, action, limit] of [
      [input.email, 'otp:email', this.config.rateLimit.otpPerHour],
      [input.ip, 'otp:ip', this.config.rateLimit.otpPerHour * 4],
    ] as const) {
      const decision = await consumeRateLimit(this.pool, {
        subject, action, limit,
        windowMinutes: this.config.rateLimit.windowMinutes,
        secretKey: this.config.secretKey,
      });
      if (!decision.allowed) {
        throw new RateLimitError(
          'Too many codes have been requested. Try again shortly.',
          decision.retryAfterSeconds,
        );
      }
    }

    try {
      await this.issueCode(input.email);
    } catch (err) {
      // A delivery failure is logged, not reported. Answering a known address
      // with an error and an unknown one with the usual message would tell a
      // caller which addresses belong to members. The transaction has already
      // rolled back, so no usable code is left behind.
      this.log.error('one-time code could not be delivered', {
        error: err instanceof Error ? err.name : 'unknown',
      });
      return { accepted: true, message: sameMessage, delivered: false };
    }

    return { accepted: true, message: sameMessage, delivered: this.otp.delivers };
  }

  /** Mints, stores and sends a code; throws if it could not be delivered. */
  private async issueCode(email: string): Promise<void> {
    const input = { email };
    await this.pool.transaction(async (tx) => {
      const found = await tx.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1 AND is_active = true LIMIT 1',
        [input.email],
      );
      const user = found.rows[0];
      if (user === undefined) {
        // Rate limit already consumed, so an unknown address costs the caller
        // the same as a known one.
        this.log.info('sign-in requested for an address that is not on file');
        return;
      }

      const code = mintLoginCode(this.config.loginCodeLength);
      const expiresAt = new Date(Date.now() + this.config.loginCodeTtlMinutes * 60_000);

      // Any code still outstanding for this user is burned, so requesting a
      // new one invalidates the old rather than widening the window.
      await tx.query(
        `UPDATE login_codes SET consumed_at = now()
          WHERE user_id = $1 AND consumed_at IS NULL`,
        [user.id],
      );
      await tx.query(
        `INSERT INTO login_codes (user_id, code_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, hashToken(code, this.config.secretKey), expiresAt.toISOString()],
      );

      try {
        const delivery = await this.otp.send({
          to: input.email,
          code,
          expiresInMinutes: this.config.loginCodeTtlMinutes,
        });
        this.log.info('one-time code issued', {
          provider: delivery.provider,
          providerMessageId: delivery.providerMessageId,
          delivers: this.otp.delivers,
        });
      } catch (err) {
        // A provider failure must not leave a usable code behind.
        await tx.query(
          'UPDATE login_codes SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL',
          [user.id],
        );
        throw err;
      }
    });
  }

  /** Exchanges a code for a session. */
  async completeSignIn(input: { email: string; code: string; userAgent?: string; ip: string }): Promise<SignInResult> {
    // Outside the transaction, for the reason given in startSignIn: a failed
    // attempt must still cost the caller an attempt.
    const decision = await consumeRateLimit(this.pool, {
      subject: input.ip, action: 'login:ip',
      limit: this.config.rateLimit.loginPerHour,
      windowMinutes: this.config.rateLimit.windowMinutes,
      secretKey: this.config.secretKey,
    });
    if (!decision.allowed) {
      throw new RateLimitError(
        'Too many sign-in attempts. Try again shortly.',
        decision.retryAfterSeconds,
      );
    }
    // A second bucket per address, so rotating source addresses does not buy
    // an attacker more guesses at one member's code.
    const perEmail = await consumeRateLimit(this.pool, {
      subject: input.email, action: 'login:email',
      limit: this.config.rateLimit.loginPerHour,
      windowMinutes: this.config.rateLimit.windowMinutes,
      secretKey: this.config.secretKey,
    });
    if (!perEmail.allowed) {
      throw new RateLimitError(
        'Too many sign-in attempts. Try again shortly.',
        perEmail.retryAfterSeconds,
      );
    }

    // The attempt counter and the burn are written on the pool, not on `tx`:
    // the refusal that follows them throws, the transaction rolls back, and an
    // update made inside it would be undone along with everything else —
    // leaving a code that can be guessed at without limit.
    const countFailure = (codeId: string) => this.pool.query(
      'UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1', [codeId],
    );
    const burn = (codeId: string) => this.pool.query(
      'UPDATE login_codes SET consumed_at = now() WHERE id = $1', [codeId],
    );

    return this.pool.transaction(async (tx) => {
      const found = await tx.query<{ id: string; society_id: string; email: string }>(
        'SELECT id, society_id, email FROM users WHERE email = $1 AND is_active = true LIMIT 1',
        [input.email],
      );
      const user = found.rows[0];
      // The same refusal whether the address is unknown or the code is wrong.
      const refuse = (): never => {
        throw new AuthError('That code is not valid.');
      };
      if (user === undefined) refuse();

      const codes = await tx.query<{ id: string; code_hash: string; attempts: string }>(
        `SELECT id, code_hash, attempts FROM login_codes
          WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()
          ORDER BY issued_at DESC LIMIT 1`,
        [user.id],
      );
      const candidate = codes.rows[0];
      if (candidate === undefined) refuse();

      if (Number(candidate.attempts) >= this.config.loginCodeMaxAttempts) {
        await burn(candidate.id);
        throw new AuthError('That code has been tried too many times. Request a new one.');
      }

      if (!verifyCode(input.code, candidate.code_hash, this.config.secretKey)) {
        await countFailure(candidate.id);
        refuse();
      }

      await tx.query('UPDATE login_codes SET consumed_at = now() WHERE id = $1', [candidate.id]);
      return this.issueSession(tx, user.id, user.society_id, user.email, input.userAgent);
    });
  }

  /** Password sign-in, for an account that has one set. */
  async signInWithPassword(input: {
    email: string; password: string; userAgent?: string; ip: string;
  }): Promise<SignInResult> {
    const decision = await consumeRateLimit(this.pool, {
      subject: `${input.ip}|${input.email}`, action: 'login:password',
      limit: this.config.rateLimit.loginPerHour,
      windowMinutes: this.config.rateLimit.windowMinutes,
      secretKey: this.config.secretKey,
    });
    if (!decision.allowed) {
      throw new RateLimitError(
        'Too many sign-in attempts. Try again shortly.',
        decision.retryAfterSeconds,
      );
    }

    return this.pool.transaction(async (tx) => {
      const found = await tx.query<{
        id: string; society_id: string; email: string; password_hash: string | null;
      }>(
        `SELECT id, society_id, email, password_hash FROM users
          WHERE email = $1 AND is_active = true LIMIT 1`,
        [input.email],
      );
      const user = found.rows[0];

      // Verify against a dummy hash when the user is unknown, so the response
      // time does not reveal whether the address exists.
      const stored = user?.password_hash
        ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      const ok = verifyPassword(input.password, stored);

      if (user === undefined || user.password_hash === null || !ok) {
        throw new AuthError('That email and password do not match.');
      }

      return this.issueSession(tx, user.id, user.society_id, user.email, input.userAgent);
    });
  }

  /**
   * Signs in an e-mail address an identity provider has verified — Google.
   *
   * Only an address already on file: there is no sign-up. A member exists
   * because the office imported their flat or added them, and a Google
   * account the society has never heard of gets the same refusal as a wrong
   * password. Rate-limited per source address like every other sign-in.
   */
  async signInWithVerifiedEmail(input: {
    email: string; provider: string; userAgent?: string; ip: string;
  }): Promise<SignInResult> {
    const decision = await consumeRateLimit(this.pool, {
      subject: input.ip, action: `login:${input.provider}`,
      limit: this.config.rateLimit.loginPerHour,
      windowMinutes: this.config.rateLimit.windowMinutes,
      secretKey: this.config.secretKey,
    });
    if (!decision.allowed) {
      throw new RateLimitError('Too many sign-in attempts. Try again shortly.', decision.retryAfterSeconds);
    }
    return this.pool.transaction(async (tx) => {
      const found = await tx.query<{ id: string; society_id: string; email: string }>(
        `SELECT id, society_id, email FROM users
          WHERE lower(email) = lower($1) AND is_active = true LIMIT 1`,
        [input.email],
      );
      const user = found.rows[0];
      if (user === undefined) {
        throw new AuthError('That account is not registered with the society.');
      }
      this.log.info('signed in through an identity provider', { provider: input.provider });
      return this.issueSession(tx, user.id, user.society_id, user.email, input.userAgent);
    });
  }

  private async issueSession(
    tx: Queryable,
    userId: string,
    societyId: string,
    email: string,
    userAgent?: string,
  ): Promise<SignInResult> {
    const token = mintSessionToken();
    const expiresAt = new Date(Date.now() + this.config.sessionTtlMinutes * 60_000);

    await tx.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [
        userId,
        hashToken(token, this.config.secretKey),
        expiresAt.toISOString(),
        userAgent ?? null,
      ],
    );
    await tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);

    const principal = await this.loadPrincipal(tx, userId, societyId, email);
    return {
      principal,
      sessionToken: token,
      csrfToken: mintCsrfToken(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Resolves a session cookie to a principal.
   *
   * Roles and flats are read fresh every time. Putting them in the cookie
   * would be faster and would mean a revoked role kept working until the
   * session expired.
   */
  async resolveSession(token: string | undefined): Promise<Principal | null> {
    if (token === undefined || token === '') return null;
    const hash = hashToken(token, this.config.secretKey);

    const found = await this.pool.query<{
      user_id: string; society_id: string; email: string;
    }>(
      `SELECT s.user_id, u.society_id, u.email
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.is_active = true
        LIMIT 1`,
      [hash],
    );
    const row = found.rows[0];
    if (row === undefined) return null;

    return this.loadPrincipal(this.pool, row.user_id, row.society_id, row.email);
  }

  private async loadPrincipal(
    tx: Queryable,
    userId: string,
    societyId: string,
    email: string,
  ): Promise<Principal> {
    const roleRows = await tx.query<{ role: string }>(
      'SELECT role FROM user_roles WHERE user_id = $1',
      [userId],
    );
    const roles: Role[] = [];
    for (const r of roleRows.rows) {
      if (isValidRole(r.role)) roles.push(r.role);
      else this.log.warn('a role in the database is not one this build knows', { role: r.role });
    }

    // The flats this user may see: those their owner record currently holds.
    // A tenancy that has ended stops granting access, which is what `held_until`
    // is for.
    const flatRows = await tx.query<{ flat_id: string }>(
      `SELECT DISTINCT fo.flat_id
         FROM flat_ownership fo
         JOIN owners o ON o.id = fo.owner_id
         JOIN users u ON u.owner_id = o.id
        WHERE u.id = $1
          AND fo.held_from <= current_date
          AND (fo.held_until IS NULL OR fo.held_until >= current_date)`,
      [userId],
    );

    return {
      userId,
      societyId,
      email,
      roles,
      flatIds: flatRows.rows.map(r => r.flat_id),
    };
  }

  async signOut(token: string | undefined): Promise<void> {
    if (token === undefined || token === '') return;
    await this.pool.query(
      'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashToken(token, this.config.secretKey)],
    );
  }

  /**
   * A signed-in user changing their own password.
   *
   * The current password is asked for even though the session is valid: a
   * session left open on a shared computer should not be enough to take the
   * account over. Rate-limited like a sign-in, since a wrong current password
   * is a guess. Every other session of the account ends; this one stays.
   */
  async changeOwnPassword(input: {
    userId: string; sessionToken: string | undefined;
    currentPassword: string; newPassword: string; ip: string;
  }): Promise<{ sessionsRevoked: number }> {
    const decision = await consumeRateLimit(this.pool, {
      subject: `${input.ip}|${input.userId}`, action: 'password:change',
      limit: this.config.rateLimit.loginPerHour,
      windowMinutes: this.config.rateLimit.windowMinutes,
      secretKey: this.config.secretKey,
    });
    if (!decision.allowed) {
      throw new RateLimitError('Too many attempts. Try again shortly.', decision.retryAfterSeconds);
    }

    return this.pool.transaction(async (tx) => {
      const found = await tx.query<{ password_hash: string | null }>(
        'SELECT password_hash FROM users WHERE id = $1 AND is_active = true',
        [input.userId],
      );
      const stored = found.rows[0]?.password_hash ?? null;
      if (stored === null) {
        throw badRequest('This account has no password to change. Ask the secretary to set one.');
      }
      if (!verifyPassword(input.currentPassword, stored)) {
        throw badRequest('The current password is not right.');
      }
      if (input.currentPassword === input.newPassword) {
        throw badRequest('The new password is the same as the current one.');
      }

      await tx.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
        hashPassword(input.newPassword), input.userId,
      ]);
      const keep = input.sessionToken === undefined || input.sessionToken === ''
        ? ''
        : hashToken(input.sessionToken, this.config.secretKey);
      const revoked = await tx.query(
        `UPDATE sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2`,
        [input.userId, keep],
      );
      return { sessionsRevoked: revoked.rowCount };
    });
  }

  /** Revokes every session for a user. Used when a role changes or on request. */
  async signOutEverywhere(userId: string): Promise<number> {
    const r = await this.pool.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    return r.rowCount;
  }
}
