import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatRequest } from '../src/server/llm/index.js';
import { Engram } from '../src/server/mcp.js';
import { createTutorSession } from '../src/server/session.js';
import { streamModel } from './mockModel.js';
import { LW_REPO } from './lwRepo.js';

let lw: Engram; let vault: string;

// A text-only reply (no record_evidence) — used to trip the guardrail — recording every
// ChatRequest the session sends so tests can assert the tools and context of each model call.
// structuredClone is safe here: the loop hands the model plain declarations (no execute closures).
const textOnly = () => {
  const calls: ChatRequest[] = [];
  const model = streamModel((req) => {
    calls.push(structuredClone(req));
    return { text: 'Nice work!' };
  });
  return { model, calls };
};

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), 'lwh-vault-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  // Two pages, and the difference between them is the point. `arith` is a page worth teaching from:
  // solid, sourced, and long enough to say something. `photosynthesis` is the shape a vault fills up
  // with if nobody checks — confident, on-topic, and citing nothing. session.ts's vaultGap treats the
  // second as a knowledge gap, so a one-line "status: solid" fixture would have made the
  // research-withheld test below pass for the wrong reason.
  writeFileSync(join(vault, 'pages', 'arith.md'),
    '---\ntitle: Arithmetic\ndifficulty: 1\nstatus: solid\nsources: ["https://example.edu/arithmetic"]\n---\n'
    + `Addition, subtraction, multiplication and division over the integers. ${'Detail. '.repeat(80)}`);
  writeFileSync(join(vault, 'pages', 'photosynthesis.md'),
    '---\ntitle: Photosynthesis\ndifficulty: 2\nstatus: solid\n---\n'
    + `Plants convert light into chemical energy. ${'Confident unsourced prose. '.repeat(40)}`);
  lw = await Engram.connect({
    vault, student: 'kid',
    engram: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
  } as any);
}, 30_000);
afterAll(async () => { await lw.close(); });

// A UIMessage history whose last assistant message contains a completed quick_check tool output.
const blockOutputHistory = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
  {
    id: 'a1', role: 'assistant', parts: [{
      type: 'tool-quick_check', toolCallId: 'tc1', state: 'output-available',
      input: { question: '2+2?', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' },
      output: { answer: '4' },
    }],
  },
] as any[];

describe('evidence guardrail', () => {
  it('nudges once when block output arrives but no record_evidence is called', async () => {
    const { model, calls } = textOnly();

    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any,
      { model, now: () => new Date('2026-07-12') });
    const res = await session.respond(blockOutputHistory, 'learn');
    await res.text(); // drain the stream

    expect(calls.length).toBe(2); // original + one nudged retry
    const secondPrompt = JSON.stringify(calls[1].messages);
    expect(secondPrompt).toMatch(/record_evidence/);
    // second violation logged
    expect(existsSync(join(vault, '.harness', 'guardrail.log'))).toBe(true);
    expect(readFileSync(join(vault, '.harness', 'guardrail.log'), 'utf8')).toMatch(/quick_check/);
  }, 30_000);

  it('does not nudge on plain conversation', async () => {
    const { model, calls } = textOnly();
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any, { model });
    const res = await session.respond([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any, 'learn');
    await res.text();
    expect(calls.length).toBe(1);
  }, 30_000);

  it('injects bootstrap context on first turn', async () => {
    const { model, calls } = textOnly();
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any, { model });
    await (await session.respond([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] as any, 'learn')).text();
    expect(JSON.stringify(calls[0].messages)).toMatch(/SESSION CONTEXT/);
  }, 30_000);

  // Context placement is a caching decision: the transcript's prefix is what the cache
  // breakpoints reuse, so per-turn HARNESS notes go at the TAIL (after the history) and only the
  // first turn's bootstrap leads. A prepended note would shift every byte of the history and
  // force a full input re-read on that turn and the next.
  it('puts per-turn harness notes at the tail of the transcript, bootstrap at the head', async () => {
    const { model, calls } = textOnly();
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any,
      { model, now: () => new Date('2026-07-12') });
    // A pristine history, not a clone of the shared fixture: earlier tests merge `grading` into
    // the fixture's output IN PLACE, and an already-graded output is (correctly) not re-graded —
    // which would make this a no-grades turn with no note to place.
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
      {
        id: 'a1', role: 'assistant', parts: [{
          type: 'tool-quick_check', toolCallId: 'tc-placement', state: 'output-available',
          input: { question: '2+2?', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' },
          output: { answer: '4' },
        }],
      },
    ] as any[];
    await (await session.respond(history, 'learn', 'placement-thread')).text();

    const msgs = calls[0].messages;
    const text = (m: any) => JSON.stringify(m.content);
    // The grades note is the LAST message — after the history it points back into, which is what
    // makes its "attached above" wording literally true.
    expect(text(msgs[msgs.length - 1])).toMatch(/graded block results attached above/);
    expect(msgs.slice(0, -1).map(text).join('')).not.toMatch(/graded block results/);

    // Turn 1: bootstrap is the head of a brand-new transcript, ahead of the user's first words.
    const first = textOnly();
    const s2 = createTutorSession(lw, { student: 'kid', vault, models: {} } as any, { model: first.model });
    await (await s2.respond([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] as any, 'learn')).text();
    expect(text(first.calls[0].messages[0])).toMatch(/SESSION CONTEXT/);
  }, 30_000);
});

