/**
 * An SMTP client, written against the protocol.
 *
 * This is the email provider that actually sends. Nodemailer cannot be
 * installed here, so this speaks SMTP over node's own `net` and `tls`: EHLO,
 * STARTTLS where the server offers it, AUTH PLAIN or LOGIN, MAIL FROM, RCPT
 * TO, DATA. It is not a mail server and does not try to be — no queueing, no
 * retries, no DKIM signing. Queueing and retries are the job scheduler's, and
 * DKIM is the sending domain's.
 *
 * It reports a delivery only when the server has accepted the message and
 * given a response to DATA, and `providerMessageId` carries that response —
 * which is the only evidence a delivery happened. `notifications` cannot reach
 * state 'sent' without it.
 *
 * NOT CONNECTED without credentials. `resolveEmailProvider` returns this only
 * when SMTP_HOST is configured; with nothing configured the server says so
 * rather than pretending.
 */

import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';
import type { EmailDelivery, EmailMessage, EmailProvider } from './email';
import type { Logger } from '../logger';

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  /** True for implicit TLS on connect (port 465). STARTTLS is used otherwise. */
  readonly implicitTls: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
  readonly fromName?: string;
  readonly timeoutMs: number;
  /** Refuses to send over a connection that never became encrypted. */
  readonly requireTls: boolean;
}

export class SmtpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'SmtpError';
  }
}

interface Reply {
  readonly code: number;
  readonly lines: readonly string[];
}

/**
 * One SMTP conversation.
 *
 * Replies are read line by line because a multi-line reply is `250-` on every
 * line but the last, which is `250 `. Treating the first line as the whole
 * reply is the classic way to miss STARTTLS in the EHLO response.
 */
class Session {
  private socket: Socket | TLSSocket;
  private buffer = '';
  private waiters: Array<{ resolve: (r: Reply) => void; reject: (e: Error) => void }> = [];
  private failure: Error | null = null;
  private secure: boolean;

  constructor(socket: Socket | TLSSocket, secure: boolean) {
    this.socket = socket;
    this.secure = secure;
    this.attach();
  }

  private attach(): void {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => { this.consume(chunk); });
    this.socket.on('error', (err: Error) => { this.fail(err); });
    this.socket.on('close', () => {
      this.fail(new SmtpError('the server closed the connection'));
    });
  }

  private fail(err: Error): void {
    this.failure = err;
    const waiting = this.waiters;
    this.waiters = [];
    for (const waiter of waiting) waiter.reject(err);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      this.pending.push(line);
      // A continuation line has a hyphen in the fourth column.
      if (line.length >= 4 && line[3] === '-') continue;
      const lines = this.pending;
      this.pending = [];
      const code = Number(lines[lines.length - 1].slice(0, 3));
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter.resolve({ code, lines });
    }
  }

  private pending: string[] = [];

  read(): Promise<Reply> {
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise<Reply>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async send(command: string, opts: { secret?: boolean } = {}): Promise<Reply> {
    if (this.failure !== null) throw this.failure;
    this.socket.write(`${command}\r\n`);
    void opts;
    return this.read();
  }

  /** Replaces the plain socket with a TLS one, after STARTTLS. */
  async upgrade(host: string, timeoutMs: number): Promise<void> {
    const plain = this.socket as Socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');

    const upgraded = await new Promise<TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SmtpError('TLS negotiation timed out')), timeoutMs);
      // SNI must be a hostname: RFC 6066 forbids an IP address there, and
      // node warns that it will start ignoring one. `host` is passed either
      // way, because that — not servername — is what the certificate is
      // checked against when there is no SNI, and dropping both would leave
      // an encrypted connection to nobody in particular.
      const isIpAddress = /^[0-9.]+$/.test(host) || host.includes(':');
      const tls = tlsConnect({
        socket: plain,
        host,
        ...(isIpAddress ? {} : { servername: host }),
      }, () => {
        clearTimeout(timer);
        resolve(tls);
      });
      tls.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.socket = upgraded;
    this.secure = true;
    this.buffer = '';
    this.pending = [];
    this.attach();
  }

  get encrypted(): boolean { return this.secure; }

  close(): void {
    try { this.socket.end(); } catch { /* already gone */ }
    try { this.socket.destroy(); } catch { /* already gone */ }
  }
}

