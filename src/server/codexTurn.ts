import { zeroUsage, type StreamEvent, type ToolDecl } from './llm/types.js';

export type CodexMessage = { method?: string; id?: number | string; params?: any };
export interface CodexTransport {
  request(method: string, params: unknown): Promise<any>;
  reply(id: number | string, result: unknown): void;
  subscribe(listener: (message: CodexMessage) => void): () => void;
}
export type CodexTurnOptions = {
  model: string;
  prompt: string;
  signal?: AbortSignal;
  tools: (ToolDecl & { execute: (input: unknown) => Promise<unknown> })[];
};
export type CodexTurnEvent = StreamEvent | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown; isError?: boolean };

/** Internal execution primitive, not a selectable provider. The caller owns authentication
 * and tool isolation. Unlike ChatModel.stream, this owns tool execution until turn completion;
 * do not plug it into runLoop (that would execute tools twice).
 */
export async function* runCodexTurn(rpc: CodexTransport, opts: CodexTurnOptions): AsyncIterable<CodexTurnEvent> {
  opts.signal?.throwIfAborted();
  const queue: CodexMessage[] = [];
  let wake: (() => void) | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let completed = false;
  const notify = () => { wake?.(); wake = undefined; };
  const unsubscribe = rpc.subscribe(message => { queue.push(message); notify(); });
  opts.signal?.addEventListener('abort', notify, { once: true });
  const usage = zeroUsage();
  const texts = new Map<string, string>();
  const seenCalls = new Set<string>();
  const tools = new Map(opts.tools.map(tool => [tool.name, tool]));
  try {
    const thread = await rpc.request('thread/start', {
      model: opts.model, modelProvider: 'openai', allowProviderModelFallback: false,
      ephemeral: true, sandbox: 'read-only', approvalPolicy: 'untrusted',
      dynamicTools: opts.tools.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema })),
    });
    threadId = thread.thread?.id;
    if (!threadId) throw new Error('Codex did not create a thread.');
    opts.signal?.throwIfAborted();
    const turn = await rpc.request('turn/start', {
      threadId, input: [{ type: 'text', text: opts.prompt, text_elements: [] }],
    });
    turnId = turn.turn?.id;
    if (!turnId) throw new Error('Codex did not start a turn.');
    while (!completed) {
      opts.signal?.throwIfAborted();
      if (!queue.length) {
        await new Promise<void>(resolve => { wake = resolve; });
        continue;
      }
      const message = queue.shift()!;
      const p = message.params;
      if (p?.threadId !== threadId) continue;
      if (p.turnId !== undefined && p.turnId !== turnId) continue;
      if (message.method === 'item/agentMessage/delta') {
        if (typeof p.itemId !== 'string' || typeof p.delta !== 'string') throw new Error('Malformed Codex text event.');
        if (!texts.has(p.itemId)) yield { type: 'text-start', id: p.itemId };
        texts.set(p.itemId, (texts.get(p.itemId) ?? '') + p.delta);
        yield { type: 'text-delta', id: p.itemId, text: p.delta };
      } else if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
        const item = p.item;
        if (!texts.has(item.id)) {
          yield { type: 'text-start', id: item.id };
          yield { type: 'text-delta', id: item.id, text: item.text };
        }
        yield { type: 'text-end', id: item.id };
        texts.delete(item.id);
      } else if (message.method === 'item/tool/call' && message.id !== undefined) {
        if (typeof p.callId !== 'string' || typeof p.tool !== 'string') throw new Error('Malformed Codex tool event.');
        if (seenCalls.has(p.callId)) {
          rpc.reply(message.id, { contentItems: [{ type: 'inputText', text: 'Duplicate tool call refused.' }], success: false });
          continue;
        }
        seenCalls.add(p.callId);
        const tool = !p.namespace ? tools.get(p.tool) : undefined;
        yield { type: 'tool-call', toolCallId: p.callId, toolName: p.tool, input: p.arguments };
        let output: unknown;
        let success = false;
        let serialized: string;
        try {
          opts.signal?.throwIfAborted();
          if (!tool) throw new Error('Unavailable tool');
          output = await tool.execute(p.arguments);
          serialized = JSON.stringify(output ?? null);
          success = true;
        } catch {
          // Tool exceptions may include paths or credentials. Do not relay them.
          output = 'The requested Myelin tool was unavailable or failed.';
          serialized = JSON.stringify(output);
        }
        rpc.reply(message.id, { contentItems: [{ type: 'inputText', text: serialized }], success });
        yield { type: 'tool-result', toolCallId: p.callId, toolName: p.tool, output, ...(!success ? { isError: true } : {}) };
      } else if (message.id !== undefined) {
        // No shell/file approval or user-interaction request is authorized by this runner.
        throw new Error('Codex requested an unsupported client action.');
      } else if (message.method === 'thread/tokenUsage/updated') {
        const last = p.tokenUsage?.last;
        if (last) {
          usage.cacheReadTokens = last.cachedInputTokens ?? 0;
          usage.inputTokens = Math.max(0, (last.inputTokens ?? 0) - usage.cacheReadTokens);
          usage.outputTokens = last.outputTokens ?? 0;
        }
      } else if (message.method === 'turn/completed' && p.turn?.id === turnId) {
        completed = true;
        if (p.turn.status !== 'completed') throw new Error(p.turn.status === 'interrupted'
          ? 'Codex turn was interrupted.' : 'Codex turn failed. Check your subscription access and retry.');
        for (const id of texts.keys()) yield { type: 'text-end', id };
        yield { type: 'finish', reason: 'stop', usage };
      }
    }
  } finally {
    unsubscribe();
    opts.signal?.removeEventListener('abort', notify);
    if (threadId && turnId && !completed) {
      await rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    }
  }
}
