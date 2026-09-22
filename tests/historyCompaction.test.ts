import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compactHistory, estimateTokens, historyBudgetTokens, planCompaction, fallbackSummary,
  renderForSummary, readBlocks, blocksToMessage, DEFAULT_HISTORY_BUDGET_TOKENS,
  type CompactionDeps, type HistorySummary,
} from '../src/server/historyCompaction.js';
import { deleteThread } from '../src/server/sessionStore.js';
import type { UIMessage } from '../src/shared/uiMessages.js';

let vault: string;
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'myelin-compaction-')); });
afterEach(() => rmSync(vault, { recursive: true, force: true }));

/** A turn: one user message and the tutor's reply, each padded so a few turns cross a small
 *  budget without the test having to write thousands of words. */
const turn = (n: number, chars = 4_000): UIMessage[] => [
  { id: `u${n}`, role: 'user', parts: [{ type: 'text', text: `question ${n} ${'x'.repeat(chars)}` }] },
  { id: `a${n}`, role: 'assistant', parts: [{ type: 'text', text: `answer ${n} ${'y'.repeat(chars)}` }] },
];
const thread = (turns: number, chars?: number): UIMessage[] =>
  Array.from({ length: turns }, (_, i) => turn(i + 1, chars)).flat();

const summarizer = (text = 'Covered derivatives; the student applied the chain rule correctly.') => {
  const calls: string[] = [];
  const deps: CompactionDeps = {
    summarize: async (prompt) => {
      calls.push(prompt);
      return { summary: text, openThreads: ['the integral exercise was offered but not taken'] };
    },
  };
  return { deps, calls };
};

describe('estimating and budgeting', () => {
  it('counts text, tool inputs and tool outputs — the whole wire cost of a message', () => {
    const withTool: UIMessage[] = [{
      id: 'a1', role: 'assistant',
      parts: [
        { type: 'text', text: 'x'.repeat(400) },
        { type: 'tool-quick_check', toolCallId: 't1', state: 'output-available',
          input: { question: 'q'.repeat(200) }, output: { answer: 'a'.repeat(200) } } as any,
      ],
    }];
    // 400 text + ~200 input + ~200 output + the tool name, over four chars per token.
    expect(estimateTokens(withTool)).toBeGreaterThan(200);
    expect(estimateTokens(withTool)).toBeLessThan(300);
  });

  it('takes the declared context window minus a reserve, and falls back to the default', () => {
    expect(historyBudgetTokens(64_000)).toBe(48_000);
    expect(historyBudgetTokens(undefined)).toBe(DEFAULT_HISTORY_BUDGET_TOKENS);
    // A tiny window still leaves a floor rather than a negative budget.
    expect(historyBudgetTokens(8_000)).toBe(4_000);
  });
});

describe('planCompaction', () => {
  it('returns 0 while the thread fits — the overwhelmingly common case', () => {
    expect(planCompaction(thread(4), 100_000, 0)).toBe(0);
  });

  it('cuts only at a turn boundary, so a turn is never half-summarized', () => {
    const messages = thread(20);
    const cut = planCompaction(messages, 10_000, 0);
    expect(cut).toBeGreaterThan(0);
    // Every cut index is a user message: the start of a turn.
    expect(messages[cut]!.role).toBe('user');
  });

  it('always leaves the last six turns verbatim, however tight the budget', () => {
    const messages = thread(10);
    const cut = planCompaction(messages, 1, 0);
    // 10 turns, 6 kept → at most 4 turns (8 messages) may go.
    expect(cut).toBeLessThanOrEqual(8);
    expect(messages.length - cut).toBeGreaterThanOrEqual(12);
  });

  it('refuses to compact a short thread even when it is over budget', () => {
    // Five turns is fewer than MIN_KEEP_TURNS: there is no legal boundary, so nothing moves.
    expect(planCompaction(thread(5, 40_000), 1_000, 0)).toBe(0);
  });

  it('overshoots the budget so it does not fire again on the very next turn', () => {
    const messages = thread(40, 1_000);
    const cut = planCompaction(messages, 10_000, 0);
    expect(estimateTokens(messages.slice(cut))).toBeLessThanOrEqual(10_000 * 0.6);
  });

  // The floor is reachable: a budget small relative to a turn leaves the thread over budget even
  // with only MIN_KEEP_TURNS left. Compacting one more turn per request there would mean a
  // summarization call and a cache miss on EVERY turn — worse than the overflow it prevents.
  it('does not nibble one turn at a time once the keep-floor binds', () => {
    const messages = thread(20);
    const first = planCompaction(messages, 10_000, 0);
    expect(first).toBeGreaterThan(0);
    // One more turn arrives; there is no longer a chunk worth taking, so nothing moves.
    const later = [...messages, ...turn(21)];
    expect(planCompaction(later, 10_000, first)).toBe(0);
  });
});

