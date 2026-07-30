import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engram } from '../src/server/mcp.js';
import { sawToolResult, streamModel, turnsModel } from './mockModel.js';
import {
  canCompileNow, compileConcurrencyFor, ensureCompileDrain, readQueue, startConversion,
} from '../src/server/ingest.js';
import type { Converter, IncrementalConverter } from '../src/server/convert.js';
import type { HarnessConfig } from '../src/server/config.js';
import { LW_REPO } from './lwRepo.js';


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

describe('compileConcurrencyFor', () => {
  it('is 1 for an ollama-backed compile model — one local GPU, same contention as canCompileNow', () => {
    expect(compileConcurrencyFor('ollama:qwen2.5-coder')).toBe(1);
  });

  it('is 4 for a cloud (non-ollama) compile model — no local GPU to contend for', () => {
    expect(compileConcurrencyFor('claude-sonnet-5')).toBe(4);
    expect(compileConcurrencyFor('claude-drain-test')).toBe(4);
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
  let lw: Engram;
  let vault: string;
  let cfg: HarnessConfig;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), 'lwh-drain-vault-'));
    mkdirSync(join(vault, 'pages'), { recursive: true });
    cfg = {
      vault, student: 'kid', autoCompile: true,
      // Non-ollama id so canCompileNow never gates this test on activeConversions timing.
      models: { compile: { model: 'claude-drain-test' } },
      engram: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
    } as unknown as HarnessConfig;
    lw = await Engram.connect(cfg);
  }, 30_000);
  afterAll(async () => { await lw.close(); });

  it('drains pending entries automatically once a conversion completes, without /api/ingest/compile', async () => {
    const model = turnsModel([
      {
        toolCalls: [{
          toolName: 'write_page',
          input: {
            slug: 'auto-compile-concept',
            title: 'Auto Compile Concept',
            body: 'Content written by the auto-compile drain test. Part of Auto Compile Book.',
            sources: ['Auto Compile Book', 'chapter 1'],
            difficulty: 2,
            status: 'draft',
          },
        }],
      },
      { text: 'Compiled 1 concept.' },
    ]);

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

  it('a non-ollama (cloud) compile model drains a progressively-queued chapter WHILE its own conversion is still active', async () => {
    // A model whose responses don't depend on call order/interleaving — it looks at whether a
    // tool result is already in the transcript to decide "first step" (call write_page) vs
    // "second step" (stop). Slugs are unique per call so concurrent/aggregate writes never collide.
    let nextSlug = 0;
    const cloudModel = streamModel((req) => {
      if (sawToolResult(req)) return { text: 'Compiled 1 concept.' };
      const n = nextSlug++;
      return {
        toolCalls: [{
          toolName: 'write_page',
          input: {
            slug: `cloud-during-conversion-${n}`,
            title: `Cloud During Conversion Concept ${n}`,
            body: `Content compiled while its own conversion (${n}) is technically still running.`,
            sources: ['Cloud During Conversion Book', 'chapter 1'],
            difficulty: 2,
            status: 'draft',
          },
        }],
      };
    });

    let releaseGate: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });

    const fakeIncremental: IncrementalConverter = async (_file, _outDir, onProgress) => {
      // Chapter One is confirmed complete by Chapter Two appearing — progressive queueing puts
      // it in the ledger as 'pending' even though this conversion is nowhere near finished.
      await onProgress({
        markdown: ['# Cloud Drain Chapter One', 'Complete content.', '# Cloud Drain Chapter Two', 'Still growing.'].join('\n'),
        pagesDone: 10, pagesTotal: 20, final: false,
      });
      await gate; // holds activeConversions at 1 for this conversion until the test releases it
      await onProgress({
        markdown: ['# Cloud Drain Chapter One', 'Complete content.', '# Cloud Drain Chapter Two', 'Now complete too.'].join('\n'),
        pagesDone: 20, pagesTotal: 20, final: true,
      });
    };

    // Deliberately no opts.model here — startConversion's own on-completion kick is irrelevant to
    // this test (it fires only after the gate releases, at the very end).
    startConversion(lw, cfg, '/uploads/Cloud During Conversion Book.pdf', {
      incrementalConverter: fakeIncremental, mode: 'book',
    });

    await until(() => readQueue(vault).some((e) => e.title === 'Cloud Drain Chapter One' && e.status === 'pending'));
    // Still gated — the conversion has not finished, activeConversions is still 1 for it.
    expect(readQueue(vault).some((e) => e.status === 'converting')).toBe(true);

    ensureCompileDrain(lw, cfg, { model: cloudModel });
    const done = await until(
      () => readQueue(vault).find((e) => e.title === 'Cloud Drain Chapter One' && e.status === 'done'),
    );
    expect(done).toBeTruthy();
    // The proof: this happened before the gate was released, i.e. while the conversion that
    // queued it was still actively running — canCompileNow only allows this for a non-ollama
    // compile model (cfg.models.compile.model is 'claude-drain-test' throughout this describe).
    expect(readQueue(vault).some((e) => e.status === 'converting')).toBe(true);

    releaseGate!();
    await until(() => !readQueue(vault).some((e) => e.status === 'converting'));
  }, 30_000);
});
