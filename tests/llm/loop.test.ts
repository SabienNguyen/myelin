import { describe, it, expect } from 'vitest';
import { runLoop, zeroUsage, type ChatModel, type ChatRequest, type LoopEvent, type StreamEvent, type Usage } from '../../src/server/llm/index.js';

// A scripted ChatModel: each stream() call plays the next turn's events and snapshots the
// request, so tests can assert both the transcript the loop built and what the model was shown.
function scriptedModel(turns: StreamEvent[][]): { model: ChatModel; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let turn = 0;
  const model: ChatModel = {
    generate() { throw new Error('loop tests never call generate'); },
    async *stream(req) {
      requests.push(structuredClone(req));
      yield* turns[Math.min(turn++, turns.length - 1)];
    },
  };
  return { model, requests };
}

const finish = (reason: 'stop' | 'tool-calls', usage: Partial<Usage> = {}): StreamEvent =>
  ({ type: 'finish', reason, usage: { ...zeroUsage(), ...usage } });

const call = (id: string, name: string, input: unknown): StreamEvent =>
  ({ type: 'tool-call', toolCallId: id, toolName: name, input });

const START = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }];

describe('runLoop', () => {
  it('executes a tool, feeds the result back, and ends on a step with no calls', async () => {
    const executed: unknown[] = [];
    const { model, requests } = scriptedModel([
      [
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', text: 'Checking' },
        { type: 'text-end', id: '0' },
        call('t1', 'lookup', { q: 'x' }),
        finish('tool-calls', { inputTokens: 10, outputTokens: 5 }),
      ],
      [
        { type: 'text-delta', id: '0', text: 'Answer' },
        finish('stop', { inputTokens: 20, outputTokens: 7, cacheReadTokens: 3 }),
      ],
    ]);
    const out = await runLoop({
      model,
      system: 'sys',
      messages: START,
      tools: [{
        name: 'lookup', description: 'd', inputSchema: { type: 'object' },
        execute: async (input) => { executed.push(input); return { found: true }; },
      }],
      maxSteps: 5,
      cache: true,
    });

    expect(out.stopReason).toBe('end');
    expect(executed).toEqual([{ q: 'x' }]);
    expect(out.steps).toEqual([
      { text: 'Checking', toolCalls: [{ type: 'tool-call', toolCallId: 't1', toolName: 'lookup', input: { q: 'x' } }] },
      { text: 'Answer', toolCalls: [] },
    ]);
    expect(out.usage).toEqual({ inputTokens: 30, outputTokens: 12, cacheReadTokens: 3, cacheWriteTokens: 0 });
    expect(out.messages).toEqual([
      ...START,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'lookup', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'lookup', output: { found: true } }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
    ]);
    // The model was shown plain declarations (no execute) and, on step 2, the tool result.
    expect(requests[0].tools).toEqual([{ name: 'lookup', description: 'd', inputSchema: { type: 'object' } }]);
    expect(requests[0].system).toBe('sys');
    expect(requests[0].cache).toBe(true);
    expect(requests[1].messages).toHaveLength(3);
    expect(requests[1].messages[2].content[0]).toMatchObject({ type: 'tool-result', toolCallId: 't1' });
  });

  it('echoes the step\'s thinking (with signature) ahead of the tool call in the next request', async () => {
    // This is the tool-loop 400 fix: with thinking active, the Anthropic wire rejects the next
    // request unless the thinking block that preceded the tool_use is echoed back in position.
    const { model, requests } = scriptedModel([
      [
        { type: 'thinking-start', id: '0' },
        { type: 'thinking-delta', id: '0', text: 'Look it up.' },
        { type: 'thinking-end', id: '0', text: 'Look it up.', signature: 'sig_1' },
        { type: 'text-delta', id: '1', text: 'Checking' },
        call('t1', 'lookup', { q: 'x' }),
        finish('tool-calls'),
      ],
      [
        { type: 'thinking-start', id: '0' },
        { type: 'thinking-end', id: '0', text: '', redacted: { data: 'opaque==' } },
        { type: 'text-delta', id: '1', text: 'Answer' },
        finish('stop'),
      ],
    ]);
    const out = await runLoop({
      model,
      messages: START,
      tools: [{ name: 'lookup', description: 'd', inputSchema: {}, execute: async () => ({ found: true }) }],
      maxSteps: 5,
    });
    expect(out.stopReason).toBe('end');
    // The second request saw the first step's assistant turn thinking-first.
    expect(requests[1].messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'Look it up.', signature: 'sig_1' },
        { type: 'text', text: 'Checking' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'lookup', input: { q: 'x' } },
      ],
    });
    // A redacted block round-trips onto the transcript the same way.
    expect(out.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', text: '', redacted: { data: 'opaque==' } },
        { type: 'text', text: 'Answer' },
      ],
    });
  });

  it('halts as external-tool on a declared tool with no execute, running nothing', async () => {
    let ran = false;
    const { model, requests } = scriptedModel([
      [call('b1', 'show_block', { kind: 'quiz' }), finish('tool-calls')],
    ]);
    const out = await runLoop({
      model,
      messages: START,
      tools: [
        { name: 'show_block', description: 'block tool', inputSchema: {} },
        { name: 'lookup', description: 'd', inputSchema: {}, execute: async () => { ran = true; return null; } },
      ],
      maxSteps: 5,
    });
    expect(out.stopReason).toBe('external-tool');
    expect(ran).toBe(false);
    expect(requests).toHaveLength(1);
    // The transcript ends on the assistant's call — no tool-result was appended; the resubmit
    // supplies it.
    expect(out.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'b1', toolName: 'show_block', input: { kind: 'quiz' } }],
    });
  });

  it('halts at maxSteps when the model keeps calling tools', async () => {
    const { model, requests } = scriptedModel([
      [call('t1', 'lookup', {}), finish('tool-calls', { inputTokens: 1 })],
    ]);
    const out = await runLoop({
      model,
      messages: START,
      tools: [{ name: 'lookup', description: 'd', inputSchema: {}, execute: async () => 'r' }],
      maxSteps: 2,
    });
    expect(out.stopReason).toBe('max-steps');
    expect(requests).toHaveLength(2);
    expect(out.steps).toHaveLength(2);
    expect(out.usage.inputTokens).toBe(2);
    // The final step's call still executed and its result is on the transcript.
    expect(out.messages.at(-1)).toMatchObject({ role: 'user' });
  });

  it('turns a throwing execute into an isError result and continues', async () => {
    const { model, requests } = scriptedModel([
      [call('t1', 'lookup', { q: 'x' }), finish('tool-calls')],
      [{ type: 'text-delta', id: '0', text: 'recovered' }, finish('stop')],
    ]);
    const out = await runLoop({
      model,
      messages: START,
      tools: [{
        name: 'lookup', description: 'd', inputSchema: {},
        execute: async () => { throw new Error('backend down'); },
      }],
      maxSteps: 5,
    });
    expect(out.stopReason).toBe('end');
    expect(out.messages[2].content).toEqual([
      { type: 'tool-result', toolCallId: 't1', toolName: 'lookup', output: 'backend down', isError: true },
    ]);
    // The model saw the failure on the next step and could recover.
    expect(requests[1].messages[2].content[0]).toMatchObject({ isError: true });
    expect(out.steps[1].text).toBe('recovered');
  });

  it('answers a hallucinated tool name with an isError result instead of pausing the run', async () => {
    const { model } = scriptedModel([
      [call('t1', 'no_such_tool', {}), finish('tool-calls')],
      [finish('stop')],
    ]);
    const out = await runLoop({
      model,
      messages: START,
      tools: [{ name: 'lookup', description: 'd', inputSchema: {}, execute: async () => 'r' }],
      maxSteps: 5,
    });
    expect(out.stopReason).toBe('end');
    expect(out.messages[2].content[0]).toEqual({
      type: 'tool-result', toolCallId: 't1', toolName: 'no_such_tool',
      output: 'unknown tool: no_such_tool', isError: true,
    });
  });

  it('appends no assistant message for a no-text no-call step (empty content is invalid on the wire)', async () => {
    const { model } = scriptedModel([[finish('stop')]]);
    const out = await runLoop({ model, messages: START, tools: [], maxSteps: 5 });
    expect(out.stopReason).toBe('end');
    expect(out.messages).toEqual(START);
    expect(out.steps).toEqual([{ text: '', toolCalls: [] }]);
  });

  it('forwards stream events wrapped in step-start/step-finish, in order', async () => {
    const seen: string[] = [];
    const { model } = scriptedModel([
      [
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', text: 'a' },
        { type: 'text-end', id: '0' },
        call('t1', 'lookup', {}),
        finish('tool-calls'),
      ],
      [{ type: 'text-delta', id: '0', text: 'b' }, finish('stop')],
    ]);
    await runLoop({
      model,
      messages: START,
      tools: [{ name: 'lookup', description: 'd', inputSchema: {}, execute: async () => 'r' }],
      maxSteps: 5,
      onEvent: (e: LoopEvent) => { seen.push(e.type); },
    });
    expect(seen).toEqual([
      'step-start', 'text-start', 'text-delta', 'text-end', 'tool-call', 'finish', 'step-finish',
      'tool-result',
      'step-start', 'text-delta', 'finish', 'step-finish',
    ]);
  });

  it('emits a tool-result event per executed tool, carrying the output and isError', async () => {
    const results: LoopEvent[] = [];
    const { model } = scriptedModel([
      [call('t1', 'lookup', {}), call('t2', 'broken', {}), finish('tool-calls')],
      [finish('stop')],
    ]);
    await runLoop({
      model,
      messages: START,
      tools: [
        { name: 'lookup', description: 'd', inputSchema: {}, execute: async () => ({ ok: 1 }) },
        { name: 'broken', description: 'd', inputSchema: {}, execute: async () => { throw new Error('nope'); } },
      ],
      maxSteps: 5,
      onEvent: (e) => { if (e.type === 'tool-result') results.push(e); },
    });
    expect(results).toEqual([
      { type: 'tool-result', toolCallId: 't1', toolName: 'lookup', output: { ok: 1 } },
      { type: 'tool-result', toolCallId: 't2', toolName: 'broken', output: 'nope', isError: true },
    ]);
  });

  it('passes server tools to the model verbatim without ever executing or halting on them', async () => {
    const { model, requests } = scriptedModel([[finish('stop')]]);
    const serverTool = { type: 'web_search_20260209', name: 'web_search', max_uses: 8 };
    const out = await runLoop({
      model,
      messages: START,
      tools: [{ name: 'lookup', description: 'd', inputSchema: {}, execute: async () => 'r' }],
      serverTools: [serverTool],
      maxSteps: 5,
    });
    expect(out.stopReason).toBe('end');
    expect(requests[0].tools).toEqual([
      { name: 'lookup', description: 'd', inputSchema: {} },
      serverTool,
    ]);
  });
});
