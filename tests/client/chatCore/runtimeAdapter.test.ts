// @vitest-environment jsdom
//
// The adapter's pure conversion only — mounting the external-store runtime belongs to E2's
// browser-verified swap. What is pinned here is the render contract toolkit.tsx depends on:
// tool parts must arrive as 'tool-call' parts whose args/result/isError feed
// render({ args, result, addResult, isError }) exactly as the react-ai-sdk converter fed them.
import { describe, it, expect } from 'vitest';
import { uiMessageToThreadMessage } from '../../../src/client/chatCore/runtimeAdapter.js';
import type { UIMessage } from '../../../src/shared/uiMessages.js';

describe('uiMessageToThreadMessage', () => {
  it('maps text and completed tool parts, dropping step-start markers', () => {
    const message: UIMessage = {
      id: 'a1', role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'text', state: 'done', text: "Let's warm up." },
        {
          type: 'tool-quick_check', toolCallId: 'tc1', state: 'output-available',
          input: { question: '2+2?' }, output: { answer: '4' },
        },
      ],
    };
    expect(uiMessageToThreadMessage(message)).toEqual({
      id: 'a1',
      role: 'assistant',
      content: [
        { type: 'text', text: "Let's warm up." },
        {
          type: 'tool-call', toolCallId: 'tc1', toolName: 'quick_check',
          args: { question: '2+2?' }, result: { answer: '4' },
        },
      ],
    });
  });

  it('a paused block (input-available, no output) keeps args and carries no result', () => {
    const message: UIMessage = {
      id: 'a1', role: 'assistant',
      parts: [{ type: 'tool-quiz', toolCallId: 'tc1', state: 'input-available', input: { items: [] } }],
    };
    const [part] = uiMessageToThreadMessage(message).content as any[];
    expect(part).toEqual({ type: 'tool-call', toolCallId: 'tc1', toolName: 'quiz', args: { items: [] } });
    expect('result' in part).toBe(false);
  });

  it('args falls back to {} while the input is still streaming (no provisional parse)', () => {
    const message: UIMessage = {
      id: 'a1', role: 'assistant',
      parts: [{ type: 'tool-quick_check', toolCallId: 'tc1', state: 'input-streaming' }],
    };
    expect(uiMessageToThreadMessage(message).content).toEqual([
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'quick_check', args: {} },
    ]);
  });

  it('output-error becomes an isError result carrying the errorText — toolkit sniffs this text', () => {
    const message: UIMessage = {
      id: 'a1', role: 'assistant',
      parts: [{
        type: 'tool-quick_check', toolCallId: 'tc1', state: 'output-error',
        input: { question: '2+2?' }, errorText: 'User cancelled tool call by sending a new message.',
      }],
    };
    expect(uiMessageToThreadMessage(message).content).toEqual([{
      type: 'tool-call', toolCallId: 'tc1', toolName: 'quick_check',
      args: { question: '2+2?' },
      result: { error: 'User cancelled tool call by sending a new message.' },
      isError: true,
    }]);
  });

  it('keeps data-* parts as named data parts and passes user text through', () => {
    const message: UIMessage = {
      id: 'u1', role: 'user',
      parts: [
        { type: 'text', text: 'hi' },
        { type: 'data-note', id: 'n1', data: { x: 1 } },
      ],
    };
    expect(uiMessageToThreadMessage(message)).toEqual({
      id: 'u1',
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'data', name: 'note', data: { x: 1 } },
      ],
    });
  });

  it('a turn error becomes an explicit incomplete status so the error bubble renders', () => {
    const message: UIMessage = { id: 'a1', role: 'assistant', parts: [] };
    expect(uiMessageToThreadMessage(message, 'model exploded').status).toEqual({
      type: 'incomplete', reason: 'error', error: 'model exploded',
    });
    // Never on a user message, whatever the store's error state.
    const user: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    expect(uiMessageToThreadMessage(user, 'model exploded').status).toBeUndefined();
  });
});
