/**
 * The HTTP layer: routing, middleware and error handling.
 *
 * Built on node's own `http` module. No framework, because none could be
 * installed where this was written — the npm registry is unreachable — and the
 * surface needed is small enough that the absence is not felt: a router, a
 * JSON body reader with a size cap, CORS, CSRF, session resolution and one
 * place where every error becomes a response.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { ValidationError, type Schema } from './validate';
import { AuthError, RateLimitError, CSRF_COOKIE, csrfMatches, parseCookies, requestId } from './security';
import { ForbiddenError, type Principal } from './rbac';
import { PgError } from './pg';
import type { Logger } from './logger';
import type { Config } from './config';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} was not found.`);
export const badRequest = (why: string) => new HttpError(400, why);
export const conflict = (why: string) => new HttpError(409, why);

export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly cookies: Record<string, string>;
  readonly requestId: string;
  readonly log: Logger;
  readonly ip: string;
  /** Null on a route that does not require a session. */
  readonly principal: Principal | null;
  /** Parses the JSON body against a schema. Throws HttpError 400 on a problem. */
  body<T>(schema: Schema<T>): T;
  /** The raw parsed body, for routes that need to look before validating. */
  readonly rawBody: unknown;
}

export interface Reply {
  readonly status: number;
  /**
   * JSON, unless it is a Buffer — then it is written as it is, with the
   * Content-Type the reply carries. That is how a PDF gets out of here
   * without being base64 in a JSON envelope.
   */
  readonly body?: unknown;
  readonly headers?: Record<string, string | string[]>;
}

export type Handler = (ctx: RequestContext) => Promise<Reply> | Reply;

export interface RouteDefinition {
  readonly method: string;
  /** `/billing/:period/documents` — `:name` segments become params. */
  readonly pattern: string;
  readonly handler: Handler;
  /** False for login, health and anything that cannot require a session. */
  readonly authenticated: boolean;
  /** Skips the CSRF check. Only for routes a browser never calls with cookies. */
  readonly csrfExempt?: boolean;
}

interface CompiledRoute extends RouteDefinition {
  readonly segments: readonly string[];
}

const MAX_BODY_BYTES = 1_000_000;

/**
 * What a caller already knows about the request.
 *
 * Empty for the standalone server, which reads its own body from the socket.
 * The serverless adapter fills in `bodyText`, because its platform has
 * already consumed the stream.
 */
export interface PreparedRequest {
  readonly bodyText?: string;
}

export interface AppDependencies {
  readonly config: Config;
  readonly log: Logger;
  /** Resolves a session cookie to a principal, or null. */
  readonly resolveSession: (token: string | undefined) => Promise<Principal | null>;
}

