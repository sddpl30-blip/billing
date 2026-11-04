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
import { recipientsOf } from '../contactEmails';
import type { BlockedAddress, EmailDelivery, EmailMessage, EmailProvider } from './email';

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
    /**
     * Brevo's transactional block-list: the addresses it will not send to,
     * after a hard bounce, a spam complaint or an unsubscribe. Read-only. Up
     * to 2,000 are read, a hundred a request.
     */
    /** Removes one address from Brevo's transactional block-list (DELETE, by address). */
    async unblockAddress(email: string): Promise<void> {
      const base = settings.apiUrl.replace(/\/smtp\/email$/, '/smtp/blockedContacts');
      let response: { ok: boolean; status: number; text(): Promise<string> };
      try {
        response = await fetch(`${base}/${encodeURIComponent(email)}`, {
          method: 'DELETE',
          headers: { 'api-key': settings.apiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(settings.timeoutMs),
        });
      } catch (err) {
        throw new Error(`Brevo could not be reached: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 204 is removed; 404 means it was not on the list, which is the state wanted.
      if (response.ok || response.status === 404) return;
      const text = await response.text();
      let message = text.slice(0, 200);
      try { const parsed = JSON.parse(text) as { message?: unknown }; if (typeof parsed.message === 'string') message = parsed.message; } catch { /* not JSON */ }
      throw new Error(`Brevo refused to unblock the address (${response.status}): ${message}`);
    },

    async blockedAddresses(): Promise<BlockedAddress[]> {
      const base = settings.apiUrl.replace(/\/smtp\/email$/, '/smtp/blockedContacts');
      const out: BlockedAddress[] = [];
      for (let offset = 0; offset < 2000; offset += 100) {
        let response: { ok: boolean; status: number; text(): Promise<string> };
        try {
          response = await fetch(`${base}?limit=100&offset=${offset}`, {
            headers: { 'api-key': settings.apiKey, accept: 'application/json' },
            signal: AbortSignal.timeout(settings.timeoutMs),
          });
        } catch (err) {
          throw new Error(`Brevo could not be reached: ${err instanceof Error ? err.message : String(err)}`);
        }
        const text = await response.text();
        let parsed: { contacts?: unknown; message?: unknown } = {};
        try { parsed = text === '' ? {} : JSON.parse(text) as typeof parsed; } catch { /* not JSON */ }
        if (!response.ok) {
          throw new Error(`Brevo refused the block-list request (${response.status}): ${typeof parsed.message === 'string' ? parsed.message : text.slice(0, 200)}`);
        }
        const contacts = Array.isArray(parsed.contacts) ? parsed.contacts as Array<{ email?: unknown; reason?: { message?: unknown; code?: unknown }; blockedAt?: unknown }> : [];
        for (const c of contacts) {
          if (typeof c.email !== 'string') continue;
          out.push({
            email: c.email.toLowerCase(),
            reason: typeof c.reason?.message === 'string' ? c.reason.message : typeof c.reason?.code === 'string' ? c.reason.code : 'blocked',
            blockedAt: typeof c.blockedAt === 'string' ? c.blockedAt : null,
          });
        }
        if (contacts.length < 100) break;
      }
      return out;
    },
    async send(message: EmailMessage): Promise<EmailDelivery> {
      const body = {
        sender: { email: settings.from, ...(settings.fromName === undefined ? {} : { name: settings.fromName }) },
        to: recipientsOf(message.to).map(email => ({ email })),
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
