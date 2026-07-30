// @vitest-environment jsdom
//
// chatCore's copy of the auto-resubmit predicate. Every case here carries the same meaning as
// its counterpart in tests/client/runtime.test.tsx (which pins runtime.tsx's copy until E2
// consolidates the two): the T12 MCP runaway, the last-step scoping runaway, and the one
// legitimate resubmit.
import { describe, it, expect } from 'vitest';
import { blockOutputsComplete } from '../../../src/client/chatCore/blockOutputsComplete.js';

const blockPart = (over: Partial<any> = {}) => ({
  type: 'tool-quick_check', toolCallId: 'tc1', state: 'output-available',
  input: { question: '2+2?', mode: 'choice', choices: ['3', '4'], pageSlug: 'arith' },
  output: { answer: '4' },
  ...over,
});

const mcpPart = (over: Partial<any> = {}) => ({
  type: 'tool-record_evidence', toolCallId: 'tc2', state: 'output-available',
  input: { student: 'kid', slug: 'arith', kind: 'applied-correctly', note: 'x' },
  output: { ok: true },
  ...over,
});

describe('chatCore blockOutputsComplete', () => {
  it('resubmits when the last assistant message has a completed block tool part', () => {
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [blockPart()] },
    ] as any;
    expect(blockOutputsComplete({ messages })).toBe(true);
  });

  it('does NOT resubmit on a server-side MCP tool part alone (the T12 runaway-loop regression)', () => {
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [mcpPart(), { type: 'text', text: 'Correct!' }] },
    ] as any;
    expect(blockOutputsComplete({ messages })).toBe(false);
  });

  it('does not resubmit while the block tool part is still streaming (no output yet)', () => {
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [blockPart({ state: 'input-streaming', output: undefined })] },
    ] as any;
    expect(blockOutputsComplete({ messages })).toBe(false);
  });

  it('does not resubmit when the last message is from the user', () => {
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ] as any;
    expect(blockOutputsComplete({ messages })).toBe(false);
  });

  it('terminates the loop: a follow-up turn with only MCP + text parts does not re-trigger', () => {
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [blockPart()] },
      { id: 'a2', role: 'assistant', parts: [mcpPart(), { type: 'text', text: 'Correct! Recorded — nice.' }] },
    ] as any;
    expect(blockOutputsComplete({ messages })).toBe(false);
  });

  it('scopes to the LAST STEP only, so a carried-forward block part from an earlier step does not re-trigger', () => {
    // The continued-message shape: the resubmitted response appends a new step onto the SAME
    // assistant message, so the answered block from step 1 stays physically present forever.
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      {
        id: 'a1', role: 'assistant', parts: [
          { type: 'step-start' },
          blockPart(),
          { type: 'text', text: "Let's warm up." },
          { type: 'step-start' },
          mcpPart(),
          { type: 'text', text: 'Correct! Recorded — nice.' },
        ],
      },
    ] as any;
    expect(blockOutputsComplete({ messages })).toBe(false);
  });

  it('resubmits for a completed code_exercise block part too (it iterates BLOCK_TOOL_NAMES)', () => {
    const codeExercisePart = {
      type: 'tool-code_exercise', toolCallId: 'tc3', state: 'output-available',
      input: { pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' },
      output: { completed: true, rungReached: 'full_body', testsPassed: 8, testsTotal: 8, wroteCode: true },
    };
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [codeExercisePart] },
    ] as any;
    expect(blockOutputsComplete({ messages })).toBe(true);
  });
});
