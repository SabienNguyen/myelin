import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engram } from '../src/server/mcp.js';
import { ingestBook, compileNext, readQueue, startConversion } from '../src/server/ingest.js';
import { LlmHttpError } from '../src/server/llm/index.js';
import { sawToolResult, streamModel, textModel, turnsModel } from './mockModel.js';
import type { Converter } from '../src/server/convert.js';
import type { HarnessConfig } from '../src/server/config.js';
import { readLinkDirectories } from '../src/server/linkList.js';
import { LW_REPO } from './lwRepo.js';


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

  it('removes the temp conversion dir (assets and all) instead of leaking it', async () => {
    // The converter unpacks the source into a mkdtemp scratch dir — pandoc/pdftotext leave images
    // and intermediates there. It must be removed after every ingest, or /tmp/lwh-convert-* dirs
    // pile up one-per-document (a real disk leak on a fixed-disk desktop app).
    const vault = mkdtempSync(join(tmpdir(), 'lwh-ingest-'));
    const cfg = { vault, student: 'kid', models: {} } as unknown as HarnessConfig;
    let scratch = '';
    const leakyConverter: Converter = async (_file, outDir) => {
      scratch = outDir;
      writeFileSync(join(outDir, 'extracted-image.png'), 'fake asset'); // pandoc-style leftover
      return { markdown: FIXTURE_MD };
    };
    await ingestBook(cfg, '/uploads/Book.pdf', { converter: leakyConverter });
    expect(scratch).toMatch(/lwh-convert-/);
    expect(existsSync(scratch)).toBe(false); // whole scratch dir gone, image included
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

describe('startConversion — input temp dir cleanup', () => {
  const fake: Converter = async () => ({ markdown: '# T\nbody' });
  const cfgFor = (vault: string) =>
    ({ vault, student: 'kid', models: {}, autoCompile: false }) as unknown as HarnessConfig;

  // startConversion runs the conversion in the BACKGROUND; wait for onComplete, then a tick so the
  // finally (where the dirs are removed) has run. lw is unused with autoCompile:false.
  const runToDone = (cfg: HarnessConfig, filePath: string, extra: Record<string, unknown>) =>
    new Promise<void>((resolve) => {
      startConversion({} as never, cfg, filePath, {
        converter: fake, mode: 'paper', onComplete: () => resolve(), ...extra,
      });
    }).then(() => new Promise((r) => { setTimeout(r, 30); }));

  it('removes an opt-in cleanupInputDir once conversion finishes', async () => {
    const cfg = cfgFor(mkdtempSync(join(tmpdir(), 'lwh-conv-vault-')));
    const tempInput = mkdtempSync(join(tmpdir(), 'lwh-upload-'));
    writeFileSync(join(tempInput, 'doc.md'), '# T\nbody');
    await runToDone(cfg, join(tempInput, 'doc.md'), { cleanupInputDir: tempInput });
    expect(existsSync(tempInput)).toBe(false);
  });

  it("NEVER removes the containing dir when cleanupInputDir is unset — a learner's own file is safe", async () => {
    // The `path` ingest branch passes a user's local file straight through with NO cleanupInputDir;
    // deleting its parent would wipe their directory. This is the guard against that.
    const cfg = cfgFor(mkdtempSync(join(tmpdir(), 'lwh-conv-vault-')));
    const ownDir = mkdtempSync(join(tmpdir(), 'lwh-userfiles-'));
    writeFileSync(join(ownDir, 'notes.md'), '# T\nbody');
    await runToDone(cfg, join(ownDir, 'notes.md'), {}); // no cleanupInputDir
    expect(existsSync(ownDir)).toBe(true);
  });
});

describe('startConversion — link-directory diversion (upload/URL doors)', () => {
  const AWESOME_MD = [
    '# Awesome Reads', '',
    'A curated list.', '',
    '## Systems', '',
    ...Array.from({ length: 12 }, (_, i) => `- [Systems ${i}](https://blog.example/sys-${i}) - systems reading ${i}`),
    '',
    '## Theory', '',
    ...Array.from({ length: 8 }, (_, i) => `- [Theory ${i}](https://blog.example/th-${i})`),
  ].join('\n');
  const awesomeConverter: Converter = async () => ({ markdown: AWESOME_MD });
  const cfgFor = (vault: string) =>
    ({ vault, student: 'kid', models: {}, autoCompile: false }) as unknown as HarnessConfig;
  const runToDone = (cfg: HarnessConfig, filePath: string, extra: Record<string, unknown> = {}) =>
    new Promise<void>((resolve) => {
      startConversion({} as never, cfg, filePath, {
        converter: awesomeConverter, onComplete: () => resolve(), ...extra,
      });
    }).then(() => new Promise((r) => { setTimeout(r, 30); }));

  it('a bare .md upload (book mode) becomes a catalogue, not chapters', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-linkconv-'));
    await runToDone(cfgFor(vault), '/uploads/awesome-reads.md');

    const queue = readQueue(vault);
    // One terminal 'done' receipt, zero pending chapters, no leftover placeholder.
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      book: 'awesome-reads', chapter: '__link_directory__/awesome-reads', status: 'done',
    });
    expect(queue[0].title).toContain('20 links catalogued');

    const dirs = readLinkDirectories(vault);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].name).toBe('awesome-reads');
    expect(dirs[0].total).toBe(20);
    expect(dirs[0].sections.map((s) => s.title)).toEqual(['Systems', 'Theory']);
  });

  it('a downloaded URL (paper mode) diverts too, carrying the source url', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-linkconv-'));
    await runToDone(cfgFor(vault), '/tmp/dl/readme.md', {
      mode: 'paper', sourceUrl: 'https://example.com/awesome/readme.md',
    });

    const queue = readQueue(vault);
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('done');
    expect(queue[0].sourceUrl).toBe('https://example.com/awesome/readme.md');
    // No pending paper row — the directory was catalogued instead of queued for compilation.
    expect(queue.some((e) => e.status === 'pending')).toBe(false);
    expect(readLinkDirectories(vault)[0].source).toBe('https://example.com/awesome/readme.md');
  });

  it('an ordinary document still queues chapters and writes no catalogue', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-linkconv-'));
    const cfg = cfgFor(vault);
    await new Promise<void>((resolve) => {
      startConversion({} as never, cfg, '/uploads/plain.md', {
        converter: async () => ({ markdown: FIXTURE_MD }), onComplete: () => resolve(),
      });
    }).then(() => new Promise((r) => { setTimeout(r, 30); }));

    expect(readQueue(vault).filter((e) => e.status === 'pending')).toHaveLength(2);
    expect(readLinkDirectories(vault)).toEqual([]);
  });
});

