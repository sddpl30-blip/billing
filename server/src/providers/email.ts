/**
 * Email delivery.
 *
 * ── NOT CONNECTED ───────────────────────────────────────────────────────────
 * No transactional email service is integrated. `localDevEmailProvider` writes
 * the message to the log; `noneEmailProvider` refuses.
 *
 * A notification row cannot be marked `sent` without a provider name and that
 * provider's message id — a CHECK constraint in the schema enforces it — so
 * neither of these can produce a record claiming a member was emailed.
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { Logger } from '../logger';
import { smtpProvider, smtpSettingsFromEnv } from './smtp';
import { ProviderNotConfiguredError } from './otp';

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Attachment bytes, for an invoice or a receipt. */
  readonly attachments?: ReadonlyArray<{ filename: string; contentType: string; body: Buffer }>;
}

export interface EmailDelivery {
  readonly provider: string;
  readonly providerMessageId: string;
}

export interface EmailProvider {
  readonly name: string;
  readonly delivers: boolean;
  send(message: EmailMessage): Promise<EmailDelivery>;
}

export function localDevEmailProvider(log: Logger): EmailProvider {
  let counter = 0;
  return {
    name: 'local-dev',
    delivers: false,
    async send(message) {
      counter += 1;
      log.warn('DEVELOPMENT ONLY: an email was logged instead of being sent', {
        to: message.to,
        subject: message.subject,
        bytes: Buffer.byteLength(message.text, 'utf8'),
        attachments: (message.attachments ?? []).map(a => a.filename),
      });
      return { provider: 'local-dev', providerMessageId: `local-dev-mail-${Date.now()}-${counter}` };
    },
  };
}

export function noneEmailProvider(): EmailProvider {
  return {
    name: 'none',
    delivers: false,
    async send() {
      throw new ProviderNotConfiguredError('email');
    },
  };
}

/**
 * Picks the provider from the configuration.
 *
 * `smtp` is the one that sends; it is resolved from the environment and throws
 * if SMTP_HOST is missing, which `loadConfig` has already refused. The other
 * two deliver nothing and say so: `delivers` is false on both, which is why no
 * response and no notification row claims a send when one of them is in use.
 */
export function resolveEmailProvider(
  which: 'local-dev' | 'none' | 'smtp',
  log: Logger,
  env: Record<string, string | undefined> = {},
): EmailProvider {
  if (which === 'smtp') {
    const settings = smtpSettingsFromEnv(env);
    if (settings === null) {
      throw new ProviderNotConfiguredError(
        'smtp: SMTP_HOST is not set, so there is nowhere to send',
      );
    }
    return smtpProvider(settings, log);
  }
  return which === 'local-dev' ? localDevEmailProvider(log) : noneEmailProvider();
}
