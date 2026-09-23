import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UIMessage } from '../src/shared/uiMessages.js';
import type { HarnessConfig } from '../src/server/config.js';
import { Engram } from '../src/server/mcp.js';
import {
  MIN_LESSON_CHARS, enqueueLessonNotes, isTeachingTurn, lessonTurnFromParts, type LessonTurn,
} from '../src/server/lessonNotes.js';
import { readQueue, type QueueEntry } from '../src/server/queueStore.js';
import { zeroUsage, type ChatModel, type ChatRequest } from '../src/server/llm/index.js';
import { compileOne } from '../src/server/ingest.js';
import { LW_REPO } from './lwRepo.js';

const LONG_TEXT = 'x'.repeat(MIN_LESSON_CHARS);

function assistantText(text: string): UIMessage {
  return { id: 'a1', role: 'assistant', parts: [{ type: 'text', text }] };
}

function baseTurn(overrides: Partial<LessonTurn> = {}): LessonTurn {
  return {
    threadId: 't1', topicSlug: 'inference-batching', endedAt: '2026-09-22T10:00:00.000Z',
    tutorText: LONG_TEXT, exchanges: [], sources: [],
    ...overrides,
  };
}

describe('isTeachingTurn', () => {
  it('is false for a bare greeting', () => {
    expect(isTeachingTurn(baseTurn(), { gradingOnly: false, bareGreeting: true, progressQuestion: false })).toBe(false);
  });

  it('is false for a progress question', () => {
    expect(isTeachingTurn(baseTurn(), { gradingOnly: false, bareGreeting: false, progressQuestion: true })).toBe(false);
  });

  it('is false for a grading-only turn', () => {
    expect(isTeachingTurn(baseTurn(), { gradingOnly: true, bareGreeting: false, progressQuestion: false })).toBe(false);
  });

  it('is false when the tutor prose is under MIN_LESSON_CHARS', () => {
    const turn = baseTurn({ tutorText: 'short answer' });
    expect(isTeachingTurn(turn, { gradingOnly: false, bareGreeting: false, progressQuestion: false })).toBe(false);
  });

  it('is true for a real teaching turn', () => {
    expect(isTeachingTurn(baseTurn(), { gradingOnly: false, bareGreeting: false, progressQuestion: false })).toBe(true);
  });

  it('is true when short prose plus a block prompt together clear MIN_LESSON_CHARS', () => {
    // ~350 chars of prose alone would fail the old prose-only gate; the concept here lives in the
    // quick_check prompt, not the prose, which is exactly the live-turn shape this counts for.
    const prose = 'x'.repeat(350);
    const prompt = 'A serving system waits briefly to combine several model requests into one '
      + 'batch. What is the most likely tradeoff?'; // ~100 chars
    const turn = baseTurn({ tutorText: prose, exchanges: [{ prompt, answer: 'irrelevant' }] });
    expect(isTeachingTurn(turn, { gradingOnly: false, bareGreeting: false, progressQuestion: false })).toBe(true);
  });

  it('is false when prose plus block prompts together still fall under MIN_LESSON_CHARS', () => {
    const prose = 'x'.repeat(150);
    const prompt = 'y'.repeat(60);
    const turn = baseTurn({ tutorText: prose, exchanges: [{ prompt, answer: 'irrelevant' }] });
    expect(isTeachingTurn(turn, { gradingOnly: false, bareGreeting: false, progressQuestion: false })).toBe(false);
  });

  // Chat answers from memory all day; compiling each long answer would fill the vault with
  // unsourced pages nobody asked for. A chat turn becomes pages only when it researched something
  // or put the learner to work.
  describe('in chat', () => {
    const chat = { gradingOnly: false, bareGreeting: false, progressQuestion: false, chat: true };
    it('is false for a long answer from memory', () => {
      expect(isTeachingTurn(baseTurn(), chat)).toBe(false);
    });
    it('is true when the turn researched', () => {
      expect(isTeachingTurn(baseTurn({ sources: [{ url: 'https://example.org/a' }] }), chat)).toBe(true);
    });
    it('is true when the turn used a block', () => {
      expect(isTeachingTurn(baseTurn({ exchanges: [{ prompt: 'why?', answer: '' }] }), chat)).toBe(true);
    });
    it('still needs enough to say', () => {
      const turn = baseTurn({ tutorText: 'short', sources: [{ url: 'https://example.org/a' }] });
      expect(isTeachingTurn(turn, chat)).toBe(false);
    });
  });
});

