/**
 * One-time code delivery.
 *
 * `emailOtpProvider` (OTP_PROVIDER=email) sends the code through the configured
 * email provider, so with EMAIL_PROVIDER=smtp members sign in from their inbox.
 * No SMS provider is integrated. `localDevProvider` writes the code to the
 * log and returns a fake message id; it is refused in production by
 * `loadConfig`, which will not start with OTP_PROVIDER=local-dev there.
 *
 * `noneProvider` is the production default: it refuses to issue a code at all,
 * so a deployment without a configured provider cannot silently fail to send
 * one and leave members unable to sign in without anybody noticing.
 *
 * To connect a real one: implement `OtpProvider`, return the provider's own
 * message id from `send`, and register it in `resolveOtpProvider`. The message
 * id is what makes "sent" mean anything — nothing in this system records a
 * delivery it cannot evidence.
 */

import type { Logger } from '../logger';

export interface OtpDelivery {
  /** The provider's own id for the message. Required: it is the evidence. */
  readonly providerMessageId: string;
  readonly provider: string;
}

export interface OtpProvider {
  readonly name: string;
  /** True when this provider actually delivers to a real recipient. */
  readonly delivers: boolean;
  send(input: { to: string; code: string; expiresInMinutes: number }): Promise<OtpDelivery>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(what: string) {
    super(
      `No ${what} provider is configured, so nothing was sent. This is a configuration ` +
      `gap, not a transient failure: set the provider in the environment and restart.`,
    );
    this.name = 'ProviderNotConfiguredError';
  }
}

/**
 * Development only. Logs the code instead of sending it.
 *
 * The code appears in the log on purpose — there is nowhere else for it to go
 * — and that is exactly why `loadConfig` refuses this provider in production.
 */
export function localDevOtpProvider(log: Logger): OtpProvider {
  let counter = 0;
  return {
    name: 'local-dev',
    delivers: false,
    async send({ to, code, expiresInMinutes }) {
      counter += 1;
      log.warn(
        'DEVELOPMENT ONLY: a one-time code was written to this log instead of being sent',
        { to, code, expiresInMinutes, provider: 'local-dev' },
      );
      return { provider: 'local-dev', providerMessageId: `local-dev-${Date.now()}-${counter}` };
    },
  };
}

/** The production default until a real provider is wired in. */
export function noneOtpProvider(): OtpProvider {
  return {
    name: 'none',
    delivers: false,
    async send() {
      throw new ProviderNotConfiguredError('one-time code');
    },
  };
}

/**
 * Sends the code by email, through whichever email provider is configured.
 *
 * The member's address is already what they sign in with, so this needs no
 * second provider: with EMAIL_PROVIDER=smtp a code reaches the member's inbox,
 * and it delivers exactly when the email provider does.
 */
export function emailOtpProvider(email: {
  readonly name: string;
  readonly delivers: boolean;
  send(message: { to: string; subject: string; text: string }): Promise<{ provider: string; providerMessageId: string }>;
}): OtpProvider {
  return {
    name: `email:${email.name}`,
    delivers: email.delivers,
    async send({ to, code, expiresInMinutes }) {
      const delivery = await email.send({
        to,
        subject: 'Your sign-in code',
        text:
          `Your sign-in code is ${code}.\n\n` +
          `It can be used once and expires in ${expiresInMinutes} minutes. ` +
          'If you did not ask to sign in, ignore this email; nobody can use the code without ' +
          'access to this inbox.',
      });
      return { provider: delivery.provider, providerMessageId: delivery.providerMessageId };
    },
  };
}

export function resolveOtpProvider(
  which: 'local-dev' | 'none' | 'email',
  log: Logger,
  email?: Parameters<typeof emailOtpProvider>[0],
): OtpProvider {
  if (which === 'email') {
    if (email === undefined) throw new ProviderNotConfiguredError('email for one-time codes');
    return emailOtpProvider(email);
  }
  return which === 'local-dev' ? localDevOtpProvider(log) : noneOtpProvider();
}
