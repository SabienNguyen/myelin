import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// buildChatRoute pulls in session.ts (owned by a concurrent executor, spawns the real
// Loreweaver MCP session) — mock it so this test only exercises the thread-list/delete
// routes added here, not the tutor agent loop. The mock records the mode respond() was called
// with, so the writeUp-promotion test can assert what the route resolved.
const seenModes: string[] = [];
vi.mock('../src/server/session.js', () => ({
  createTutorSession: () => ({
    respond: async (_m: any, mode: string) => {
      seenModes.push(mode);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    },
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

describe('POST /api/chat — writeUp promotion', () => {
  it('promotes a teaching-mode turn to freeform when writeUp is set, leaving other turns alone', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-chatroute-'));
    const app = buildChatRoute({} as any, makeCfg(vault));
    seenModes.length = 0;
    const post = (payload: any) => app.request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const msgs = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
    await post({ messages: msgs, mode: 'learn' });                 // ordinary learn turn
    await post({ messages: msgs, mode: 'learn', writeUp: true });  // the one-click write
    await post({ messages: msgs, mode: 'freeform', writeUp: true }); // already freeform, unchanged
    expect(seenModes).toEqual(['learn', 'freeform', 'freeform']);
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