describe('lessonTurnFromParts', () => {
  it('extracts tutor prose, a quick_check exchange, and research URLs from realistic UI parts', () => {
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: LONG_TEXT },
        // Anthropic's web_search_tool_result content shape: an array of result objects.
        {
          type: 'tool-web_search', toolCallId: 'srv_1', state: 'output-available', providerExecuted: true,
          input: { query: 'inference batching' },
          output: [{ url: 'https://a.example/batching', title: 'Batching basics' }],
        },
        // read_url part — the input names the URL, regardless of provider.
        {
          type: 'tool-read_url', toolCallId: 'ru_1', state: 'output-available',
          input: { url: 'https://b.example/queueing' },
          output: { url: 'https://b.example/queueing', text: '...' },
        },
        {
          type: 'tool-quick_check', toolCallId: 'qc_1', state: 'output-available',
          input: { question: 'What does batching trade off?', mode: 'text', pageSlug: 'inference-batching' },
          output: { answer: 'latency for throughput', grading: { verdict: 'applied-correctly' } },
        },
      ],
    };

    const turn = lessonTurnFromParts('t1', 'inference-batching', '2026-09-22T10:00:00.000Z', message);

    expect(turn.threadId).toBe('t1');
    expect(turn.topicSlug).toBe('inference-batching');
    expect(turn.tutorText).toBe(LONG_TEXT);
    expect(turn.exchanges).toEqual([
      { prompt: 'What does batching trade off?', answer: 'latency for throughput', verdict: 'applied-correctly' },
    ]);
    expect(turn.sources).toEqual(expect.arrayContaining([
      { url: 'https://a.example/batching', title: 'Batching basics' },
      { url: 'https://b.example/queueing', title: undefined },
    ]));
    expect(turn.sources).toHaveLength(2);
  });

  it('extracts sources from the OpenAI Responses shape ({ query, sources })', () => {
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: LONG_TEXT },
        {
          type: 'tool-web_search', toolCallId: 'srv_1', state: 'output-available', providerExecuted: true,
          input: { query: 'queue vs generation latency' },
          output: { query: 'queue vs generation latency', sources: [{ url: 'https://c.example/lat', title: 'Latency' }] },
        },
      ],
    };
    const turn = lessonTurnFromParts('t1', null, '2026-09-22T10:00:00.000Z', message);
    expect(turn.sources).toEqual([{ url: 'https://c.example/lat', title: 'Latency' }]);
    expect(turn.topicSlug).toBeNull();
  });

  it('produces no exchanges or sources for plain prose with no tool parts', () => {
    const turn = lessonTurnFromParts('t1', null, '2026-09-22T10:00:00.000Z', assistantText(LONG_TEXT));
    expect(turn.exchanges).toEqual([]);
    expect(turn.sources).toEqual([]);
  });
});

