import { Hono } from 'hono';
import { CodexConnection } from './codexConnection.js';

type Connection = Pick<CodexConnection, 'status' | 'beginLogin' | 'disconnect' | 'signInError'>;

/** Authentication only. No model routes change and no paid API fallback exists here. */
export function buildCodexRoutes(connection: Connection = new CodexConnection()) {
  const app = new Hono();
  app.get('/api/setup/codex', async (c) => {
    try {
      return c.json({ ...await connection.status(), chatEnabled: false, error: connection.signInError });
    } catch {
      return c.json({ error: 'Could not check Codex. Check the installation and restart Myelin.' }, 503);
    }
  });
  app.post('/api/setup/codex/login', async (c) => {
    try { return c.json(await connection.beginLogin()); }
    catch { return c.json({ error: 'Could not start ChatGPT sign-in. Check your connection and try again.' }, 503); }
  });
  app.delete('/api/setup/codex', async (c) => {
    try { await connection.disconnect(); return c.json({ ok: true }); }
    catch { return c.json({ error: 'Could not disconnect ChatGPT. Restart Myelin and try again.' }, 503); }
  });
  return app;
}
