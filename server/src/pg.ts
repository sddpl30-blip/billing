/**
 * A minimal PostgreSQL client speaking the wire protocol directly.
 *
 * Why not `pg`: the npm registry is unreachable in the environment this was
 * written in, so no driver could be installed. Why not shelling out to `psql`:
 * a subprocess per statement cannot hold a transaction open, and building SQL
 * by string interpolation to pass values is how injection happens.
 *
 * So this implements the parts of the v3 protocol the server actually needs:
 *
 *   · startup with trust, cleartext and md5 authentication
 *   · the extended query protocol — Parse, Bind, Execute — which is what gives
 *     real parameter binding, so a value can never be parsed as SQL
 *   · simple query, for migrations and multi-statement scripts
 *   · BEGIN / COMMIT / ROLLBACK on a single pinned connection
 *   · a small connection pool
 *
 * It does NOT implement: SCRAM-SHA-256 (so a production server with
 * `scram-sha-256` auth needs the real driver or a password-less connection),
 * TLS, COPY, notifications, prepared-statement caching, or binary parameter
 * formats. Every value is sent and received as text.
 *
 * It is deliberately shaped like the slice of `pg`'s API this codebase uses, so
 * replacing it is a matter of swapping the import.
 */

import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import {
  createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual,
} from 'node:crypto';

export class PgError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly constraint?: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'PgError';
  }
}

export interface QueryResult<Row = Record<string, string | null>> {
  readonly rows: Row[];
  readonly fields: string[];
  /** Rows affected, where the command reports it. */
  readonly rowCount: number;
  readonly command: string;
}

/**
 * How much TLS to insist on, named as libpq names it.
 *
 *   disable      never offer it
 *   prefer       use it when the server offers it, carry on without otherwise
 *   require      refuse to connect without it, but do not check the certificate
 *   verify-full  require it and verify the certificate against the CA store
 *
 * A managed Postgres — Neon, RDS, Supabase — refuses a connection that is not
 * encrypted, so `require` is the floor there. `verify-full` is the right
 * setting for production: `require` alone encrypts the traffic without
 * establishing who is on the other end of it.
 */
export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-full';

export interface ConnectionOptions {
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  readonly database: string;
  readonly password?: string;
  readonly connectTimeoutMs?: number;
  /** Defaults to 'prefer' over TCP and 'disable' over a unix socket. */
  readonly sslMode?: SslMode;
  /** SNI name, when it differs from the host. Neon routes on it. */
  readonly servername?: string;
  /**
   * SCRAM channel binding. 'require' refuses to authenticate unless the
   * exchange is bound to this TLS connection, which is what stops a
   * man-in-the-middle relaying the handshake to the real server.
   */
  readonly channelBinding?: 'disable' | 'prefer' | 'require';
  /** Extra startup parameters, such as libpq's `options`. */
  readonly startupParameters?: Readonly<Record<string, string>>;
  readonly applicationName?: string;
}

// --- message writing -------------------------------------------------------

/** Builds protocol messages. Length prefixes are filled in on finish(). */
class Writer {
  private chunks: Buffer[] = [];

  int32(value: number): this {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32BE(value, 0);
    this.chunks.push(b);
    return this;
  }

  int16(value: number): this {
    const b = Buffer.allocUnsafe(2);
    b.writeInt16BE(value, 0);
    this.chunks.push(b);
    return this;
  }

  cstring(value: string): this {
    this.chunks.push(Buffer.from(value, 'utf8'), Buffer.from([0]));
    return this;
  }

  bytes(value: Buffer): this {
    this.chunks.push(value);
    return this;
  }

  /** Prefixes the type byte and the length, as the protocol requires. */
  finish(type?: string): Buffer {
    const body = Buffer.concat(this.chunks);
    const length = Buffer.allocUnsafe(4);
    length.writeInt32BE(body.length + 4, 0);
    return type === undefined
      ? Buffer.concat([length, body])
      : Buffer.concat([Buffer.from(type, 'ascii'), length, body]);
  }
}

// --- message reading -------------------------------------------------------

interface ServerMessage {
  readonly type: string;
  readonly body: Buffer;
}

/**
 * Splits the byte stream into messages.
 *
 * TCP gives no message boundaries, so a reply can arrive in pieces or several
 * replies in one chunk. Buffering here rather than at each call site is the
 * difference between a client that works and one that works until it is busy.
 */
class MessageStream {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /** Returns complete messages and keeps any partial tail. */
  take(): ServerMessage[] {
    const out: ServerMessage[] = [];
    while (this.buffer.length >= 5) {
      const length = this.buffer.readInt32BE(1);
      const total = length + 1;
      if (this.buffer.length < total) break;
      out.push({
        type: String.fromCharCode(this.buffer[0]),
        body: this.buffer.subarray(5, total),
      });
      this.buffer = this.buffer.subarray(total);
    }
    return out;
  }
}

