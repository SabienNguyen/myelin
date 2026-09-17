import type { MiddlewareHandler } from 'hono';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false; // "null" and garbage are not loopback origins
  }
}

/**
 * Binding 127.0.0.1 keeps other machines out; it does nothing about the learner's own browser,
 * which will happily deliver another site's request to a loopback port. This app has no auth and
 * /api/gap/run executes code, so two checks stand in for it:
 *
 *   - **Origin** on anything that is not a read. Browsers attach it to every cross-site POST/PUT/
 *     DELETE, so a foreign page is refused while the built client, Vite's dev server and Electron
 *     (all loopback origins, any port) pass. No Origin at all means a non-browser client, which
 *     could already do anything this user can.
 *   - **Host** on everything. After a DNS rebind the attacker's page IS same-origin with this
 *     server, so its reads carry no Origin — but the Host header still names their domain.
 */
export function localOnly(): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host');
    if (host && !isLoopbackUrl(`http://${host}`)) {
      console.error(`[localOnly] refused ${c.req.method} ${c.req.path}: Host ${host}`);
      return c.json({ error: `refused: Host ${host} is not this machine` }, 403);
    }
    const origin = c.req.header('origin');
    const isRead = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (!isRead && origin !== undefined && !isLoopbackUrl(origin)) {
      console.error(`[localOnly] refused ${c.req.method} ${c.req.path}: Origin ${origin}`);
      return c.json({ error: `refused: origin ${origin} is not this app` }, 403);
    }
    await next();
  };
}
