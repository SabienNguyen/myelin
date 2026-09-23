import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    await post({ messages: msgs, mode: 'chat', writeUp: true });   // chat can already write
    expect(seenModes).toEqual(['learn', 'freeform', 'freeform', 'chat']);
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

  // /study names no mode of its own: it is the structured tutor, which is `learn`. /chat leaves it.
  it('/study runs the turn as the learn tutor and /chat returns it to chat', async () => {
    const { post } = makeApp();
    seenModes.length = 0;
    await post({ messages: msgs, command: 'study' });
    await post({ messages: msgs, mode: 'learn', command: 'chat' });
    await post({ messages: msgs, mode: 'chat', command: 'write' });
    expect(seenModes).toEqual(['learn', 'chat', 'chat']);
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


/**
 * The mode selector is gone: a request that sends no `mode` gets one derived from what the learner
 * actually said plus the session plan. These assert the ROUTE seam — that the derived value is what
 * respond() receives — since deriveMode's own mapping is covered in deriveMode.test.ts.
 */
describe('an absent mode is derived, not defaulted', () => {
  const send = async (text: string, extra: Record<string, unknown> = {}) => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-derive-'));
    const app = buildChatRoute({} as any, makeCfg(vault));
    seenModes.length = 0;
    await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        threadId: 't', ...extra,
      }),
    });
    return seenModes[0];
  };

  it('routes an authoring ask to chat, which can build paths', async () => {
    expect(await send('build me a path for jazz harmony')).toBe('chat');
  });

  it('routes an ordinary message to chat', async () => {
    expect(await send('hi')).toBe('chat');
    expect(await send('what is a monad?')).toBe('chat');
  });

  it('routes "quiz me" to quiz', async () => {
    expect(await send('quiz me on what I know')).toBe('quiz');
  });

  it('follows the plan when the learner asks for nothing in particular', async () => {
    expect(await send('ok next', { planKinds: ['review', 'new'] })).toBe('review');
    expect(await send('ok next', { planKinds: ['new'] })).toBe('chat');
  });

  it('treats an empty vault as chat, which can research and write the first pages', async () => {
    expect(await send('teach me jazz harmony', { emptyVault: true })).toBe('chat');
  });

  it('still honours an explicit mode, so anything that sends one is unaffected', async () => {
    expect(await send('quiz me', { mode: 'learn' })).toBe('learn');
  });

  it('still lets a slash command override the derivation for its turn', async () => {
    expect(await send('teach me tensors', { command: 'freeform' })).toBe('freeform');
  });
});

describe('POST /api/chat — a vault that cannot be written', () => {
  it('answers a failed pre-stream save with a JSON error, not a 500 the client cannot parse', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-unwritable-'));
    // .harness/sessions as a FILE makes saveThread's mkdirSync throw ENOTDIR — a stand-in for the
    // read-only or full vault that used to throw past the route's guard, since those two writes
    // sat just outside the try. Hono then returned a bare 500 and the client showed "unreachable".
    mkdirSync(join(vault, '.harness'), { recursive: true });
    writeFileSync(join(vault, '.harness', 'sessions'), 'not a directory');
    const app = buildChatRoute({} as any, makeCfg(vault));
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], threadId: 't' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json(); // the point of the fix: this parses at all
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/could not be started/);
    // …and the failed turn left nothing registered, so the retry isn't refused with a 409.
    const run = await (await app.request('/api/thread/t/run')).json();
    expect(run.running).toBe(false);
  });
});
