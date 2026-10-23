/**
 * A local stand-in for Vercel's function runtime.
 *
 * Not a mock of our code: it runs the real serverless handler, over a real
 * socket, against a real database. What it imitates is the one thing about
 * the platform that changes how a handler must be written — the request body
 * is read by the runtime before the function is called, so by then the stream
 * has already ended and `req.body` holds what was parsed.
 *
 * That detail is imitated faithfully, including the part that bites: the
 * request object handed to the handler has been fully consumed, so code that
 * waits for 'end' waits for ever. A handler that reads the socket itself
 * hangs here exactly as it would on Vercel, which is the point — the failure
 * shows up in a test run rather than as a timed-out invocation in production.
 *
 * Also added, because the platform adds it: `x-forwarded-for`. Behind a proxy
 * the socket address is the proxy's, and anything that counts per caller —
 * the login rate limiter — is wrong unless the forwarded address is used.
 *
 *   import { startVercelHost } from './vercelHost.mjs';
 *   const host = await startVercelHost({ clientIp: '203.0.113.7' });
 *   await fetch(`${host.base}/api/health`);
 *   await host.close();
 */

import { createServer } from 'node:http';

const build = '../.server-build/server/src';

/**
 * Starts the host.
 *
 * `clientIp` is what the imitated platform claims the caller is; pass a
 * function to vary it per request, which is how a test proves the rate
 * limiter counts callers separately.
 */
export async function startVercelHost(options = {}) {
  const { createServerlessApp } = await import(`${build}/serverless.js`);
  const env = { ...process.env, VERCEL: '1', ...(options.env ?? {}) };
  const instance = createServerlessApp(env, { platformReadsBody: true });
  const handler = instance.handler;

  const clientIp = typeof options.clientIp === 'function'
    ? options.clientIp
    : () => options.clientIp ?? '198.51.100.23';

  let invocations = 0;

  const server = createServer((req, res) => {
    invocations += 1;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const type = String(req.headers['content-type'] ?? '');

      // What @vercel/node does: JSON is parsed onto req.body, other bodies
      // are left as a Buffer, and an empty body leaves it undefined.
      if (raw.length === 0) {
        req.body = undefined;
      } else if (type.includes('application/json')) {
        try {
          req.body = JSON.parse(raw.toString('utf8'));
        } catch {
          // The runtime leaves a body it cannot parse as text; the handler is
          // the one that decides that is a 400.
          req.body = raw.toString('utf8');
        }
      } else {
        req.body = raw;
      }

      // The platform sits in front of everything, and says so. A test that
      // needs to look like two different callers sets `x-sb-test-ip`, which
      // stands in for the platform having seen two different people — the
      // header a browser could send is `x-forwarded-for`, and that one is
      // overwritten here exactly as the platform overwrites it.
      const asked = req.headers['x-sb-test-ip'];
      req.headers['x-forwarded-for'] = typeof asked === 'string' && asked !== ''
        ? asked
        : clientIp(req);
      req.headers['x-forwarded-proto'] = 'https';

      void handler(req, res);
    });
    req.on('error', () => { res.statusCode = 400; res.end(); });
  });

  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  return {
    base: `http://127.0.0.1:${port}`,
    get invocations() { return invocations; },
    // The instance is disposed as well as the socket closed. On the platform
    // nothing disposes it — the pool stays warm for the next invocation —
    // but a test process that left it open would never exit.
    close: async () => {
      await new Promise((resolve) => { server.close(() => resolve()); });
      await instance.dispose();
    },
  };
}
