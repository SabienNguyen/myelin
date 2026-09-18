import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { buildChatRoute } from '../src/server/chatRoute.js';
import { buildSetupRoutes } from '../src/server/setupRoutes.js';
import { resetEnvShadow } from '../src/server/settings.js';
import { chatModelFor } from '../src/server/models.js';
import { streamModel } from './mockModel.js';
import type { HarnessConfig } from '../src/server/config.js';
import type { Engram } from '../src/server/mcp.js';

vi.mock('../src/server/models.js', async (original) => ({
  ...await original<object>(), chatModelFor: vi.fn(),
}));
let dir: string;
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetEnvShadow();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('UI model saves reach the existing chat handler', () => {
  it('uses the newly saved tutor on the next turn', async () => {
    dir = mkdtempSync(join(tmpdir(), 'myelin-live-model-'));
    vi.stubEnv('MYELIN_CONFIG_DIR', join(dir, 'config'));
    resetEnvShadow();
    const used: string[] = [];
    vi.mocked(chatModelFor).mockImplementation((_role, cfg) => {
      const id = cfg.models.tutor.model;
      return streamModel(() => { used.push(id); return { text: 'Hello.' }; });
    });
    const cfg = { student: 'test', vault: dir, models: {
      tutor: { model: 'ollama:old' }, grader: { model: 'ollama:grader' },
      card_gen: { model: 'ollama:cards' }, compile: { model: 'ollama:compile' },
    } } as HarnessConfig;
    const lw = {
      listSlugs: async () => ['topic'], tools: async () => [],
      call: async (name: string) => {
        if (name === 'read_page') return { page: { meta: { title: 'Topic', status: 'solid', sources: ['https://example.org'] }, body: 'Useful teaching content. '.repeat(100) } };
        if (name === 'next_lessons') return { lessons: [{ slug: 'topic', title: 'Topic' }] };
        return { members: [], analogies: [], hits: [] };
      },
    } as unknown as Engram;
    const app = new Hono();
    app.route('/', buildSetupRoutes(cfg));
    app.route('/', buildChatRoute(lw, cfg)); // Construct ONCE, before either UI save.
    for (const [n, id] of ['ollama:ui-first', 'openrouter:openrouter/free'].entries()) {
      const saved = await app.request('/api/setup/models', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: { tutor: id } }),
      });
      expect(saved.status).toBe(200);
      expect((await saved.json()).roles.tutor.effective).toBe(id);
      const response = await app.request('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: `turn-${n}`, mode: 'learn', messages: [
          { id: 'a0', role: 'assistant', parts: [{ type: 'text', text: 'Welcome.' }] },
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
        ] }),
      });
      const body = await response.text();
      expect(body).not.toContain('"type":"error"');
      expect(used.at(-1)).toBe(id);
    }
  });

  it('mid-conversation switch changes the model on the next turn of the SAME thread', async () => {
    dir = mkdtempSync(join(tmpdir(), 'myelin-midthread-'));
    vi.stubEnv('MYELIN_CONFIG_DIR', join(dir, 'config'));
    resetEnvShadow();
    const used: string[] = [];
    vi.mocked(chatModelFor).mockImplementation((_role, cfg) =>
      streamModel(() => { used.push(cfg.models.tutor.model); return { text: 'Hello.' }; }));
    const cfg = { student: 'test', vault: dir, models: {
      tutor: { model: 'ollama:old' }, grader: { model: 'ollama:grader' },
      card_gen: { model: 'ollama:cards' }, compile: { model: 'ollama:compile' },
    } } as HarnessConfig;
    const lw = { listSlugs: async () => [], tools: async () => [], call: async () => ({}) } as unknown as Engram;
    const app = new Hono();
    app.route('/', buildSetupRoutes(cfg));
    app.route('/', buildChatRoute(lw, cfg));
    const send = async () => {
      const res = await app.request('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 'same-thread', mode: 'learn', messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
        ] }),
      });
      const body = await res.text(); // drain: the model call runs inside the stream body
      expect(body).not.toContain('"type":"error"');
    };
    await send();
    await app.request('/api/setup/models', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: { tutor: 'openrouter:openrouter/free' } }),
    });
    await send();
    expect(used).toEqual(['ollama:old', 'openrouter:openrouter/free']);
  });
});