describe('compactHistory', () => {
  it('returns the same array identity when nothing needs compacting', async () => {
    const messages = thread(3);
    const { deps, calls } = summarizer();
    const out = await compactHistory({ vault, threadId: 't', messages, budgetTokens: 100_000, deps });
    expect(out.messages).toBe(messages);
    expect(out.compacted).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('replaces the compacted prefix with one summary message and keeps the recent turns whole', async () => {
    const messages = thread(20);
    const { deps, calls } = summarizer();
    const out = await compactHistory({ vault, threadId: 't', messages, budgetTokens: 10_000, deps });
    expect(calls).toHaveLength(1);
    expect(out.newBlock).toBe(true);
    // One synthetic user message, then the untouched tail.
    expect(out.messages[0]!.role).toBe('user');
    expect(out.messages[0]!.id).toMatch(/^compaction-/);
    const text = (out.messages[0]!.parts[0] as any).text;
    expect(text).toContain('Covered derivatives');
    expect(text).toContain('summarized below');
    expect(text).toContain('the integral exercise was offered but not taken');
    expect(out.messages.slice(1)).toEqual(messages.slice(out.compacted));
    // And it actually achieved the point of the exercise.
    expect(estimateTokens(out.messages)).toBeLessThan(estimateTokens(messages));
  });

  // THE property the whole design exists for. A summary recomputed each turn would change bytes
  // near the front of the transcript on every request and destroy the prompt cache — which costs
  // more than the overflow it prevents.
  it('reuses the stored summary verbatim on later turns instead of re-summarizing', async () => {
    const messages = thread(20);
    const { deps, calls } = summarizer();
    const first = await compactHistory({ vault, threadId: 't', messages, budgetTokens: 10_000, deps });
    expect(calls).toHaveLength(1);

    // The next turn arrives: same history plus one more exchange.
    const later = [...messages, ...turn(21)];
    const second = await compactHistory({ vault, threadId: 't', messages: later, budgetTokens: 10_000, deps });
    expect(calls).toHaveLength(1); // no second summarization
    expect(second.newBlock).toBe(false);
    // Byte-identical prefix — the cache survives.
    expect(second.messages[0]).toEqual(first.messages[0]);
  });

  it('appends a second block without touching the first block\'s text', async () => {
    const { deps, calls } = summarizer();
    const first = await compactHistory({
      vault, threadId: 't', messages: thread(20), budgetTokens: 10_000, deps,
    });
    const firstText = (first.messages[0]!.parts[0] as any).text;

    // Twenty more turns: over budget again, so a second block is cut.
    const grown = thread(40);
    const second = await compactHistory({ vault, threadId: 't', messages: grown, budgetTokens: 10_000, deps });
    expect(calls).toHaveLength(2);
    expect(second.newBlock).toBe(true);
    const blocks = readBlocks(vault, 't');
    expect(blocks).toHaveLength(2);
    // The first block's own summary is untouched; the combined message simply carries both.
    expect(blocks[0]!.summary).toBe('Covered derivatives; the student applied the chain rule correctly.');
    expect(firstText).toContain(blocks[0]!.summary);
    expect((second.messages[0]!.parts[0] as any).text).toContain(blocks[0]!.summary);
  });

  // The header states its count to the model as fact, inside the message that stands in for
  // everything it replaced. Summing block.messages double-counted every earlier block: an
  // 80-message thread was reported as 96 compacted, a count that cannot exist.
  it('counts each compacted message once after a second block, not once per block', async () => {
    const { deps } = summarizer();
    await compactHistory({ vault, threadId: 't', messages: thread(20), budgetTokens: 10_000, deps });
    const grown = thread(40);
    const second = await compactHistory({ vault, threadId: 't', messages: grown, budgetTokens: 10_000, deps });
    expect(readBlocks(vault, 't')).toHaveLength(2);
    const text = (second.messages[0]!.parts[0] as any).text;
    const stated = Number(/first (\d+) messages/.exec(text)![1]);
    expect(stated).toBe(second.compacted);
    expect(stated).toBeLessThanOrEqual(grown.length);
  });

  it('falls back to a mechanical summary when the summarizer throws, and stores it', async () => {
    const deps: CompactionDeps = {
      summarize: async () => { throw new Error('model refused'); },
    };
    const messages = thread(20);
    const out = await compactHistory({ vault, threadId: 't', messages, budgetTokens: 10_000, deps });
    // The thread is still saved from overflow — that is the whole point of not throwing here.
    expect(out.compacted).toBeGreaterThan(0);
    const text = (out.messages[0]!.parts[0] as any).text;
    expect(text).toContain('could not be summarized by a model');
    expect(text).toContain('question 1');
    // Stored, so the fallback text is stable too rather than re-derived every turn.
    expect(readBlocks(vault, 't')).toHaveLength(1);
  });

  it('drops stored blocks whose messages are gone — a thread recreated under the same id', async () => {
    const { deps } = summarizer();
    await compactHistory({ vault, threadId: 't', messages: thread(20), budgetTokens: 10_000, deps });
    expect(readBlocks(vault, 't')).toHaveLength(1);
    // A brand-new conversation reusing the id: none of the stored ids are present.
    const fresh: UIMessage[] = [
      { id: 'new1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    ];
    const out = await compactHistory({ vault, threadId: 't', messages: fresh, budgetTokens: 10_000, deps });
    expect(out.messages).toBe(fresh);
    expect(out.compacted).toBe(0);
  });

  it('survives a corrupt block file rather than bricking the thread it was meant to save', async () => {
    mkdirSync(join(vault, '.harness', 'compaction'), { recursive: true });
    writeFileSync(join(vault, '.harness', 'compaction', 't.json'), 'not json at all');
    const { deps } = summarizer();
    const out = await compactHistory({ vault, threadId: 't', messages: thread(20), budgetTokens: 10_000, deps });
    expect(out.compacted).toBeGreaterThan(0);
  });
});

describe('the summarizer\'s inputs and the fallback', () => {
  it('renders the transcript with tool calls named and verdicts kept, not payloads dumped', () => {
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'teach me derivatives' }] },
      { id: 'a1', role: 'assistant', parts: [
        { type: 'text', text: 'Here is the chain rule.' },
        { type: 'tool-quick_check', toolCallId: 't1', state: 'output-available',
          input: { pageSlug: 'derivatives', question: 'q' },
          output: { answer: 'a', grading: { verdict: 'correct' } } } as any,
      ] },
    ];
    const rendered = renderForSummary(messages);
    expect(rendered).toContain('Student: teach me derivatives');
    expect(rendered).toContain('Tutor: Here is the chain rule. [quick_check → correct]');
  });

  it('the mechanical fallback names what was asked and what was graded', () => {
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'explain the chain rule' }] },
      { id: 'a1', role: 'assistant', parts: [
        { type: 'tool-quick_check', toolCallId: 't1', state: 'output-available',
          input: { pageSlug: 'derivatives' },
          output: { grading: { verdict: 'incorrect' } } } as any,
      ] },
    ];
    const out: HistorySummary = fallbackSummary(messages);
    expect(out.summary).toContain('explain the chain rule');
    expect(out.summary).toContain('derivatives → incorrect');
    expect(out.openThreads).toEqual([]);
  });

  it('reads the last block\'s cumulative count, so stacked blocks do not inflate the header', () => {
    const msg = blocksToMessage([
      { throughId: 'a9', messages: 18, summary: 'S1', openThreads: [], createdAt: 'now' },
      { throughId: 'a20', messages: 40, summary: 'S2', openThreads: [], createdAt: 'now' },
    ]);
    // 40 is the whole covered prefix; 18 + 40 would claim 58 messages of a 40-message thread.
    expect((msg.parts[0] as any).text).toContain('first 40 messages');
  });

  it('the synthetic message tells the tutor the vault outranks the precis', () => {
    const msg = blocksToMessage([
      { throughId: 'a9', messages: 18, summary: 'S', openThreads: [], createdAt: 'now' },
    ]);
    const text = (msg.parts[0] as any).text;
    expect(text).toContain('first 18 messages');
    expect(text).toContain('get_student_state');
    expect(msg.id).toBe('compaction-a9');
  });
});

describe('thread deletion', () => {
  it('removes the compaction blocks with the thread', async () => {
    const { deps } = summarizer();
    await compactHistory({ vault, threadId: 'gone', messages: thread(20), budgetTokens: 10_000, deps });
    const blockFile = join(vault, '.harness', 'compaction', 'gone.json');
    expect(existsSync(blockFile)).toBe(true);
    deleteThread(vault, 'gone');
    expect(existsSync(blockFile)).toBe(false);
  });
});
