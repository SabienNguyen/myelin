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

  describe('model discovery on GET', () => {
    it('lists Ollama tags and openai-compat ids, with the compat key as a bearer header', async () => {
      process.env.OLLAMA_BASE_URL = 'http://ollama.test/v1';
      process.env.OPENAI_COMPAT_BASE_URL = 'http://compat.test/v1';
      process.env.OPENAI_COMPAT_API_KEY = 'sk-proxy';
      const probeFetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
        const u = String(args[0]);
        if (u === 'http://ollama.test/api/tags') {
          return { ok: true, json: async () => ({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.1:8b' }] }) };
        }
        if (u === 'http://compat.test/v1/models') {
          return { ok: true, json: async () => ({ data: [{ id: 'mistralai/mistral-7b' }] }) };
        }
        throw new Error(`unexpected probe: ${u}`);
      });
      const app = buildSetupRoutes(cfgWith(plainModels()), { probeFetch: probeFetch as unknown as typeof fetch });
      const state = await (await app.request('/api/setup/models')).json();
      expect(state.available).toEqual({
        ollama: ['qwen3:8b', 'llama3.1:8b'],
        openaiCompat: ['mistralai/mistral-7b'],
      });
      const compatCall = probeFetch.mock.calls.find(([u]) => String(u).includes('/models'));
      expect(compatCall?.[1]?.headers).toEqual({ authorization: 'Bearer sk-proxy' });
    });

    it('unreachable endpoints yield absent fields, never an error — the dialog opens offline', async () => {
      process.env.OPENAI_COMPAT_BASE_URL = 'http://compat.test/v1';
      const probeFetch = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
      const app = buildSetupRoutes(cfgWith(plainModels()), { probeFetch: probeFetch as unknown as typeof fetch });
      const res = await app.request('/api/setup/models');
      expect(res.status).toBe(200);
      expect((await res.json()).available).toEqual({});
    });

    it('no OPENAI_COMPAT_BASE_URL means no compat probe at all', async () => {
      process.env.OLLAMA_BASE_URL = 'http://ollama.test/v1';
      const probeFetch = vi.fn(async (..._args: Parameters<typeof fetch>) => ({ ok: true, json: async () => ({ models: [] }) }));
      const app = buildSetupRoutes(cfgWith(plainModels()), { probeFetch: probeFetch as unknown as typeof fetch });
      const state = await (await app.request('/api/setup/models')).json();
      // Reachable but empty is the same as absent: nothing worth a line in the dialog.
      expect(state.available).toEqual({});
      expect(probeFetch).toHaveBeenCalledTimes(1);
      expect(String(probeFetch.mock.calls[0][0])).toBe('http://ollama.test/api/tags');
    });
  });
});

