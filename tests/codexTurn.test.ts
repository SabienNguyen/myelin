import { describe, expect, it, vi } from 'vitest';
import { runCodexTurn, type CodexTransport } from '../src/server/codexTurn.js';

function transport() {
  let listener: (message: any) => void = () => {};
  const rpc: CodexTransport = {
    request: vi.fn(async (method) => method === 'thread/start' ? { thread: { id: 'thread' } } : { turn: { id: 'turn' } }),
    reply: vi.fn(),
    subscribe: vi.fn(fn => { listener = fn; return () => { listener = () => {}; }; }),
  };
  return { rpc, emit: (method: string, params: unknown, id?: number) => listener({ method, params, id }) };
}

describe('Codex turn execution boundary', () => {
  it('interrupts a running turn on explicit cancellation and removes the subscription', async () => {
    const { rpc } = transport();
    const controller = new AbortController();
    const run = (async () => {
      for await (const _event of runCodexTurn(rpc, { model: 'test-model', prompt: 'Test', tools: [], signal: controller.signal })) { /* drain */ }
    })();
    const rejected = expect(run).rejects.toThrow();
    await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledWith('turn/start', expect.anything()));
    controller.abort();
    await rejected;
    expect(rpc.request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread', turnId: 'turn' });
  });

  it('does not create a thread for an already cancelled request', async () => {
    const { rpc } = transport();
    const controller = new AbortController();
    controller.abort();
    const run = runCodexTurn(rpc, { model: 'test-model', prompt: 'Test', tools: [], signal: controller.signal });
    await expect(run[Symbol.asyncIterator]().next()).rejects.toThrow();
    expect(rpc.request).not.toHaveBeenCalled();
  });

  it('never executes duplicate or undeclared tools and redacts failures', async () => {
    const { rpc, emit } = transport();
    const execute = vi.fn(async () => { throw new Error('private diagnostic'); });
    const events: unknown[] = [];
    const run = (async () => {
      for await (const event of runCodexTurn(rpc, { model: 'test-model', prompt: 'Test', tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' }, execute }] })) events.push(event);
    })();
    await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledWith('turn/start', expect.anything()));
    const params = { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'ping', arguments: {} };
    emit('item/tool/call', params, 1);
    emit('item/tool/call', params, 2);
    emit('item/tool/call', { ...params, callId: 'other', tool: 'unavailable' }, 3);
    await vi.waitFor(() => expect(rpc.reply).toHaveBeenCalledTimes(3));
    emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
    await run;
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).not.toContain('private diagnostic');
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', isError: true }));
  });

  it('turn failures are errors, not successful completion or leaked provider diagnostics', async () => {
    const { rpc, emit } = transport();
    const events: unknown[] = [];
    const run = (async () => {
      for await (const event of runCodexTurn(rpc, { model: 'test-model', prompt: 'Test', tools: [] })) events.push(event);
    })();
    const rejected = expect(run).rejects.toThrow('Codex turn failed.');
    await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledWith('turn/start', expect.anything()));
    emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'failed', error: { message: 'private diagnostic' } } });
    await rejected;
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'finish' }));
  });

  it('streams text, executes only declared host tools, and finishes with provider usage', async () => {
    const { rpc, emit } = transport();
    const execute = vi.fn(async () => ({ ok: true }));
    const events: unknown[] = [];
    const run = (async () => {
      for await (const event of runCodexTurn(rpc, { model: 'test-model', prompt: 'Test', tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' }, execute }] })) events.push(event);
    })();
    await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledWith('turn/start', expect.anything()));
    emit('item/agentMessage/delta', { threadId: 'other', turnId: 'turn', itemId: 'wrong', delta: 'Ignore' });
    emit('item/agentMessage/delta', { threadId: 'thread', turnId: 'turn', itemId: 'a', delta: 'Hello' });
    emit('item/tool/call', { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'ping', arguments: {} }, 22);
    await vi.waitFor(() => expect(rpc.reply).toHaveBeenCalledWith(22, { contentItems: [{ type: 'inputText', text: '{"ok":true}' }], success: true }));
    emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', id: 'a', text: 'Hello' } });
    emit('thread/tokenUsage/updated', { threadId: 'thread', turnId: 'turn', tokenUsage: { last: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 2 } } });
    emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
    await run;
    expect(execute).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: 'tool-result', toolCallId: 'call', toolName: 'ping', output: { ok: true } });
    expect(events).toContainEqual({ type: 'text-delta', id: 'a', text: 'Hello' });
    expect(events).not.toContainEqual(expect.objectContaining({ text: 'Ignore' }));
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 } });
    expect(rpc.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'untrusted', allowProviderModelFallback: false }));
  });
});
