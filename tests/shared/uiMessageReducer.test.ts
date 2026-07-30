// The reducer's full behavior is pinned end-to-end by tests/llm/wire.test.ts (every stream there
// runs through it via createUiStream). This file only smokes the EXTRACTED surface: that the
// shared module assembles standalone — no server imports, no HTTP — since phase E1's client
// consumer drives it exactly this way.
import { describe, it, expect } from 'vitest';
import { MessageAssembler, generateMessageId, type UiChunk } from '../../src/shared/uiMessageReducer.js';
import type { UIMessage } from '../../src/shared/uiMessages.js';

const USER_TURN: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
];

describe('shared MessageAssembler (direct drive)', () => {
  it('assembles a scripted turn into the same message shape the wire persists', () => {
    const assembler = new MessageAssembler(USER_TURN, 'm1');
    const chunks: UiChunk[] = [
      { type: 'start', messageId: 'm1' },
      { type: 'start-step' },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'Try ' },
      { type: 'text-delta', id: '0', delta: 'this.' },
      { type: 'text-end', id: '0' },
      { type: 'tool-input-start', toolCallId: 'tc9', toolName: 'quick_check' },
      { type: 'tool-input-available', toolCallId: 'tc9', toolName: 'quick_check', input: { question: '3+3?' } },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'tool-calls' },
    ];
    for (const chunk of chunks) assembler.apply(chunk);

    expect(assembler.message.parts).toEqual([
      { type: 'step-start' },
      { type: 'text', state: 'done', text: 'Try this.' },
      { type: 'tool-quick_check', toolCallId: 'tc9', state: 'input-available', input: { question: '3+3?' } },
    ]);
    expect(assembler.finalMessages()).toEqual([...USER_TURN, assembler.message]);
  });

  it('continues the last assistant message in place on a resubmit history', () => {
    const history: UIMessage[] = [
      ...USER_TURN,
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', state: 'done', text: 'Answer?' }] },
    ];
    const assembler = new MessageAssembler(history, 'ignored');
    assembler.apply({ type: 'start', messageId: 'a1' });
    assembler.apply({ type: 'start-step' });

    const final = assembler.finalMessages();
    expect(final).toHaveLength(2);
    expect(final[1]!.id).toBe('a1');
    expect(final[1]!.parts.map((p) => p.type)).toEqual(['text', 'step-start']);
    // The continuation cloned the original — a stream must never mutate the caller's history.
    expect(history[1]!.parts).toHaveLength(1);
  });

  it('assembles a reasoning part streaming -> done, storing providerMetadata from reasoning-end', () => {
    const assembler = new MessageAssembler(USER_TURN, 'm1');
    assembler.apply({ type: 'start', messageId: 'm1' });
    assembler.apply({ type: 'start-step' });
    assembler.apply({ type: 'reasoning-start', id: '0' });
    assembler.apply({ type: 'reasoning-delta', id: '0', delta: 'Let me ' });
    expect(assembler.message.parts[1]).toEqual({ type: 'reasoning', state: 'streaming', text: 'Let me ' });
    assembler.apply({ type: 'reasoning-delta', id: '0', delta: 'reason.' });
    assembler.apply({ type: 'reasoning-end', id: '0', providerMetadata: { signature: 'sig_1' } });
    expect(assembler.message.parts[1]).toEqual({
      type: 'reasoning', state: 'done', text: 'Let me reason.', providerMetadata: { signature: 'sig_1' },
    });
  });

  it('resets reasoning correlation at finish-step, like text', () => {
    const assembler = new MessageAssembler(USER_TURN, 'm1');
    assembler.apply({ type: 'start-step' });
    assembler.apply({ type: 'reasoning-start', id: '0' });
    assembler.apply({ type: 'reasoning-end', id: '0' });
    assembler.apply({ type: 'finish-step' });
    // The anthropic adapter reuses block-index ids across steps; a stale id must not resolve.
    expect(() => assembler.apply({ type: 'reasoning-delta', id: '0', delta: 'x' })).toThrow(/unknown reasoning id/);
  });

  it('generateMessageId keeps the SDK-familiar 16-char format', () => {
    expect(generateMessageId()).toMatch(/^[0-9A-Za-z]{16}$/);
  });
});
