import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatModelFor, modelRouteFor } from '../src/server/models.js';
import { buildSetupRoutes } from '../src/server/setupRoutes.js';
import { readSettings, resetEnvShadow } from '../src/server/settings.js';

let dir: string;
const cfg = (model = 'groq:openai/gpt-oss-120b') => ({ vault: dir, student: 'test', models: Object.fromEntries(
  ['tutor', 'grader', 'quiz_gen', 'card_gen', 'compile'].map((r) => [r, { model }]),
) }) as any;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myelin-groq-'));
  vi.stubEnv('MYELIN_CONFIG_DIR', dir);
  vi.stubEnv('LW_MOCK_MODEL', '');
  vi.stubEnv('GROQ_API_KEY', '');
  vi.stubEnv('OPENAI_COMPAT_BASE_URL', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  resetEnvShadow();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetEnvShadow(); rmSync(dir, { recursive: true, force: true }); });

const put = (config: any, body: object) => buildSetupRoutes(config).request('/api/setup/models', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('groq: route', () => {
  it('is its own route, and a Groq model id keeps its vendor slash', () => {
    expect(modelRouteFor('groq:openai/gpt-oss-120b')).toBe('groq');
    expect(modelRouteFor('groq:llama-3.3-70b-versatile')).toBe('groq');
  });

  // The point of a first-class route: Groq used to ride openai: + OPENAI_COMPAT_BASE_URL, which
  // took the ONE custom-endpoint slot — so Groq and a LiteLLM proxy could not both be configured.
  it('sends to Groq\'s pinned endpoint with GROQ_API_KEY, needing no compat base URL', async () => {
    vi.stubEnv('GROQ_API_KEY', 'gsk-test');
    const seen: { url: string; auth: string | null; model: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push({
        url: String(url), auth: new Headers(init.headers).get('authorization'),
        model: JSON.parse(String(init.body)).model,
      });
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} });
    }));
    const model = chatModelFor('grader', cfg());
    await model.generate({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as any);
    expect(seen[0]).toEqual({
      url: 'https://api.groq.com/openai/v1/chat/completions', auth: 'Bearer gsk-test', model: 'openai/gpt-oss-120b',
    });
  });

  it('blocks first run until a Groq key exists, and says Groq is what is missing', async () => {
    const before = await (await buildSetupRoutes(cfg()).request('/api/setup')).json() as any;
    expect(before.blocked).toBe(true);
    expect(before.groq).toEqual({ required: true, present: false });
    vi.stubEnv('GROQ_API_KEY', 'gsk-test');
    const after = await (await buildSetupRoutes(cfg()).request('/api/setup')).json() as any;
    expect(after.blocked).toBe(false);
  });

  it('refuses to save a groq: role with no key anywhere — it would fail mid-lesson instead', async () => {
    const config = cfg('claude-sonnet-5');
    const res = await put(config, { models: { tutor: 'groq:openai/gpt-oss-120b' } });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/groq api key/i);
    expect(config.models.tutor.model).toBe('claude-sonnet-5');
  });

  it('saves a groq: role together with its key; the key never comes back in a response', async () => {
    const config = cfg('claude-sonnet-5');
    const res = await put(config, { models: { tutor: 'groq:openai/gpt-oss-120b' }, env: { GROQ_API_KEY: 'gsk-secret' } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('gsk-secret');
    expect(JSON.parse(body).env.GROQ_API_KEY).toEqual({ set: true, shadowed: false });
    expect(config.models.tutor.model).toBe('groq:openai/gpt-oss-120b');
    expect(readSettings().env?.GROQ_API_KEY).toBe('gsk-secret');
    expect(process.env.GROQ_API_KEY).toBe('gsk-secret');
  });
});
