import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { localOnly } from '../src/server/localOnly.js';

function app() {
  const a = new Hono();
  a.use('*', localOnly());
  a.get('/api/status', (c) => c.json({ ok: true }));
  a.post('/api/gap/run', (c) => c.json({ ran: true }));
  return a;
}
const req = (path: string, method: string, headers: Record<string, string>) =>
  app().request(path, { method, headers });

describe('localOnly', () => {
  it('serves the app to its own pages: the built client, the Vite dev server, Electron', async () => {
    for (const origin of ['http://127.0.0.1:4820', 'http://localhost:5173', 'http://[::1]:4820']) {
      const res = await req('/api/gap/run', 'POST', { host: '127.0.0.1:4820', origin });
      expect(res.status, origin).toBe(200);
    }
  });

  it('serves a client that sends no Origin at all (curl, the drive scripts, the e2e fixtures)', async () => {
    expect((await req('/api/gap/run', 'POST', { host: 'localhost:4820' })).status).toBe(200);
  });

  // Any page open in the learner's browser can fire a POST at 127.0.0.1. Without this, that is
  // code execution through /api/gap/run from a tab they never looked at.
  it('refuses a state-changing request from another site', async () => {
    const res = await req('/api/gap/run', 'POST', { host: '127.0.0.1:4820', origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/origin/i) });
  });

  it('refuses the opaque "null" origin a sandboxed iframe or file:// page sends', async () => {
    expect((await req('/api/gap/run', 'POST', { host: '127.0.0.1:4820', origin: 'null' })).status).toBe(403);
  });

  it('does not mistake a lookalike hostname for loopback', async () => {
    for (const origin of ['http://localhost.evil.example', 'http://127.0.0.1.evil.example', 'http://evil.example/localhost']) {
      const res = await req('/api/gap/run', 'POST', { host: '127.0.0.1:4820', origin });
      expect(res.status, origin).toBe(403);
    }
  });

  // DNS rebinding: evil.example re-resolves to 127.0.0.1, so the browser treats our API as
  // same-origin with the attacker's page and GETs carry no Origin. The Host header still names them.
  it('refuses any request, reads included, whose Host is not loopback', async () => {
    const res = await req('/api/status', 'GET', { host: 'evil.example:4820' });
    expect(res.status).toBe(403);
    expect((await req('/api/status', 'GET', { host: 'localhost:4820' })).status).toBe(200);
  });
});
