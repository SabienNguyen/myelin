import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { Loreweaver } from '../src/server/mcp.js';
import { createTutorSession } from '../src/server/session.js';

const LW_REPO = `${process.env.HOME}/Dev/personal/loreweaver`;
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
  writeFileSync(join(vault, 'pages', 'arith.md'), '---\ntitle: Arithmetic\ndifficulty: 1\nstatus: solid\n---\nnumbers');
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
