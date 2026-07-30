import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BLOCK_TOOLS } from '../src/shared/blocks.js';
import { Engram } from '../src/server/mcp.js';
import { createTutorSession } from '../src/server/session.js';
import { textModel } from './mockModel.js';
import { LW_REPO } from './lwRepo.js';

// Rails against the real Engram MCP server: a rails turn stages a schema-valid quick_check over
// the wire, and a resubmit records evidence in the vault WITHOUT the model calling
// record_evidence — the harness calls it (spec invariant: rails changes WHO calls, never WHAT).
let lw: Engram; let vault: string;

const railsCfg = () => ({
  student: 'kid', vault,
  models: { tutor: { model: 'test-tutor', rails: true } },
} as any);

// One model serves both narrow generation calls, keyed on the prompt markers each carries. It
// never calls record_evidence — which is the point of the evidence assertions below.
const railsModel = (next: 'continue' | 'stop-offer' = 'stop-offer') => textModel((prompt) => {
  if (prompt.includes('multiple-choice quick check')) {
    return JSON.stringify({
      question: 'What is 2+2?', mode: 'choice',
      choices: ['3', '4', '5'], expected: '4',
      framing: 'First contact — a wrong guess just tells us where to start.',
    });
  }
  return JSON.stringify({ feedback: 'You picked "4" — the machine grade agrees.', next });
});

const chunks = (body: string) => body.split('\n')
  .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
  .map((l) => JSON.parse(l.slice('data: '.length)));

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), 'lwh-rails-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  writeFileSync(join(vault, 'pages', 'arith.md'),
    '---\ntitle: Arithmetic\ndifficulty: 1\nstatus: solid\n---\n# Arithmetic\nAddition and friends.');
  writeFileSync(join(vault, 'pages', 'algebra.md'),
    '---\ntitle: Algebra\ndifficulty: 2\nstatus: solid\nprereqs: [arith]\n---\n# Algebra\nSymbols over numbers.');
  lw = await Engram.connect({
    vault, student: 'kid',
    engram: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
  } as any);
}, 30_000);
afterAll(async () => { await lw.close(); });

describe('rails turn (harness-driven)', () => {
  it('stages a schema-valid quick_check block with a framing line and a rails toolCallId', async () => {
    const { model, prompts } = railsModel();
    const session = createTutorSession(lw, railsCfg(), { model });
    const body = await (await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'drill me' }] }] as any,
      'review', 'rails-stage',
    )).text();

    const all = chunks(body);
    const block = all.find((c) => c.type === 'tool-input-available');
    expect(block, `no tool-input-available chunk in:\n${body}`).toBeTruthy();
    expect(block.toolName).toBe('quick_check');
    expect(block.toolCallId).toBe('rails-1');
    // The staged input must satisfy the client's own schema — a drifted contract fails here.
    expect(() => BLOCK_TOOLS.quick_check.input.parse(block.input)).not.toThrow();
    expect(block.input.pageSlug).toBe('arith'); // next_lessons frontier: easiest page first
    // Exactly one framing text chunk precedes the block.
    const framing = all.filter((c) => c.type === 'text-delta');
    expect(framing).toHaveLength(1);
    expect(framing[0].delta).toMatch(/wrong guess/);
    // The generation prompt was page-grounded — the model saw the vault page, not just the ask.
    expect(prompts[0]).toMatch(/Addition and friends/);
    // A rails turn never gives the model tools (the generation call's forced schema tool aside).
    expect(prompts[0]).not.toMatch(/record_evidence/);
  }, 30_000);

  it('a resubmit grades, records evidence WITHOUT the model, sends feedback, and honors stop-offer', async () => {
    const { model } = railsModel('stop-offer');
    const session = createTutorSession(lw, railsCfg(), { model });
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'drill me' }] },
      {
        id: 'a1', role: 'assistant', parts: [
          { type: 'step-start' },
          { type: 'text', text: 'First contact framing.' },
          {
            type: 'tool-quick_check', toolCallId: 'rails-1', state: 'output-available',
            input: { question: 'What is 2+2?', mode: 'choice', choices: ['3', '4', '5'], expected: '4', pageSlug: 'arith' },
            output: { answer: '4' },
          },
        ],
      },
    ] as any[];
    const body = await (await session.respond(history, 'review', 'rails-resubmit')).text();
    const all = chunks(body);

    // Grading round-trips to the already-rendered card, exactly like the agentic Bug 2 fix.
    const patched = all.find((c) => c.type === 'tool-output-available' && c.toolCallId === 'rails-1');
    expect(patched.output.grading.verdict).toBe('correct');
    // Continuation: the stream continues the incoming assistant message, not a sibling.
    expect(all.find((c) => c.type === 'start').messageId).toBe('a1');

    // THE invariant: evidence landed although the model never called record_evidence — the model
    // here can only answer forced generation schemas, so this can only be the harness's lw.call.
    const student = JSON.parse(readFileSync(join(vault, 'students', 'kid.json'), 'utf8'));
    expect(student.arith.evidence).toHaveLength(1);
    expect(student.arith.evidence[0]).toMatchObject({ kind: 'applied-correctly' });
    expect(student.arith.evidence[0].note).toMatch(/^quick_check: What is 2\+2\?/);

    // Feedback text present, then the stop-offer line; no new block staged.
    const text = all.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('\n');
    expect(text).toMatch(/machine grade agrees/);
    expect(text).toMatch(/keep going\?/);
    expect(all.filter((c) => c.type === 'tool-input-available')).toHaveLength(0);
  }, 30_000);

  it("on 'continue' the next item is staged in the same stream, skipping the answered page", async () => {
    const { model } = railsModel('continue');
    const session = createTutorSession(lw, railsCfg(), { model });
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'drill me' }] },
      {
        id: 'a1', role: 'assistant', parts: [{
          type: 'tool-quick_check', toolCallId: 'rails-1', state: 'output-available',
          input: { question: 'What is 2+2?', mode: 'choice', choices: ['3', '4', '5'], expected: '4', pageSlug: 'arith' },
          output: { answer: '4' },
        }],
      },
    ] as any[];
    const body = await (await session.respond(history, 'review', 'rails-continue')).text();
    const all = chunks(body);
    const staged = all.filter((c) => c.type === 'tool-input-available');
    expect(staged).toHaveLength(1);
    // The answered page was seeded into the staged set from the thread itself, so the next pick
    // moves on — here to the only other page.
    expect(staged[0].input.pageSlug).toBe('algebra');
    expect(staged[0].toolCallId).toBe('rails-2'); // seq continues past rails-1 in the history
  }, 30_000);

  it('rails off: the flag gates the only branch — an agentic turn still runs the tool loop', async () => {
    // Same model, rails absent: respond() must go down the agentic path (which drives stream(),
    // not generate() — textModel serves both) and offer the model real tools.
    const { model, prompts } = textModel('Hello!');
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any, { model });
    const body = await (await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any, 'learn', 'agentic',
    )).text();
    expect(body).toMatch(/Hello!/);
    expect(prompts[0]).toMatch(/SESSION CONTEXT/); // bootstrap ran — the agentic path's signature
  }, 30_000);
});