function readCString(body: Buffer, offset: number): { value: string; next: number } {
  const end = body.indexOf(0, offset);
  if (end === -1) throw new PgError('malformed message: unterminated string');
  return { value: body.subarray(offset, end).toString('utf8'), next: end + 1 };
}

/** ErrorResponse and NoticeResponse are a set of tagged fields. */
function parseErrorFields(body: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const tag = String.fromCharCode(body[offset]);
    const { value, next } = readCString(body, offset + 1);
    fields[tag] = value;
    offset = next;
  }
  return fields;
}

function errorFrom(body: Buffer): PgError {
  const f = parseErrorFields(body);
  return new PgError(
    `${f.S ?? 'ERROR'}: ${f.M ?? 'unknown error'}`,
    f.C,
    f.n,
    f.D,
  );
}

// --- the connection --------------------------------------------------------

type Waiter = { resolve: (v: ServerMessage[]) => void; reject: (e: Error) => void };

/**
 * One connection. Not safe for concurrent queries — the protocol is a single
 * request/response stream per connection — which is why the pool hands out one
 * at a time and a transaction pins one.
 */
export class PgConnection {
  private socket: Socket | null = null;
  private stream = new MessageStream();
  private pending: ServerMessage[] = [];
  private waiter: Waiter | null = null;
  private failure: Error | null = null;
  private closed = false;
  /** True between BEGIN and COMMIT/ROLLBACK, so the pool does not reuse it. */
  inTransaction = false;

  private tls: TLSSocket | null = null;

  constructor(private readonly options: ConnectionOptions) {}

  async connect(): Promise<void> {
    const port = this.options.port ?? 5432;
    const isSocketDir = this.options.host.startsWith('/');
    const timeoutMs = this.options.connectTimeoutMs ?? 10000;

    const plain = await new Promise<Socket>((resolve, reject) => {
      // A unix socket path is the directory; the file is .s.PGSQL.<port>.
      const target = isSocketDir
        ? { path: `${this.options.host}/.s.PGSQL.${port}` }
        : { host: this.options.host, port };
      const s = createConnection(target);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new PgError(`timed out connecting to ${JSON.stringify(target)}`));
      }, timeoutMs);
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
    plain.setNoDelay(true);

    // Over a unix socket there is nothing to encrypt — the bytes never leave
    // the machine — so TLS defaults off there and on everywhere else.
    const mode: SslMode = this.options.sslMode
      ?? (isSocketDir ? 'disable' : 'prefer');

    this.socket = mode === 'disable'
      ? plain
      : await this.negotiateTls(plain, mode, timeoutMs);

    this.socket.on('data', (chunk: Buffer) => {
      this.stream.push(chunk);
      this.pending.push(...this.stream.take());
      this.flush();
    });
    this.socket.on('error', (err) => this.fail(err));
    this.socket.on('close', () => {
      if (!this.closed) this.fail(new PgError('connection closed by the server'));
    });

