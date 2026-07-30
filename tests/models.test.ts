import { describe, it, expect, afterEach } from 'vitest';
import { modelFor, cachedSystem } from '../src/server/models.js';

const cfg = { models: { tutor: { model: 'claude-sonnet-5' }, grader: { model: 'claude-haiku-4-5' } } } as any;

describe('model router', () => {
  it('routes roles to configured ids', () => {
    expect(modelFor('tutor', cfg).modelId).toBe('claude-sonnet-5');
    expect(modelFor('grader', cfg).modelId).toBe('claude-haiku-4-5');
  });
  describe('LW_MOCK_MODEL hook (ESM require regression)', () => {
    const prev = process.env.LW_MOCK_MODEL;
    afterEach(() => {
      if (prev === undefined) delete process.env.LW_MOCK_MODEL;
      else process.env.LW_MOCK_MODEL = prev;
    });

    it('uses createRequire, not the (undefined in ESM) bare require', () => {
      process.env.LW_MOCK_MODEL = 'scripted';
      // Until Task 12 lands, tests/e2e/scripted-model.cjs does not exist. The hook must
      // either return the scripted model or fail with module-not-found — never with
      // "require is not defined" (the ESM bare-require crash this guards against).
      try {
        const m = modelFor('tutor', cfg);
        expect(m).toBeDefined(); // Task 12 has landed; the scripted model loaded
      } catch (e: any) {
        expect(String(e?.message)).not.toMatch(/require is not defined/);
        expect(String(e?.message)).toMatch(/scripted-model/);
        expect(e?.code ?? '').toMatch(/MODULE_NOT_FOUND/);
      }
    });
  });

  it('marks system message for anthropic caching', () => {
    const m = cachedSystem('be a tutor');
    expect(m.role).toBe('system');
    expect((m as any).providerOptions.anthropic.cacheControl.type).toBe('ephemeral');
  });

  describe('ollama: local model routing', () => {
    const ollamaCfg = { models: { grader: { model: 'ollama:qwen2.5-coder:14B' } } } as any;

    it('strips the ollama: prefix and returns an openai-compatible model, not anthropic', () => {
      const m = modelFor('grader', ollamaCfg) as any;
      expect(m.modelId).toBe('qwen2.5-coder:14B');
      expect(m.provider).not.toMatch(/anthropic/);
      expect(m.provider).toBe('ollama.chat');
    });

    it('still resolves with its localhost default when OLLAMA_BASE_URL is unset', () => {
      const prev = process.env.OLLAMA_BASE_URL;
      delete process.env.OLLAMA_BASE_URL;
      try {
        expect((modelFor('grader', ollamaCfg) as any).modelId).toBe('qwen2.5-coder:14B');
      } finally {
        if (prev !== undefined) process.env.OLLAMA_BASE_URL = prev;
      }
    });
  });

  describe('openai: OpenAI-compatible provider routing', () => {
    const openaiCfg = { models: { grader: { model: 'openai:foo/bar' } } } as any;
    const prevBase = process.env.OPENAI_COMPAT_BASE_URL;
    const prevKey = process.env.OPENAI_COMPAT_API_KEY;
    afterEach(() => {
      if (prevBase === undefined) delete process.env.OPENAI_COMPAT_BASE_URL;
      else process.env.OPENAI_COMPAT_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.OPENAI_COMPAT_API_KEY;
      else process.env.OPENAI_COMPAT_API_KEY = prevKey;
    });

    it('strips the openai: prefix and routes to the configured base URL, not anthropic', () => {
      process.env.OPENAI_COMPAT_BASE_URL = 'https://openrouter.ai/api/v1';
      const m = modelFor('grader', openaiCfg) as any;
      expect(m.modelId).toBe('foo/bar');
      expect(m.provider).not.toMatch(/anthropic/);
      expect(m.provider).toBe('openai-compatible.chat');
    });

    it('works without an api key — some proxies are keyless; a 401 belongs to the provider', () => {
      process.env.OPENAI_COMPAT_BASE_URL = 'https://openrouter.ai/api/v1';
      delete process.env.OPENAI_COMPAT_API_KEY;
      expect((modelFor('grader', openaiCfg) as any).modelId).toBe('foo/bar');
    });

    it('with no base URL, fails loudly naming OPENAI_COMPAT_BASE_URL — never defaults to localhost', () => {
      delete process.env.OPENAI_COMPAT_BASE_URL;
      expect(() => modelFor('grader', openaiCfg))
        .toThrow(/OPENAI_COMPAT_BASE_URL/);
      expect(() => modelFor('grader', openaiCfg))
        .toThrow(/openai:foo\/bar/);
    });

    it('reads the base URL per call, not at module load', () => {
      process.env.OPENAI_COMPAT_BASE_URL = 'https://openrouter.ai/api/v1';
      expect((modelFor('grader', openaiCfg) as any).modelId).toBe('foo/bar');
      delete process.env.OPENAI_COMPAT_BASE_URL;
      expect(() => modelFor('grader', openaiCfg)).toThrow(/OPENAI_COMPAT_BASE_URL/);
    });
  });
});
