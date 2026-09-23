import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatModel, ChatRequest } from '../src/server/llm/index.js';
import { zeroUsage } from '../src/server/llm/index.js';
import { Engram } from '../src/server/mcp.js';
import { buildAsideRoute } from '../src/server/asideRoute.js';
import { loadThread, saveThread } from '../src/server/sessionStore.js';
import { readQueue } from '../src/server/queueStore.js';
import { streamModel, turnsModel } from './mockModel.js';
import { LW_REPO } from './lwRepo.js';

let lw: Engram; let vault: string;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), 'lwh-aside-vault-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  writeFileSync(join(vault, 'pages', 'arith.md'),
    '---\ntitle: Arithmetic\ndifficulty: 1\nstatus: solid\nsources: ["https://example.edu/arithmetic"]\n---\n'
    + `Addition, subtraction, multiplication and division over the integers. ${'Detail. '.repeat(80)}`);
  lw = await Engram.connect({
    vault, student: 'kid',
    engram: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
  } as any);
}, 30_000);
afterAll(async () => { await lw.close(); });

const cfg = () => ({ vault, student: 'kid', autoCompile: false, models: {} } as any);

function seedThread(threadId: string, messageId = 'a1') {
  saveThread(vault, threadId, [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'teach me arithmetic' }] },
    { id: messageId, role: 'assistant', parts: [{ type: 'text', text: 'Addition combines two numbers into a sum.' }] },
  ]);
}

