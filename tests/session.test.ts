import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { Loreweaver } from '../src/server/mcp.js';
import { createTutorSession } from '../src/server/session.js';
import { LW_REPO } from './lwRepo.js';

let lw: Loreweaver; let vault: string;

// Stream chunks for: a text-only reply (no record_evidence) — used to trip the guardrail.
const textOnly = () => new MockLanguageModelV3({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Nice work!' },
        { type: 'text-end', id: 't1' },
        {
          type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    }),
  }),
});

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
  lw = await Loreweaver.connect({
    vault, student: 'kid',
    loreweaver: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
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
    const calls: any[] = [];
    const model = textOnly();
    const origDoStream = model.doStream.bind(model);
    (model as any).doStream = async (opts: any) => { calls.push(opts); return origDoStream(opts); };

    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any,
      { model, now: () => new Date('2026-07-12') });
    const res = await session.respond(blockOutputHistory, 'learn');
    await res.text(); // drain the stream

    expect(calls.length).toBe(2); // original + one nudged retry
    const secondPrompt = JSON.stringify(calls[1].prompt);
    expect(secondPrompt).toMatch(/record_evidence/);
    // second violation logged
    expect(existsSync(join(vault, '.harness', 'guardrail.log'))).toBe(true);
    expect(readFileSync(join(vault, '.harness', 'guardrail.log'), 'utf8')).toMatch(/quick_check/);
  }, 30_000);

  it('does not nudge on plain conversation', async () => {
    const calls: any[] = [];
    const model = textOnly();
    const orig = model.doStream.bind(model);
    (model as any).doStream = async (o: any) => { calls.push(o); return orig(o); };
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any, { model });
    const res = await session.respond([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any, 'learn');
    await res.text();
    expect(calls.length).toBe(1);
  }, 30_000);

  it('injects bootstrap context on first turn', async () => {
    const calls: any[] = [];
    const model = textOnly();
    const orig = model.doStream.bind(model);
    (model as any).doStream = async (o: any) => { calls.push(o); return orig(o); };
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any, { model });
    await (await session.respond([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] as any, 'learn')).text();
    expect(JSON.stringify(calls[0].prompt)).toMatch(/SESSION CONTEXT/);
  }, 30_000);
});

describe('cold-start research unlock', () => {
  // researchGate.test.ts covers the DECISION against a stubbed scorer. This covers the WIRING:
  // that a teaching-mode turn actually hands the tutor the tools, and tells it they are there.
  // Those are separable — the gate returning true is worthless if session.ts still builds `{}`.
  const drive = async (text: string) => {
    const calls: any[] = [];
    const model = textOnly();
    const orig = model.doStream.bind(model);
    (model as any).doStream = async (o: any) => { calls.push(o); return orig(o); };
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
      // USER messages only, deliberately. The whole serialized prompt includes the system prompt,
      // which now documents the gap-unlock line verbatim — so a whole-prompt regex matched the
      // documentation and the withheld-research assertion below passed and failed for the same
      // reason. What is under test is what the HARNESS injected this turn.
      prompt: JSON.stringify((calls[0].prompt ?? []).filter((m: any) => m.role === 'user')),
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
});

describe('grading round-trip (Bug 2)', () => {
  it('sends a tool-output-available chunk carrying the graded output for pending block outputs', async () => {
    // Design note: a `data-grading` data-part + client-side onData merge was tried first, but it
    // races the continuation's own replace-in-place write (see the "continues the SAME assistant
    // message id" test below) and gets clobbered — confirmed by driving the real browser E2E flow.
    // A plain `tool-output-available` chunk targeting the pending tool call's id works instead:
    // because this response continues (replaces in place) the incoming history's last assistant
    // message (originalMessages below), the client seeds its working message state from THAT
    // message — which already has a part with this toolCallId — so the chunk finds and patches it
    // through the normal tool-result code path, same as any other tool result.
    const model = textOnly();
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
    // Regression test: without `originalMessages` wired into createUIMessageStream, the server
    // always minted a fresh random message id, while ai@7's useChat (on the client, for a
    // sendAutomaticallyWhen-triggered resubmit) seeds its streaming state from a SNAPSHOT of the
    // incoming history's last assistant message and only replaces it in place when ids match —
    // otherwise it pushes the snapshot-plus-new-content as an extra sibling message, duplicating
    // turn-1 content in the rendered thread. Confirmed by manual browser E2E debugging.
    const model = textOnly();
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
    const model = textOnly();
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