describe('POST /api/setup/models/pull — choose a model, we install it', () => {
  const ndjson = (lines: object[]) => new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
      controller.close();
    },
  });

  it('proxies Ollama /api/pull with {name,stream} and relays its NDJSON body verbatim', async () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama.test/v1';
    const body = ndjson([
      { status: 'pulling manifest' },
      { status: 'downloading', total: 100, completed: 40 },
      { status: 'success' },
    ]);
    const probeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://ollama.test/api/pull'); // root, not the /v1 compat prefix
      expect(JSON.parse(String(init?.body))).toEqual({ name: 'qwen3:8b', stream: true });
      return { ok: true, body, status: 200 };
    });
    const app = buildSetupRoutes(cfgWith(plainModels()), { probeFetch: probeFetch as unknown as typeof fetch });
    const res = await app.request('/api/setup/models/pull', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:8b' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    const text = await res.text();
    expect(text).toContain('"status":"downloading"');
    expect(text).toContain('"completed":40');
    expect(text.trim().split('\n')).toHaveLength(3); // passed through line-for-line
  });

  it('a missing model name is a 400', async () => {
    const app400 = buildSetupRoutes(cfgWith(plainModels()));
    expect((await app400.request('/api/setup/models/pull', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).status).toBe(400);
  });

  // This replaced a test asserting that ANY unreachable Ollama returns "install it from
  // ollama.com". That was the bug, pinned: it sent someone whose daemon was merely stopped off to
  // download software they already had. The 502 now carries which of the three it was, and the
  // client renders a different next step for each.
  const pullWith = async (detect: any, code = 'ECONNREFUSED') => {
    const app = buildSetupRoutes(cfgWith(plainModels()), {
      probeFetch: (async () => { throw Object.assign(new Error('fetch failed'), { cause: { code } }); }) as unknown as typeof fetch,
      detect,
    });
    const res = await app.request('/api/setup/models/pull', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b' }),
    });
    return { status: res.status, body: await res.json() as { error: string; reason: string; ollama: { state: string } } };
  };

  it('reports a missing Ollama as not-installed, with the install hint attached', async () => {
    const { status, body } = await pullWith(async () => ({
      state: 'absent', root: 'http://localhost:11434',
      install: { platform: 'linux', url: 'https://ollama.com/download/linux', command: 'curl -fsSL https://ollama.com/install.sh | sh' },
    }));
    expect(status).toBe(502);
    expect(body.reason).toBe('not-installed');
    // The client needs the hint to render a link; the prose alone can't be clicked.
    expect(body.ollama).toMatchObject({ state: 'absent', install: { platform: 'linux' } });
  });

  it('reports an installed-but-stopped Ollama as not-running, and does not say to install it', async () => {
    const { status, body } = await pullWith(async () => ({
      state: 'stopped', root: 'http://localhost:11434', binary: '/usr/local/bin/ollama',
    }));
    expect(status).toBe(502);
    expect(body.reason).toBe('not-running');
    expect(body.error).not.toMatch(/ollama\.com|install it/i);
  });

  it('blames the network, not the install, when a live daemon times out', async () => {
    const running = async () => ({ state: 'running', root: 'http://localhost:11434' });
    // A timeout against a daemon that just answered /api/tags is a firewall or proxy story.
    expect((await pullWith(running, 'ETIMEDOUT')).body.reason).toBe('unreachable');
    // A refusal from that same daemon means it died between the probe and the pull — asking the
    // learner to start it is the useful advice, not "check your network".
    expect((await pullWith(running, 'ECONNREFUSED')).body.reason).toBe('not-running');
  });

  it('GET /api/setup/ollama answers with the detected state', async () => {
    const app = buildSetupRoutes(cfgWith(plainModels()), {
      detect: (async () => ({ state: 'running', root: 'http://localhost:11434' })) as any,
    });
    const res = await app.request('/api/setup/ollama');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'running' });
  });

  it('refuses to start a daemon that is not installed, instead of spawning nothing', async () => {
    const startOllama = vi.fn();
    const app = buildSetupRoutes(cfgWith(plainModels()), {
      detect: (async () => ({ state: 'absent', root: 'http://localhost:11434', install: { platform: 'linux', url: 'x' } })) as any,
      startOllama,
    });
    const res = await app.request('/api/setup/ollama/start', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(startOllama).not.toHaveBeenCalled();
  });

  it('starts a stopped daemon and reports it running once it binds', async () => {
    const startOllama = vi.fn();
    let up = false;
    const app = buildSetupRoutes(cfgWith(plainModels()), {
      detect: (async () => (up
        ? { state: 'running', root: 'http://localhost:11434' }
        : { state: 'stopped', root: 'http://localhost:11434', binary: '/usr/local/bin/ollama' })) as any,
      startOllama: (b: string) => { startOllama(b); up = true; },
    });
    const res = await app.request('/api/setup/ollama/start', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'running' });
    // Only ever the binary we located — never a name off the request body.
    expect(startOllama).toHaveBeenCalledWith('/usr/local/bin/ollama');
  });
});
