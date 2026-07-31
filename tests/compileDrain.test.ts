import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engram } from '../src/server/mcp.js';
import { sawToolResult, streamModel, turnsModel } from './mockModel.js';
import { writeQueue } from '../src/server/queueStore.js';
import {
  canCompileNow, compileConcurrencyFor, ensureCompileDrain, ingestBook, readQueue, startConversion,
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

  it('the breaker prunes a stranded duplicate instead of recompiling it forever', async () => {
    // Reproduces the runaway's mechanism directly: a 'pending' entry whose chapter DUPLICATES a
    // 'done' one. compileOne finishes and writes status via find(chapter) — which resolves to the
    // 'done' row, so the pending duplicate never terminates. Pre-fix, ensureCompileDrain's
    // `while (some pending)` recompiled it without end (thousands of calls). The breaker must both
    // STOP the runaway (a handful of calls, not thousands) AND prune the provably-redundant
    // duplicate (its chapter already compiled under the done twin), leaving a clean ledger.
    let calls = 0;
    const model = streamModel((req) => {
      calls++;
      return sawToolResult(req)
        ? { text: 'done' }
        : { toolCalls: [{ toolName: 'write_page', input: {
          slug: 'dup', title: 'Dup', body: 'A concept. Part of Dup Book.',
          sources: ['Dup Book'], difficulty: 1, status: 'draft',
        } }] };
    });
    writeQueue(vault, [
      { book: 'Dup Book', chapter: 'raw/uploads/dup/ch-01.md', title: 'Dup', status: 'done' },
      { book: 'Dup Book', chapter: 'raw/uploads/dup/ch-01.md', title: 'Dup', status: 'pending' },
    ]);

    ensureCompileDrain(lw, cfg, { model });
    await until(() => !readQueue(vault).some((e) => e.status === 'pending' || e.status === 'compiling'), 8_000);
    const ledger = readQueue(vault);
    // The invariants that matter and are deterministic: the duplicate is collapsed to one row, it
    // is terminal (not stuck pending/compiling), and the runaway is gone. The exact terminal value
    // is nondeterministic — the status write lands on whichever twin find() hits first — which is
    // the whole reason a duplicate chapter is a bug, and the whole reason we prune it.
    expect(ledger.filter((e) => e.chapter === 'raw/uploads/dup/ch-01.md')).toHaveLength(1);
    expect(['done', 'error']).toContain(ledger[0].status);
    expect(calls).toBeLessThan(6); // the runaway is gone — a couple of passes, not thousands
  }, 30_000);

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

describe('ensureCompileDrain — the drain hands the book\'s order to a path', () => {
  // Its own vault and engram: the drain is a module singleton, so sharing a vault with the tests
  // above would leave this one racing whichever drain they kicked last.
  let lw: Engram;
  let vault: string;
  let cfg: HarnessConfig;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), 'lwh-artifact-drain-'));
    mkdirSync(join(vault, 'pages'), { recursive: true });
    cfg = {
      vault, student: 'kid', autoCompile: true,
      models: { compile: { model: 'claude-drain-test' } },
      engram: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
    } as unknown as HarnessConfig;
    lw = await Engram.connect(cfg);
  }, 30_000);
  afterAll(async () => { await lw.close(); });

  it('turns the book\'s own chapter order into a path once the drain settles', async () => {
    // The end-to-end wiring: two chapters compile, and the source's own order comes back out of
    // engram as a path — chapter 1's pages, then chapter 2's, in the order write_page was called.
    // Nothing between here and the path re-sequences anything.
    const perChapter: Record<string, string[]> = {
      'Spine Drain Chapter One': ['spine-drain-alpha', 'spine-drain-beta'],
      'Spine Drain Chapter Two': ['spine-drain-gamma'],
    };
    const model = streamModel((req) => {
      if (sawToolResult(req)) return { text: 'done' };
      const prompt = req.messages
        .map((m) => m.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('\n'))
        .join('\n');
      const chapter = Object.keys(perChapter).find((t) => prompt.includes(t))!;
      return {
        toolCalls: perChapter[chapter].map((slug) => ({
          toolName: 'write_page',
          input: {
            slug, title: slug, body: `Body for ${slug}, written by the artifact-path drain test.`,
            sources: ['Artifact Order Book'], difficulty: 2, status: 'draft',
          },
        })),
      };
    });
    await ingestBook(cfg, '/uploads/Artifact Order Book.pdf', {
      converter: async () => ({
        markdown: [
          '# Spine Drain Chapter One', 'The first chapter, as the author ordered it.',
          '# Spine Drain Chapter Two', 'The second chapter, which the author put second.',
        ].join('\n'),
      }),
    });

    // Kicking repeatedly is a documented no-op while one is running (the singleton), which is what
    // makes this safe to poll on.
    await until(() => {
      ensureCompileDrain(lw, cfg, { model });
      const rows = readQueue(vault).filter((e) => e.book === 'Artifact Order Book');
      return rows.length === 2 && rows.every((e) => e.status === 'done');
    });

    // The path is written after the drain loop settles, so poll for it rather than assume it is
    // there the instant the last chapter flips to 'done'.
    let doc: any = null;
    for (let i = 0; i < 200 && !doc; i++) {
      doc = await lw.call('read_path', { slug: 'source-artifact-order-book' }).catch(() => null);
      if (!doc) await new Promise((r) => { setTimeout(r, 50); });
    }
    // Chapter one wrote two pages, so it also got a MOC hub — itself written through the same
    // wrapper, landing in the chapter's own page order right after the pages it maps.
    expect(doc.pages).toEqual([
      'spine-drain-alpha', 'spine-drain-beta', 'artifact-order-book-ch-1-moc', 'spine-drain-gamma',
    ]);
    expect(doc.title).toBe('Artifact Order Book');
    expect(doc.body).toContain('order the source itself presents');
  }, 60_000);
});
