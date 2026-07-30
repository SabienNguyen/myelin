// The FirstRun routes over real HTTP. Credentials redirect to a temp dir via XDG_CONFIG_HOME; the
// Anthropic key probe is an injected fake.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSetupRoutes } from '../src/server/setupRoutes.js';
import { chatModelFor } from '../src/server/models.js';
import { PROVIDER_ENV_KEYS, readSettings, resetEnvShadow } from '../src/server/settings.js';
import type { HarnessConfig } from '../src/server/config.js';

const plainModels = () => ({
  tutor: { model: 'claude-sonnet-5' }, grader: { model: 'claude-haiku-4-5' },
  quiz_gen: { model: 'claude-sonnet-5' }, card_gen: { model: 'claude-haiku-4-5' },
  compile: { model: 'claude-sonnet-5' },
});

let confDir: string;
let savedKey: string | undefined;
beforeEach(() => {
  confDir = mkdtempSync(join(tmpdir(), 'lwh-setup-'));
  vi.stubEnv('XDG_CONFIG_HOME', confDir);
  vi.stubEnv('LW_MOCK_MODEL', '');
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  rmSync(confDir, { recursive: true, force: true });
});

const cfgWith = (models: Record<string, { model: string }>) =>
  ({ vault: confDir, student: 'kid', models } as unknown as HarnessConfig);

describe('GET /api/setup', () => {
  it('plain Anthropic models with no key anywhere: blocked, naming every role', async () => {
    const app = buildSetupRoutes(cfgWith(plainModels()));
    const state = await (await app.request('/api/setup')).json();
    expect(state.blocked).toBe(true);
    expect(state.apiKey.rolesNeeding).toEqual(['tutor', 'grader', 'quiz_gen', 'card_gen', 'compile']);
    expect(state.apiKey.present).toBe(false);
  });

  it('a fully ollama: config is ready without any key', async () => {
    const models = Object.fromEntries(
      Object.keys(plainModels()).map((r) => [r, { model: 'ollama:qwen' }]),
    );
    const app = buildSetupRoutes(cfgWith(models));
    const state = await (await app.request('/api/setup')).json();
    expect(state.blocked).toBe(false);
    expect(state.apiKey.rolesNeeding).toEqual([]);
  });
});

