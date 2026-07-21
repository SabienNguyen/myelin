import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// buildChatRoute pulls in session.ts (owned by a concurrent executor, spawns the real
// Loreweaver MCP session) — mock it so this test only exercises the thread-list/delete
// routes added here, not the tutor agent loop.
vi.mock('../src/server/session.js', () => ({
  createTutorSession: () => ({
    respond: async () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }),
  }),
}));

const { buildChatRoute } = await import('../src/server/chatRoute.js');
const { saveThread } = await import('../src/server/sessionStore.js');

// buildChatRoute now picks a session impl (AI-SDK vs Agent-SDK) by inspecting
// cfg.models.tutor.model at construction time (T43) — a non-claude-sdk: model id here keeps
// these thread-route tests on the mocked session.js stub above.
const makeCfg = (vault: string) => ({ vault, student: 'kid', models: { tutor: { model: 'claude-sonnet-5' } } } as any);

describe('GET /api/threads', () => {
  it('returns the vault thread list', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-chatroute-'));
    saveThread(vault, 'abc123', [{ role: 'user', parts: [{ type: 'text', text: 'hi there' }] }]);
    const app = buildChatRoute({} as any, makeCfg(vault));
    const res = await app.request('/api/threads');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'abc123', title: 'hi there' });
  });
});

describe('DELETE /api/thread/:id', () => {
  it('deletes a valid thread and returns 204', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-chatroute-'));
    saveThread(vault, 'gone', [{ role: 'user', parts: [] }]);
    const app = buildChatRoute({} as any, makeCfg(vault));
    const res = await app.request('/api/thread/gone', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const list = await (await app.request('/api/threads')).json();
    expect(list.some((t: any) => t.id === 'gone')).toBe(false);
  });

  it('rejects an invalid threadId rather than deleting arbitrary files', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-chatroute-'));
    const app = buildChatRoute({} as any, makeCfg(vault));
    const res = await app.request('/api/thread/bad.id.with.dots', { method: 'DELETE' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