describe('enqueueLessonNotes', () => {
  function makeCfg(vault: string): HarnessConfig {
    return {
      vault, student: 'kid', autoCompile: false,
      models: { compile: { model: 'claude-lesson-test' } },
    } as unknown as HarnessConfig;
  }
  const noopLw = {} as Engram;

  it('writes the lesson file under raw/uploads/lesson-notes/<threadId>/ and a mode: lesson queue entry', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-lesson-vault-'));
    mkdirSync(join(vault, 'pages'), { recursive: true });
    const turn = baseTurn({
      threadId: 'thread-abc',
      sources: [{ url: 'https://a.example/x', title: 'X' }],
    });

    await enqueueLessonNotes(vault, turn, { lw: noopLw, cfg: makeCfg(vault) });

    const ledger = readQueue(vault);
    expect(ledger).toHaveLength(1);
    const entry = ledger[0];
    expect(entry.mode).toBe('lesson');
    expect(entry.book).toBe('lesson-notes');
    expect(entry.status).toBe('pending');
    expect(entry.lessonTopic).toBe('inference-batching');
    expect(entry.sourceUrls).toEqual(['https://a.example/x']);
    expect(entry.chapter).toMatch(/^raw\/uploads\/lesson-notes\/thread-abc\//);

    const fileContents = readFileSync(join(vault, entry.chapter), 'utf8');
    expect(fileContents).toContain(LONG_TEXT);
    expect(fileContents).toContain('https://a.example/x');
  });

  it('never enqueues twice for the same turn', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-lesson-vault-'));
    mkdirSync(join(vault, 'pages'), { recursive: true });
    const turn = baseTurn({ threadId: 'thread-dup' });
    const cfg = makeCfg(vault);

    await enqueueLessonNotes(vault, turn, { lw: noopLw, cfg });
    await enqueueLessonNotes(vault, turn, { lw: noopLw, cfg });

    const ledger = readQueue(vault).filter((e) => e.book === 'lesson-notes');
    expect(ledger).toHaveLength(1);
  });
});

// compileOne's lesson branch: the compile model must be told the 3-concept / search-first /
// link-to-topic / cite-sourceUrls rules — asserted on the actual prompt text the model receives,
// not on a mock call count. `lw` is faked to the two methods compileOne actually calls (tools(),
// listSlugs()) — no real Engram/MCP process needed to see what prompt a compile model was shown.
describe('compileOne — lesson branch prompt', () => {
  function fakeLw(writePage: (args: unknown) => Promise<unknown>): Engram {
    return {
      async listSlugs() { return []; },
      async tools() {
        return [
          { name: 'write_page', description: '', inputSchema: {}, execute: writePage },
          { name: 'search', description: '', inputSchema: {}, execute: async () => ({ results: [] }) },
        ];
      },
      async call() { return {}; },
    } as unknown as Engram;
  }

  function promptText(req: ChatRequest): string {
    const parts = req.messages.map((m) => m.content.filter((p) => p.type === 'text').map((p) => (p as any).text).join('\n'));
    if (req.system !== undefined) parts.unshift(req.system);
    return parts.join('\n');
  }

  it('adds the lesson-mode rules to the prompt and links to lessonTopic / cites sourceUrls', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-lesson-compile-'));
    mkdirSync(join(vault, 'pages'), { recursive: true });
    const chapterRel = 'raw/uploads/lesson-notes/thread-xyz/2026-09-22t10-00-00.md';
    mkdirSync(join(vault, 'raw/uploads/lesson-notes/thread-xyz'), { recursive: true });
    writeFileSync(join(vault, chapterRel), `${LONG_TEXT}\n`);

    const prompts: string[] = [];
    let calls = 0;
    const model: ChatModel = {
      async generate() { throw new Error('unused — compileOne streams'); },
      async *stream(req) {
        prompts.push(promptText(req));
        const n = calls++;
        if (n === 0) {
          yield {
            type: 'tool-call', toolCallId: 'c1', toolName: 'write_page',
            input: { slug: 'batching-concept', title: 'Batching', body: 'b'.repeat(200), status: 'draft' },
          };
          yield { type: 'finish', reason: 'tool-calls', usage: zeroUsage() };
        } else {
          yield { type: 'text-start', id: '0' };
          yield { type: 'text-delta', id: '0', text: 'done' };
          yield { type: 'text-end', id: '0' };
          yield { type: 'finish', reason: 'stop', usage: zeroUsage() };
        }
      },
    };

    const cfg = {
      vault, student: 'kid', autoCompile: false,
      models: { compile: { model: 'claude-lesson-test' } },
    } as unknown as HarnessConfig;

    const written: unknown[] = [];
    const lw = fakeLw(async (args) => { written.push(args); return { proposedLinks: [] }; });

    const entry = {
      book: 'lesson-notes', chapter: chapterRel, title: 'Lesson notes: inference-batching',
      status: 'compiling' as const, mode: 'lesson' as const,
      lessonTopic: 'inference-batching', sourceUrls: ['https://a.example/batching'],
    };

    const outcome = await compileOne(lw, cfg, model, entry, 24_000);

    expect(outcome).toBe('compiled');
    expect(written).toHaveLength(1);
    const prompt = prompts[0];
    expect(prompt).toContain('AT MOST 3');
    expect(prompt).toContain('search');
    expect(prompt).toContain('inference-batching');
    expect(prompt).toContain('https://a.example/batching');
    expect(prompt).toContain('draft');
  });
});

