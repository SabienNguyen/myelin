import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { Loreweaver } from '../src/server/mcp.js';
import { ingestBook, compileNext, readQueue } from '../src/server/ingest.js';
import type { Converter } from '../src/server/convert.js';
import type { HarnessConfig } from '../src/server/config.js';

const LW_REPO = `${process.env.HOME}/Dev/personal/loreweaver`;

const FIXTURE_MD = [
  '# Photosynthesis Basics',
  'Plants convert light into chemical energy using chlorophyll.',
  '# Cellular Respiration',
  'Cells break down glucose to release usable energy.',
].join('\n');

const fakeConverter: Converter = async () => ({ markdown: FIXTURE_MD });

describe('ingestBook', () => {
  it('writes per-chapter markdown to raw/uploads/<book>/ and appends pending ledger entries', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-'));
    const cfg = { vault, student: 'kid', models: {} } as unknown as HarnessConfig;

    const result = await ingestBook(cfg, '/uploads/Intro to Biology.pdf', { converter: fakeConverter });

    expect(result.book).toBe('Intro to Biology');
    expect(result.chapters).toBe(2);

    const bookDir = join(vault, 'raw', 'uploads', 'intro-to-biology');
    const files = readQueue(vault).map((e) => e.chapter);
    expect(files).toEqual([
      'raw/uploads/intro-to-biology/ch-01-photosynthesis-basics.md',
      'raw/uploads/intro-to-biology/ch-02-cellular-respiration.md',
    ]);

    for (const f of files) expect(existsSync(join(vault, f))).toBe(true);

    const ch1 = readFileSync(join(bookDir, 'ch-01-photosynthesis-basics.md'), 'utf8');
    expect(ch1).toContain('Intro to Biology');
    expect(ch1).toContain('chapter 1');
    expect(ch1).toContain('Plants convert light into chemical energy');

    const ledger = readQueue(vault);
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({
      book: 'Intro to Biology', title: 'Photosynthesis Basics', status: 'pending',
    });
    expect(ledger[1]).toMatchObject({
      book: 'Intro to Biology', title: 'Cellular Respiration', status: 'pending',
    });
  });

  it('appends to an existing ledger rather than overwriting it', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-'));
    const cfg = { vault, student: 'kid', models: {} } as unknown as HarnessConfig;
    await ingestBook(cfg, '/uploads/Book One.pdf', { converter: fakeConverter });
    await ingestBook(cfg, '/uploads/Book Two.pdf', { converter: fakeConverter });
    const ledger = readQueue(vault);
    expect(ledger).toHaveLength(4);
    expect(new Set(ledger.map((e) => e.book))).toEqual(new Set(['Book One', 'Book Two']));
  });
});

describe('ingestBook paper mode', () => {
  const manyHeadingsMd = [
    '# The Real Paper Title',
    'Abstract: this paper studies many things.',
    '## Introduction',
    'Some intro content.',
    '# A Misleading Second H1',
    'This looks like a chapter break but paper mode must not split on it.',
    '## Results',
    'Some results content.',
  ].join('\n');

  it('produces exactly one pending ledger entry titled from the first H1, no chapter splitting', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-paper-'));
    const cfg = { vault, student: 'kid', models: {} } as unknown as HarnessConfig;

    const result = await ingestBook(cfg, '/uploads/some-upload-name.pdf', {
      mode: 'paper',
      converter: async () => ({ markdown: manyHeadingsMd }),
    });

    expect(result).toEqual({ book: 'The Real Paper Title', chapters: 1 });

    const ledger = readQueue(vault);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      book: 'The Real Paper Title',
      title: 'The Real Paper Title',
      chapter: 'raw/uploads/the-real-paper-title/paper.md',
      status: 'pending',
    });

    const written = readFileSync(join(vault, 'raw', 'uploads', 'the-real-paper-title', 'paper.md'), 'utf8');
    expect(written).toContain('The Real Paper Title');
    expect(written).toContain('A Misleading Second H1'); // full doc kept intact, not split
  });

  it('falls back to the filename when the markdown has no H1', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-paper-'));
    const cfg = { vault, student: 'kid', models: {} } as unknown as HarnessConfig;

    const result = await ingestBook(cfg, '/uploads/Untitled Paper.pdf', {
      mode: 'paper',
      converter: async () => ({ markdown: 'No headings here, just body text.' }),
    });

    expect(result.book).toBe('Untitled Paper');
    expect(readQueue(vault)[0].title).toBe('Untitled Paper');
  });

  it('an explicit title opt overrides H1 detection', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-paper-'));
    const cfg = { vault, student: 'kid', models: {} } as unknown as HarnessConfig;

    const result = await ingestBook(cfg, '/uploads/whatever.pdf', {
      mode: 'paper', title: 'Explicit Title',
      converter: async () => ({ markdown: '# Detected H1 Title\nbody' }),
    });

    expect(result.book).toBe('Explicit Title');
    expect(readQueue(vault)[0].title).toBe('Explicit Title');
  });
});

