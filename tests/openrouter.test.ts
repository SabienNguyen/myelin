import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatModelFor } from '../src/server/models.js';
import { buildSetupRoutes } from '../src/server/setupRoutes.js';
import { readSettings, resetEnvShadow, writeSettings } from '../src/server/settings.js';

let dir: string;
const cfg = () => ({ vault: dir, student: 'test', models: Object.fromEntries(
  ['tutor', 'grader', 'quiz_gen', 'card_gen', 'compile'].map(r => [r, { model: 'openrouter:openrouter/free' }]),
) }) as any;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myelin-router-'));
  vi.stubEnv('MYELIN_CONFIG_DIR', dir);
  vi.stubEnv('LW_MOCK_MODEL', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  resetEnvShadow();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetEnvShadow(); rmSync(dir, {recursive:true,force:true}); });

describe('OpenRouter', () => {
  it('rejects unknown catalog ids before writing any settings or live state', async () => {
    const config = cfg();
    const original = structuredClone(config.models);
    const probeFetch = vi.fn(async () => Response.json({ data: [{ id: 'openrouter/free' }] }));
    const res = await buildSetupRoutes(config, { probeFetch }).request('/api/setup/models', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: { tutor: 'openrouter:invented/model' },
        env: { OPENROUTER_API_KEY: 'do-not-save' } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/tutor.*invented\/model.*catalog/i);
    expect(readSettings()).toEqual({});
    expect(config.models).toEqual(original);
    expect(process.env.OPENROUTER_API_KEY).toBe('');
  });
  it.each(['network', 'http', 'malformed'])('fails closed on %s catalog failures', async (failure) => {
    const config = cfg();
    const probeFetch = vi.fn(async () => {
      if (failure === 'network') throw new Error('offline');
      if (failure === 'http') return new Response('', { status: 503 });
      return Response.json({ unexpected: [] });
    });
    const res = await buildSetupRoutes(config, { probeFetch }).request('/api/setup/models', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: { tutor: 'openrouter:some/model' } }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/catalog.*not saved.*retry/i);
    expect(readSettings()).toEqual({});
    expect(config.models.tutor.model).toBe('openrouter:openrouter/free');
  });
  it('validates exact ids against the full public catalog once, without credentials or impersonation', async () => {
    const config = cfg();
    const probeFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ data: [{ id: 'vendor/paid' }, { id: 'vendor/inkling:free' }] }));
    const res = await buildSetupRoutes(config, { probeFetch }).request('/api/setup/models', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: { tutor: ' openrouter:vendor/inkling:free ', grader: 'openrouter:vendor/paid' },
        env: { OPENROUTER_API_KEY: 'test-router-key' } }),
    });
    expect(res.status).toBe(200);
    expect(config.models.tutor.model).toBe('openrouter:vendor/inkling:free');
    expect(config.models.grader.model).toBe('openrouter:vendor/paid');
    expect(probeFetch).toHaveBeenCalledTimes(1);
    expect(probeFetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models');
    expect(probeFetch.mock.calls[0][1]?.headers).toBeUndefined();
    expect(await res.text()).not.toContain('test-router-key');
  });
  it('sends the exact selected model and dedicated key to the pinned endpoint', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-router-key');
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ choices: [{message:{content:'hello'},finish_reason:'stop'}] }));
    vi.stubGlobal('fetch', f);
    await chatModelFor('tutor', cfg()).generate({ messages: [] });
    expect(f.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const init = (f.mock.calls as any)[0][1];
    expect(init.headers.authorization).toBe('Bearer test-router-key');
    expect(JSON.parse(init.body).model).toBe('openrouter/free');
  });
  it('does not ask for Anthropic credentials and blocks a missing OpenRouter key', async () => {
    const state = await (await buildSetupRoutes(cfg()).request('/api/setup')).json();
    expect(state.apiKey.rolesNeeding).toEqual([]);
    expect(state.openrouter.required).toBe(true);
    expect(state.blocked).toBe(true);
  });
  it('saves a dedicated key without reflecting the secret in any response', async () => {
    const app = buildSetupRoutes(cfg());
    const res = await app.request('/api/setup/models', {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({env:{OPENROUTER_API_KEY:'test-router-key'}})});
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('test-router-key');
    expect(JSON.parse(text).env.OPENROUTER_API_KEY.set).toBe(true);
    expect((await (await app.request('/api/setup')).json()).blocked).toBe(false);
  });
  it('lists only zero-priced tool-capable free models; paid and missing prices never qualify', async () => {
    const row = (id: string, price: unknown, tools = true) => ({id,pricing:price,supported_parameters:tools?['tools']:[]});
    const probeFetch = vi.fn(async () => Response.json({data:[
      row('test/free:free',{prompt:'0',completion:'0'}),
      row('test/paid:free',{prompt:'0.01',completion:'0'}),
      row('test/missing:free',{}),row('test/no-tools:free',{prompt:'0',completion:'0'},false),
    ]}));
    const res = await buildSetupRoutes(cfg(), {probeFetch}).request('/api/setup/openrouter/models');
    expect(res.status).toBe(200);
    expect((await res.json()).models.map((m:any)=>m.id)).toEqual(['test/free:free']);
  });
});