function expect(reply: Reply, codes: readonly number[], what: string): Reply {
  if (!codes.includes(reply.code)) {
    throw new SmtpError(
      `${what}: the server answered ${reply.lines.join(' | ')}`,
      reply.code,
    );
  }
  return reply;
}

/**
 * The message, as RFC 5322 text.
 *
 * Headers are folded where they must be and the body is encoded
 * quoted-printable, because an 8-bit body over a server that has not announced
 * 8BITMIME is how a message arrives with the wrong characters.
 */
export function composeMessage(
  message: EmailMessage,
  input: { from: string; fromName?: string; messageId: string; date?: Date },
): string {
  const date = (input.date ?? new Date()).toUTCString().replace('GMT', '+0000');
  const headers = [
    `From: ${input.fromName === undefined ? input.from : `${encodeHeader(input.fromName)} <${input.from}>`}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${date}`,
    `Message-ID: <${input.messageId}>`,
    'MIME-Version: 1.0',
  ];

  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset=utf-8');
    headers.push('Content-Transfer-Encoding: quoted-printable');
    return `${headers.join('\r\n')}\r\n\r\n${quotedPrintable(message.text)}`;
  }

  const boundary = `sb-${input.messageId.replace(/[^A-Za-z0-9]/g, '')}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts: string[] = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(message.text),
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      // 76-character lines, as base64 in mail must be.
      (attachment.body.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
    );
  }
  parts.push(`--${boundary}--`, '');

  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

function encodeHeader(value: string): string {
  // ASCII goes as it is; anything else is encoded, because a raw 8-bit header
  // is not legal and gets mangled.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    let encoded = '';
    for (const byte of Buffer.from(line, 'utf8')) {
      if (byte === 61) encoded += '=3D';
      else if (byte >= 33 && byte <= 126) encoded += String.fromCharCode(byte);
      else if (byte === 32 || byte === 9) encoded += String.fromCharCode(byte);
      else encoded += `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    // Trailing whitespace must be encoded or it is stripped in transit.
    encoded = encoded.replace(/ $/, '=20').replace(/\t$/, '=09');
    // Soft line breaks at 75 characters.
    while (encoded.length > 75) {
      let cut = 75;
      // Never split an escape sequence.
      while (cut > 0 && /=[0-9A-F]?$/.test(encoded.slice(0, cut))) cut -= 1;
      out.push(`${encoded.slice(0, cut)}=`);
      encoded = encoded.slice(cut);
    }
    out.push(encoded);
  }
  return out.join('\r\n');
}

/**
 * Escapes a message body for the DATA command.
 *
 * A line that is a single dot ends the message, so a body line beginning with
 * a dot must be given a second one. Without this, a message containing a line
 * "." is silently truncated at that point.
 */
