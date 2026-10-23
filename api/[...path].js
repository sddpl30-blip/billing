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
 * Plain JavaScript, importing the compiled server rather than its TypeScript.
 * package.json says "type": "module", so the platform would compile a .ts
 * entry and everything it imports as ES modules — and ES modules need file
 * extensions on relative imports, which the server's sources do not carry.
 * The function failed to load with ERR_MODULE_NOT_FOUND. `npm run
 * server:build` (part of the Vercel build command) emits the same server as
 * CommonJS into .server-build, which is exactly what the serverless test suite
 * runs, so what is deployed is what was tested.
 *
 * `/api/cron/run` is in here too, as an ordinary route behind a bearer secret.
 * It is what replaces the long-lived worker: see `server/src/routesCron.ts`.
 */

import { createServerlessHandler } from '../.server-build/server/src/serverless.js';

const handler = createServerlessHandler(process.env, { platformReadsBody: true });

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export default async function (req, res) {
  await handler(req, res);
}