    await this.startup();
  }

  /** True once the connection is encrypted. Reported by the health endpoint. */
  get encrypted(): boolean { return this.tls !== null; }

  /** The cipher in use, for an operator who wants to see it. */
  get cipher(): string | null {
    const socket = this.tls;
    if (socket === null) return null;
    const cipher = socket.getCipher?.();
    return cipher === undefined ? 'unknown' : `${cipher.name} (${cipher.version})`;
  }

  /**
   * Asks the server for TLS and upgrades the socket.
   *
   * The exchange is not part of the message protocol: eight bytes, a length
   * and the magic number 80877103, answered with a single byte — 'S' to
   * proceed, 'N' to refuse. Nothing else may be read from the socket before
   * the answer, which is why this is done here rather than through the
   * message reader.
   */
  private async negotiateTls(
    plain: Socket,
    mode: SslMode,
    timeoutMs: number,
  ): Promise<Socket | TLSSocket> {
    const answer = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new PgError('the server did not answer the TLS request')),
        timeoutMs,
      );
      const onData = (chunk: Buffer): void => {
        clearTimeout(timer);
        plain.removeListener('data', onData);
        plain.removeListener('error', onError);
        resolve(chunk.toString('latin1', 0, 1));
      };
      const onError = (err: Error): void => {
        clearTimeout(timer);
        reject(err);
      };
      plain.on('data', onData);
      plain.once('error', onError);
      // Int32 length, then the SSLRequest code.
      const request = Buffer.allocUnsafe(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      plain.write(request);
    });

    if (answer === 'N') {
      if (mode === 'require' || mode === 'verify-full') {
        plain.destroy();
        throw new PgError(
          `the server refused TLS and sslmode is "${mode}". A managed Postgres always ` +
          'offers it, so this is usually the wrong host, the wrong port, or a proxy in ' +
          'between. Nothing was sent: the password has not left this process.',
        );
      }
      return plain;
    }
    if (answer !== 'S') {
      plain.destroy();
      throw new PgError(
        `expected 'S' or 'N' in answer to the TLS request, got ${JSON.stringify(answer)}`,
      );
    }

    const candidate = this.options.servername ?? this.options.host;
    const isIpAddress = /^[0-9.]+$/.test(candidate) || candidate.includes(':');
    const servername = isIpAddress ? null : candidate;

    const upgraded = await new Promise<TLSSocket>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new PgError('TLS negotiation timed out')),
        timeoutMs,
      );
      const socket = tlsConnect(
        {
          socket: plain,
          // SNI must be a hostname: RFC 6066 forbids an IP address there, and
          // node warns about it. A provider that routes on SNI — Neon does —
          // is always addressed by name anyway.
          ...(servername === null ? {} : { servername }),
          // 'require' encrypts without establishing who is on the other end;
          // 'verify-full' is the one that checks. Named so an operator reading
          // the configuration can see which they chose.
          rejectUnauthorized: mode === 'verify-full',
        },
        () => { clearTimeout(timer); resolve(socket); },
      );
      socket.once('error', (err: Error) => { clearTimeout(timer); reject(err); });
    });

    this.tls = upgraded;
    return upgraded;
  }

  private fail(err: Error): void {
    this.failure = err;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter.reject(err);
  }

  private flush(): void {
    if (this.waiter === null) return;
    // A reply is complete at ReadyForQuery, or at an error for startup.
    const readyAt = this.pending.findIndex(m => m.type === 'Z');
    if (readyAt === -1) return;
    const batch = this.pending.splice(0, readyAt + 1);
    const waiter = this.waiter;
    this.waiter = null;
    waiter.resolve(batch);
  }

  private send(buffer: Buffer): void {
    if (this.socket === null) throw new PgError('not connected');
    if (this.failure !== null) throw this.failure;
    this.socket.write(buffer);
  }

  /** Sends, then waits for the reply up to ReadyForQuery. */
  private exchange(buffer: Buffer): Promise<ServerMessage[]> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.waiter !== null) {
      return Promise.reject(new PgError('a query is already in flight on this connection'));
    }
    return new Promise<ServerMessage[]>((resolve, reject) => {
      this.waiter = { resolve, reject };
      try {
        this.send(buffer);
      } catch (err) {
        this.waiter = null;
        reject(err as Error);
        return;
      }
      this.flush();
    });
  }

  /** Startup is its own exchange: several auth round trips, then ReadyForQuery. */
  private async startup(): Promise<void> {
    const writer = new Writer()
      .int32(196608) // protocol 3.0
      .cstring('user').cstring(this.options.user)
      .cstring('database').cstring(this.options.database)
      // Dates and intervals come back in a form this client can parse, and
      // integers as text, whatever the server's defaults are.
      .cstring('DateStyle').cstring('ISO, YMD')
      .cstring('client_encoding').cstring('UTF8')
      .cstring('application_name')
      .cstring(this.options.applicationName ?? 'societybooks-api');

    // Anything else the connection string carried — libpq's `options`, which
    // is how some providers route a connection to the right compute.
    for (const [key, value] of Object.entries(this.options.startupParameters ?? {})) {
      writer.cstring(key).cstring(value);
    }

    const startup = writer.cstring('').finish();

    let messages = await this.exchangeStartup(startup);

    // Authentication may take more than one round trip.
    for (let round = 0; round < 5; round++) {
      const auth = messages.find(m => m.type === 'R');
      const error = messages.find(m => m.type === 'E');
      if (error) throw errorFrom(error.body);
      if (!auth) break;

      const kind = auth.body.readInt32BE(0);
      if (kind === 0) break; // AuthenticationOk

      if (kind === 3) {
        // Cleartext. Only acceptable over a unix socket or TLS; this client has
        // no TLS, so a TCP server demanding this is a misconfiguration.
        const password = this.requirePassword();
        messages = await this.exchangeStartup(
          new Writer().cstring(password).finish('p'),
        );
        continue;
      }

      if (kind === 5) {
        // md5: md5(md5(password + user) + salt), hex, prefixed "md5".
        const password = this.requirePassword();
        const salt = auth.body.subarray(4, 8);
        const inner = createHash('md5')
          .update(password + this.options.user, 'utf8').digest('hex');
        const outer = createHash('md5')
          .update(Buffer.concat([Buffer.from(inner, 'utf8'), salt])).digest('hex');
        messages = await this.exchangeStartup(
          new Writer().cstring(`md5${outer}`).finish('p'),
        );
        continue;
      }

      if (kind === 10) {
        // SASL. The mechanisms the server will accept, as a list of cstrings.
        const mechanisms = auth.body.subarray(4).toString('utf8')
          .split('\0').filter(name => name !== '');
        messages = await this.authenticateScram(mechanisms);
        continue;
      }

      throw new PgError(`unsupported authentication method ${kind}`);
    }

    const error = messages.find(m => m.type === 'E');
    if (error) throw errorFrom(error.body);
  }

  /**
   * SCRAM-SHA-256, as RFC 5802 and RFC 7677 define it.
   *
   * The password never crosses the wire, in any form. Both sides prove they
   * know it by signing a transcript of the exchange, and this client checks
   * the server's half of that proof as well — skipping that check is what
   * lets something in the middle accept any password and be believed.
   *
   * SCRAM-SHA-256-PLUS binds the exchange to this TLS connection by mixing in
   * a hash of the server's certificate. With it, a proxy that terminates TLS
   * cannot relay the handshake to the real server: the transcript would not
   * match. It is used whenever the server offers it and the connection is
   * encrypted.
   */
  private async authenticateScram(mechanisms: readonly string[]): Promise<ServerMessage[]> {
    const password = this.requirePassword();
    const binding = this.options.channelBinding ?? 'prefer';

    const offersPlus = mechanisms.includes('SCRAM-SHA-256-PLUS');
    const offersPlain = mechanisms.includes('SCRAM-SHA-256');
    if (!offersPlus && !offersPlain) {
      throw new PgError(
        `the server offered ${mechanisms.join(', ') || 'no SASL mechanism'}; this client ` +
        'implements SCRAM-SHA-256 and SCRAM-SHA-256-PLUS',
      );
    }

    const certificate = this.tls?.getPeerCertificate?.();
    const der = certificate?.raw;
    const canBind = this.tls !== null && der !== undefined && offersPlus;

    if (binding === 'require' && !canBind) {
      throw new PgError(
        'channel binding is required and not available: ' +
        (this.tls === null
          ? 'the connection is not encrypted'
          : offersPlus
            ? 'the server certificate could not be read'
            : 'the server does not offer SCRAM-SHA-256-PLUS'),
      );
    }

    const usePlus = canBind && binding !== 'disable';
    const mechanism = usePlus ? 'SCRAM-SHA-256-PLUS' : 'SCRAM-SHA-256';

    // The gs2 header says what the client did about channel binding, and it is
    // part of the signed transcript — so a downgrade cannot go unnoticed.
    //
    // The three values are not interchangeable, and getting this wrong is a
    // protocol error rather than a weaker connection:
    //
    //   'p=...'  bound to this TLS connection
    //   'y,,'    "I support binding and you did not offer it" — which the
    //            server rejects outright if it *did* offer it, because that is
    //            what a downgrade attack looks like
    //   'n,,'    "I do not support binding", which is the honest header when
    //            it has been turned off or there is no TLS to bind to
    const gs2 = usePlus
      ? 'p=tls-server-end-point,,'
      : (offersPlus ? 'n,,' : 'y,,');
    const clientNonce = randomBytes(18).toString('base64');
    const clientFirstBare = `n=*,r=${clientNonce}`;

    const initial = new Writer()
      .cstring(mechanism)
      .int32(Buffer.byteLength(gs2 + clientFirstBare, 'utf8'))
      .bytes(Buffer.from(gs2 + clientFirstBare, 'utf8'))
      .finish('p');

    let messages = await this.exchangeStartup(initial);
    const error = messages.find(m => m.type === 'E');
    if (error) throw errorFrom(error.body);

    const challenge = messages.find(
      m => m.type === 'R' && m.body.readInt32BE(0) === 11,
    );
    if (challenge === undefined) {
      throw new PgError('the server did not send a SASL challenge');
    }
    const serverFirst = challenge.body.subarray(4).toString('utf8');
    const attributes = parseScram(serverFirst);
    const serverNonce = attributes.r;
    const salt = attributes.s;
    const iterations = Number(attributes.i);

    if (serverNonce === undefined || salt === undefined || !Number.isInteger(iterations)) {
      throw new PgError(`the SASL challenge is not usable: ${serverFirst}`);
    }
    if (!serverNonce.startsWith(clientNonce)) {
      // The server must echo the client's nonce. A server that does not is not
      // in the exchange this client started.
      throw new PgError('the server nonce does not extend the client nonce');
    }
    if (iterations < 4096) {
      throw new PgError(`the server asked for ${iterations} PBKDF2 iterations; 4096 is the floor`);
    }

    const channelBindingData = usePlus
      ? Buffer.concat([
          Buffer.from(gs2, 'utf8'),
          createHash('sha256').update(der as Buffer).digest(),
        ])
      : Buffer.from(gs2, 'utf8');

    const clientFinalWithoutProof =
      `c=${channelBindingData.toString('base64')},r=${serverNonce}`;

    const saltedPassword = pbkdf2Sync(
      // SASLprep would normalise the password here. ASCII passwords — which is
      // what a generated database password is — are unaffected by it.
      password,
      Buffer.from(salt, 'base64'),
      iterations,
      32,
      'sha256',
    );
    const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
    const storedKey = createHash('sha256').update(clientKey).digest();
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
    const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
    const proof = Buffer.allocUnsafe(clientKey.length);
    for (let i = 0; i < clientKey.length; i++) {
      proof[i] = clientKey[i] ^ clientSignature[i];
    }

    messages = await this.exchangeStartup(
      new Writer()
        .bytes(Buffer.from(
          `${clientFinalWithoutProof},p=${proof.toString('base64')}`,
          'utf8',
        ))
        .finish('p'),
    );
    const finalError = messages.find(m => m.type === 'E');
    if (finalError) throw errorFrom(finalError.body);

    // The server's half of the proof. Checked, not assumed: without this, a
    // man in the middle that cannot verify the password can still claim the
    // authentication succeeded.
    const final = messages.find(m => m.type === 'R' && m.body.readInt32BE(0) === 12);
    if (final === undefined) {
      throw new PgError('the server did not send its SASL signature');
    }
    const serverFinal = parseScram(final.body.subarray(4).toString('utf8'));
    if (serverFinal.e !== undefined) {
      throw new PgError(`the server rejected the SASL exchange: ${serverFinal.e}`);
    }
    const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
    const expected = createHmac('sha256', serverKey).update(authMessage).digest();
    const received = Buffer.from(serverFinal.v ?? '', 'base64');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new PgError(
        'the server\'s SASL signature does not match. Something is answering for the ' +
        'database that does not know the password.',
      );
    }

    this.authenticatedWith = mechanism;
    // The SASL final is not the end of startup: AuthenticationOk, the
    // parameter statuses and ReadyForQuery still follow. Waiting for them here
    // is what keeps the outer loop from seeing message 12 and treating it as
    // an authentication method it does not know.
    return this.waitForReady();
  }

  /** Waits for ReadyForQuery, or an error, without sending anything. */
  private waitForReady(): Promise<ServerMessage[]> {
    return new Promise<ServerMessage[]>((resolve, reject) => {
      const settle = (): boolean => {
        const readyAt = this.pending.findIndex(m => m.type === 'Z');
        const errorAt = this.pending.findIndex(m => m.type === 'E');
        const at = [readyAt, errorAt].filter(i => i !== -1).sort((a, b) => a - b)[0];
        if (at === undefined) return false;
        resolve(this.pending.splice(0, at + 1));
        return true;
      };
      if (settle()) return;
      const onData = (): void => { if (settle()) this.socket?.off('data', onData); };
      this.socket?.on('data', onData);
      this.socket?.once('error', reject);
    });
  }

  /** The mechanism the connection authenticated with, for the health report. */
  private authenticatedWith: string | null = null;
  get authMechanism(): string | null { return this.authenticatedWith; }

  private requirePassword(): string {
    if (this.options.password === undefined || this.options.password === '') {
      throw new PgError(
        'the server asked for a password and none was configured. Set PGPASSWORD ' +
        'or DATABASE_URL with credentials.',
      );
    }
    return this.options.password;
  }

  /** Startup replies end at ReadyForQuery or an ErrorResponse. */
  private exchangeStartup(buffer: Buffer): Promise<ServerMessage[]> {
    return new Promise<ServerMessage[]>((resolve, reject) => {
      const settle = () => {
        const readyAt = this.pending.findIndex(m => m.type === 'Z');
        const errorAt = this.pending.findIndex(m => m.type === 'E');
        const authAt = this.pending.findIndex(m => m.type === 'R' && m.body.readInt32BE(0) !== 0);
        const at = [readyAt, errorAt, authAt].filter(i => i !== -1).sort((a, b) => a - b)[0];
        if (at === undefined) return false;
        resolve(this.pending.splice(0, at + 1));
        return true;
      };

      this.waiter = {
        resolve: () => { /* replaced below */ },
        reject,
      };
      // Startup needs its own completion rule, so the generic flush is bypassed.
      const onData = () => { if (settle()) { this.socket?.off('data', onData); } };
      this.waiter = null;
      try {
        this.send(buffer);
      } catch (err) {
        reject(err as Error);
        return;
      }
      if (settle()) return;
      this.socket?.on('data', onData);
      this.socket?.once('error', reject);
    });
  }

  /**
   * A parameterised query, through Parse/Bind/Execute.
   *
   * Parameters are `$1`, `$2`, … and are sent as separate text values, so a
   * value can never be parsed as SQL. This is the only query path the routes
   * use.
   */
  async query<Row = Record<string, string | null>>(
    sql: string,
    params: ReadonlyArray<string | number | boolean | null> = [],
  ): Promise<QueryResult<Row>> {
    const text = params.map(p =>
      p === null ? null
      : typeof p === 'boolean' ? (p ? 'true' : 'false')
      : String(p));

    const parse = new Writer()
      .cstring('')      // unnamed statement
      .cstring(sql)
      .int16(0)         // let the server infer parameter types
      .finish('P');

    const bind = new Writer().cstring('').cstring('');
    bind.int16(0);                        // no format codes: all text
    bind.int16(text.length);
    for (const value of text) {
      if (value === null) {
        bind.int32(-1);
      } else {
        const b = Buffer.from(value, 'utf8');
        bind.int32(b.length).bytes(b);
      }
    }
    bind.int16(0);                        // results in text too

    const message = Buffer.concat([
      parse,
      bind.finish('B'),
      // Describe the portal. Without this the server sends DataRow messages
      // with no RowDescription before them — the simple query protocol sends
      // one unprompted, the extended one does not — and every column comes
      // back positional with no name.
      new Writer().bytes(Buffer.from('P', 'ascii')).cstring('').finish('D'),
      new Writer().cstring('').int32(0).finish('E'),  // Execute, no row limit
      new Writer().finish('S'),                        // Sync
    ]);

    const messages = await this.exchange(message);
    return this.collect<Row>(messages, sql);
  }

  /**
   * A simple query, which may contain several statements.
   *
   * No parameters — the protocol's simple query has none — so this is for SQL
   * the application itself authored: migrations, BEGIN/COMMIT, DDL in tests.
   * Never for anything carrying a caller's value.
   */
  async simple<Row = Record<string, string | null>>(sql: string): Promise<QueryResult<Row>> {
    const messages = await this.exchange(new Writer().cstring(sql).finish('Q'));
    return this.collect<Row>(messages, sql);
  }

  private collect<Row>(messages: ServerMessage[], sql: string): QueryResult<Row> {
    let fields: string[] = [];
    const rows: Row[] = [];
    let command = '';
    let rowCount = 0;
    let error: PgError | null = null;

    for (const m of messages) {
      switch (m.type) {
        case 'T': { // RowDescription
          const count = m.body.readInt16BE(0);
          const names: string[] = [];
          let offset = 2;
          for (let i = 0; i < count; i++) {
            const { value, next } = readCString(m.body, offset);
            names.push(value);
            offset = next + 18; // table oid, column, type oid, size, modifier, format
          }
          fields = names;
          break;
        }
        case 'D': { // DataRow
          const count = m.body.readInt16BE(0);
          const row: Record<string, string | null> = {};
          let offset = 2;
          for (let i = 0; i < count; i++) {
            const length = m.body.readInt32BE(offset);
            offset += 4;
            if (length === -1) {
              row[fields[i] ?? `col${i}`] = null;
            } else {
              row[fields[i] ?? `col${i}`] = m.body.subarray(offset, offset + length).toString('utf8');
              offset += length;
            }
          }
          rows.push(row as Row);
          break;
        }
        case 'C': { // CommandComplete
          const tag = readCString(m.body, 0).value;
          command = tag.split(' ')[0];
          const last = tag.split(' ').pop();
          const n = Number(last);
          if (Number.isFinite(n)) rowCount = n;
          break;
        }
        case 'E':
          error = errorFrom(m.body);
          break;
        default:
          break;
      }
    }

    if (error !== null) {
      // The failing SQL is attached for the log, never the parameters: those
      // are the values this system exists to protect.
      error.message = `${error.message}\n  while running: ${sql.trim().split('\n')[0]}`;
      throw error;
    }
    return { rows, fields, rowCount, command };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.socket !== null) {
      try { this.socket.write(new Writer().finish('X')); } catch { /* already gone */ }
      this.socket.destroy();
      this.socket = null;
    }
  }

  get healthy(): boolean {
    return this.failure === null && this.socket !== null && !this.closed;
  }
}