// compileOne's lesson-mode write_page wrapper (withLessonRules), exercised against a REAL Engram
// process the way tests/compileDrain.test.ts does — assertions land on actual vault page files, not
// a fake execute() that only proves a mock was called. This is the mechanical fix for a live
// incident: a lesson compile's write_page landed fake citations on every page (1)/(2), and once
// silently destroyed a real 'solid' page's real citations by overwriting it (3). (4) pins the one
// carve-out (a 'stub' page may still be upgraded).
describe('compileOne — lesson branch write_page rules (real Engram)', () => {
  let lw: Engram;
  let vault: string;
  let cfg: HarnessConfig;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), 'lwh-lesson-rules-'));
    mkdirSync(join(vault, 'pages'), { recursive: true });
    cfg = {
      vault, student: 'kid', autoCompile: false,
      models: { compile: { model: 'claude-lesson-rules-test' } },
      engram: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
    } as unknown as HarnessConfig;
    lw = await Engram.connect(cfg);
  }, 30_000);
  afterAll(async () => { await lw.close(); });

  function lessonEntry(overrides: Partial<QueueEntry> & { chapter: string }): QueueEntry {
    return {
      book: 'lesson-notes', title: 'Lesson notes: rust-ownership', status: 'compiling',
      mode: 'lesson', ...overrides,
    };
  }

  function writeLessonFile(threadId: string): string {
    const chapter = `raw/uploads/lesson-notes/${threadId}/note.md`;
    mkdirSync(join(vault, 'raw/uploads/lesson-notes', threadId), { recursive: true });
    writeFileSync(join(vault, chapter), `${LONG_TEXT}\n`);
    return chapter;
  }

  // One write_page call, then a plain-text "done" — the shape every case below scripts.
  function oneWriteThenDone(input: unknown): ChatModel {
    let calls = 0;
    return {
      async generate() { throw new Error('unused — compileOne streams'); },
      async *stream() {
        const n = calls++;
        if (n === 0) {
          yield { type: 'tool-call', toolCallId: 'c1', toolName: 'write_page', input };
          yield { type: 'finish', reason: 'tool-calls', usage: zeroUsage() };
        } else {
          yield { type: 'text-start', id: '0' };
          yield { type: 'text-delta', id: '0', text: 'done' };
          yield { type: 'text-end', id: '0' };
          yield { type: 'finish', reason: 'stop', usage: zeroUsage() };
        }
      },
    };
  }

  const REAL_URL = 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html';

  it('keeps only the URL present in entry.sourceUrls, dropping "lesson-notes"/"chapter 1"', async () => {
    const chapter = writeLessonFile('t-case1');
    // entry.sourceUrls carries a trailing slash the model's own citation does not — proves the
    // trim/trailing-slash normalization, not just an exact string match.
    const entry = lessonEntry({ chapter, sourceUrls: [`${REAL_URL}/`] });
    const model = oneWriteThenDone({
      slug: 'rust-ownership-real-url', title: 'Ownership (real url)', body: 'b'.repeat(200),
      status: 'solid', sources: ['lesson-notes', 'chapter 1', REAL_URL],
    });

    const outcome = await compileOne(lw, cfg, model, entry, 24_000);
    expect(outcome).toBe('compiled');

    const { page } = await lw.call('read_page', { slug: 'rust-ownership-real-url' });
    expect(page.meta.sources).toEqual([REAL_URL]);
    expect(page.meta.status).toBe('solid'); // a real, non-empty source list is never forced to draft
  }, 15_000);

  it('drops every source with no match in entry.sourceUrls and forces status draft', async () => {
    const chapter = writeLessonFile('t-case2');
    const entry = lessonEntry({ chapter }); // no sourceUrls — this turn cited no research
    const model = oneWriteThenDone({
      slug: 'rust-ownership-no-url', title: 'Ownership (no url)', body: 'b'.repeat(200),
      status: 'solid', sources: ['lesson-notes', 'chapter 1'],
    });

    const outcome = await compileOne(lw, cfg, model, entry, 24_000);
    expect(outcome).toBe('compiled');

    const { page } = await lw.call('read_page', { slug: 'rust-ownership-no-url' });
    expect(page.meta.sources).toEqual([]);
    expect(page.meta.status).toBe('draft');
  }, 15_000);

  it('refuses to overwrite an existing non-stub page, leaving it byte-identical on disk', async () => {
    // The live incident, reproduced directly: a real page the tutor already wrote, solid status,
    // real sources — a lesson compile must never touch it.
    await lw.call('write_page', {
      slug: 'rust-ownership-and-moves', title: 'Rust Ownership and Moves', body: 'The real body.',
      status: 'solid',
      sources: [REAL_URL, 'https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html'],
    });
    const pageFile = join(vault, 'pages', 'rust-ownership-and-moves.md');
    const before = readFileSync(pageFile, 'utf8');

    const chapter = writeLessonFile('t-case3');
    const entry = lessonEntry({ chapter, sourceUrls: [REAL_URL] });
    const seenRequests: ChatRequest[] = [];
    const model: ChatModel = {
      async generate() { throw new Error('unused — compileOne streams'); },
      async *stream(req) {
        seenRequests.push(req);
        if (seenRequests.length === 1) {
          yield {
            type: 'tool-call', toolCallId: 'c1', toolName: 'write_page',
            input: {
              slug: 'rust-ownership-and-moves', title: 'Rust Ownership and Moves (redo)',
              body: 'clobbered', status: 'draft', sources: ['lesson-notes', 'chapter 1'],
            },
          };
          yield { type: 'finish', reason: 'tool-calls', usage: zeroUsage() };
        } else {
          yield { type: 'text-start', id: '0' };
          yield { type: 'text-delta', id: '0', text: 'noted — linking instead' };
          yield { type: 'text-end', id: '0' };
          yield { type: 'finish', reason: 'stop', usage: zeroUsage() };
        }
      },
    };

    await compileOne(lw, cfg, model, entry, 24_000);

    // The model's SECOND request transcript carries the refusal as a tool result it can read —
    // asserted on the actual mechanical output, not on whether some function was called.
    const secondReq = seenRequests[1];
    const toolResult = secondReq.messages
      .flatMap((m) => m.content)
      .find((p: any) => p.type === 'tool-result' && p.toolName === 'write_page') as any;
    expect(toolResult.output.isError).toBe(true);
    expect(toolResult.output.content[0].text).toContain('already exists');
    expect(toolResult.output.content[0].text).toContain('link_pages');

    const after = readFileSync(pageFile, 'utf8');
    expect(after).toBe(before);
  }, 15_000);

  it('upgrades an existing STUB page and keeps its old sources', async () => {
    const OLD_URL = 'https://old-source.example/pre-existing';
    await lw.call('write_page', {
      slug: 'rust-ownership-stub-concept', title: 'Ownership Stub', body: 'stub body',
      status: 'stub', sources: [OLD_URL],
    });

    const chapter = writeLessonFile('t-case4');
    const entry = lessonEntry({ chapter, sourceUrls: [REAL_URL] });
    const model = oneWriteThenDone({
      slug: 'rust-ownership-stub-concept', title: 'Ownership (upgraded)', body: 'b'.repeat(200),
      status: 'solid', sources: ['lesson-notes', REAL_URL],
    });

    const outcome = await compileOne(lw, cfg, model, entry, 24_000);
    expect(outcome).toBe('compiled');

    const { page } = await lw.call('read_page', { slug: 'rust-ownership-stub-concept' });
    expect(new Set(page.meta.sources)).toEqual(new Set([OLD_URL, REAL_URL]));
    expect(page.meta.status).toBe('solid'); // no longer a stub
  }, 15_000);
});
