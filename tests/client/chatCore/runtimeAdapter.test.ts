// @vitest-environment jsdom
//
// The adapter's pure conversion only — mounting the external-store runtime belongs to E2's
// browser-verified swap. What is pinned here is the render contract toolkit.tsx depends on:
// tool parts must arrive as 'tool-call' parts whose args/result/isError feed
// render({ args, result, addResult, isError }) exactly as the react-ai-sdk converter fed them.
import { describe, it, expect } from 'vitest';
import { uiMessageToThreadMessage, withErrorPlaceholder } from '../../../src/client/chatCore/runtimeAdapter.js';
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

  it('maps reasoning parts to assistant-ui reasoning content, leaving providerMetadata behind', () => {
    const message: UIMessage = {
      id: 'a1', role: 'assistant',
      parts: [
        {
          type: 'reasoning', state: 'done', text: 'Warm-up first.',
          providerMetadata: { signature: 'sig_1' },
        },
        { type: 'text', state: 'done', text: 'Try this.' },
      ],
    };
    expect(uiMessageToThreadMessage(message).content).toEqual([
      // The signature is resubmit plumbing, not render input — it must not leak to the UI layer.
      { type: 'reasoning', text: 'Warm-up first.' },
      { type: 'text', text: 'Try this.' },
    ]);
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

  it('maps user file parts to assistant-ui content: images as image parts, PDFs as file parts', () => {
    const message: UIMessage = {
      id: 'u1', role: 'user',
      parts: [
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,aW1n', filename: 'shot.png' },
        { type: 'file', mediaType: 'application/pdf', url: 'data:application/pdf;base64,cGRm', filename: 'notes.pdf' },
        { type: 'text', text: 'see attached' },
      ],
    };
    expect(uiMessageToThreadMessage(message).content).toEqual([
      { type: 'image', image: 'data:image/png;base64,aW1n', filename: 'shot.png' },
      { type: 'file', data: 'data:application/pdf;base64,cGRm', mimeType: 'application/pdf', filename: 'notes.pdf' },
      { type: 'text', text: 'see attached' },
    ]);
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

describe('withErrorPlaceholder', () => {
  const userTurn: UIMessage[] = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];

  it('appends a synthetic assistant message when a turn errors with no assistant message last', () => {
    // The dead-backend-on-a-fresh-send case: without the placeholder there is no message for
    // the error status to ride, and the error bubble never renders (the react-ai-sdk stack
    // appended one via createErrorAssistantMessage).
    const out = withErrorPlaceholder(userTurn, 'HTTP 502');
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: 'assistant', parts: [] });
    expect(uiMessageToThreadMessage(out[1]!, 'HTTP 502').status)
      .toEqual({ type: 'incomplete', reason: 'error', error: 'HTTP 502' });
  });

  it('passes through untouched when there is no error, or the last message is already assistant', () => {
    expect(withErrorPlaceholder(userTurn, undefined)).toBe(userTurn);
    const withAssistant: UIMessage[] = [...userTurn, { id: 'a1', role: 'assistant', parts: [] }];
    expect(withErrorPlaceholder(withAssistant, 'mid-turn error')).toBe(withAssistant);
  });
});
