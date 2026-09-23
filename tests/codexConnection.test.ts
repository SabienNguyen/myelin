import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the installed, official binary with a fresh private home, not the user's credentials.
describe('Codex subscription connection', () => {
  it('checks signed-out state through the real app-server without starting login', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myelin-codex-test-'));
    const module = await import('../src/server/codexConnection.js').catch(() => ({}));
    expect(module).toHaveProperty('CodexConnection');
    const { CodexConnection } = module as typeof import('../src/server/codexConnection.js');
    const connection = new CodexConnection({ home });
    try {
      const { buildCodexRoutes } = await import('../src/server/codexRoutes.js');
      const app = buildCodexRoutes(connection);
      const status = await app.request('/api/setup/codex');
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ connected: false, plan: null, chatEnabled: false });
      const logout = await app.request('/api/setup/codex', { method: 'DELETE' });
      expect(logout.status).toBe(200);
      expect(await connection.status()).toEqual({ connected: false, plan: null });
      expect(connection).toHaveProperty('request');
      // thread/start (and even turn/start) resolve without auth on this app-server version --
      // thread creation is local bookkeeping that never checks account state first, so neither
      // can be the probe below. An unknown method is what the real server actually rejects
      // synchronously over the same stdio JSON-RPC channel.
      await expect(connection.request('myelin/not-a-method', {})).rejects.toMatchObject({
        name: 'CodexRpcError',
        code: expect.any(Number),
        // The security property: the real error text (which would quote the bad method name
        // back, e.g. an "unknown variant" message) never reaches the caller.
        message: expect.not.stringContaining('myelin/not-a-method'),
      });
      console.info('Real Codex app-server rejected an unknown method over stdio JSON-RPC in a fresh signed-out home, surfaced as a typed CodexRpcError with the generic message, not the provider\'s.');
    } finally {
      await connection.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);
});
