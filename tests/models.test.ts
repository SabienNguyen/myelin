import { describe, it, expect, afterEach, vi } from 'vitest';
import { chatModelFor, modelRouteFor, withRequestDefaults } from '../src/server/models.js';
import type { ChatModel, ChatRequest } from '../src/server/llm/index.js';

const cfg = { models: { tutor: { model: 'claude-sonnet-5' }, grader: { model: 'claude-haiku-4-5' } } } as any;

// chatModelFor returns an opaque {generate, stream} — no modelId to read — so these pin the
// behaviors observable from outside: the resolve-time failure, its per-call env read, and the
// LW_MOCK_MODEL hook resolving the scripted model. Wire-level routing is the adapters' tests.
describe('chatModelFor (the model router)', () => {
  const openaiCfg = { models: { grader: { model: 'openai:foo/bar' } } } as any;
  const prevBase = process.env.OPENAI_COMPAT_BASE_URL;
  const prevOllama = process.env.OLLAMA_BASE_URL;
  const prevMock = process.env.LW_MOCK_MODEL;
  afterEach(() => {
    if (prevBase === undefined) delete process.env.OPENAI_COMPAT_BASE_URL;
    else process.env.OPENAI_COMPAT_BASE_URL = prevBase;
    if (prevOllama === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = prevOllama;
    if (prevMock === undefined) delete process.env.LW_MOCK_MODEL;
    else process.env.LW_MOCK_MODEL = prevMock;
  });

  it('resolves each route to a ChatModel', () => {
    process.env.OPENAI_COMPAT_BASE_URL = 'https://openrouter.ai/api/v1';
    for (const c of [cfg, { models: { tutor: { model: 'ollama:qwen2.5-coder:14B' } } } as any]) {
      const m = chatModelFor('tutor', c);
      expect(typeof m.generate).toBe('function');
      expect(typeof m.stream).toBe('function');
    }
    expect(typeof chatModelFor('grader', openaiCfg).generate).toBe('function');
  });

  it('ollama: still resolves with its localhost default when OLLAMA_BASE_URL is unset', () => {
    delete process.env.OLLAMA_BASE_URL;
    const m = chatModelFor('grader', { models: { grader: { model: 'ollama:qwen2.5-coder:14B' } } } as any);
    expect(typeof m.generate).toBe('function');
  });

  it('openai: with no base URL fails loudly naming OPENAI_COMPAT_BASE_URL, read per call — never defaults to localhost', () => {
    delete process.env.OPENAI_COMPAT_BASE_URL;
    expect(() => chatModelFor('grader', openaiCfg)).toThrow(/OPENAI_COMPAT_BASE_URL/);
    expect(() => chatModelFor('grader', openaiCfg)).toThrow(/openai:foo\/bar/);
    process.env.OPENAI_COMPAT_BASE_URL = 'https://openrouter.ai/api/v1';
    expect(typeof chatModelFor('grader', openaiCfg).generate).toBe('function');
  });

  it('openai: works without an api key — some proxies are keyless; a 401 belongs to the provider', () => {
    process.env.OPENAI_COMPAT_BASE_URL = 'https://openrouter.ai/api/v1';
    const prevKey = process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.OPENAI_COMPAT_API_KEY;
    try {
      expect(typeof chatModelFor('grader', openaiCfg).generate).toBe('function');
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_COMPAT_API_KEY = prevKey;
    }
  });

  it('openrouter: resolves without OPENAI_COMPAT_BASE_URL and reads OPENROUTER_API_KEY per call', () => {
    const orCfg = { models: { grader: { model: 'openrouter:deepseek/deepseek-chat:free' } } } as any;
    const savedBase = process.env.OPENAI_COMPAT_BASE_URL;
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_COMPAT_BASE_URL;
    delete process.env.OPENROUTER_API_KEY;
    try {
      // The whole point of the openrouter: route: no compat base URL configured anywhere, and it
      // still resolves — the route pins its own endpoint.
      expect(typeof chatModelFor('grader', orCfg).generate).toBe('function');
    } finally {
      if (savedBase !== undefined) process.env.OPENAI_COMPAT_BASE_URL = savedBase;
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
    }
  });

  it('openrouter: works without an api key at resolve time — the provider owns the 401', () => {
    // Keyless resolve on purpose: the key may be saved through the setup panel AFTER the role is
    // configured, and models resolve per call, so a missing key at route time is not an error.
    const orCfg = { models: { grader: { model: 'openrouter:z-ai/glm-5.2:free' } } } as any;
    expect(typeof chatModelFor('grader', orCfg).generate).toBe('function');
  });

  it('modelRouteFor classifies the openrouter: prefix', () => {
    expect(modelRouteFor('openrouter:deepseek/deepseek-chat:free')).toBe('openrouter');
    expect(modelRouteFor('openai:foo')).toBe('openai');
    expect(modelRouteFor('ollama:q')).toBe('ollama');
    expect(modelRouteFor('claude-sonnet-5')).toBe('anthropic');
  });

  // oai: is its own route, distinct from openai: — the openai: slot stays a configurable
  // OpenAI-compatible endpoint (OPENAI_COMPAT_BASE_URL), while oai: is the pinned Responses API
  // with built-in web search and reasoning-alongside-tools.
  it('modelRouteFor classifies the oai: prefix, distinct from openai:', () => {
    expect(modelRouteFor('oai:gpt-5.1')).toBe('oai');
    expect(modelRouteFor('openai:gpt-5.1')).toBe('openai');
  });

  it('oai: resolves to a ChatModel, needing no key at resolve time', () => {
    const m = chatModelFor('grader', { models: { grader: { model: 'oai:gpt-5.1' } } } as any);
    expect(typeof m.generate).toBe('function');
    expect(typeof m.stream).toBe('function');
  });

  it('oai: sends to the Responses API, reading OPENAI_API_KEY per call like the other routes', async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-oai-test';
    const seen: { url: string; auth: string | null; model: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), model: body.model });
      const frame = `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed', response: { status: 'completed', usage: {} },
      })}\n\n`;
      return new Response(frame, { headers: { 'content-type': 'text/event-stream' } });
    }));
    try {
      const model = chatModelFor('grader', { models: { grader: { model: 'oai:gpt-5.1' } } } as any);
      await model.generate({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as any);
      expect(seen[0]).toEqual({
        url: 'https://api.openai.com/v1/responses', auth: 'Bearer sk-oai-test', model: 'gpt-5.1',
      });
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      vi.unstubAllGlobals();
    }
  });

  it('withRequestDefaults injects the role\'s effort and sampler into every request without touching the rest', async () => {
    const seen: ChatRequest[] = [];
    const stub: ChatModel = {
      supportsResponseFormat: true,
      async generate(req) {
        seen.push(req);
        return { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, finishReason: 'stop' as const };
      },
      async *stream(req) { seen.push(req); },
    };
    const sampler = { topK: 20, minP: 0.05 };
    const wrapped = withRequestDefaults(stub, { effort: 'low', sampler });
    expect(wrapped.supportsResponseFormat).toBe(true);
    await wrapped.generate({ messages: [], maxTokens: 9 });
    for await (const _ of wrapped.stream({ messages: [] })) void _;
    expect(seen[0]).toMatchObject({ effort: 'low', sampler, maxTokens: 9 });
    expect(seen[1]).toMatchObject({ effort: 'low', sampler });
    // A request that already carries a value wins over the role default, per field: the request's
    // sampler replaces the role's whole block (no per-knob merging), and effort follows suit.
    await wrapped.generate({ messages: [], effort: 'high', sampler: { topP: 0.9 } });
    expect(seen[2]).toMatchObject({ effort: 'high', sampler: { topP: 0.9 } });
    expect((seen[2].sampler as Record<string, unknown>).topK).toBeUndefined();
    // A defaults object with neither field set leaves requests untouched.
    const bare = withRequestDefaults(stub, {});
    await bare.generate({ messages: [] });
    expect(seen[3].effort).toBeUndefined();
    expect(seen[3].sampler).toBeUndefined();
  });

  it('LW_MOCK_MODEL resolves the scripted chat model via createRequire (no bare require in ESM)', () => {
    // The script file is read lazily (first pop, never at factory time), so the path need not
    // exist here — the hook must return a model, never crash with "require is not defined".
    process.env.LW_MOCK_MODEL = 'scripted';
    const m = chatModelFor('grader', cfg);
    expect(typeof m.generate).toBe('function');
    expect(typeof m.stream).toBe('function');
  });

  it('scripted models stay unwrapped even when the role configures effort/sampler', () => {
    // The cache must return the SAME instance per script path (the shared-turn-sequence
    // contract); a defaults wrapper would mint a fresh object per call, so reference identity is
    // the observable proof the scripted path skips withRequestDefaults.
    process.env.LW_MOCK_MODEL = 'scripted';
    const tuned = {
      models: { grader: { model: 'ollama:q', effort: 'low', sampler: { topK: 20 } } },
    } as any;
    expect(chatModelFor('grader', tuned)).toBe(chatModelFor('grader', tuned));
  });
});
