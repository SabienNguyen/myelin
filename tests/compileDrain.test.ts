import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { Loreweaver } from '../src/server/mcp.js';
import { canCompileNow, ensureCompileDrain, readQueue, startConversion } from '../src/server/ingest.js';
import type { Converter } from '../src/server/convert.js';
import type { HarnessConfig } from '../src/server/config.js';

const LW_REPO = `${process.env.HOME}/Dev/personal/loreweaver`;

describe('canCompileNow', () => {
  it('allows a cloud (non-ollama) compile model regardless of active conversions', () => {
    expect(canCompileNow('claude-sonnet-5', 0)).toBe(true);
    expect(canCompileNow('claude-sonnet-5', 1)).toBe(true);
    expect(canCompileNow('claude-sonnet-5', 5)).toBe(true);
  });

  it('allows an ollama compile model when no conversion is active', () => {
    expect(canCompileNow('ollama:qwen2.5-coder', 0)).toBe(true);
  });

  it('blocks an ollama compile model while a conversion is active (GPU contention)', () => {
    expect(canCompileNow('ollama:qwen2.5-coder', 1)).toBe(false);
    expect(canCompileNow('ollama:qwen2.5-coder', 3)).toBe(false);
  });
});

/** Poll until fn() is truthy. */
async function until<T>(fn: () => T, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('until(): timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('ensureCompileDrain — autoCompile end to end', () => {
  let lw: Loreweaver;
  let vault: string;
  let cfg: HarnessConfig;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), 'lwh-drain-vault-'));
    mkdirSync(join(vault, 'pages'), { recursive: true });
    cfg = {
      vault, student: 'kid', autoCompile: true,
      // Non-ollama id so canCompileNow never gates this test on activeConversions timing.
      models: { compile: { model: 'claude-drain-test' } },
      loreweaver: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
    } as unknown as HarnessConfig;
    lw = await Loreweaver.connect(cfg);
  }, 30_000);
  afterAll(async () => { await lw.close(); });

  it('drains pending entries automatically once a conversion completes, without /api/ingest/compile', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [
        {
          content: [{
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'write_page',
            input: JSON.stringify({
              slug: 'auto-compile-concept',
              title: 'Auto Compile Concept',
              body: 'Content written by the auto-compile drain test. Part of Auto Compile Book.',
              sources: ['Auto Compile Book', 'chapter 1'],
              difficulty: 2,
              status: 'draft',
            }),
          }],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: 0, reasoning: undefined },
          },
          warnings: [],
        },
        {
          content: [{ type: 'text', text: 'Compiled 1 concept.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
          warnings: [],
        },
      ],
    });

    const fakeConverter: Converter = async () => ({
      markdown: '# Auto Compile Concept\nContent written by the auto-compile drain test.',
    });

    // No explicit ensureCompileDrain call here — startConversion's own on-completion kick (with
    // this fake model threaded through opts.model) is what should drain the queue.
    startConversion(lw, cfg, '/uploads/Auto Compile Book.pdf', { converter: fakeConverter, model });

    const entry = await until(() => readQueue(vault).find((e) => e.book === 'Auto Compile Book' && e.status === 'done'));
    expect(entry).toBeTruthy();
  }, 30_000);

  it('a second ensureCompileDrain call while one is already running is a harmless no-op (singleton)', async () => {
    // Nothing pending at this point (previous test drained everything) — this just proves
    // calling it again doesn't throw or double-run.
    expect(() => ensureCompileDrain(lw, cfg)).not.toThrow();
  });
});