describe('PUT /api/setup/api-key', () => {
  const put = (app: ReturnType<typeof buildSetupRoutes>, key: string) =>
    app.request('/api/setup/api-key', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
    });
  const REAL_SHAPE = `sk-ant-${'a'.repeat(60)}`;

  it('a probe-approved key saves, enters the environment, and unblocks', async () => {
    const probeFetch = vi.fn(async (..._args: Parameters<typeof fetch>) => ({ ok: true, status: 200 }) as Response);
    const app = buildSetupRoutes(cfgWith(plainModels()), { probeFetch });
    const res = await put(app, REAL_SHAPE);
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.blocked).toBe(false);
    expect(state.apiKey.present).toBe(true);
    expect(process.env.ANTHROPIC_API_KEY).toBe(REAL_SHAPE);
    const stored = JSON.parse(readFileSync(join(confDir, 'myelin', 'credentials.json'), 'utf8'));
    expect(stored.anthropicApiKey).toBe(REAL_SHAPE);
    // The probe carried the pasted key, not whatever the process had.
    expect(probeFetch.mock.calls[0][1]?.headers).toMatchObject({ 'x-api-key': REAL_SHAPE });
  });

  it('a key Anthropic rejects is never saved', async () => {
    const probeFetch = async () => ({ ok: false, status: 401 }) as Response;
    const app = buildSetupRoutes(cfgWith(plainModels()), { probeFetch });
    const res = await put(app, REAL_SHAPE);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Anthropic rejected/);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('a truncated sk-ant- paste gets the truncation sentence, not "wrong prefix"', async () => {
    const app = buildSetupRoutes(cfgWith(plainModels()));
    const res = await put(app, 'sk-ant-tooshort');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/truncated/);
  });

  it('a non-Anthropic-shaped paste names the expected prefix', async () => {
    const app = buildSetupRoutes(cfgWith(plainModels()));
    const res = await put(app, 'hunter2');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sk-ant-/);
  });

  it('an unreachable probe is a could-not-check error, not a saved key', async () => {
    const probeFetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    const app = buildSetupRoutes(cfgWith(plainModels()), { probeFetch: probeFetch as any });
    const res = await put(app, REAL_SHAPE);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Could not reach Anthropic/);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('GET/PUT /api/setup/models', () => {
  // applyEnvValues writes the provider vars into the real process.env, and envShadow snapshots it
  // lazily — both need a clean slate per test and restoration after.
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedEnv = {};
    for (const k of PROVIDER_ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    resetEnvShadow();
  });
  afterEach(() => {
    for (const k of PROVIDER_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetEnvShadow();
  });

  const put = (app: ReturnType<typeof buildSetupRoutes>, body: unknown) =>
    app.request('/api/setup/models', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

  it('GET reports per-role effective ids and where saves land', async () => {
    const app = buildSetupRoutes(cfgWith(plainModels()));
    const state = await (await app.request('/api/setup/models')).json();
    expect(Object.keys(state.roles)).toEqual(['tutor', 'grader', 'quiz_gen', 'card_gen', 'compile']);
    expect(state.roles.grader).toEqual({ effective: 'claude-haiku-4-5', saved: null });
    expect(state.savedAt).toContain('settings.json');
  });

  it('an unknown role is a 400 naming the known ones; an empty id is a 400 too', async () => {
    const app = buildSetupRoutes(cfgWith(plainModels()));
    const bad = await put(app, { models: { paint_mixer: 'claude-haiku-4-5' } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/unknown model role: "paint_mixer".*tutor, grader/);
    const empty = await put(app, { models: { grader: '   ' } });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toMatch(/model for grader is empty/);
  });

  it('a claude-sdk: id is refused with the removed-route message, and nothing is saved', async () => {
    const cfg = cfgWith(plainModels());
    const app = buildSetupRoutes(cfg);
    const res = await put(app, { models: { tutor: 'claude-sdk:opus' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error)
      .toMatch(/claude-sdk:' has been removed.*tutor: "claude-sdk:opus"/s);
    expect(cfg.models.tutor.model).toBe('claude-sonnet-5');
    expect(readSettings()).toEqual({});
  });

  it('an openai: role with no base URL anywhere is refused; one in the same request saves', async () => {
    const cfg = cfgWith(plainModels());
    const app = buildSetupRoutes(cfg);
    const bare = await put(app, { models: { grader: 'openai:test/model' } });
    expect(bare.status).toBe(400);
    expect((await bare.json()).error).toMatch(/openai:test\/model.*base URL/);
    expect(cfg.models.grader.model).toBe('claude-haiku-4-5'); // the refused save changed nothing

    const ok = await put(app, {
      models: { grader: 'openai:test/model' },
      env: { OPENAI_COMPAT_BASE_URL: 'https://x.example/v1' },
    });
    expect(ok.status).toBe(200);
    const state = await ok.json();
    expect(state.roles.grader).toEqual({ effective: 'openai:test/model', saved: 'openai:test/model' });
    expect(state.env.OPENAI_COMPAT_BASE_URL).toEqual({ value: 'https://x.example/v1', shadowed: false });
    // Persisted, and live in the environment models.ts reads per call.
    expect(readSettings().models?.grader).toBe('openai:test/model');
    expect(process.env.OPENAI_COMPAT_BASE_URL).toBe('https://x.example/v1');
  });

  it('a save is live: chatModelFor serves the new id from the same cfg object, no reconstruction', async () => {
    // chatModelFor is opaque ({generate, stream} — no modelId to read), so liveness is pinned by
    // its one id-revealing observable: an openai: id with no base URL fails loudly NAMING the id.
    // Before the save, grader resolves as a plain Anthropic model; after it, the same cfg object
    // must resolve — and, with the base URL deleted again, fail naming — the NEW id.
    const cfg = cfgWith(plainModels());
    const app = buildSetupRoutes(cfg);
    expect(typeof chatModelFor('grader', cfg).generate).toBe('function');
    await put(app, {
      models: { grader: 'openai:test/model' },
      env: { OPENAI_COMPAT_BASE_URL: 'https://x.example/v1' },
    });
    expect(typeof chatModelFor('grader', cfg).generate).toBe('function');
    delete process.env.OPENAI_COMPAT_BASE_URL;
    expect(() => chatModelFor('grader', cfg)).toThrow(/openai:test\/model/);
  });

  it('saved API keys come back as set:true, never as the value', async () => {
    const app = buildSetupRoutes(cfgWith(plainModels()));
    const res = await put(app, { env: { OPENAI_COMPAT_API_KEY: 'sk-or-supersecret-123' } });
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.env.OPENAI_COMPAT_API_KEY).toEqual({ set: true, shadowed: false });
    expect(JSON.stringify(state)).not.toContain('supersecret');
    const again = await (await app.request('/api/setup/models')).json();
    expect(again.env.OPENAI_COMPAT_API_KEY.set).toBe(true);
    expect(JSON.stringify(again)).not.toContain('supersecret');
    // The key itself lives only in settings.json.
    expect(readSettings().env?.OPENAI_COMPAT_API_KEY).toBe('sk-or-supersecret-123');
  });

  it('a real environment variable shadows the saved value: reported, and never overwritten', async () => {
    process.env.OLLAMA_BASE_URL = 'http://real:9/v1'; // present before first capture = a real var
    const app = buildSetupRoutes(cfgWith(plainModels()));
    const state = await (await app.request('/api/setup/models')).json();
    expect(state.env.OLLAMA_BASE_URL.shadowed).toBe(true);
    const res = await put(app, { env: { OLLAMA_BASE_URL: 'http://saved:1/v1' } });
    const after = await res.json();
    expect(process.env.OLLAMA_BASE_URL).toBe('http://real:9/v1'); // the real var kept winning
    expect(readSettings().env?.OLLAMA_BASE_URL).toBe('http://saved:1/v1'); // intent persisted
    expect(after.env.OLLAMA_BASE_URL).toEqual({ value: 'http://saved:1/v1', shadowed: true });
  });

  it('an unknown env field is a 400 naming the four real ones', async () => {
    const app = buildSetupRoutes(cfgWith(plainModels()));
    const res = await put(app, { env: { PATH: '/tmp' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown env field: "PATH".*OLLAMA_BASE_URL/);
  });
});
