/**
 * E-mail through Brevo's transactional API (https://developers.brevo.com).
 *
 *   EMAIL_PROVIDER=brevo
 *   BREVO_API_KEY   the API key from Brevo → SMTP & API → API keys
 *   EMAIL_FROM      the sender address, verified in Brevo (falls back to SMTP_FROM)
 *   EMAIL_FROM_NAME optional display name (falls back to SMTP_FROM_NAME)
 *
 * One HTTPS request per message. A send counts only when Brevo answers 2xx
 * with a messageId; that id is what the notifications row records, so a row
 * reaches 'sent' only on Brevo's own acceptance. Anything else throws with
 * Brevo's message, and the row is marked failed with it.
 */

import type { Logger } from '../logger';
import type { EmailDelivery, EmailMessage, EmailProvider } from './email';

export interface BrevoSettings {
  readonly apiKey: string;
  readonly from: string;
  readonly fromName?: string;
  /** Overridable only for tests; production always talks to Brevo. */
  readonly apiUrl: string;
  readonly timeoutMs: number;
}

export function brevoSettingsFromEnv(
  env: Record<string, string | undefined>, isProduction: boolean,
): BrevoSettings | null {
  const apiKey = (env.BREVO_API_KEY ?? '').trim();
  const from = (env.EMAIL_FROM ?? env.SMTP_FROM ?? '').trim();
  if (apiKey === '' || from === '') return null;
  const fromName = (env.EMAIL_FROM_NAME ?? env.SMTP_FROM_NAME ?? '').trim();
  return {
    apiKey,
    from,
    ...(fromName === '' ? {} : { fromName }),
    apiUrl: (!isProduction && env.BREVO_API_URL) || 'https://api.brevo.com/v3/smtp/email',
    timeoutMs: Number(env.BREVO_TIMEOUT_MS ?? '15000'),
  };
}

export function brevoProvider(settings: BrevoSettings, log: Logger): EmailProvider {
  return {
    name: 'brevo',
    delivers: true,
    async send(message: EmailMessage): Promise<EmailDelivery> {
      const body = {
        sender: { email: settings.from, ...(settings.fromName === undefined ? {} : { name: settings.fromName }) },
        to: [{ email: message.to }],
        subject: message.subject,
        textContent: message.text,
        ...(message.attachments !== undefined && message.attachments.length > 0
          ? { attachment: message.attachments.map(a => ({ name: a.filename, content: a.body.toString('base64') })) }
          : {}),
      };
      let response: { ok: boolean; status: number; text(): Promise<string> };
      try {
        response = await fetch(settings.apiUrl, {
          method: 'POST',
          headers: { 'api-key': settings.apiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(settings.timeoutMs),
        });
      } catch (err) {
        throw new Error(`Brevo could not be reached: ${err instanceof Error ? err.message : String(err)}`);
      }
      const text = await response.text();
      let parsed: { messageId?: unknown; message?: unknown; code?: unknown } = {};
      try { parsed = text === '' ? {} : JSON.parse(text) as typeof parsed; } catch { /* not JSON */ }
      if (!response.ok || typeof parsed.messageId !== 'string' || parsed.messageId === '') {
        const why = typeof parsed.message === 'string' ? parsed.message : text.slice(0, 200);
        log.warn('Brevo refused a message', { status: response.status, code: parsed.code });
        throw new Error(`Brevo refused the message (${response.status}): ${why}`);
      }
      return { provider: 'brevo', providerMessageId: parsed.messageId };
    },
  };
}