describe('compileNext', () => {
  let lw: Engram;
  let vault: string;
  let cfg: HarnessConfig;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), 'lwh-compile-vault-'));
    mkdirSync(join(vault, 'pages'), { recursive: true });
    cfg = {
      vault, student: 'kid',
      engram: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
    } as unknown as HarnessConfig;
    lw = await Engram.connect(cfg);
  }, 30_000);
  afterAll(async () => { await lw.close(); });

  it('drains one pending chapter through a one-shot compile agent and marks it done', async () => {
    await ingestBook(cfg, '/uploads/Test Biology Book.pdf', {
      converter: async () => ({ markdown: '# Photosynthesis Basics\nPlants convert light into chemical energy.' }),
    });

    // Step 1: model calls write_page once. Step 2: model replies with text and stops — no more tools.
    const model = turnsModel([
      {
        toolCalls: [{
          toolName: 'write_page',
          input: {
            slug: 'photosynthesis-basics',
            title: 'Photosynthesis Basics',
            body: 'Plants convert light into chemical energy using chlorophyll. Part of Test Biology Book.',
            sources: ['Test Biology Book', 'chapter 1'],
            difficulty: 2,
            status: 'draft',
          },
        }],
      },
      { text: 'Compiled 1 concept from this chapter.' },
    ]);

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
    // Transport-shaped on purpose: an unreachable endpoint must STILL fail the entry (the queue
    // retries when it recovers). Mere model weakness no longer fails compile — see the
    // weak-model fallback tests below.
    const model = streamModel(() => { throw new LlmHttpError('openai-compat', 503, 'model unavailable'); });
    const summary = await compileNext(lw, cfg, 1, { model });
    expect(summary).toEqual({ compiled: 0, failed: 1 });

    const ledger = readQueue(vault);
    const entry = ledger.find((e) => e.book === 'Broken Book');
    expect(entry?.status).toBe('error');
    expect(entry?.error).toMatch(/model unavailable/);
  }, 30_000);

  it('a weak model that narrates instead of calling tools still compiles: harness distillation', async () => {
    await ingestBook(cfg, '/uploads/Weak Distill Book.pdf', {
      converter: async () => ({ markdown: '# Mitochondria\nThe powerhouse of the cell.' }),
    });
    // textModel: stream() narrates the reply as TEXT (no tool calls — the weak-agentic shape),
    // while generate() answers the forced schema tool with the same JSON — so one fake plays both
    // halves of the ladder: agentic pass empty, structured distillation succeeds.
    const { model } = textModel(JSON.stringify({
      title: 'Mitochondria Distilled',
      body: 'Mitochondria produce ATP — the powerhouse of the cell.',
    }));
    const summary = await compileNext(lw, cfg, 1, { model });
    expect(summary).toEqual({ compiled: 1, failed: 0 });
    const page = readFileSync(join(vault, 'pages', 'mitochondria-distilled.md'), 'utf8');
    expect(page).toContain('powerhouse of the cell');
    // The mechanical citation guarantee holds on the fallback path too — the harness writes
    // through the same citation-wrapped write_page the agentic loop uses.
    expect(page).toContain('Weak Distill Book');
    expect(readQueue(vault).find((e) => e.book === 'Weak Distill Book')?.status).toBe('done');
  }, 30_000);

  it('a model that cannot produce structured JSON lands on the verbatim floor — never zero pages', async () => {
    await ingestBook(cfg, '/uploads/Verbatim Floor Book.pdf', {
      converter: async () => ({ markdown: '# Krebs Cycle\nEight steps oxidize acetyl-CoA.' }),
    });
    const { model } = textModel('Sure! Great chapter, happy to help — but no JSON from me.');
    const summary = await compileNext(lw, cfg, 1, { model });
    expect(summary).toEqual({ compiled: 1, failed: 0 });
    const entry = readQueue(vault).find((e) => e.book === 'Verbatim Floor Book');
    expect(entry?.status).toBe('done');
    const slug = 'krebs-cycle'; // slugified chapter title — the floor names the page after the source
    const page = readFileSync(join(vault, 'pages', `${slug}.md`), 'utf8');
    expect(page).toContain('Compiled verbatim');
    expect(page).toContain('Eight steps oxidize acetyl-CoA'); // the source text IS the page
    expect(page).toContain('Verbatim Floor Book'); // citation still mechanical
  }, 30_000);

  it('a weak model distills the remaining parts in PARALLEL once part 1 proves it cannot drive tools', async () => {
    // A second H1 chapter (trivial, untouched by this test) so splitChapters treats "Cell Biology"
    // as ONE chapter with three H2 subsections, rather than splitting on H2 into three chapters —
    // chunkChapter, not ingestBook, is what must produce the three parts here.
    const THREE_PART_CHAPTER = [
      '# Cell Biology',
      '## Mitochondria',
      'A'.repeat(200),
      '## Ribosomes',
      'B'.repeat(200),
      '## Golgi Apparatus',
      'C'.repeat(200),
      '# Appendix',
      'Nothing under compile test here.',
    ].join('\n');
    await ingestBook(cfg, '/uploads/Parallel Distill Book.pdf', {
      converter: async () => ({ markdown: THREE_PART_CHAPTER }),
    });

    // One fake plays both halves of the ladder, same trick as the single-part fallback tests: text
    // (no tool calls) for the agentic pass, forced-schema JSON for every distillation call. The
    // reply function keys off prompt content, not call order, precisely because this task's point
    // is that the distillation calls no longer arrive in a fixed sequential order. It also compiles
    // the trivial Appendix chapter (so this shared vault's queue never leaks a pending entry to a
    // later test) — kept out of the counts below by filtering on "Cell Biology".
    let distillCalls = 0;
    const { model, prompts } = textModel((prompt) => {
      if (prompt.includes('Distill this chapter part')) {
        if (!prompt.includes('Cell Biology')) return JSON.stringify({ title: 'Appendix Distilled', body: 'Nothing under compile test here, distilled.' });
        distillCalls++;
        return JSON.stringify({
          title: `Distilled Part ${distillCalls}`,
          body: 'A page body of enough words to be a page, distilled from the source chapter part.',
        });
      }
      return 'I cannot call tools, sorry — here is a summary instead.';
    });

    const localCfg: HarnessConfig = { ...cfg, models: { compile: { concurrency: 3 } } } as HarnessConfig;
    const summary = await compileNext(lw, localCfg, 2, { model, chunkChars: 320 });
    expect(summary).toEqual({ compiled: 2, failed: 0 });

    // Exactly one agentic attempt on "Cell Biology": part 1 tried and fell back; parts 2 and 3
    // skipped the doomed agentic round-trip entirely instead of narrating twice more.
    const agenticPrompts = prompts.filter((p) => p.includes('You are compiling one textbook chapter') && p.includes('Cell Biology'));
    expect(agenticPrompts).toHaveLength(1);

    // All three parts distilled — including part 1, whose agentic attempt produced no page and so
    // is redistilled by the harness alongside parts 2 and 3, not left half-handled.
    expect(distillCalls).toBe(3);
    const slugs = await lw.listSlugs();
    expect(slugs.filter((s) => s.startsWith('distilled-part-'))).toHaveLength(3);

    const entry = readQueue(vault).find((e) => e.book === 'Parallel Distill Book');
    expect(entry?.status).toBe('done');
  }, 30_000);

  describe('concurrency', () => {
    /** A model whose response doesn't depend on call order — it looks at whether a tool result is
     * already in the transcript to tell "first step" (call write_page) from "second step" (stop),
     * so it behaves correctly no matter how compileNext's worker pool interleaves calls across
     * chapters. Tracks how many of its "first step" calls are simultaneously in flight (via an
     * artificial delay) so tests can assert on actual overlap, not just wall-clock time. */
    function trackedModel(delayMs: number, inFlight: { current: number; max: number }) {
      let nextSlug = 0;
      return streamModel(async (req) => {
        if (sawToolResult(req)) return { text: 'done' };
        inFlight.current++;
        inFlight.max = Math.max(inFlight.max, inFlight.current);
        await new Promise((r) => { setTimeout(r, delayMs); });
        inFlight.current--;
        const n = nextSlug++;
        return {
          toolCalls: [{
            toolName: 'write_page',
            input: {
              slug: `pool-concept-${n}`,
              title: `Pool Concept ${n}`,
              body: `Body for pool concept ${n}, written by the concurrency pool test.`,
              sources: ['Pool Test Book', 'chapter 1'],
              difficulty: 2,
              status: 'draft',
            },
          }],
        };
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

    it('keeps per-entry attribution intact under concurrency: a no-op model lands every entry on ITS OWN fallback page', async () => {
      const chapters = Array.from({ length: 3 }, (_, i) => `# Pool Chapter C${i + 1}\nContent ${i + 1}.`).join('\n');
      await ingestBook(cfg, '/uploads/Pool Test Book C.pdf', { converter: async () => ({ markdown: chapters }) });

      // A narrating no-tool model used to fail every entry here; with the weak-model fallback it
      // now compiles every entry — the invariant this test keeps is ATTRIBUTION under
      // concurrency: each worker's fallback page is its own chapter's, none stolen or shared.
      // (streamModel's generate() throws, so the ladder lands on the verbatim floor.)
      const noToolModel = streamModel(() => ({ text: 'narrating instead of writing pages' }));

      const summary = await compileNext(lw, cfg, 3, { model: noToolModel, concurrency: 3 });

      expect(summary).toEqual({ compiled: 3, failed: 0 });
      const ledger = readQueue(vault);
      const entries = ledger.filter((e) => e.book === 'Pool Test Book C');
      expect(entries).toHaveLength(3);
      for (const [i, e] of entries.entries()) {
        expect(e.status).toBe('done');
        const page = readFileSync(join(vault, 'pages', `pool-chapter-c${i + 1}.md`), 'utf8');
        expect(page).toContain('Compiled verbatim');
        expect(page).toContain(`Content ${i + 1}.`); // this chapter's own text, not a sibling's
      }
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
  it('does not treat a `##` comment inside a code fence as a chunk boundary', () => {
    // Two real H2 sections, each comfortably under budget so the split is purely on H2 boundaries
    // (no giant-section hard-cut). The fenced `## not a section` between them must not add a third
    // chunk starting mid-code; byte-fidelity still holds.
    const md = `## One\n${'a'.repeat(40)}\n\`\`\`sh\n## not a section\n${'b'.repeat(10)}\n\`\`\`\n## Two\n${'c'.repeat(40)}`;
    const parts = chunkChapter(md, 100);
    expect(parts.join('')).toBe(md);
    expect(parts).toHaveLength(2);
    expect(parts.slice(1).every((p) => p.startsWith('## '))).toBe(true);
    expect(parts.some((p) => p.startsWith('## not a section'))).toBe(false);
  });
});

describe('mechanical citation on write_page', async () => {
  const { compileNext } = await import('../src/server/ingest.js');
  const { mkdtempSync: mkTmp, mkdirSync: mkDir, writeFileSync: writeF } = await import('node:fs');
  const { tmpdir: tmpD } = await import('node:os');
  const { join: j } = await import('node:path');

  // A fake Engram whose write_page records what it was invoked with — the citation merge under
  // test happens between the model's call and this execute.
  function seeingLw(seen: any[]) {
    return {
      listSlugs: async () => [],
      tools: async () => [{
        name: 'write_page', description: 'w', inputSchema: { type: 'object' },
        execute: async (args: any) => { seen.push(args); return { ok: true }; },
      }],
    } as any;
  }

  function writePageModel() {
    return turnsModel([
      { toolCalls: [{ toolName: 'write_page', input: { slug: 'attention', title: 'Attention', body: 'x', sources: ['model-added'] } }] },
      { text: 'done' },
    ]);
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
    const res = await compileNext(seeingLw(seen), { vault, student: 'kid', models: {} } as any, 1,
      { model: writePageModel() });
    expect(res).toEqual({ compiled: 1, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0].sources).toContain('model-added');
    expect(seen[0].sources).toContain('Attention Is All You Need (https://arxiv.org/pdf/1706.03762)');
  });

  it('merges the source record’s authors into write_page, overriding what the model asserted', async () => {
    // Same seam, same guarantee as the citation: the compile model does not have to remember the
    // byline and cannot overwrite it. Override, not union — a union is how a model appends a
    // creator the artifact never carried, which is the whole failure this feature exists for.
    const { recordSource } = await import('../src/server/provenance.js');
    const vault = mkTmp(j(tmpD(), 'lwh-authors-'));
    mkDir(j(vault, 'raw', 'uploads', 'v'), { recursive: true });
    writeF(j(vault, 'raw', 'uploads', 'v', 'paper.md'), '# V\ntranscript');
    mkDir(j(vault, '.harness'), { recursive: true });
    writeF(j(vault, '.harness', 'compile-queue.json'), JSON.stringify([{
      book: 'How semiconductors work', chapter: 'raw/uploads/v/paper.md',
      title: 'How semiconductors work', status: 'pending',
    }]));
    recordSource(vault, {
      book: 'How semiconductors work', title: 'How semiconductors work',
      authors: ['Branch Education'], attribution: 'verified',
      origin: { kind: 'video', url: 'https://youtu.be/x', platform: 'YouTube' },
      addedAt: new Date().toISOString(),
    });

    const model = turnsModel([
      {
        toolCalls: [{
          toolName: 'write_page',
          input: {
            slug: 'doping', title: 'Doping', body: 'x', sources: [],
            authors: ['3Blue1Brown'], // the model's own guess, from the incident
          },
        }],
      },
      { text: 'done' },
    ]);

    const seen: any[] = [];
    const res = await compileNext(seeingLw(seen), { vault, student: 'kid', models: {} } as any, 1,
      { model });
    expect(res).toEqual({ compiled: 1, failed: 0 });
    expect(seen[0].authors).toEqual(['Branch Education']);
  });

  it('the weak-model fallback path inherits the authors too — it writes through the same wrapper', async () => {
    const { recordSource } = await import('../src/server/provenance.js');
    const { textModel } = await import('./mockModel.js');
    const vault = mkTmp(j(tmpD(), 'lwh-authors-fb-'));
    mkDir(j(vault, 'raw', 'uploads', 'v'), { recursive: true });
    writeF(j(vault, 'raw', 'uploads', 'v', 'paper.md'), '# V\ntranscript');
    mkDir(j(vault, '.harness'), { recursive: true });
    writeF(j(vault, '.harness', 'compile-queue.json'), JSON.stringify([{
      book: 'How semiconductors work', chapter: 'raw/uploads/v/paper.md',
      title: 'How semiconductors work', status: 'pending',
    }]));
    recordSource(vault, {
      book: 'How semiconductors work', title: 'How semiconductors work',
      authors: ['Branch Education'], attribution: 'verified',
      origin: { kind: 'video', url: 'https://youtu.be/x', platform: 'YouTube' },
      addedAt: new Date().toISOString(),
    });

    // Narrates instead of tool-calling (agentic pass empty), then answers the forced schema — the
    // harness-driven distillation branch, which calls write_page itself and never sees `authors`.
    const { model } = textModel(JSON.stringify({
      title: 'Doping Distilled', body: 'Adding impurities changes a semiconductor’s carriers.',
    }));

    const seen: any[] = [];
    const res = await compileNext(seeingLw(seen), { vault, student: 'kid', models: {} } as any, 1,
      { model });
    expect(res).toEqual({ compiled: 1, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0].authors).toEqual(['Branch Education']);
    expect(seen[0].sources).toContain('How semiconductors work — How semiconductors work');
  });

  it('a video-sourced compile also linkifies plain [M:SS] stamps in the body', async () => {
    const vault = mkTmp(j(tmpD(), 'lwh-vstamp-'));
    mkDir(j(vault, 'raw', 'uploads', 'v'), { recursive: true });
    writeF(j(vault, 'raw', 'uploads', 'v', 'paper.md'), '# V\ntranscript');
    mkDir(j(vault, '.harness'), { recursive: true });
    writeF(j(vault, '.harness', 'compile-queue.json'), JSON.stringify([{
      book: 'The essence of calculus', chapter: 'raw/uploads/v/paper.md', title: 'The essence of calculus',
      status: 'pending', sourceUrl: 'https://www.youtube.com/watch?v=WUvTyaaNkzM',
    }]));

    const stampModel = turnsModel([
      { toolCalls: [{ toolName: 'write_page', input: { slug: 'rings', title: 'Rings', body: 'slice the disk ([2:40])', sources: [] } }] },
      { text: 'done' },
    ]);

    const seen: any[] = [];
    const res = await compileNext(seeingLw(seen), { vault, student: 'kid', models: {} } as any, 1,
      { model: stampModel });
    expect(res).toEqual({ compiled: 1, failed: 0 });
    expect(seen[0].body).toBe('slice the disk ([\\[2:40\\]](https://www.youtube.com/watch?v=WUvTyaaNkzM&t=160s))');
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

  // B2c: a repo ingest's whole lifetime (clone/docs/mine/seed) lives behind ONE 'converting'
  // placeholder (mode: 'repo') — a server restart mid-ingest must sweep it the same way a book
  // conversion sweeps, just with a message that points at re-running the ingest, not re-uploading
  // a file (there's no upload to re-do).
  it('sweeps an interrupted repo-ingest placeholder to convert-error with a repo-specific message', () => {
    const vault = mkT(jn(tD(), 'lwh-sweep-repo-'));
    mkD(jn(vault, '.harness'), { recursive: true });
    wF(jn(vault, '.harness', 'compile-queue.json'), JSON.stringify([
      {
        book: 'my-repo', chapter: '__ingesting_repo__/x', title: 'Ingesting repo…', mode: 'repo',
        status: 'converting', phase: 'mining…',
      },
    ]));
    expect(sweepInterruptedConversions(vault)).toBe(1);
    const q = rq(vault);
    expect(q[0].status).toBe('convert-error');
    expect(q[0].error).toMatch(/re-run the repo ingest/);
  });
});


describe('buildCompilePrompt slug cap', async () => {
  const { buildCompilePrompt } = await import('../src/server/ingest.js');
  it('small vaults inline every slug as link candidates', () => {
    const p = buildCompilePrompt('B', 1, 'C', 'body', ['a', 'b']);
    expect(p).toContain('Existing vault slugs');
    expect(p).toContain('a, b');
  });
  it('past the cap, points at write_page proposals instead of a thousand-token list', () => {
    const slugs = Array.from({ length: 400 }, (_, i) => `s${i}`);
    const p = buildCompilePrompt('B', 1, 'C', 'body', slugs);
    expect(p).toContain('400 pages — too many to list');
    expect(p).not.toContain('s200');
    expect(p).toMatch(/write_page proposes/);
  });
});

describe('the source spine — compile records the book\'s own order', async () => {
  const { sourceFor } = await import('../src/server/provenance.js');
  const { writeQueue } = await import('../src/server/queueStore.js');

  const TWO_CHAPTERS = [
    '# Photosynthesis Basics',
    'Plants convert light into chemical energy using chlorophyll.',
    '# Cellular Respiration',
    'Cells break down glucose to release usable energy.',
  ].join('\n');

  /** A fake Engram whose write_page just succeeds — the spine is collected in the harness's
   * wrapper, above whatever engram does with the page. */
  const fakeLw = () => ({
    listSlugs: async () => [],
    tools: async () => [{
      name: 'write_page', description: 'w', inputSchema: { type: 'object' },
      execute: async () => ({ ok: true }),
    }],
  }) as any;

  const promptOf = (req: any) => req.messages
    .map((m: any) => m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n'))
    .join('\n');

  async function twoChapterVault(name: string) {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-spine-compile-'));
    const cfg = { vault, student: 'kid', models: {} } as unknown as HarnessConfig;
    await ingestBook(cfg, `/uploads/${name}.pdf`, { converter: async () => ({ markdown: TWO_CHAPTERS }) });
    return { vault, cfg };
  }

  it('captures each chapter\'s pages in write_page call order, under the right ordinal', async () => {
    const { vault, cfg } = await twoChapterVault('Spine Book');
    // Deliberately not alphabetical: the spine must be the order the pages were WRITTEN, which is
    // the order the chapter presents them, not any order we could have sorted our way to.
    const perChapter: Record<string, string[]> = {
      'Photosynthesis Basics': ['light-reactions', 'calvin-cycle'],
      'Cellular Respiration': ['glycolysis'],
    };
    const model = streamModel((req) => {
      if (sawToolResult(req)) return { text: 'done' };
      const prompt = promptOf(req);
      const chapter = Object.keys(perChapter).find((t) => prompt.includes(t))!;
      return {
        toolCalls: perChapter[chapter].map((slug) => ({
          toolName: 'write_page',
          input: { slug, title: slug, body: `Body for ${slug}.`, sources: [] },
        })),
      };
    });

    expect(await compileNext(fakeLw(), cfg, 2, { model })).toEqual({ compiled: 2, failed: 0 });

    expect(sourceFor(vault, 'Spine Book')?.spine).toEqual([
      {
        chapter: 'raw/uploads/spine-book/ch-01-photosynthesis-basics.md',
        chapterOrdinal: 1,
        title: 'Photosynthesis Basics',
        pages: ['light-reactions', 'calvin-cycle'],
      },
      {
        chapter: 'raw/uploads/spine-book/ch-02-cellular-respiration.md',
        chapterOrdinal: 2,
        title: 'Cellular Respiration',
        pages: ['glycolysis'],
      },
    ]);
  });

  it('the weak-model fallback contributes its page too — both routes write through one wrapper', async () => {
    const { vault, cfg } = await twoChapterVault('Weak Spine Book');
    // Narrates instead of tool-calling (the agentic pass comes back empty), then answers the forced
    // schema — the harness-driven distillation, whose write_page the model never sees.
    const { model } = textModel(JSON.stringify({
      title: 'Distilled Concept', body: 'A distilled explanation of this chapter part.',
    }));

    expect(await compileNext(fakeLw(), cfg, 2, { model })).toEqual({ compiled: 2, failed: 0 });

    const spine = sourceFor(vault, 'Weak Spine Book')?.spine;
    expect(spine).toHaveLength(2);
    // The slug recorded is the one the FALLBACK chose (freshSlug off the distilled title), not
    // anything the model handed to a tool — it never called one.
    expect(spine?.map((s) => s.pages)).toEqual([['distilled-concept'], ['distilled-concept']]);
    expect(spine?.map((s) => s.chapterOrdinal)).toEqual([1, 2]);
  });

  it('recompiling a chapter REPLACES its slice rather than appending a second one', async () => {
    const { vault, cfg } = await twoChapterVault('Recompiled Book');
    const writes = (slugs: string[]) => streamModel((req) => (sawToolResult(req) ? { text: 'done' } : {
      toolCalls: slugs.map((slug) => ({
        toolName: 'write_page', input: { slug, title: slug, body: `Body for ${slug}.`, sources: [] },
      })),
    }));

    await compileNext(fakeLw(), cfg, 1, { model: writes(['first-pass-page']) });
    // Re-queue chapter 1 exactly as a "compile again" would, and compile it with a better model.
    writeQueue(vault, readQueue(vault).map((e) => (
      e.chapter.includes('ch-01') ? { ...e, status: 'pending' as const } : e)));
    await compileNext(fakeLw(), cfg, 1, { model: writes(['second-pass-page', 'and-another']) });

    const spine = sourceFor(vault, 'Recompiled Book')?.spine;
    expect(spine).toHaveLength(1); // chapter 2 was never compiled; chapter 1 has ONE slice
    expect(spine?.[0].pages).toEqual(['second-pass-page', 'and-another']);
  });

  it('a paper records no spine — one unit of work has no order to preserve', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-spine-paper-'));
    const cfg = { vault, student: 'kid', models: {} } as unknown as HarnessConfig;
    await ingestBook(cfg, '/uploads/whatever.pdf', {
      mode: 'paper', converter: async () => ({ markdown: '# Attention Is All You Need\nBody.' }),
    });
    const model = streamModel((req) => (sawToolResult(req) ? { text: 'done' } : {
      toolCalls: [{ toolName: 'write_page', input: { slug: 'attention', title: 'Attention', body: 'x', sources: [] } }],
    }));

    expect(await compileNext(fakeLw(), cfg, 1, { model })).toEqual({ compiled: 1, failed: 0 });
    expect(sourceFor(vault, 'Attention Is All You Need')?.spine).toBeUndefined();
  });
});
