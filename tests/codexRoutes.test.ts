import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { localOnly } from '../src/server/localOnly.js';

const connection = () => ({
  status: vi.fn(async () => ({ connected: false, plan: null })),
  beginLogin: vi.fn(async () => ({ url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE' })),
  disconnect: vi.fn(async () => {}),
  signInError: undefined,
});

describe('Codex setup routes', () => {
  it('reports auth readiness separately from model routing, and begins login only on POST', async () => {
    const module = await import('../src/server/codexRoutes.js').catch(() => ({}));
    expect(module).toHaveProperty('buildCodexRoutes');
    const { buildCodexRoutes } = module as typeof import('../src/server/codexRoutes.js');
    const conn = connection();
    const app = buildCodexRoutes(conn);
    expect(await (await app.request('/api/setup/codex')).json()).toEqual({ connected: false, plan: null, chatEnabled: false });
    expect(conn.beginLogin).not.toHaveBeenCalled();
    const login = await app.request('/api/setup/codex/login', { method: 'POST' });
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE' });
    expect(conn.beginLogin).toHaveBeenCalledTimes(1);
    expect((await app.request('/api/setup/codex', { method: 'DELETE' })).status).toBe(200);
    expect(conn.disconnect).toHaveBeenCalledOnce();
  });

  it('does not reflect raw authentication exceptions to the browser', async () => {
    const { buildCodexRoutes } = await import('../src/server/codexRoutes.js');
    const conn = connection();
    conn.beginLogin.mockRejectedValue(new Error('sensitive-upstream-value'));
    const res = await buildCodexRoutes(conn).request('/api/setup/codex/login', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('sensitive-upstream-value');
  });

  it('refuses a foreign-site login request under the application middleware', async () => {
    const { buildCodexRoutes } = await import('../src/server/codexRoutes.js');
    const conn = connection();
    const app = new Hono();
    app.use('*', localOnly());
    app.route('/', buildCodexRoutes(conn));
    const res = await app.request('/api/setup/codex/login', { method: 'POST', headers: { Origin: 'https://example.com' } });
    expect(res.status).toBe(403);
    expect(conn.beginLogin).not.toHaveBeenCalled();
  });
});