export function createApp(routes: readonly RouteDefinition[], deps: AppDependencies) {
  const compiled: CompiledRoute[] = routes.map(r => ({
    ...r,
    segments: r.pattern.split('/').filter(s => s !== ''),
  }));

  const match = (method: string, path: string): { route: CompiledRoute; params: Record<string, string> } | null => {
    const parts = path.split('/').filter(s => s !== '');
    let pathMatched = false;
    for (const route of compiled) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (const [i, segment] of route.segments.entries()) {
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(parts[i]);
        } else if (segment !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    // A known path with the wrong verb is 405, not 404: that distinction is
    // what tells a client it has the URL right and the method wrong.
    if (pathMatched) throw new HttpError(405, `${method} is not allowed on ${path}.`);
    return null;
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, `The request body exceeds ${MAX_BODY_BYTES} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  /**
   * The caller's address.
   *
   * `X-Forwarded-For` is a list, appended to by each hop; the left-most entry
   * is the original client and the ones after it are proxies. Only the
   * left-most is of any use for rate limiting, and only where the header can
   * be believed at all — see `config.trustProxy`.
   */
  const addressOf = (req: IncomingMessage): string => {
    if (deps.config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      const list = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
      const first = (list ?? '').split(',')[0].trim();
      if (first !== '') return first;
    }
    return req.socket?.remoteAddress ?? 'unknown';
  };

  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
    prepared: PreparedRequest = {},
  ): Promise<void> => {
    const id = requestId();
    const started = process.hrtime.bigint();
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://internal');
    const log = deps.log.child({ requestId: id, method, path: url.pathname });

    // Security headers on every response, including errors.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Request-Id', id);

    // CORS, for exactly one origin and with credentials. A wildcard origin and
    // credentials cannot be combined, and should not be.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin === deps.config.allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }

    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token,Idempotency-Key');
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204).end();
      return;
    }

    const send = (reply: Reply): void => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      for (const [name, value] of Object.entries(reply.headers ?? {})) {
        res.setHeader(name, value);
      }
      if (Buffer.isBuffer(reply.body)) {
        // A binary reply sets its own Content-Type; only the length is added.
        res.setHeader('Content-Length', String(reply.body.length));
        res.writeHead(reply.status);
        res.end(reply.body);
      } else {
        const payload = reply.body === undefined ? '' : JSON.stringify(reply.body);
        if (payload !== '') res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.writeHead(reply.status);
        res.end(payload);
      }
      const level = reply.status >= 500 ? 'error' : reply.status >= 400 ? 'warn' : 'info';
      log[level]('request', { status: reply.status, elapsedMs: Math.round(elapsedMs * 10) / 10 });
    };

    try {
      const found = match(method, url.pathname);
      if (found === null) {
        send({ status: 404, body: { error: 'not_found', message: `No route for ${method} ${url.pathname}.` } });
        return;
      }

      const cookies = parseCookies(
        typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
      );

      // CSRF: a double-submit check on anything that is not a read. The cookie
      // is readable by the site's own script and not by another origin, so a
      // cross-site form post can send the cookie but cannot set the header.
      const isWrite = method !== 'GET' && method !== 'HEAD';
      if (isWrite && found.route.csrfExempt !== true) {
        const header = req.headers['x-csrf-token'];
        const headerValue = Array.isArray(header) ? header[0] : header;
        if (!csrfMatches(cookies[CSRF_COOKIE], headerValue)) {
          send({
            status: 403,
            body: {
              error: 'csrf_failed',
              message:
                'This request is missing a matching CSRF token. Read the sb_csrf cookie and ' +
                'send it back in the X-CSRF-Token header.',
            },
          });
          return;
        }
      }

      let principal: Principal | null = null;
      if (found.route.authenticated) {
        principal = await deps.resolveSession(cookies['sb_session']);
        if (principal === null) {
          send({ status: 401, body: { error: 'unauthenticated', message: 'Sign in to continue.' } });
          return;
        }
      }

      let parsedBody: unknown = undefined;
      if (isWrite) {
        // A serverless platform reads the request body before the function is
        // called, so by the time this runs the stream has already ended and
        // waiting on it would hang until the invocation timed out. The
        // adapter passes what it was given instead.
        const text = prepared.bodyText ?? await readBody(req);
        if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
          throw new HttpError(413, `The request body exceeds ${MAX_BODY_BYTES} bytes.`);
        }
        if (text.trim() !== '') {
          try {
            parsedBody = JSON.parse(text);
          } catch {
            send({ status: 400, body: { error: 'invalid_json', message: 'The request body is not valid JSON.' } });
            return;
          }
        }
      }

      const ctx: RequestContext = {
        method,
        path: url.pathname,
        params: found.params,
        query: url.searchParams as unknown as URLSearchParams,
        headers: req.headers,
        cookies,
        requestId: id,
        log: principal === null ? log : log.child({ userId: principal.userId }),
        ip: addressOf(req),
        principal,
        rawBody: parsedBody,
        body<T>(schema: Schema<T>): T {
          const result = schema.safeParse(parsedBody);
          if (!result.ok) {
            throw new HttpError(400, 'The request body is not valid.', result.error.issues);
          }
          return result.value;
        },
      };

      send(await found.route.handler(ctx));
    } catch (err) {
      send(toReply(err, log, deps.config));
    }
  };

  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });

  return { server, handler };
}

/**
 * One place where every error becomes a response.
 *
 * A thrown error reaching a client as a stack trace is an information leak and
 * a bug report nobody asked for. Known errors map to their status; anything
 * unrecognised is a 500 whose message says nothing about internals, with the
 * detail going to the log under the same request id.
 */
export function toReply(err: unknown, log: Logger, config: Config): Reply {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: {
        error: err.status === 404 ? 'not_found' : err.status === 409 ? 'conflict' : 'bad_request',
        message: err.message,
        ...(err.detail === undefined ? {} : { detail: err.detail }),
      },
    };
  }

  if (err instanceof ValidationError) {
    return {
      status: 400,
      body: { error: 'invalid_input', message: 'The request is not valid.', detail: err.issues },
    };
  }

  if (err instanceof ForbiddenError) {
    return { status: 403, body: { error: 'forbidden', message: err.message } };
  }

  if (err instanceof RateLimitError) {
    return {
      status: 429,
      headers: { 'Retry-After': String(err.retryAfterSeconds) },
      body: { error: 'rate_limited', message: err.message, retryAfterSeconds: err.retryAfterSeconds },
    };
  }

  if (err instanceof AuthError) {
    return { status: err.status, body: { error: 'unauthenticated', message: err.message } };
  }

  if (err instanceof PgError) {
    // A unique violation is the caller's problem and worth saying so; anything
    // else from the database is ours, and its text may name internals.
    if (err.code === '23505' || err.code === '23P01' || err.code === '23514' || err.code === '23503') {
      log.warn('database rejected a request', { code: err.code, constraint: err.constraint });
      return {
        status: 409,
        body: {
          error: 'constraint_violated',
          message:
            'The database refused this change because it would break a rule the books rely on.',
          ...(err.constraint === undefined ? {} : { constraint: err.constraint }),
        },
      };
    }
    // A RAISE from one of our own triggers — the period lock, the balance
    // check, the allocation check. Those messages are written for a person to
    // read and name no internals, so they are passed through rather than
    // flattened into "something went wrong", which would leave a treasurer
    // with no idea why a posting was refused.
    if (err.code === 'P0001') {
      log.warn('a database rule refused a request', { message: err.message });
      return { status: 409, body: { error: 'rule_violated', message: err.message } };
    }

    log.error('database error', { code: err.code, message: err.message });
    return { status: 500, body: { error: 'internal', message: 'Something went wrong.' } };
  }

  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  log.error('unhandled error', { message, stack });
  return {
    status: 500,
    body: {
      error: 'internal',
      message: 'Something went wrong.',
      // In development the message helps; in production it may name internals.
      ...(config.mode === 'production' ? {} : { developmentDetail: message }),
    },
  };
}

export const route = (
  method: string,
  pattern: string,
  handler: Handler,
  opts: { authenticated?: boolean; csrfExempt?: boolean } = {},
): RouteDefinition => ({
  method,
  pattern,
  handler,
  authenticated: opts.authenticated ?? true,
  ...(opts.csrfExempt !== undefined ? { csrfExempt: opts.csrfExempt } : {}),
});
