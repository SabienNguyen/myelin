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
});
