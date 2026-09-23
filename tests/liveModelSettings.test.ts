import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { buildChatRoute } from '../src/server/chatRoute.js';
import { buildSetupRoutes } from '../src/server/setupRoutes.js';
import { readSettings, resetEnvShadow, writeSettings } from '../src/server/settings.js';
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

// The real report: a role hand-edited into settings.json as `{ model, sampler: {...} }` (tuning a
// local model past what the popover exposes) must survive both reads and writes of every OTHER
// role — this is the PUT route's side of the fix; settings.test.ts covers applySettings' boot-time
// validation of the object itself.
describe('an object-form saved role (hand-tuned sampler) survives GET and PUT', () => {
  const cfgWithQuizGen = (vault: string): HarnessConfig => ({
    student: 'test', vault, models: {
      tutor: { model: 'ollama:old' }, grader: { model: 'ollama:grader' },
      quiz_gen: { model: 'openai:bonsai-2-27b' },
      card_gen: { model: 'ollama:cards' }, compile: { model: 'ollama:compile' },
    },
  } as unknown as HarnessConfig);

  it('a PUT touching another role leaves an object-form role on disk untouched', async () => {
    dir = mkdtempSync(join(tmpdir(), 'myelin-objectrole-1-'));
    vi.stubEnv('MYELIN_CONFIG_DIR', join(dir, 'config'));
    resetEnvShadow();
    const override = { model: 'openai:bonsai-2-27b', sampler: { topP: 0.95, topK: 20, minP: 0 } };
    writeSettings({ models: { quiz_gen: override } });
    const app = new Hono();
    app.route('/', buildSetupRoutes(cfgWithQuizGen(dir)));
    const res = await app.request('/api/setup/models', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: { tutor: 'ollama:new-tutor' } }),
    });
    expect(res.status).toBe(200);
    expect(readSettings().models?.quiz_gen).toEqual(override);
  });

  it("a PUT changing an object-form role's model keeps its other fields, only the id changes", async () => {
    dir = mkdtempSync(join(tmpdir(), 'myelin-objectrole-2-'));
    vi.stubEnv('MYELIN_CONFIG_DIR', join(dir, 'config'));
    resetEnvShadow();
    const override = { model: 'openai:bonsai-2-27b', sampler: { topP: 0.95, topK: 20, minP: 0 } };
    writeSettings({ models: { quiz_gen: override } });
    const app = new Hono();
    app.route('/', buildSetupRoutes(cfgWithQuizGen(dir)));
    const res = await app.request('/api/setup/models', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: { quiz_gen: 'ollama:bonsai-3-40b-q4' } }),
    });
    expect(res.status).toBe(200);
    expect(readSettings().models?.quiz_gen).toEqual({ ...override, model: 'ollama:bonsai-3-40b-q4' });
  });

  it('GET reports the saved model id as a string even though settings.json holds the full object', async () => {
    dir = mkdtempSync(join(tmpdir(), 'myelin-objectrole-3-'));
    vi.stubEnv('MYELIN_CONFIG_DIR', join(dir, 'config'));
    resetEnvShadow();
    writeSettings({ models: { quiz_gen: { model: 'openai:bonsai-2-27b', sampler: { topP: 0.95 } } } });
    const app = new Hono();
    app.route('/', buildSetupRoutes(cfgWithQuizGen(dir)));
    const state = await (await app.request('/api/setup/models')).json();
    expect(state.roles.quiz_gen.saved).toBe('openai:bonsai-2-27b');
    expect(typeof state.roles.quiz_gen.saved).toBe('string');
    expect(state.roles.quiz_gen.savedHasOverrides).toBe(true);
  });
});