describe('cold-start research unlock', () => {
  // researchGate.test.ts covers the DECISION against a stubbed scorer. This covers the WIRING:
  // that a teaching-mode turn actually hands the tutor the tools, and tells it they are there.
  // Those are separable — the gate returning true is worthless if session.ts still builds `[]`.
  const drive = async (text: string) => {
    const { model, calls } = textOnly();
    const session = createTutorSession(lw, {
      student: 'kid', vault, models: {},
      // A SearXNG that is never reached: the tool only has to EXIST for this test. The provider-
      // executed Anthropic tool cannot be used here because the model is injected, which is
      // exactly what session.ts's searchModelId is careful about.
      search: { searxng: 'http://127.0.0.1:1' },
    } as any, { model });
    await (await session.respond([{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }] as any, 'learn')).text();
    return {
      tools: (calls[0].tools ?? []).map((t: any) => t.name),
      // USER messages only, deliberately. The whole request includes the system prompt, which now
      // documents the gap-unlock line verbatim — so a whole-request regex matched the
      // documentation and the withheld-research assertion below passed and failed for the same
      // reason. What is under test is what the HARNESS injected this turn.
      prompt: JSON.stringify((calls[0].messages ?? []).filter((m: any) => m.role === 'user')),
    };
  };

  it('hands a learn-mode tutor web tools for a topic the vault has never heard of', async () => {
    const { tools, prompt } = await drive('explain species counterpoint to me');
    expect(tools).toContain('web_search');
    expect(tools).toContain('read_url');
    expect(prompt).toMatch(/your memory has a gap here/);
    expect(prompt).toMatch(/no page covers what the student just asked/);
    // The unlock must not quietly become a write unlock — that is the single-writer rule.
    expect(tools).not.toContain('write_page');
  }, 30_000);

  it('unlocks for a page that EXISTS but cites nothing, and says which page', async () => {
    // The case the first version of this gate missed entirely. An unsourced page is the vault's own
    // record that it was written from memory and never checked; teaching from it as though it were
    // verified is the exact failure the vault-grounded design exists to prevent.
    const { tools, prompt } = await drive('tell me about photosynthesis');
    expect(tools).toContain('web_search');
    expect(prompt).toMatch(/cites no sources/);
    expect(prompt).toMatch(/photosynthesis/);
    // And it must point at rewriting THAT page, not at researching the subject from scratch.
    expect(prompt).toMatch(/can be rewritten properly/);
    expect(tools).not.toContain('write_page');
  }, 30_000);

  it('withholds them when a solid sourced page covers it — evidence and edges beat a blog post', async () => {
    const { tools, prompt } = await drive('remind me how arithmetic works');
    expect(tools).not.toContain('web_search');
    expect(tools).not.toContain('read_url');
    expect(prompt).not.toMatch(/your memory has a gap here/);
  }, 30_000);

  it('does NOT re-open research on a grade turn, even when the staging question had a gap', async () => {
    // The staging message names a topic the vault cannot cover (a no-page gap), but THIS turn is a
    // block submission — grading, not a fresh ask. vaultGap keys off that stale user text, so without
    // the grade-turn guard the tutor got a "research this" directive over the graded card and
    // re-taught the whole topic instead of landing the grade.
    const { model, calls } = textOnly();
    const session = createTutorSession(lw, {
      student: 'kid', vault, models: {}, search: { searxng: 'http://127.0.0.1:1' },
    } as any, { model });
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'explain species counterpoint to me' }] },
      { id: 'a1', role: 'assistant', parts: [{
        type: 'tool-quick_check', toolCallId: 'tc1', state: 'output-available',
        input: { question: 'name a first-species rule', mode: 'free', expected: 'no parallel fifths', pageSlug: 'counterpoint' },
        output: { answer: 'no parallel fifths' },
      }] },
    ] as any[];
    await (await session.respond(history, 'learn')).text();
    const tools = (calls[0].tools ?? []).map((t: any) => t.name);
    const userPrompt = JSON.stringify((calls[0].messages ?? []).filter((m: any) => m.role === 'user'));
    expect(tools).not.toContain('web_search'); // research withheld on the grade turn…
    expect(userPrompt).not.toMatch(/your memory has a gap here/);
    expect(userPrompt).toMatch(/record_evidence/); // …because it IS a grade turn
  }, 30_000);
});

