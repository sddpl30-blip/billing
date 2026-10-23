/**
 * The same server, as a serverless function.
 *
 * Nothing about the routes, the business rules or the database access changes
 * here. `buildApp` already separates the wiring from the socket: the
 * standalone entry point calls `listen()`, and this one hands the platform's
 * own request and response objects to the very same handler. There is no
 * second copy of the routing, the CSRF check or the error mapping — those are
 * exactly the things that would drift.
 *
 * Three differences between a socket and a function, each dealt with here:
 *
 *  1. **The app is built once per instance, not once per request.** Building
 *     it parses the configuration and creates a connection pool; doing that
 *     per request would mean a TLS handshake and a SCRAM exchange on every
 *     call, and would exhaust the database's connection limit under any load
 *     at all. The instance is reused for as long as the platform keeps it
 *     warm, and the pool with it.
 *
 *  2. **The body has already been read.** The platform buffers the request
 *     before calling the function, so the stream has ended; waiting on it
 *     would hang until the invocation timed out. Whatever the platform parsed
 *     is turned back into the text the handler expects.
 *
 *  3. **A configuration error must not take the instance down silently.** A
 *     thrown error at module scope gives a platform-level 500 with nothing in
 *     it. The failure is caught, logged once, and answered with a response
 *     that says the deployment is misconfigured — the operator reads that in
 *     a browser instead of guessing from an empty error.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp, type App } from './app';
import { ConfigError } from './config';

export interface ServerlessOptions {
  /**
   * Whether the platform has already consumed the request stream.
   *
   * True on Vercel, where `req.body` is populated before the function runs.
   * False lets the handler read the socket itself, which is what the tests of
   * the standalone server do.
   */
  readonly platformReadsBody?: boolean;
}

/** The text of a body the platform has already parsed. */
export function bodyTextOf(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  // An object is what a JSON body arrives as. Re-serialising it is lossless
  // for JSON and is what the handler's own parser expects to receive.
  return JSON.stringify(body);
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface ServerlessApp {
  readonly handler: Handler;
  /**
   * Closes the pool, for a host that has an end.
   *
   * A serverless instance never calls this: its connections stay open exactly
   * so the next invocation can reuse them, and the platform reclaims the
   * instance when it is done with it. A test process does have an end, and a
   * pool holding open sockets keeps node alive after the last check has run.
   */
  dispose(): Promise<void>;
}

interface Cached {
  app?: App;
  failure?: string;
}

/**
 * Builds the handler, caching the app across invocations.
 *
 * The cache lives in the module, which on a serverless platform means "for
 * the life of this instance". A failed build is cached too: a deployment with
 * a bad `SESSION_SECRET` should answer quickly and identically every time,
 * not retry the same failing startup on every request.
 */
export function createServerlessApp(
  env: Record<string, string | undefined>,
  options: ServerlessOptions = {},
): ServerlessApp {
  const cache: Cached = {};
  const platformReadsBody = options.platformReadsBody ?? (env.VERCEL ?? '') !== '';

  const build = (): Cached => {
    if (cache.app !== undefined || cache.failure !== undefined) return cache;
    try {
      // No worker: a serverless instance has nowhere to keep a timer, and the
      // scheduled work runs through /api/cron/run instead.
      cache.app = buildApp(env, { runWorker: false });
    } catch (err) {
      const detail = err instanceof ConfigError
        ? err.message
        : err instanceof Error ? err.message : String(err);
      cache.failure = detail;
      // Printed once per instance rather than per request, which is the
      // difference between one legible line in the platform's log and a page
      // of the same line.
      console.error(`configuration error: ${detail}`);
    }
    return cache;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { app, failure } = build();

    if (app === undefined) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({
        error: 'misconfigured',
        message:
          'The server could not start because its configuration is incomplete. The ' +
          'deployment log names the variable.',
        // The ConfigError messages name variables and never values, so this
        // is safe to show and is the difference between a fixable deployment
        // and an opaque 500.
        detail: failure ?? 'unknown',
      }));
      return;
    }

    const prepared = platformReadsBody
      ? { bodyText: bodyTextOf((req as IncomingMessage & { body?: unknown }).body) }
      : {};

    await app.handler(req, res, prepared);
  };

  return {
    handler,
    async dispose(): Promise<void> {
      await cache.app?.close();
      delete cache.app;
    },
  };
}

/** The handler alone, which is all a platform's entry point needs. */
export function createServerlessHandler(
  env: Record<string, string | undefined>,
  options: ServerlessOptions = {},
): Handler {
  return createServerlessApp(env, options).handler;
}