export function dotStuff(message: string): string {
  return message.replace(/\r\n/g, '\n').split('\n')
    .map(line => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

export function smtpSettingsFromEnv(
  env: Record<string, string | undefined>,
): SmtpSettings | null {
  const host = env.SMTP_HOST;
  if (host === undefined || host.trim() === '') return null;

  const port = Number(env.SMTP_PORT ?? '587');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SmtpError(`SMTP_PORT must be a port number, got "${String(env.SMTP_PORT)}"`);
  }
  const from = env.SMTP_FROM;
  if (from === undefined || !from.includes('@')) {
    throw new SmtpError(
      'SMTP_FROM must be the address messages are sent from. A society\'s invoices ' +
      'cannot go out with no envelope sender.',
    );
  }

  return {
    host: host.trim(),
    port,
    implicitTls: env.SMTP_IMPLICIT_TLS === undefined ? port === 465 : env.SMTP_IMPLICIT_TLS === 'true',
    ...(env.SMTP_USER === undefined ? {} : { user: env.SMTP_USER }),
    ...(env.SMTP_PASSWORD === undefined ? {} : { password: env.SMTP_PASSWORD }),
    from,
    ...(env.SMTP_FROM_NAME === undefined ? {} : { fromName: env.SMTP_FROM_NAME }),
    timeoutMs: Number(env.SMTP_TIMEOUT_MS ?? '20000'),
    // Defaults to refusing plaintext. A member's address and their dues going
    // over an unencrypted connection is a disclosure, not a configuration
    // preference — so turning this off has to be deliberate.
    requireTls: env.SMTP_REQUIRE_TLS !== 'false',
  };
}

export function smtpProvider(settings: SmtpSettings, log: Logger): EmailProvider {
  return {
    name: `smtp:${settings.host}`,
    delivers: true,

    async send(message: EmailMessage): Promise<EmailDelivery> {
      const messageId = `${randomUUID()}@${settings.from.split('@')[1] ?? 'societybooks'}`;
      const socket = await openSocket(settings);
      const session = new Session(socket, settings.implicitTls);

      try {
        expect(await session.read(), [220], 'the server did not greet the connection');

        let greeting = expect(
          await session.send(`EHLO ${hostnameOf(settings.from)}`),
          [250],
          'EHLO was refused',
        );

        const offers = (keyword: string): boolean =>
          greeting.lines.some(line => line.slice(4).toUpperCase().startsWith(keyword));

        if (!session.encrypted && offers('STARTTLS')) {
          expect(await session.send('STARTTLS'), [220], 'STARTTLS was refused');
          await session.upgrade(settings.host, settings.timeoutMs);
          // EHLO again: the extension list after STARTTLS is the one that
          // counts, and AUTH is usually only offered once encrypted.
          greeting = expect(
            await session.send(`EHLO ${hostnameOf(settings.from)}`),
            [250],
            'EHLO after STARTTLS was refused',
          );
        }

        if (settings.requireTls && !session.encrypted) {
          throw new SmtpError(
            `${settings.host} does not offer STARTTLS and SMTP_REQUIRE_TLS is on, so nothing ` +
            'was sent. Members\' addresses and their dues are not going out in plaintext.',
          );
        }

        if (settings.user !== undefined && settings.password !== undefined) {
          await authenticate(session, settings, offers('AUTH LOGIN'));
        }

        expect(
          await session.send(`MAIL FROM:<${settings.from}>`),
          [250],
          'the sender was refused',
        );
        expect(
          await session.send(`RCPT TO:<${message.to}>`),
          [250, 251],
          'the recipient was refused',
        );
        expect(await session.send('DATA'), [354], 'DATA was refused');

        const body = composeMessage(message, {
          from: settings.from,
          ...(settings.fromName === undefined ? {} : { fromName: settings.fromName }),
          messageId,
        });
        const accepted = expect(
          await session.send(`${dotStuff(body)}\r\n.`),
          [250],
          'the message was not accepted',
        );

        // The server's own acceptance line, kept as the evidence of delivery.
        const providerMessageId = accepted.lines.join(' ').trim() || messageId;
        log.info('message accepted by the server', {
          host: settings.host,
          encrypted: session.encrypted,
          response: providerMessageId,
        });

        try { await session.send('QUIT'); } catch { /* the message is already accepted */ }

        return { provider: `smtp:${settings.host}`, providerMessageId };
      } finally {
        session.close();
      }
    },
  };
}

async function authenticate(
  session: Session,
  settings: SmtpSettings,
  preferLogin: boolean,
): Promise<void> {
  const user = settings.user as string;
  const password = settings.password as string;

  if (preferLogin) {
    expect(await session.send('AUTH LOGIN'), [334], 'AUTH LOGIN was refused');
    expect(
      await session.send(Buffer.from(user, 'utf8').toString('base64'), { secret: true }),
      [334],
      'the username was refused',
    );
    expect(
      await session.send(Buffer.from(password, 'utf8').toString('base64'), { secret: true }),
      [235],
      'authentication failed',
    );
    return;
  }

  const token = Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64');
  expect(
    await session.send(`AUTH PLAIN ${token}`, { secret: true }),
    [235],
    'authentication failed',
  );
}

function hostnameOf(address: string): string {
  const domain = address.split('@')[1];
  return domain === undefined || domain === '' ? 'localhost' : domain;
}

function openSocket(settings: SmtpSettings): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SmtpError(`connecting to ${settings.host}:${settings.port} timed out`));
    }, settings.timeoutMs);

    const done = (socket: Socket | TLSSocket): void => {
      clearTimeout(timer);
      socket.removeListener('error', failed);
      socket.setTimeout(settings.timeoutMs);
      resolve(socket);
    };
    const failed = (err: Error): void => {
      clearTimeout(timer);
      reject(err);
    };

    if (settings.implicitTls) {
      const socket = tlsConnect(
        { host: settings.host, port: settings.port, servername: settings.host },
        () => done(socket),
      );
      socket.once('error', failed);
    } else {
      const socket = createConnection({ host: settings.host, port: settings.port }, () => done(socket));
      socket.once('error', failed);
    }
  });
}
