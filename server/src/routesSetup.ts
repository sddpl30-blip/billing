/**
 * First-time setup over HTTP: the setup screen's two calls.
 *
 *   GET  /api/setup   whether setup is still needed, and whether it is open
 *   POST /api/setup   create the production society and its secretary
 *
 * Closed three ways. SETUP_TOKEN must be set in the deployment (without it the
 * route says setup is CLI-only), the caller must present it, and once a
 * production society exists the route refuses whatever is presented — the
 * first secretary can only be created once. Wrong tokens are rate-limited per
 * address like sign-in attempts.
 */

import { timingSafeEqual } from 'node:crypto';
import { conflict, route, type RouteDefinition } from './http';
import { v } from './validate';
import { RateLimitError, consumeRateLimit } from './security';
import { ForbiddenError } from './rbac';
import { AlreadyBootstrappedError, createProductionSociety, needsBootstrap } from './bootstrap';
import type { PgPool } from './pg';
import type { Config } from './config';
import type { Logger } from './logger';

export interface SetupDependencies {
  readonly pool: PgPool;
  readonly config: Config;
  readonly log: Logger;
}

const tokenMatches = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

export function createSetupRoutes(deps: SetupDependencies): RouteDefinition[] {
  const { pool, config, log } = deps;

  const status = route('GET', '/api/setup', async () => {
    const required = await needsBootstrap(pool);
    return {
      status: 200,
      body: { required, open: required && config.setupToken !== null },
    };
  }, { authenticated: false });

  const run = route('POST', '/api/setup', async (ctx) => {
    if (config.setupToken === null) {
      throw conflict(
        'Setup over the web is closed: SETUP_TOKEN is not set in this deployment. Set it and ' +
        'redeploy, or run `npm run db:bootstrap` from a terminal.',
      );
    }
    const input = ctx.body(v.object({
      token: v.string({ min: 1, max: 200 }),
      societyName: v.string({ min: 3, max: 200 }),
      registrationNo: v.string({ max: 100 }).optional(),
      gstin: v.string({
        pattern: /^[0-9]{2}[A-Z0-9]{13}$/, patternName: 'a 15-character GSTIN',
      }).optional(),
      stateCode: v.string({ pattern: /^[0-9]{2}$/, patternName: 'a two-digit state code' }).optional(),
      invoicePrefix: v.string({
        min: 1, max: 6, pattern: /^[A-Z0-9]+$/, patternName: '1–6 capital letters or digits',
      }),
      secretaryEmail: v.email(),
      secretaryPassword: v.string({ min: 12, max: 200 }),
      bank: v.object({
        bankName: v.string({ min: 2, max: 100 }),
        last4: v.string({ pattern: /^[0-9]{4}$/, patternName: 'the last four digits' }),
        ifsc: v.string({ pattern: /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, patternName: 'an IFSC code' }),
      }).optional(),
    }));

    // Counted before the comparison, on the pool, so a wrong guess costs an
    // attempt whatever happens after it.
    const decision = await consumeRateLimit(pool, {
      subject: ctx.ip, action: 'setup',
      limit: config.rateLimit.loginPerHour,
      windowMinutes: config.rateLimit.windowMinutes,
      secretKey: config.secretKey,
    });
    if (!decision.allowed) {
      throw new RateLimitError('Too many setup attempts. Try again shortly.', decision.retryAfterSeconds);
    }
    if (!tokenMatches(input.token, config.setupToken)) {
      log.warn('a setup attempt presented the wrong token');
      throw new ForbiddenError('That setup token is not the one this deployment was given.');
    }

    try {
      const result = await pool.transaction(tx => createProductionSociety(tx, {
        societyName: input.societyName.trim(),
        invoicePrefix: input.invoicePrefix,
        secretaryEmail: input.secretaryEmail,
        secretaryPassword: input.secretaryPassword,
        requestId: ctx.requestId,
        ...(input.registrationNo ? { registrationNo: input.registrationNo.trim() } : {}),
        ...(input.gstin ? { gstin: input.gstin } : {}),
        ...(input.stateCode ? { stateCode: input.stateCode } : {}),
        ...(input.bank ? { bank: input.bank } : {}),
      }));
      log.info('production society created through setup', { societyId: result.societyId });
      return {
        status: 201,
        body: {
          societyId: result.societyId,
          secretaryEmail: input.secretaryEmail.trim().toLowerCase(),
          next:
            'Sign in as the secretary. Then remove SETUP_TOKEN from the deployment: setup is ' +
            'closed now anyway, and a secret nobody needs is better gone.',
        },
      };
    } catch (err) {
      if (err instanceof AlreadyBootstrappedError) throw conflict(err.message);
      throw err;
    }
  }, { authenticated: false, csrfExempt: true });

  return [status, run];
}
