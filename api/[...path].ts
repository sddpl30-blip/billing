/**
 * The whole API, as one Vercel function.
 *
 * Everything under /api/ arrives here: Vercel routes a request to the most
 * specific file in this directory, and a catch-all is the only pattern that
 * covers a router whose paths are declared in the application rather than in
 * the filesystem. One file also means one bundle and one cold start — a
 * function per endpoint would multiply both, and each instance would hold its
 * own database connections.
 *
 * The handler itself is the standalone server's handler, built once per
 * instance. See `server/src/serverless.ts` for what that costs and why it is
 * cached.
 *
 * `/api/cron/run` is in here too, as an ordinary route behind a bearer secret.
 * It is what replaces the long-lived worker: see `server/src/routesCron.ts`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServerlessHandler } from '../server/src/serverless';

const handler = createServerlessHandler(process.env, { platformReadsBody: true });

export default async function (req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handler(req, res);
}