describe('POST /api/aside — validation', () => {
  const app = buildAsideRoute(null, cfg());
  const post = (body: unknown) => app.request('/api/aside', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('400s on a missing threadId', async () => {
    expect((await post({ messageId: 'a1', question: 'what is this?' })).status).toBe(400);
  });

  it('400s on an invalid threadId (path-traversal shaped)', async () => {
    expect((await post({ threadId: '../evil', messageId: 'a1', question: 'q' })).status).toBe(400);
  });

  it('400s on a missing messageId', async () => {
    expect((await post({ threadId: 't1', question: 'q' })).status).toBe(400);
  });

  it('400s on a missing or empty question', async () => {
    expect((await post({ threadId: 't1', messageId: 'a1' })).status).toBe(400);
    expect((await post({ threadId: 't1', messageId: 'a1', question: '   ' })).status).toBe(400);
  });

  it('400s on a question over ASIDE_MAX_QUESTION', async () => {
    const res = await post({ threadId: 't1', messageId: 'a1', question: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  it('400s on a quote over ASIDE_MAX_QUESTION', async () => {
    const res = await post({ threadId: 't1', messageId: 'a1', question: 'q', quote: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/aside — unknown thread/message', () => {
  it('404s when the message does not exist on disk', async () => {
    const app = buildAsideRoute(lw, cfg());
    const res = await app.request('/api/aside', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'no-such-thread', messageId: 'a1', question: 'what is this?' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/a1/);
  });

  it('404s when the thread exists but the message id does not', async () => {
    seedThread('has-a-thread');
    const app = buildAsideRoute(lw, cfg());
    const res = await app.request('/api/aside', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'has-a-thread', messageId: 'not-real', question: 'what is this?' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/aside — degraded boot', () => {
  it('502s when lw is null instead of throwing', async () => {
    const app = buildAsideRoute(null, cfg());
    const res = await app.request('/api/aside', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'anything', messageId: 'a1', question: 'q' }),
    });
    expect(res.status).toBe(502);
  });
});

describe('POST /api/aside — tools offered', () => {
  it('offers exactly search, read_page and read_url — no block tools, record_evidence, or write_page', async () => {
    seedThread('tools-thread');
    const calls: ChatRequest[] = [];
    const model = streamModel((req) => {
      calls.push(structuredClone(req));
      return { text: 'A short grounded answer. (from memory — not checked against a source)' };
    });
    const app = buildAsideRoute(lw, cfg(), { model, now: () => new Date('2026-09-22T00:00:00.000Z') });
    const res = await app.request('/api/aside', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'tools-thread', messageId: 'a1', question: 'what does "sum" mean?' }),
    });
    expect(res.status).toBe(200);
    const names = (calls[0].tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['read_page', 'read_url', 'search']);
    for (const forbidden of ['record_evidence', 'write_page', 'quick_check', 'structured_check', 'code_exercise']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('POST /api/aside — grounding computed from the actual tool sequence', () => {
  it('is fromMemory when nothing was read or searched', async () => {
    seedThread('memory-thread');
    const model = turnsModel([
      { text: 'A sum adds two numbers together. (from memory — not checked against a source)' },
    ]);
    const app = buildAsideRoute(lw, cfg(), { model, now: () => new Date('2026-09-22T00:00:00.000Z') });
    const res = await app.request('/api/aside', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'memory-thread', messageId: 'a1', question: 'what is a sum?' }),
    });
    expect(res.status).toBe(200);
    const { part } = await res.json();
    expect(part.data.fromMemory).toBe(true);
    expect(part.data.sources).toEqual([]);
    expect(part.data.vaultPages).toEqual([]);
  });

  it('collects vaultPages from a read_page call and is not fromMemory', async () => {
    seedThread('vault-thread');
    const model = turnsModel([
      { toolCalls: [{ toolName: 'read_page', input: { slug: 'arith' } }] },
      { text: 'Addition is covered on the arithmetic page — see "arith".' },
    ]);
    const app = buildAsideRoute(lw, cfg(), { model, now: () => new Date('2026-09-22T00:00:00.000Z') });
    const res = await app.request('/api/aside', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'vault-thread', messageId: 'a1', question: 'where is addition covered?' }),
    });
    expect(res.status).toBe(200);
    const { part } = await res.json();
    expect(part.data.vaultPages).toEqual(['arith']);
    expect(part.data.fromMemory).toBe(false);
  });

  it('collects sources from a provider-executed web search (server-tool-result)', async () => {
    seedThread('search-thread');
    const calls: ChatRequest[] = [];
    const model: ChatModel = {
      async generate() { throw new Error('unused — asideRoute streams'); },
      async *stream(req) {
        calls.push(structuredClone(req));
        yield {
          type: 'server-tool-result', toolCallId: 'srv1', toolName: 'web_search',
          output: { query: 'sum definition', sources: [{ url: 'https://example.edu/sum', title: 'Sum (math)' }] },
        };
        yield { type: 'text-start', id: '0' };
        yield { type: 'text-delta', id: '0', text: 'A sum is the result of addition, per Sum (math).' };
        yield { type: 'text-end', id: '0' };
        yield { type: 'finish', reason: 'stop', usage: zeroUsage() };
      },
    };
    const app = buildAsideRoute(lw, cfg(), { model, now: () => new Date('2026-09-22T00:00:00.000Z') });
    const res = await app.request('/api/aside', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'search-thread', messageId: 'a1', question: 'what is a sum, precisely?' }),
    });
    expect(res.status).toBe(200);
    const { part } = await res.json();
    expect(part.data.sources).toEqual([{ url: 'https://example.edu/sum', title: 'Sum (math)' }]);
    expect(part.data.fromMemory).toBe(false);
  });
});

describe('POST /api/aside — persistence', () => {
  it('persists the returned part on the right message on disk, and a later client save without it keeps it', async () => {
    seedThread('persist-thread');
    const model = turnsModel([{ text: 'A short grounded answer, kept short on purpose.' }]);
    const app = buildAsideRoute(lw, cfg(), { model, now: () => new Date('2026-09-22T00:00:00.000Z') });
    const res = await app.request('/api/aside', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'persist-thread', messageId: 'a1', question: 'what does this mean?' }),
    });
    expect(res.status).toBe(200);
    const { part } = await res.json();

    const onDisk = loadThread(vault, 'persist-thread') as any[];
    const anchor = onDisk.find((m) => m.id === 'a1');
    expect(anchor.parts.some((p: any) => p.type === 'data-aside' && p.id === part.id)).toBe(true);

    // A later client save of the SAME message, built from a snapshot taken before the aside
    // landed — it carries no data-aside part at all.
    saveThread(vault, 'persist-thread', [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'teach me arithmetic' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Addition combines two numbers into a sum.' }] },
    ]);

    const afterClientSave = loadThread(vault, 'persist-thread') as any[];
    const anchorAfter = afterClientSave.find((m) => m.id === 'a1');
    expect(anchorAfter.parts.some((p: any) => p.type === 'data-aside' && p.id === part.id)).toBe(true);
  });
});

describe('POST /api/aside — model failure', () => {
  it('502s and logs [aside] on a model/loop failure', async () => {
    seedThread('fail-thread');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const model = streamModel(() => { throw new Error('provider exploded'); });
      const app = buildAsideRoute(lw, cfg(), { model, now: () => new Date('2026-09-22T00:00:00.000Z') });
      const res = await app.request('/api/aside', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 'fail-thread', messageId: 'a1', question: 'what does this mean?' }),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toMatch(/provider exploded/);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('[aside]'))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('POST /api/aside — lesson notes', () => {
  it('queues a lesson-notes ledger entry, bypassing the teaching-turn length gate', async () => {
    seedThread('lesson-thread');
    const model = turnsModel([{ text: 'Short.' }]); // well under MIN_LESSON_CHARS
    const app = buildAsideRoute(lw, cfg(), { model, now: () => new Date('2026-09-22T00:00:00.000Z') });
    const res = await app.request('/api/aside', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'lesson-thread', messageId: 'a1', question: 'what does this mean?' }),
    });
    expect(res.status).toBe(200);
    await res.json();

    // enqueueLessonNotes is fire-and-forget; its work is pure microtask-scheduled (queueStore's
    // updateQueue chain, no real I/O wait), so flushing the microtask queue a few times is enough.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const ledger = readQueue(vault).filter((e) => e.chapter?.includes('lesson-thread'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].mode).toBe('lesson');
  });
});
