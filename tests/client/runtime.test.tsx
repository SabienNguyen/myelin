// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { blockOutputsComplete } from '../../src/client/runtime.js';

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

describe('blockOutputsComplete (Bug 1 — sendAutomaticallyWhen predicate)', () => {
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
    // Simulates the state right after the one legitimate resubmit: the harness's follow-up
    // assistant message calls record_evidence and replies with text — no block parts.
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [blockPart()] },
      { id: 'a2', role: 'assistant', parts: [mcpPart(), { type: 'text', text: 'Correct! Recorded — nice.' }] },
    ] as any;
    expect(blockOutputsComplete({ messages })).toBe(false);
  });

  it('scopes to the LAST STEP only, so a carried-forward block part from an earlier step does not re-trigger', () => {
    // Reproduces the real runaway found in manual E2E debugging: ai@7's useChat seeds a resubmitted
    // response by snapshotting the CURRENT last assistant message (see
    // AbstractChat.makeRequest/createStreamingUIMessageState) and appending a new step onto it —
    // so once the server round-trips a 'step-start' marker in its continuation, the ORIGINAL
    // quick_check part from step 1 is still physically present in the (single, growing) last
    // message, just in an earlier step. A predicate that scans the whole message re-matches it
    // forever; this one must scope to parts after the LAST step-start only.
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
});
