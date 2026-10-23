/**
 * The slice of node's API this backend uses.
 *
 * @types/node cannot be installed in the environment this was written in, so
 * the globals and modules in use are declared here. Narrow on purpose: a
 * declaration only exists where the code actually calls it, so an accidental
 * dependency on something undeclared is a compile error rather than a runtime
 * surprise.
 *
 * Delete this file and `npm i -D @types/node` as soon as a registry is
 * reachable — these declarations are a stand-in, not a contribution.
 */

declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): never;
  exitCode?: number;
  on(event: string, handler: (...args: unknown[]) => void): void;
  hrtime: { bigint(): bigint };
  platform: string;
  pid: number;
  execPath: string;
  uptime(): number;
  memoryUsage(): { heapUsed: number; rss: number };
};

declare function setTimeout(fn: (...a: unknown[]) => void, ms?: number): { unref(): void };
declare function clearTimeout(handle: unknown): void;
declare function setInterval(fn: (...a: unknown[]) => void, ms?: number): { unref(): void };
declare function clearInterval(handle: unknown): void;
declare function queueMicrotask(fn: () => void): void;

declare class URL {
  constructor(input: string, base?: string);
  hostname: string;
  port: string;
  username: string;
  password: string;
  pathname: string;
  search: string;
  searchParams: URLSearchParams;
  toString(): string;
}

declare class URLSearchParams {
  constructor(init?: string);
  set(k: string, v: string): void;
  toString(): string;
  get(k: string): string | null;
  getAll(k: string): string[];
  has(k: string): boolean;
  forEach(fn: (value: string, key: string) => void): void;
  entries(): IterableIterator<[string, string]>;
}

declare class TextEncoder { encode(input?: string): Uint8Array }
declare class TextDecoder { decode(input?: Uint8Array): string }

interface Buffer extends Uint8Array {
  toString(encoding?: string, start?: number, end?: number): string;
  readInt32BE(offset: number): number;
  readInt16BE(offset: number): number;
  writeInt32BE(value: number, offset: number): number;
  writeInt16BE(value: number, offset: number): number;
  subarray(start?: number, end?: number): Buffer;
  indexOf(value: number, from?: number): number;
  equals(other: Uint8Array): boolean;
  readonly length: number;
}

declare const Buffer: {
  from(data: string, encoding?: string): Buffer;
  from(data: ArrayBuffer | Uint8Array | readonly number[]): Buffer;
  concat(list: readonly Uint8Array[]): Buffer;
  alloc(size: number, fill?: number): Buffer;
  allocUnsafe(size: number): Buffer;
  isBuffer(value: unknown): value is Buffer;
  byteLength(value: string, encoding?: string): number;
};

declare module 'node:net' {
  export interface Socket {
    write(data: Buffer | string): boolean;
    end(): void;
    destroy(): void;
    setNoDelay(on: boolean): void;
    setEncoding(encoding: string): this;
    setTimeout(ms: number): this;
    on(event: 'data', handler: (chunk: Buffer) => void): this;
    on(event: 'data', handler: (chunk: string) => void): this;
    on(event: 'error', handler: (err: Error) => void): this;
    on(event: 'close', handler: () => void): this;
    once(event: 'connect', handler: () => void): this;
    once(event: 'error', handler: (err: Error) => void): this;
    off(event: string, handler: (...a: never[]) => void): this;
    removeAllListeners(event?: string): this;
    removeListener(event: string, handler: (...a: never[]) => void): this;
  }
  export function createConnection(
    options: { host: string; port: number } | { path: string },
    onConnect?: () => void,
  ): Socket;
}

// TLS, for the SMTP client. Only the two shapes it uses: a connection with a
// server name for SNI, and the socket upgrade that STARTTLS needs.
declare module 'node:tls' {
  import type { Socket } from 'node:net';
  export interface TLSSocket extends Socket {
    readonly encrypted: boolean;
    getCipher?(): { name: string; version: string } | undefined;
    /** The server's certificate. `raw` is the DER, which channel binding hashes. */
    getPeerCertificate?(detailed?: boolean): { raw?: Buffer } | undefined;
  }
  export function connect(
    options:
      | { host: string; port: number; servername?: string; rejectUnauthorized?: boolean }
      | { socket: Socket; servername?: string; rejectUnauthorized?: boolean },
    onSecure?: () => void,
  ): TLSSocket;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array, encoding?: string): Hash;
    digest(encoding: 'hex' | 'base64'): string;
    digest(): Buffer;
  }
  export function createHash(algorithm: string): Hash;
  export function createHmac(algorithm: string, key: string | Uint8Array): Hash;
  export function randomBytes(size: number): Buffer;
  export function randomUUID(): string;
  export function randomInt(min: number, max: number): number;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function pbkdf2Sync(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
  ): Buffer;
  export function scryptSync(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    keylen: number,
    options?: { N?: number; r?: number; p?: number; maxmem?: number },
  ): Buffer;
}

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    socket: { remoteAddress?: string };
    on(event: 'data', handler: (chunk: Buffer) => void): this;
    on(event: 'end', handler: () => void): this;
    on(event: 'error', handler: (err: Error) => void): this;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string | string[]): void;
    getHeader(name: string): string | string[] | number | undefined;
    writeHead(status: number, headers?: Record<string, string | string[]>): this;
    end(body?: string | Buffer): void;
    headersSent: boolean;
  }
  export interface Server {
    listen(port: number, host: string, cb?: () => void): Server;
    once(event: 'error', cb: (err: Error) => void): Server;
    close(cb?: (err?: Error) => void): Server;
    address(): { port: number } | string | null;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readFileSync(path: string): Buffer;
  export function writeFileSync(path: string, data: string | Buffer): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readdirSync(path: string): string[];
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function extname(p: string): string;
}

// CommonJS, for the one place that needs to know whether this file is the
// entry point. Declared rather than imported: @types/node cannot be installed
// where this was written, and the two members used are the two declared.
declare const require: ((id: string) => unknown) & { main: unknown };
declare const module: { exports: unknown };
