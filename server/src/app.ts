/**
 * Wiring, and the entry point.
 *
 * Config first, because a bad configuration should stop the process before it
 * opens a socket. Then the pool, the logger, the providers, the auth service,
 * the routes and — unless disabled — the job worker.
 *
 * `buildApp` is separate from `main` so the tests can start the same server on
 * an ephemeral port and shut it down, rather than testing a different wiring
 * from the one that runs.
 */

import { loadConfig, describeConfig, ConfigError, type Config } from './config';
import { createLogger, type Logger } from './logger';
import { PgPool, connectionFromEnv } from './pg';
import { createApp } from './http';
import { createRoutes } from './routes';
import { createAdminRoutes } from './routesAdmin';
import { createCronRoutes } from './routesCron';
import { createSetupRoutes } from './routesSetup';
import { createScheduleRoutes } from './routesSchedule';
import { AuthService } from './auth';
import { resolveOtpProvider, type OtpProvider } from './providers/otp';
import { resolveEmailProvider, type EmailProvider } from './providers/email';
import { unconfiguredBankApi } from './providers/bank';
import { startWorker, type Worker } from './jobs';
import { isoDateInIndia } from '../../src/accounting/clock';
import type { Server } from 'node:http';

export interface App {
  readonly server: Server;
  /**
   * The request handler, without a socket.
   *
   * The standalone server wraps it in `createServer`; the serverless adapter
   * hands it the platform's own request and response objects. One wiring,
   * two transports — the alternative is a second copy of the routing and the
   * middleware that only one of them is tested through.
   */
  readonly handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    prepared?: { bodyText?: string },
  ) => Promise<void>;
  readonly config: Config;
  readonly log: Logger;
  readonly pool: PgPool;
  readonly worker: Worker | null;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

export interface BuildOptions {
  /** Starts the background worker. Off in the tests, which drive it directly. */
  readonly runWorker?: boolean;
  readonly workerIntervalMs?: number;
  /**
   * Replaces a provider adapter.
   *
   * A seam for the tests, and the place a real provider is wired in. It exists
   * because neither adapter in this repository ever reports a delivery — the
   * development one writes to the log and says `delivers: false`, which is
   * honest — so without an injectable provider the code that records a
   * confirmed send could never be exercised at all, and "only record a
   * delivery the provider confirmed" would be an untested claim.
   */
  readonly email?: EmailProvider;
  readonly otp?: OtpProvider;
}

export function buildApp(
  env: Record<string, string | undefined>,
  options: BuildOptions = {},
): App {
  const config = loadConfig(env);
  const log = createLogger(config);
  // A serverless instance serves one request at a time and there may be many
  // instances, so a large pool per instance is how a database's connection
  // limit gets used up by idle sockets. Two: one in use, one spare for the
  // transaction a handler opens while another query is in flight.
  const poolMax = Number(env.DB_POOL_MAX ?? (config.platform === 'vercel' ? '2' : '8'));
  const pool = new PgPool(connectionFromEnv(env), poolMax);

  const email = options.email ?? resolveEmailProvider(config.emailProvider, log, env);
  const otp = options.otp ?? resolveOtpProvider(config.otpProvider, log, email);
  const bankApi = unconfiguredBankApi();

  const auth = new AuthService(pool, config, log, otp);
  const routes = [
    ...createRoutes({ pool, config, log, auth, email, bankApi }),
    ...createAdminRoutes({ pool, config, log, email }),
    // The scheduler's own endpoints. Present everywhere, closed unless
    // CRON_SECRET is set, so the standalone server and the serverless
    // deployment run the same routes.
    ...createCronRoutes({ pool, config, log, email }),
    ...createSetupRoutes({ pool, config, log }),
    ...createScheduleRoutes({ pool }),
  ];

  const { server, handler } = createApp(routes, {
    config,
    log,
    resolveSession: (token) => auth.resolveSession(token),
  });

  const worker = options.runWorker === true
    ? startWorker(
        // The scheduler's "today" is India's, not UTC's. In UTC the first
        // five and a half hours of every Indian day are still yesterday, so a
        // job run just after midnight IST converted due bills and stamped
        // jobs with the previous day's date.
        { pool, log: log.child({ component: 'scheduler' }), email, now: () => isoDateInIndia() },
        {
          worker: `${env.HOSTNAME ?? 'worker'}:${process.pid}`,
          intervalMs: options.workerIntervalMs ?? 60_000,
        },
      )
    : null;

  return {
    server,
    handler,
    config,
    log,
    pool,
    worker,
    listen(): Promise<{ port: number }> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        // Port 0 asks the operating system for a free one, which is what lets
        // the tests run without choosing a port and colliding.
        server.listen(config.port, config.host, () => {
          const address = server.address();
          const port = typeof address === 'object' && address !== null ? address.port : config.port;
          log.info('listening', { ...describeConfig(config), port });
          resolve({ port });
        });
      });
    },
    async close(): Promise<void> {
      worker?.stop();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
      await pool.end();
    },
  };
}

export async function main(): Promise<void> {
  let app: App;
  try {
    app = buildApp(process.env, {
      runWorker: process.env.RUN_WORKER !== 'false',
      ...(process.env.WORKER_INTERVAL_MS !== undefined
        ? { workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS) }
        : {}),
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      // Printed plainly and the process stops. A server that starts with a
      // broken configuration is worse than one that refuses to.
      console.error(`configuration error: ${err.message}`);
      process.exit(78);
    }
    throw err;
  }

  await app.listen();

  // The schema version, checked at startup. A server running against a
  // database it has never migrated is a problem worth naming immediately.
  try {
    const applied = await app.pool.query<{ version: string; count: string }>(
      `SELECT MAX(version) AS version, COUNT(*)::text AS count FROM schema_migrations`,
    );
    app.log.info('schema', {
      latest: applied.rows[0]?.version ?? null,
      applied: Number(applied.rows[0]?.count ?? '0'),
    });
  } catch (err) {
    app.log.error('the database is not reachable or has no schema', {
      error: err instanceof Error ? err.message : String(err),
      hint: 'run node server/migrate.mjs',
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info('shutting down', { signal });
      void app.close().then(() => process.exit(0));
    });
  }
}

// Run only when this file is the entry point, so importing it in a test does
// not start a server on a fixed port.
//
// The `typeof` guards are not decoration: a bundler may compile this module to
// ESM, where `require` and `module` do not exist, and an unguarded reference
// would throw a ReferenceError the moment the serverless adapter imported the
// wiring — before any route could answer.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void main();
}
