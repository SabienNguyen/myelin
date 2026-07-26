import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

/**
 * Serve the built client from the same process as the API.
 *
 * In development the client is Vite's job and this finds nothing, which is correct — Vite proxies
 * `/api/*` here and owns everything else. But a packaged app cannot ship a dev server, and asking a
 * desktop user to run two processes on two ports is not a product. So when `dist/` exists, the
 * whole app is one process on one port.
 *
 * The SPA fallback matters more than it looks: the app deep-links via `#/t/<id>/page/<slug>`, and a
 * hash never reaches the server — but a reload of any path that is not `/` still has to answer with
 * index.html rather than 404. Anything under `/api/` is deliberately excluded so a genuinely
 * missing API route stays a 404 instead of silently returning HTML, which is the kind of bug that
 * shows up as "JSON.parse: unexpected token <".
 */
export function buildStaticRoutes(
  root = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist'),
) {
  const app = new Hono();
  if (!existsSync(root)) return { app, root, found: false };

  // serveStatic resolves `root` relative to CWD, not to this file, and a desktop app's CWD is
  // whatever the OS felt like — so pass a path relative to `/` and let it be absolute.
  const rel = root.startsWith('/') ? root.slice(1) : root;
  app.use('/*', serveStatic({ root: `/${rel}` }));
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next();
    return serveStatic({ root: `/${rel}`, path: 'index.html' })(c, next);
  });
  return { app, root, found: true };
}
