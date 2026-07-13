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
});
