// Booting with an engram that cannot start. The old boot threw on Engram.connect eighty lines
// before serve(), so the setup UI that explains exactly this failure never had a port to load
// from. These pin the degraded boot: the server binds anyway, setup answers, and everything that
// needed the client says why.
//
// index.ts is the process entry point, so — as in ankiTick.test.ts — every module with a boot-time
// side effect (spawn, port bind, network, disk outside the throwaway vault) is mocked out.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beforeAll, describe, expect, it, vi,
} from 'vitest';

const CONNECT_FAILURE = 'mcp transport closed: spawn node ENOENT';

// hoisted: the serve() mock factory runs before module-scope consts exist.
const boot = vi.hoisted(() => ({ served: null as { fetch: (req: Request) => Response | Promise<Response> } | null }));

vi.mock('@hono/node-server', () => ({
  serve: vi.fn((opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    boot.served = opts;
    return {};
  }),
}));
vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));
vi.mock('../src/server/credentials.js', () => ({
  applyCredentials: vi.fn(),
  credentialsPath: vi.fn(() => '/nonexistent/credentials.json'),
}));
vi.mock('../src/server/settings.js', () => ({ applySettings: vi.fn() }));
vi.mock('../src/server/setupRoutes.js', async () => {
  const { Hono } = await import('hono');
  const app = new Hono();
  app.get('/api/setup', (c) => c.json({ blocked: true }));
  return { buildSetupRoutes: vi.fn(() => app), needsApiKey: vi.fn(() => []) };
});
vi.mock('../src/server/staticRoutes.js', () => ({ buildStaticRoutes: vi.fn(() => ({ found: false })) }));
vi.mock('../src/server/mcp.js', () => ({
  Engram: { connect: vi.fn(async () => { throw new Error(CONNECT_FAILURE); }) },
}));
vi.mock('../src/server/restRoutes.js', async () => {
  const { Hono } = await import('hono');
  return { buildRestRoutes: vi.fn(() => new Hono()) };
});
vi.mock('../src/server/chatRoute.js', async () => {
  const { Hono } = await import('hono');
  return { buildChatRoute: vi.fn(() => new Hono()) };
});
vi.mock('../src/server/ingestRoutes.js', async () => {
  const { Hono } = await import('hono');
  return { buildIngestRoutes: vi.fn(() => new Hono()) };
});
vi.mock('../src/server/gap/service.js', async () => {
  const { Hono } = await import('hono');
  return { buildBuiltinGapRoutes: vi.fn(() => new Hono()) };
});
vi.mock('../src/server/gap/generateSeam.js', () => ({ compileGenerate: vi.fn(() => vi.fn()) }));
vi.mock('../src/server/gapHelp.js', async () => {
  const { Hono } = await import('hono');
  return { buildGapHelpRoute: vi.fn(() => new Hono()) };
});
vi.mock('../src/server/seedPatternPages.js', () => ({ seedPatternPages: vi.fn(async () => {}) }));
vi.mock('../src/server/scheduler.js', () => ({ startScheduler: vi.fn() }));
vi.mock('../src/server/anki/client.js', () => ({
  AnkiClient: class {
    isUp = vi.fn(async () => true);
  },
}));
vi.mock('../src/server/ingest.js', () => ({
  ensureCompileDrain: vi.fn(),
  sweepInterruptedConversions: vi.fn(),
}));
vi.mock('../src/server/notify.js', () => ({ sendNotification: vi.fn(async () => false) }));
vi.mock('../src/server/anki/inbound.js', () => ({
  syncInbound: vi.fn(async () => ({ recorded: 0 })),
  backlogDays: vi.fn(() => 0),
}));
vi.mock('../src/server/anki/outbound.js', () => ({
  ankiOutboundTick: vi.fn(async () => ({
    pushed: 0, updated: 0, skipped: 0, failed: 0,
  })),
}));

const scratchVault = mkdtempSync(join(tmpdir(), 'myelin-degraded-'));
vi.mock('../src/server/config.js', () => ({
  loadConfig: vi.fn(() => ({
    vault: scratchVault,
    port: 0,
    student: 'test-student',
    autoCompile: false,
    // The entry point does not exist either, so preflight composes its "how to fix this" text —
    // the degraded boot is supposed to forward that to the UI rather than only the terminal.
    engram: { command: 'node', args: ['/nonexistent/entry.js'] },
    schedule: { ankiSyncMinutes: 30, ankiBacklogNudgeDays: 3 },
    models: { compile: { model: 'test-model' } },
  })),
  configSource: vi.fn(() => ({ path: '/nonexistent/harness.config.json', found: false })),
}));

const get = (path: string) => boot.served!.fetch(new Request(`http://127.0.0.1${path}`));

describe('boot with an engram that cannot start', () => {
  beforeAll(async () => {
    await import('../src/server/index.js');
  });

  it('still binds the server — the throw used to happen before serve() was ever reached', () => {
    expect(boot.served).not.toBeNull();
  });

  it('serves setup, which is the only surface that can explain the failure', async () => {
    const res = await get('/api/setup');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ blocked: true });
  });

  it('reports the failure verbatim, with preflight\'s fix, at /api/engram', async () => {
    const res = await get('/api/engram');
    expect(res.status).toBe(200); // a status probe the client cannot read is no better than a log line
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain(CONNECT_FAILURE);
    expect(body.error).toContain('ENGRAM_ENTRY');
  });

  it('answers 503 carrying the same message on a route that needed the client', async () => {
    const res = await boot.served!.fetch(new Request('http://127.0.0.1/api/chat', { method: 'POST' }));
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toContain(CONNECT_FAILURE);
  });

  it('never mounted a route holding a null client', async () => {
    const { buildRestRoutes } = await import('../src/server/restRoutes.js');
    const { buildChatRoute } = await import('../src/server/chatRoute.js');
    expect(buildRestRoutes).not.toHaveBeenCalled();
    expect(buildChatRoute).not.toHaveBeenCalled();
  });
});
