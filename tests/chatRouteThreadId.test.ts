import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same mock as chatRoute.test.ts: buildChatRoute pulls in session.ts (spawns the real Engram MCP
// session) — mock it so these tests only exercise the thread-id validation added here.
vi.mock('../src/server/session.js', () => ({
  createTutorSession: () => ({
    respond: async () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }),
  }),
}));

const { buildChatRoute } = await import('../src/server/chatRoute.js');

const makeCfg = (vault: string) => ({ vault, student: 'kid', models: { tutor: { model: 'claude-sonnet-5' } } } as any);
const BAD_ID = 'bad.id.with.dots';

describe('thread-id validation surfaces as 400, not 500', () => {
  it('GET /api/thread/:id — invalid id', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-threadid-'));
    const app = buildChatRoute({} as any, makeCfg(vault));
    const res = await app.request(`/api/thread/${BAD_ID}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid threadId/);
  });

  it('PUT /api/thread/:id — invalid id', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-threadid-'));
    const app = buildChatRoute({} as any, makeCfg(vault));
    const res = await app.request(`/api/thread/${BAD_ID}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([]),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid threadId/);
  });

  it('DELETE /api/thread/:id — invalid id', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-threadid-'));
    const app = buildChatRoute({} as any, makeCfg(vault));
    const res = await app.request(`/api/thread/${BAD_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid threadId/);
  });

  it('POST /api/chat — invalid threadId is rejected before setStance ever runs', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-threadid-'));
    const app = buildChatRoute({} as any, makeCfg(vault));
    const res = await app.request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', parts: [{ type: 'data-command', data: { command: 'beginner' } }] }],
        mode: 'learn', threadId: BAD_ID, command: 'beginner',
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid threadId/);
    // The stance write must not have happened for the rejected id — no stances.json at all, since
    // this is the only call in the test that could have created one.
    expect(existsSync(join(vault, '.harness', 'stances.json'))).toBe(false);
  });
});
