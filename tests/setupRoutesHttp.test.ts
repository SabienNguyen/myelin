// The FirstRun routes over real HTTP. Credentials redirect to a temp dir via XDG_CONFIG_HOME; the
// Anthropic key probe is an injected fake.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSetupRoutes } from '../src/server/setupRoutes.js';
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
