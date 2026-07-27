// The FirstRun routes over real HTTP — the file where the stranded-signin bug lived, previously
// tested only at the applyRoute unit level. Credentials redirect to a temp dir via
// XDG_CONFIG_HOME; the `claude` CLI and the Anthropic key probe are injected fakes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSetupRoutes } from '../src/server/setupRoutes.js';
import type { HarnessConfig } from '../src/server/config.js';

const loggedIn = async () => ({ cliFound: true, cliVersion: '2.0 (test)', loggedIn: true, email: 'e@x.test' });
const notSignedIn = async () => ({ cliFound: true, cliVersion: '2.0 (test)', loggedIn: false });
const noCli = async () => ({ cliFound: false, loggedIn: false });

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
    const app = buildSetupRoutes(cfgWith(plainModels()), { subscription: notSignedIn });
    const state = await (await app.request('/api/setup')).json();
    expect(state.blocked).toBe(true);
    expect(state.apiKey.rolesNeeding).toEqual(['tutor', 'grader', 'quiz_gen', 'card_gen', 'compile']);
    expect(state.apiKey.present).toBe(false);
  });

  it('a config already on claude-sdk everywhere is ready without any key', async () => {
    const models = Object.fromEntries(
      Object.keys(plainModels()).map((r) => [r, { model: 'claude-sdk:sonnet' }]),
    );
    const app = buildSetupRoutes(cfgWith(models), { subscription: notSignedIn });
    const state = await (await app.request('/api/setup')).json();
    expect(state.blocked).toBe(false);
    expect(state.apiKey.rolesNeeding).toEqual([]);
  });
});

describe('PUT /api/setup/subscription', () => {
  const put = (app: ReturnType<typeof buildSetupRoutes>) =>
    app.request('/api/setup/subscription', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });

  it('one click unblocks: models ride the login, the route persists, blocked clears', async () => {
    const cfg = cfgWith(plainModels());
    const app = buildSetupRoutes(cfg, { subscription: loggedIn });
    const res = await put(app);
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.blocked).toBe(false);
    expect(state.route).toBe('subscription');
    expect(cfg.models.tutor.model).toBe('claude-sdk:sonnet');
    // Persisted for the next boot, beside the key, not in the project config.
    const stored = JSON.parse(readFileSync(join(confDir, 'loreweaver', 'credentials.json'), 'utf8'));
    expect(stored.route).toBe('subscription');
  });

  it('installed but not signed in: a 400 that says to run `claude` once', async () => {
    const res = await put(buildSetupRoutes(cfgWith(plainModels()), { subscription: notSignedIn }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not signed in.*Run `claude`/s);
  });

  it('no CLI at all: a 400 that offers the API-key path', async () => {
    const res = await put(buildSetupRoutes(cfgWith(plainModels()), { subscription: noCli }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No `claude` command.*API key/s);
  });
});

describe('PUT /api/setup/api-key', () => {
  const put = (app: ReturnType<typeof buildSetupRoutes>, key: string) =>
    app.request('/api/setup/api-key', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
    });
  const REAL_SHAPE = `sk-ant-${'a'.repeat(60)}`;

  it('a probe-approved key saves, enters the environment, and unblocks', async () => {
    const probeFetch = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    const app = buildSetupRoutes(cfgWith(plainModels()), { subscription: notSignedIn, probeFetch });
    const res = await put(app, REAL_SHAPE);
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.blocked).toBe(false);
    expect(state.apiKey.present).toBe(true);
    expect(process.env.ANTHROPIC_API_KEY).toBe(REAL_SHAPE);
    const stored = JSON.parse(readFileSync(join(confDir, 'loreweaver', 'credentials.json'), 'utf8'));
    expect(stored.anthropicApiKey).toBe(REAL_SHAPE);
    // The probe carried the pasted key, not whatever the process had.
    expect(probeFetch.mock.calls[0][1]?.headers).toMatchObject({ 'x-api-key': REAL_SHAPE });
  });

  it('a key Anthropic rejects is never saved', async () => {
    const probeFetch = async () => ({ ok: false, status: 401 }) as Response;
    const app = buildSetupRoutes(cfgWith(plainModels()), { subscription: notSignedIn, probeFetch });
    const res = await put(app, REAL_SHAPE);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Anthropic rejected/);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('a truncated sk-ant- paste gets the truncation sentence, not "wrong prefix"', async () => {
    const app = buildSetupRoutes(cfgWith(plainModels()), { subscription: notSignedIn });
    const res = await put(app, 'sk-ant-tooshort');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/truncated/);
  });

  it('a non-Anthropic-shaped paste names the expected prefix', async () => {
    const app = buildSetupRoutes(cfgWith(plainModels()), { subscription: notSignedIn });
    const res = await put(app, 'hunter2');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sk-ant-/);
  });

  it('an unreachable probe is a could-not-check error, not a saved key', async () => {
    const probeFetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    const app = buildSetupRoutes(cfgWith(plainModels()), { subscription: notSignedIn, probeFetch: probeFetch as any });
    const res = await put(app, REAL_SHAPE);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Could not reach Anthropic/);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