describe('compileNext', () => {
  let lw: Loreweaver;
  let vault: string;
  let cfg: HarnessConfig;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), 'lwh-compile-vault-'));
    mkdirSync(join(vault, 'pages'), { recursive: true });
    cfg = {
      vault, student: 'kid',
      loreweaver: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
    } as unknown as HarnessConfig;
    lw = await Loreweaver.connect(cfg);
  }, 30_000);
  afterAll(async () => { await lw.close(); });

  it('drains one pending chapter through a one-shot compile agent and marks it done', async () => {
    await ingestBook(cfg, '/uploads/Test Biology Book.pdf', {
      converter: async () => ({ markdown: '# Photosynthesis Basics\nPlants convert light into chemical energy.' }),
    });

    // Step 1: model calls write_page once. Step 2: model replies with text and stops — no more tools.
    const model = new MockLanguageModelV3({
      doGenerate: [
        {
          content: [{
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'write_page',
            input: JSON.stringify({
              slug: 'photosynthesis-basics',
              title: 'Photosynthesis Basics',
              body: 'Plants convert light into chemical energy using chlorophyll. Part of Test Biology Book.',
              sources: ['Test Biology Book', 'chapter 1'],
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
          content: [{ type: 'text', text: 'Compiled 1 concept from this chapter.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
          warnings: [],
        },
      ],
    });

    const summary = await compileNext(lw, cfg, 1, { model });
    expect(summary).toEqual({ compiled: 1, failed: 0 });

    expect(existsSync(join(vault, 'pages', 'photosynthesis-basics.md'))).toBe(true);

    const ledger = readQueue(vault);
    const entry = ledger.find((e) => e.book === 'Test Biology Book');
    expect(entry?.status).toBe('done');
  }, 30_000);

  it('marks a chapter error (with message) when the compile agent throws', async () => {
    await ingestBook(cfg, '/uploads/Broken Book.pdf', {
      converter: async () => ({ markdown: '# Some Concept\nSome content.' }),
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => { throw new Error('model unavailable'); },
    });
    const summary = await compileNext(lw, cfg, 1, { model });
    expect(summary).toEqual({ compiled: 0, failed: 1 });

    const ledger = readQueue(vault);
    const entry = ledger.find((e) => e.book === 'Broken Book');
    expect(entry?.status).toBe('error');
    expect(entry?.error).toMatch(/model unavailable/);
  }, 30_000);

  describe('concurrency', () => {
    /** A model whose response doesn't depend on call order — it looks at whether a tool result is
     * already in the prompt to tell "first step" (call write_page) from "second step" (stop), so
     * it behaves correctly no matter how compileNext's worker pool interleaves calls across
     * chapters. Tracks how many of its "first step" calls are simultaneously in flight (via an
     * artificial delay) so tests can assert on actual overlap, not just wall-clock time. */
    function trackedModel(delayMs: number, inFlight: { current: number; max: number }) {
      let nextSlug = 0;
      return new MockLanguageModelV3({
        doGenerate: async (options) => {
          const alreadyCalledTool = options.prompt.some((m) => m.role === 'tool');
          if (!alreadyCalledTool) {
            inFlight.current++;
            inFlight.max = Math.max(inFlight.max, inFlight.current);
            await new Promise((r) => { setTimeout(r, delayMs); });
            inFlight.current--;
            const n = nextSlug++;
            return {
              content: [{
                type: 'tool-call',
                toolCallId: `call-pool-${n}`,
                toolName: 'write_page',
                input: JSON.stringify({
                  slug: `pool-concept-${n}`,
                  title: `Pool Concept ${n}`,
                  body: `Body for pool concept ${n}, written by the concurrency pool test.`,
                  sources: ['Pool Test Book', 'chapter 1'],
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
            };
          }
          return {
            content: [{ type: 'text', text: 'done' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            },
            warnings: [],
          };
        },
      });
    }

    it('runs multiple chapters at once when concurrency > 1 (max in-flight > 1)', async () => {
      const chapters = Array.from({ length: 6 }, (_, i) => `# Pool Chapter ${i + 1}\nContent ${i + 1}.`).join('\n');
      await ingestBook(cfg, '/uploads/Pool Test Book A.pdf', { converter: async () => ({ markdown: chapters }) });

      const inFlight = { current: 0, max: 0 };
      const summary = await compileNext(lw, cfg, 6, { model: trackedModel(30, inFlight), concurrency: 4 });

      expect(summary).toEqual({ compiled: 6, failed: 0 });
      expect(inFlight.max).toBeGreaterThan(1);
    }, 30_000);

    it('stays strictly sequential at the default concurrency of 1 (max in-flight === 1)', async () => {
      const chapters = Array.from({ length: 4 }, (_, i) => `# Pool Chapter B${i + 1}\nContent ${i + 1}.`).join('\n');
      await ingestBook(cfg, '/uploads/Pool Test Book B.pdf', { converter: async () => ({ markdown: chapters }) });

      const inFlight = { current: 0, max: 0 };
      const summary = await compileNext(lw, cfg, 4, { model: trackedModel(10, inFlight) }); // no concurrency opt

      expect(summary).toEqual({ compiled: 4, failed: 0 });
      expect(inFlight.max).toBe(1);
    }, 30_000);

    it('keeps the per-entry honesty gate intact under concurrency: a no-op model fails every entry, none stolen as false "done"', async () => {
      const chapters = Array.from({ length: 3 }, (_, i) => `# Pool Chapter C${i + 1}\nContent ${i + 1}.`).join('\n');
      await ingestBook(cfg, '/uploads/Pool Test Book C.pdf', { converter: async () => ({ markdown: chapters }) });

      const noToolModel = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'narrating instead of writing pages' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
          warnings: [],
        }),
      });

      const summary = await compileNext(lw, cfg, 3, { model: noToolModel, concurrency: 3 });

      expect(summary).toEqual({ compiled: 0, failed: 3 });
      const ledger = readQueue(vault);
      const entries = ledger.filter((e) => e.book === 'Pool Test Book C');
      expect(entries).toHaveLength(3);
      for (const e of entries) {
        expect(e.status).toBe('error');
        expect(e.error).toMatch(/no pages/);
      }
    }, 30_000);
  });

  describe('claude-sdk: prefixed compile model', () => {
    function sdkCfg(): HarnessConfig {
      return { ...cfg, models: { compile: { model: 'claude-sdk:sonnet' } } } as unknown as HarnessConfig;
    }

    it('routes to the fake sdkGenerate with mcp config containing the vault env, and passes the '
      + 'gate when toolCallNames includes write_page', async () => {
      await ingestBook(sdkCfg(), '/uploads/Claude SDK Book.pdf', {
        converter: async () => ({ markdown: '# SDK Concept\nContent compiled via the claude-sdk: route.' }),
      });

      const calls: any[] = [];
      const sdkGenerate = async (opts: any) => {
        calls.push(opts);
        return { text: 'wrote the page', toolCallNames: ['write_page'] };
      };

      const summary = await compileNext(lw, sdkCfg(), 1, { deps: { sdkGenerate } });
      expect(summary).toEqual({ compiled: 1, failed: 0 });

      expect(calls).toHaveLength(1);
      expect(calls[0].model).toBe('sonnet'); // prefix stripped before reaching the SDK
      expect(calls[0].maxTurns).toBe(24);
      expect(calls[0].allowedTools).toEqual([
        'mcp__loreweaver__write_page', 'mcp__loreweaver__link_pages', 'mcp__loreweaver__read_page',
      ]);
      expect(calls[0].mcp).toEqual({
        loreweaver: {
          command: 'npx',
          args: ['tsx', join(LW_REPO, 'src/server.ts')],
          env: expect.objectContaining({
            LOREWEAVER_VAULT: vault,
            LOREWEAVER_EMBEDDINGS: 'fake',
          }),
        },
      });
      expect(calls[0].prompt).toContain('SDK Concept');
      expect(calls[0].prompt).toContain('REQUIRED');

      const ledger = readQueue(vault);
      const entry = ledger.find((e) => e.book === 'Claude SDK Book');
      expect(entry?.status).toBe('done');
    }, 30_000);

    it('fails the entry when toolCallNames never includes write_page (honesty gate holds)', async () => {
      await ingestBook(sdkCfg(), '/uploads/Claude SDK Narrating Book.pdf', {
        converter: async () => ({ markdown: '# Narrated Concept\nNever actually written.' }),
      });

      const sdkGenerate = async () => ({ text: 'I looked at the chapter.', toolCallNames: [] });

      const summary = await compileNext(lw, sdkCfg(), 1, { deps: { sdkGenerate } });
      expect(summary).toEqual({ compiled: 0, failed: 1 });

      const ledger = readQueue(vault);
      const entry = ledger.find((e) => e.book === 'Claude SDK Narrating Book');
      expect(entry?.status).toBe('error');
      expect(entry?.error).toMatch(/no pages/);
    }, 30_000);

    it('leaves an unprefixed compile model on the unmodified ai-sdk path (opts.model still used)', async () => {
      await ingestBook(cfg, '/uploads/Unprefixed Path Book.pdf', {
        converter: async () => ({ markdown: '# Unprefixed Concept\nStill uses ToolLoopAgent.' }),
      });
      const model = new MockLanguageModelV3({
        doGenerate: [
          {
            content: [{
              type: 'tool-call',
              toolCallId: 'call-unprefixed',
              toolName: 'write_page',
              input: JSON.stringify({
                slug: 'unprefixed-concept',
                title: 'Unprefixed Concept',
                body: 'Still uses ToolLoopAgent. Part of Unprefixed Path Book.',
                sources: ['Unprefixed Path Book', 'chapter 1'],
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
            content: [{ type: 'text', text: 'done' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            },
            warnings: [],
          },
        ],
      });

      let sdkCalled = false;
      const summary = await compileNext(lw, cfg, 1, {
        model, deps: { sdkGenerate: async () => { sdkCalled = true; return { text: '', toolCallNames: [] }; } },
      });
      expect(summary).toEqual({ compiled: 1, failed: 0 });
      expect(sdkCalled).toBe(false);
    }, 30_000);
  });
});

describe('chunkChapter (context-budget splitting)', async () => {
  const { chunkChapter } = await import('../src/server/ingest.js');
  it('returns whole chapter when under budget', () => {
    expect(chunkChapter('## A\nshort', 1000)).toEqual(['## A\nshort']);
  });
  it('splits on H2 boundaries and preserves every byte', () => {
    const md = `intro ${'x'.repeat(50)}\n## One\n${'a'.repeat(80)}\n## Two\n${'b'.repeat(80)}\n## Three\n${'c'.repeat(80)}`;
    const parts = chunkChapter(md, 120);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(md);
    expect(parts.slice(1).every((p) => p.startsWith('## '))).toBe(true);
  });
  it('hard-cuts a single giant section at paragraph boundaries', () => {
    const md = `## Giant\n${'p'.repeat(90)}\n\n${'q'.repeat(90)}\n\n${'r'.repeat(90)}`;
    const parts = chunkChapter(md, 120);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(md);
  });
});

describe('mechanical citation on write_page', async () => {
  const { compileNext } = await import('../src/server/ingest.js');
  const { MockLanguageModelV3 } = await import('ai/test');
  const { mkdtempSync: mkTmp, mkdirSync: mkDir, writeFileSync: writeF } = await import('node:fs');
  const { tmpdir: tmpD } = await import('node:os');
  const { join: j } = await import('node:path');
  const { z } = await import('zod');
  const { tool } = await import('ai');

  function writePageModel() {
    return new MockLanguageModelV3({
      doGenerate: [
        {
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'write_page',
            input: JSON.stringify({ slug: 'attention', title: 'Attention', body: 'x', sources: ['model-added'] }) }],
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined } },
          warnings: [],
        },
        {
          content: [{ type: 'text', text: 'done' }],
          finishReason: { unified: 'stop', raw: 'end_turn' },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined } },
          warnings: [],
        },
      ],
    });
  }

  it('merges the canonical citation into write_page sources (paper URL form)', async () => {
    const vault = mkTmp(j(tmpD(), 'lwh-cite-'));
    mkDir(j(vault, 'raw', 'uploads', 'p'), { recursive: true });
    writeF(j(vault, 'raw', 'uploads', 'p', 'paper.md'), '# P\nbody');
    mkDir(j(vault, '.harness'), { recursive: true });
    writeF(j(vault, '.harness', 'compile-queue.json'), JSON.stringify([{
      book: 'Attention Is All You Need', chapter: 'raw/uploads/p/paper.md', title: 'Attention Is All You Need',
      status: 'pending', sourceUrl: 'https://arxiv.org/pdf/1706.03762',
    }]));

    const seen: any[] = [];
    const fakeLw = {
      listSlugs: async () => [],
      tools: async () => ({
        write_page: tool({
          description: 'w', inputSchema: z.object({}).passthrough() as any,
          execute: async (args: any) => { seen.push(args); return { ok: true }; },
        }),
      }),
    } as any;

    const res = await compileNext(fakeLw, { vault, student: 'kid', models: {} } as any, 1,
      { model: writePageModel() as any });
    expect(res).toEqual({ compiled: 1, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0].sources).toContain('model-added');
    expect(seen[0].sources).toContain('Attention Is All You Need (https://arxiv.org/pdf/1706.03762)');
  });
});

describe('sweepInterruptedConversions', async () => {
  const { sweepInterruptedConversions, readQueue: rq } = await import('../src/server/ingest.js');
  const { mkdtempSync: mkT, mkdirSync: mkD, writeFileSync: wF } = await import('node:fs');
  const { tmpdir: tD } = await import('node:os');
  const { join: jn } = await import('node:path');
  it('marks converting as convert-error and resumes compiling as pending', () => {
    const vault = mkT(jn(tD(), 'lwh-sweep-'));
    mkD(jn(vault, '.harness'), { recursive: true });
    wF(jn(vault, '.harness', 'compile-queue.json'), JSON.stringify([
      { book: 'b', chapter: '__converting__/x', title: 'Converting…', status: 'converting' },
      { book: 'b', chapter: 'raw/uploads/b/ch-01-a.md', title: 'A', status: 'compiling' },
      { book: 'b', chapter: 'raw/uploads/b/ch-02-b.md', title: 'B', status: 'done' },
    ]));
    expect(sweepInterruptedConversions(vault)).toBe(2);
    const q = rq(vault);
    expect(q[0].status).toBe('convert-error');
    expect(q[1].status).toBe('pending');
    expect(q[2].status).toBe('done');
  });
});
