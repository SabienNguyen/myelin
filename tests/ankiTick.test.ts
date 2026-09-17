import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';

// index.ts is the process entry point: importing it for real would spawn Engram and bind a
// port, which this suite must never do (a real harness may be running on the default port).
// Every module with a side effect at boot time — process spawn, port bind, network, disk outside
// the throwaway vault below — is mocked out so `import('../src/server/index.js')` is inert except
// for the one exported function this test drives.
const calls: string[] = [];

vi.mock('@hono/node-server', () => ({ serve: vi.fn() }));
vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));
vi.mock('../src/server/credentials.js', () => ({
  applyCredentials: vi.fn(),
  credentialsPath: vi.fn(() => '/nonexistent/credentials.json'),
}));
vi.mock('../src/server/settings.js', () => ({ applySettings: vi.fn() }));
vi.mock('../src/server/setupRoutes.js', async () => {
  const { Hono } = await import('hono');
  return { buildSetupRoutes: vi.fn(() => new Hono()), needsApiKey: vi.fn(() => []) };
});
vi.mock('../src/server/staticRoutes.js', () => ({ buildStaticRoutes: vi.fn(() => ({ found: false })) }));
vi.mock('../src/server/mcp.js', () => ({
  Engram: { connect: vi.fn(async () => ({})) },
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
  syncInbound: vi.fn(async () => {
    calls.push('inbound');
    return { recorded: 0 };
  }),
  backlogDays: vi.fn(() => 0),
}));
vi.mock('../src/server/anki/outbound.js', () => ({
  ankiOutboundTick: vi.fn(async () => {
    calls.push('outbound');
    return {
      pushed: 0, updated: 0, skipped: 0, failed: 0,
    };
  }),
}));

const scratchVault = mkdtempSync(join(tmpdir(), 'myelin-ankitick-'));
vi.mock('../src/server/config.js', () => ({
  loadConfig: vi.fn(() => ({
    vault: scratchVault,
    port: 0,
    student: 'test-student',
    autoCompile: false,
    engram: { command: 'node', args: ['/nonexistent/entry.js'] },
    schedule: { ankiSyncMinutes: 30, ankiBacklogNudgeDays: 3 },
    models: { compile: { model: 'test-model' } },
  })),
  configSource: vi.fn(() => ({ path: '/nonexistent/harness.config.json', found: false })),
}));

describe('runAnkiTick', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs the inbound sync then the outbound sync, in order', async () => {
    const { runAnkiTick } = await import('../src/server/index.js');
    // Importing index.ts also fires its own boot-time `runAnkiTick(...).catch(console.error)`
    // (not awaited by the module, so not awaited by this import either) — let that settle before
    // clearing the shared call log, so it can't interleave with the call this test drives below.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    calls.length = 0;

    const fakeLw = {} as never;
    const fakeAnki = { isUp: async () => true } as never;
    const fakeCfg = { vault: scratchVault, schedule: { ankiBacklogNudgeDays: 3 } } as never;

    await runAnkiTick(fakeLw, fakeAnki, fakeCfg);

    expect(calls).toEqual(['inbound', 'outbound']);
  });
});