describe('usage ledger', () => {
  it('a tutor turn appends a ledger row carrying the model-reported usage', async () => {
    // 'hi' keeps the turn off the vault-gap path — this pins only that runLoop's summed usage
    // lands in .harness/usage.jsonl under role 'tutor'. Figures are distinctive on purpose: the
    // shared vault already holds all-zero rows from this file's other turns.
    const model = streamModel(() => ({
      text: 'hello', usage: { inputTokens: 111, outputTokens: 22, cacheReadTokens: 333, cacheWriteTokens: 44 },
    }));
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any, { model });
    await (await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any, 'learn',
    )).text();
    const rows = readFileSync(join(vault, '.harness', 'usage.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const row = rows.find((r) => r.in === 111);
    expect(row).toMatchObject({ role: 'tutor', in: 111, out: 22, cacheRead: 333, cacheWrite: 44 });
  }, 30_000);
});

describe('grading round-trip (Bug 2)', () => {
  // History diet wiring: a block graded in an EARLIER turn reaches the model as a verdict line
  // (historyDiet.ts), while the turn's own pending block keeps its full payload.
  it('compacts old graded blocks in the model transcript, keeps the pending one full', async () => {
    const { model, calls } = textOnly();
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any,
      { model, now: () => new Date('2026-07-12') });
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
      {
        id: 'a1', role: 'assistant', parts: [{
          type: 'tool-quick_check', toolCallId: 'tc-old', state: 'output-available',
          input: { question: 'An old question with a distinctive payload marker OLDMARK', mode: 'choice', choices: ['a', 'b'], expected: 'a', pageSlug: 'arith' },
          output: { answer: 'a', grading: { verdict: 'correct', source: 'mechanical', detail: 'exact match' } },
        }, { type: 'text', text: 'Next one.' }],
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'go on' }] },
      {
        id: 'a2', role: 'assistant', parts: [{
          type: 'tool-quick_check', toolCallId: 'tc-new', state: 'output-available',
          input: { question: '2+2?', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' },
          output: { answer: '4' },
        }],
      },
    ] as any[];
    await (await session.respond(history, 'learn', 'diet-thread')).text();

    const all = JSON.stringify(calls[0].messages);
    // The old block's distinctive choices payload is gone; its prompt survives in the verdict line.
    expect(all).toMatch(/"compacted":true/);
    expect(all).toMatch(/OLDMARK/); // the question is kept (capped), so the model knows WHAT was asked
    expect(all).not.toMatch(/"choices":\["a","b"\]/);
    // The pending block keeps its full payload, machine grade merged.
    expect(all).toMatch(/"choices":\["3","4"\]/);
    expect(all).toMatch(/"verdict":"correct"/);
  }, 30_000);

  it('sends a tool-output-available chunk carrying the graded output for pending block outputs', async () => {
    // Design note: a `data-grading` data-part + client-side onData merge was tried first, but it
    // races the continuation's own replace-in-place write (see the "continues the SAME assistant
    // message id" test below) and gets clobbered — confirmed by driving the real browser E2E flow.
    // A plain `tool-output-available` chunk targeting the pending tool call's id works instead:
    // because this response continues (replaces in place) the incoming history's last assistant
    // message (originalMessages below), the client seeds its working message state from THAT
    // message — which already has a part with this toolCallId — so the chunk finds and patches it
    // through the normal tool-result code path, same as any other tool result.
    const { model } = textOnly();
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any, { model });
    // A fresh, never-graded history — session.respond() mutates the request's tool part output in
    // place (p.output.grading = grading), and the shared blockOutputHistory object above is
    // already permanently mutated by the earlier "nudges once" test in this file (a JSON clone of
    // it would just clone that leftover .grading field along with it).
    const freshHistory = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
      {
        id: 'a1', role: 'assistant', parts: [{
          type: 'tool-quick_check', toolCallId: 'tc1', state: 'output-available',
          input: { question: '2+2?', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' },
          output: { answer: '4' },
        }],
      },
    ] as any[];
    const res = await session.respond(freshHistory, 'learn');
    const body = await res.text();

    const line = body.split('\n').find((l) => l.startsWith('data:') && l.includes('"type":"tool-output-available"'));
    expect(line, `no tool-output-available chunk in response:\n${body}`).toBeTruthy();
    const chunk = JSON.parse(line!.slice('data: '.length));
    expect(chunk.toolCallId).toBe('tc1'); // matches freshHistory's quick_check tool part
    expect(chunk.output.answer).toBe('4'); // student's original answer preserved
    expect(chunk.output.grading.verdict).toBe('correct'); // expected '4' === answer '4', mechanical grading
  }, 30_000);

  it('continues the SAME assistant message id when the request is a resubmit (no duplicate sibling message)', async () => {
    // Regression test: without `originalMessages` wired into createUiStream, the server
    // always minted a fresh random message id, while ai@7's useChat (on the client, for a
    // sendAutomaticallyWhen-triggered resubmit) seeds its streaming state from a SNAPSHOT of the
    // incoming history's last assistant message and only replaces it in place when ids match —
    // otherwise it pushes the snapshot-plus-new-content as an extra sibling message, duplicating
    // turn-1 content in the rendered thread. Confirmed by manual browser E2E debugging.
    const { model } = textOnly();
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any, { model });
    const freshHistory = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
      {
        id: 'a1', role: 'assistant', parts: [{
          type: 'tool-quick_check', toolCallId: 'tc1', state: 'output-available',
          input: { question: '2+2?', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' },
          output: { answer: '4' },
        }],
      },
    ] as any[];
    const body = await (await session.respond(freshHistory, 'learn')).text();
    const line = body.split('\n').find((l) => l.startsWith('data:') && l.includes('"type":"start"'));
    expect(line, `no start chunk in response:\n${body}`).toBeTruthy();
    const chunk = JSON.parse(line!.slice('data: '.length));
    expect(chunk.messageId).toBe('a1'); // continues the incoming history's last assistant message
  }, 30_000);

  it('mints a fresh message id on the first turn (no assistant message to continue)', async () => {
    const { model } = textOnly();
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any, { model });
    const body = await (await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] as any, 'learn',
    )).text();
    const line = body.split('\n').find((l) => l.startsWith('data:') && l.includes('"type":"start"'));
    expect(line, `no start chunk in response:\n${body}`).toBeTruthy();
    const chunk = JSON.parse(line!.slice('data: '.length));
    expect(chunk.messageId).toBeTruthy();
    expect(chunk.messageId).not.toBe('u1');
  }, 30_000);
});