/** `r=...,s=...,i=...` as a map. Values may contain '=', so split on the first. */
function parseScram(message: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const part of message.split(',')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

// --- pool and transactions -------------------------------------------------

export interface Queryable {
  query<Row = Record<string, string | null>>(
    sql: string,
    params?: ReadonlyArray<string | number | boolean | null>,
  ): Promise<QueryResult<Row>>;
}

/**
 * A small pool. One connection is handed out at a time; a transaction pins one
 * for its whole life, which is what makes atomicity real rather than hoped for.
 */
export class PgPool {
  private idle: PgConnection[] = [];
  private borrowed = 0;
  private waiters: Array<(c: PgConnection) => void> = [];
  private closed = false;

  constructor(
    private readonly options: ConnectionOptions,
    private readonly max = 8,
  ) {}

  private async open(): Promise<PgConnection> {
    const c = new PgConnection(this.options);
    await c.connect();
    // Recorded from a real connection rather than from the configuration: the
    // question an operator asks is whether the traffic *is* encrypted, not
    // whether it was asked to be.
    this.security = {
      encrypted: c.encrypted,
      cipher: c.cipher,
      authMechanism: c.authMechanism,
    };
    return c;
  }

  private security: {
    encrypted: boolean; cipher: string | null; authMechanism: string | null;
  } | null = null;

  /**
   * How the last connection was actually established.
   *
   * Null before the first one: nothing is claimed about a connection that has
   * not been made.
   */
  get connectionSecurity(): {
    encrypted: boolean; cipher: string | null; authMechanism: string | null;
  } | null {
    return this.security;
  }

  /** The options this pool was built with, for an operator's report. */
  get describe(): Record<string, unknown> {
    return describeConnection(this.options);
  }

  private async acquire(): Promise<PgConnection> {
    if (this.closed) throw new PgError('the pool is closed');

    while (this.idle.length > 0) {
      const candidate = this.idle.pop() as PgConnection;
      if (candidate.healthy && !candidate.inTransaction) {
        this.borrowed++;
        return candidate;
      }
      await candidate.close();
    }

    if (this.borrowed < this.max) {
      this.borrowed++;
      try {
        return await this.open();
      } catch (err) {
        this.borrowed--;
        throw err;
      }
    }

    return new Promise<PgConnection>(resolve => this.waiters.push(resolve));
  }

  private release(c: PgConnection): void {
    // A connection still inside a transaction is not fit to hand on: the next
    // borrower would inherit it. Discard rather than reuse.
    if (!c.healthy || c.inTransaction) {
      void c.close();
      this.borrowed--;
      this.pump();
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(c);
      return;
    }
    this.borrowed--;
    this.idle.push(c);
  }

  private pump(): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) return;
    void this.acquire().then(waiter);
  }

  /** A single statement, on any connection. */
  async query<Row = Record<string, string | null>>(
    sql: string,
    params: ReadonlyArray<string | number | boolean | null> = [],
  ): Promise<QueryResult<Row>> {
    const c = await this.acquire();
    try {
      return await c.query<Row>(sql, params);
    } finally {
      this.release(c);
    }
  }

  async simple<Row = Record<string, string | null>>(sql: string): Promise<QueryResult<Row>> {
    const c = await this.acquire();
    try {
      return await c.simple<Row>(sql);
    } finally {
      this.release(c);
    }
  }

  /**
   * Runs `body` inside one transaction on one pinned connection.
   *
   * Commits when the body returns and rolls back when it throws. Nothing in
   * the financial paths writes outside this, which is what makes a failed
   * posting leave no trace.
   */
  async transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T> {
    const c = await this.acquire();
    c.inTransaction = true;
    try {
      await c.simple('BEGIN');
      let result: T;
      try {
        result = await body(c);
      } catch (err) {
        try { await c.simple('ROLLBACK'); } catch { /* connection may be gone */ }
        throw err;
      }
      // Deferred constraint triggers fire here. A COMMIT can therefore fail,
      // and that failure is the whole point of them.
      await c.simple('COMMIT');
      return result;
    } finally {
      c.inTransaction = false;
      this.release(c);
    }
  }

  async end(): Promise<void> {
    this.closed = true;
    const all = [...this.idle];
    this.idle = [];
    await Promise.all(all.map(c => c.close()));
  }

  get stats(): { idle: number; borrowed: number; waiting: number } {
    return { idle: this.idle.length, borrowed: this.borrowed, waiting: this.waiters.length };
  }
}

