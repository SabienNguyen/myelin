import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// buildChatRoute pulls in session.ts (owned by a concurrent executor, spawns the real
// Engram MCP session) — mock it so this test only exercises the thread-list/delete
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
const { readStance, setStance } = await import('../src/server/stanceStore.js');

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

describe('POST /api/chat — slash commands', () => {
  const makeApp = () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-chatroute-'));
    const app = buildChatRoute({} as any, makeCfg(vault));
    const post = (payload: any) => app.request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    return { vault, app, post };
  };
  const msgs = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }];

  it('rejects an unknown command with a 400 naming the valid set', async () => {
    const { post } = makeApp();
    const res = await post({ messages: msgs, mode: 'learn', command: 'expert' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown command "expert"/);
    // Actionable: the error carries the whole valid vocabulary.
    for (const c of ['beginner', 'intermediate', 'advanced', 'learn', 'review', 'quiz', 'freeform', 'write']) {
      expect(body.error).toContain(c);
    }
  });

  it('a mode command overrides the turn mode; /write rides the writeUp promotion', async () => {
    const { post } = makeApp();
    seenModes.length = 0;
    await post({ messages: msgs, mode: 'learn', command: 'review' });   // selector said learn, command wins
    await post({ messages: msgs, mode: 'quiz', command: 'freeform' });
    await post({ messages: msgs, mode: 'learn', command: 'write' });    // same promotion as writeUp:true
    expect(seenModes).toEqual(['review', 'freeform', 'freeform']);
  });

  it('a stance command persists per thread — including a bare send with no text — and later turns keep it', async () => {
    const { vault, post } = makeApp();
    seenModes.length = 0;
    // A bare "/beginner": the user message carries only the data-command part, no text.
    const bare = [{ role: 'user', parts: [{ type: 'data-command', data: { command: 'beginner' } }] }];
    const first = await post({ messages: bare, mode: 'learn', threadId: 'stancy', command: 'beginner' });
    expect(first.status).toBe(200); // the stance-only turn still runs, so the tutor can answer in it
    expect(readStance(vault, 'stancy')).toBe('beginner');
    expect(seenModes).toEqual(['learn']); // a stance never touches the mode
    await post({ messages: msgs, mode: 'learn', threadId: 'stancy' }); // an ordinary later turn
    expect(readStance(vault, 'stancy')).toBe('beginner'); // …leaves the stance standing
    await post({ messages: msgs, mode: 'learn', threadId: 'stancy', command: 'advanced' });
    expect(readStance(vault, 'stancy')).toBe('advanced'); // …until the next stance command
  });
});

describe('DELETE /api/thread/:id', () => {
  it('deletes a valid thread and returns 204, dropping its stance with it', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-chatroute-'));
    saveThread(vault, 'gone', [{ role: 'user', parts: [] }]);
    setStance(vault, 'gone', 'beginner');
    setStance(vault, 'stays', 'advanced');
    const app = buildChatRoute({} as any, makeCfg(vault));
    const res = await app.request('/api/thread/gone', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const list = await (await app.request('/api/threads')).json();
    expect(list.some((t: any) => t.id === 'gone')).toBe(false);
    expect(readStance(vault, 'gone')).toBeNull(); // a reused thread id must not inherit it
    expect(readStance(vault, 'stays')).toBe('advanced');
  });

  it('rejects an invalid threadId rather than deleting arbitrary files', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-chatroute-'));
    const app = buildChatRoute({} as any, makeCfg(vault));
    const res = await app.request('/api/thread/bad.id.with.dots', { method: 'DELETE' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