/**
 * Connection options from a URL, or from the PG* variables.
 *
 * Handles the three forms this project meets:
 *
 *  · `postgresql://user:pass@host:5432/db?sslmode=require` — a hosted
 *    database. The query parameters matter: a managed provider refuses an
 *    unencrypted connection, so `sslmode` is read rather than assumed.
 *  · `postgresql://user@/db?host=/var/run/postgresql` — libpq's unix socket
 *    form, which WHATWG `URL` rejects outright for having no host.
 *  · no URL at all, and PGHOST/PGUSER/PGDATABASE instead.
 *
 * `which` picks the variable: DATABASE_URL for the application's queries,
 * DIRECT_URL for migrations. A pooled connection is right for short queries
 * and wrong for migrations, which take session-level locks the pooler does
 * not keep.
 */
export function connectionFromEnv(
  env: Record<string, string | undefined>,
  which: 'DATABASE_URL' | 'DIRECT_URL' = 'DATABASE_URL',
): ConnectionOptions {
  // DIRECT_URL falls back to DATABASE_URL: one URL is a valid setup, and a
  // migration against the pooled endpoint usually works — it is just not what
  // a provider recommends.
  //
  // An empty DIRECT_URL counts as unset, not as "no URL". `DIRECT_URL=` is a
  // normal thing to find in a .env written from the example file, and `??`
  // alone kept the empty string: the fallback never happened, the PG*
  // variables were used instead, and a migration ran against whatever local
  // default those pointed at. Silent and wrong is the worst outcome here.
  const configured = which === 'DIRECT_URL'
    ? [env.DIRECT_URL, env.DATABASE_URL]
    : [env.DATABASE_URL];
  const url = configured.find(value => value !== undefined && value !== '');

  if (url !== undefined && url !== '') {
    const socketForm = /^[a-z+]+:\/\/[^/]*@?\//i.test(url) && /[?&]host=/.test(url);
    const parsed = new URL(socketForm ? url.replace('@/', '@placeholder/') : url);
    const parameters = parsed.searchParams;

    const hostParam = parameters.get('host');
    const host = hostParam !== null && hostParam !== ''
      ? hostParam
      : decodeURIComponent(parsed.hostname);
    const resolvedHost = host === '' || host === 'placeholder'
      ? '/var/run/postgresql'
      : host;

    const startupParameters: Record<string, string> = {};
    // libpq passes `options` through to the server as a startup parameter.
    // Neon uses it to name the compute endpoint when SNI cannot be used.
    const options = parameters.get('options');
    if (options !== null && options !== '') startupParameters.options = options;

    return {
      host: resolvedHost,
      port: parsed.port === '' ? 5432 : Number(parsed.port),
      user: decodeURIComponent(parsed.username) || 'postgres',
      database: parsed.pathname.replace(/^\//, '') || 'postgres',
      ...(parsed.password !== '' ? { password: decodeURIComponent(parsed.password) } : {}),
      ...sslFromParameters(parameters, resolvedHost),
      ...(Object.keys(startupParameters).length > 0 ? { startupParameters } : {}),
      ...(env.PGAPPNAME === undefined ? {} : { applicationName: env.PGAPPNAME }),
      ...(env.PGCONNECT_TIMEOUT === undefined
        ? {}
        : { connectTimeoutMs: Number(env.PGCONNECT_TIMEOUT) * 1000 }),
    };
  }

  const host = env.PGHOST ?? '/var/run/postgresql';
  return {
    host,
    port: env.PGPORT === undefined ? 5432 : Number(env.PGPORT),
    user: env.PGUSER ?? 'postgres',
    database: env.PGDATABASE ?? 'postgres',
    ...(env.PGPASSWORD !== undefined ? { password: env.PGPASSWORD } : {}),
    ...(env.PGSSLMODE === undefined
      ? {}
      : { sslMode: asSslMode(env.PGSSLMODE) }),
    ...(env.PGAPPNAME === undefined ? {} : { applicationName: env.PGAPPNAME }),
    ...(env.PGCONNECT_TIMEOUT === undefined
      ? {}
      : { connectTimeoutMs: Number(env.PGCONNECT_TIMEOUT) * 1000 }),
  };
}

function asSslMode(value: string): SslMode {
  // libpq also has 'allow' and 'verify-ca'. 'allow' means "plaintext unless
  // the server insists", which is prefer's opposite and not worth a separate
  // path here; 'verify-ca' is treated as the stricter 'verify-full', because
  // verifying the chain and then not checking the hostname leaves the gap
  // verification was for.
  switch (value) {
    case 'disable': return 'disable';
    case 'allow':
    case 'prefer': return 'prefer';
    case 'require': return 'require';
    case 'verify-ca':
    case 'verify-full': return 'verify-full';
    default:
      throw new PgError(
        `sslmode "${value}" is not one this client knows: disable, prefer, require, ` +
        'verify-ca or verify-full',
      );
  }
}

/** The TLS part of the options, from a connection string's parameters. */
function sslFromParameters(
  parameters: URLSearchParams,
  host: string,
): Pick<ConnectionOptions, 'sslMode' | 'channelBinding' | 'servername'> {
  const out: {
    sslMode?: SslMode;
    channelBinding?: 'disable' | 'prefer' | 'require';
    servername?: string;
  } = {};

  const sslmode = parameters.get('sslmode');
  const ssl = parameters.get('ssl');
  if (sslmode !== null && sslmode !== '') out.sslMode = asSslMode(sslmode);
  else if (ssl === 'true') out.sslMode = 'require';
  else if (!host.startsWith('/')) {
    // No sslmode given, over TCP. libpq's own default is 'prefer'.
    out.sslMode = 'prefer';
  }

  const binding = parameters.get('channel_binding');
  if (binding === 'disable' || binding === 'prefer' || binding === 'require') {
    out.channelBinding = binding;
  }

  const servername = parameters.get('servername') ?? parameters.get('sslsni');
  if (servername !== null && servername !== '' && servername !== '1') {
    out.servername = servername;
  }

  return out;
}

/**
 * Whether a host is a connection pooler.
 *
 * A guess from the hostname, and labelled as one wherever it is reported. It
 * exists so an operator can be told that migrations are about to run through
 * a pooler, which is the configuration mistake worth catching early.
 */
export function looksPooled(host: string): boolean {
  return /-pooler\./.test(host) || /^pgbouncer/.test(host) || /\bpooler\b/.test(host);
}

/** What to tell an operator about a connection, with no secret in it. */
export function describeConnection(options: ConnectionOptions): Record<string, unknown> {
  return {
    host: options.host,
    port: options.port ?? 5432,
    database: options.database,
    user: options.user,
    // Never the password, and never the URL it came from.
    passwordConfigured: options.password !== undefined && options.password !== '',
    sslMode: options.sslMode ?? (options.host.startsWith('/') ? 'disable' : 'prefer'),
    channelBinding: options.channelBinding ?? 'prefer',
    pooledHostname: looksPooled(options.host),
  };
}
