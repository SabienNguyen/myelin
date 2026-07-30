// Anthropic Messages API adapter over plain fetch. Native rather than via a proxy so prompt-cache
// placement and cache-hit accounting stay first-party (the Tier-2 efficiency program).
import {
  errorFromResponse, isServerTool, zeroUsage, LlmHttpError,
  type ChatModel, type ChatRequest, type ContentPart, type FinishReason,
  type GenerateResult, type StreamEvent, type ThinkingPart, type ToolCallPart, type Usage,
} from './types.js';
import { sseFrames } from './sse.js';
import { withRetries, type RetryOptions } from './retry.js';

export interface AnthropicModelOptions {
  modelId: string;
  /** Defaults to ANTHROPIC_API_KEY, read PER REQUEST: the setup panel saves a key at runtime and
   * the next call must see it without a restart (the constraint models.ts documents). */
  apiKey?: string;
  baseUrl?: string;
  /** Request-initiation retry knobs (retry.ts). Tests shrink the delays; callers rarely should. */
  retry?: RetryOptions;
  /** Milliseconds allowed for the provider to return response HEADERS, per attempt. Deliberately
   * not a whole-request deadline: a long stream reads for minutes, but a healthy endpoint answers
   * with headers fast — hanging there means a dead connection. Expiry surfaces as a retryable
   * 408, so withRetries gets its shot. Default 120s. */
  timeoutMs?: number;
}

const PROVIDER = 'anthropic';
const DEFAULT_TIMEOUT_MS = 120_000;
const CACHE = { type: 'ephemeral' } as const;

type Json = Record<string, unknown>;

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

type WireBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  // Redacted thinking is opaque: no deltas, the whole payload rides content_block_start.
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'server_tool_use'; id: string; name: string; input: unknown }
  | { type: 'web_search_tool_result'; tool_use_id: string; content: unknown };

type WireEvent =
  | { type: 'message_start'; message?: { usage?: WireUsage } }
  | { type: 'content_block_start'; index: number; content_block: WireBlock }
  | { type: 'content_block_delta'; index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'signature_delta'; signature: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta?: { stop_reason?: string | null }; usage?: WireUsage }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error?: { type?: string; message?: string } };

function contentBlock(part: ContentPart): Json {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'thinking':
      // Serialized in its original position (thinking leads an assistant turn): with thinking
      // active the API rejects a tool_use whose preceding thinking block is missing, so echoing
      // these — signature and redacted payload intact — is what keeps the tool loop alive.
      return part.redacted
        ? { type: 'redacted_thinking', data: part.redacted.data }
        : {
          type: 'thinking', thinking: part.text,
          ...(part.signature !== undefined ? { signature: part.signature } : {}),
        };
    case 'tool-call':
      return { type: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.input };
    case 'tool-result':
      return {
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
        ...(part.isError ? { is_error: true } : {}),
      };
  }
}

function buildBody(modelId: string, req: ChatRequest, stream: boolean): Json {
  // req.responseSchema is deliberately ignored: this wire has no response_format, and the
  // forced-tool mechanism generateStructured uses here already constrains tool input to the
  // schema. The adapter never sets supportsResponseFormat, so the field never arrives anyway.
  // req.sampler is ignored too: current Claude models reject top_p/top_k alongside adaptive
  // thinking, and the harness's Claude routes need no sampler tuning — that block exists for
  // local/compat models, so it stops here rather than 400 every request that carries it.
  const messages = req.messages.map((m) => ({ role: m.role, content: m.content.map(contentBlock) }));
  if (req.cache) {
    // Second breakpoint: the final block of the last message, so the growing history is reused
    // turn to turn. (The first breakpoint — the stable prefix — is the system block below.)
    const last = messages[messages.length - 1]?.content;
    const block = last?.[last.length - 1];
    if (block) block.cache_control = CACHE;
  }
  const body: Json = {
    model: modelId,
    // The wire requires max_tokens; 4096 is the harness default when the caller has no opinion.
    max_tokens: req.maxTokens ?? 4096,
    messages,
    stream,
  };
  if (req.system !== undefined) {
    body.system = [{ type: 'text', text: req.system, ...(req.cache ? { cache_control: CACHE } : {}) }];
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  // Effort is the ONLY thinking control sent: current Claude models run adaptive thinking by
  // default when the request has no `thinking` field, and budget_tokens is rejected with a 400 —
  // so neither is ever serialized here.
  if (req.effort !== undefined) body.output_config = { effort: req.effort };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => isServerTool(t)
      ? t // provider-executed: the provider-shaped object goes to the wire verbatim
      : { name: t.name, description: t.description, input_schema: t.inputSchema });
  }
  if (req.toolChoice) {
    body.tool_choice = req.toolChoice === 'auto'
      ? { type: 'auto' }
      : { type: 'tool', name: req.toolChoice.name };
  }
  return body;
}

function post(opts: AnthropicModelOptions, body: Json, signal?: AbortSignal): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withRetries(async () => {
    // Per-attempt controller so the header timeout can be cleared once headers arrive — a plain
    // AbortSignal.timeout on the fetch would kill a healthy long stream mid-body. The caller's
    // signal stays wired for the response's whole life: an abort after headers cancels body reads.
    const ctrl = new AbortController();
    const forwardAbort = () => ctrl.abort(signal!.reason);
    signal?.throwIfAborted();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(
      () => ctrl.abort(new LlmHttpError(PROVIDER, 408, `no response headers within ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      const base = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw await errorFromResponse(PROVIDER, res);
      return res;
    } catch (e) {
      signal?.removeEventListener('abort', forwardAbort);
      // fetch wraps its signal's reason; unwrap so the timeout's retryable 408 reaches withRetries.
      throw ctrl.signal.aborted ? ctrl.signal.reason : e;
    } finally {
      clearTimeout(timer);
    }
  }, { ...opts.retry, signal });
}

function usageOf(u?: WireUsage): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

function mapStop(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn': case 'stop_sequence': return 'stop';
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool-calls';
    default: return 'other';
  }
}

export function anthropicModel(opts: AnthropicModelOptions): ChatModel {
  return {
    async generate(req: ChatRequest): Promise<GenerateResult> {
      const res = await post(opts, buildBody(opts.modelId, req, false), req.signal);
      const msg = await res.json() as {
        content?: WireBlock[];
        stop_reason?: string | null;
        usage?: WireUsage;
      };
      let text = '';
      const toolCalls: ToolCallPart[] = [];
      const thinking: ThinkingPart[] = [];
      for (const block of msg.content ?? []) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
          toolCalls.push({ type: 'tool-call', toolCallId: block.id, toolName: block.name, input: block.input });
        } else if (block.type === 'thinking') {
          // Kept out of `text`: one-shot callers read prose, and reasoning leaking into a graded
          // answer or a generated card would be a correctness bug, not a display nit.
          thinking.push({
            type: 'thinking', text: block.thinking,
            ...(block.signature !== undefined ? { signature: block.signature } : {}),
          });
        } else if (block.type === 'redacted_thinking') {
          thinking.push({ type: 'thinking', text: '', redacted: { data: block.data } });
        }
        // server_tool_use / web_search_tool_result are provider-side artifacts; the one-shot
        // generate() callers never request server tools, so they are ignored here.
      }
      return {
        text, toolCalls,
        ...(thinking.length ? { thinking } : {}),
        usage: usageOf(msg.usage), finishReason: mapStop(msg.stop_reason),
      };
    },

    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      const res = await post(opts, buildBody(opts.modelId, req, true), req.signal);
      if (!res.body) throw new LlmHttpError(PROVIDER, res.status, 'response had no body');
      const usage = zeroUsage();
      let stopReason: string | null | undefined;
      // Per-index state for open content blocks. tool_use input arrives as string fragments and
      // is only parseable once the block stops, so it accumulates here — as do a thinking block's
      // text and signature fragments, since thinking-end promises the assembled block.
      const blocks = new Map<number, {
        kind: 'text' | 'tool' | 'server-tool' | 'thinking';
        id: string; name: string; json: string;
        thinking: string; signature?: string; redacted?: { data: string };
      }>();
      const serverToolNames = new Map<string, string>();

      for await (const frame of sseFrames(res.body)) {
        const ev = JSON.parse(frame.data) as WireEvent;
        switch (ev.type) {
          case 'message_start': {
            const u = usageOf(ev.message?.usage);
            usage.inputTokens = u.inputTokens;
            usage.cacheReadTokens = u.cacheReadTokens;
            usage.cacheWriteTokens = u.cacheWriteTokens;
            break;
          }
          case 'content_block_start': {
            const block = ev.content_block;
            if (block.type === 'text') {
              const id = String(ev.index);
              blocks.set(ev.index, { kind: 'text', id, name: '', json: '', thinking: '' });
              yield { type: 'text-start', id };
            } else if (block.type === 'thinking') {
              const id = String(ev.index);
              blocks.set(ev.index, { kind: 'thinking', id, name: '', json: '', thinking: '' });
              yield { type: 'thinking-start', id };
            } else if (block.type === 'redacted_thinking') {
              // Opaque and whole on arrival: start/end bracket it anyway so downstream sees the
              // one thinking shape, with the payload riding thinking-end's `redacted`.
              const id = String(ev.index);
              blocks.set(ev.index, {
                kind: 'thinking', id, name: '', json: '', thinking: '', redacted: { data: block.data },
              });
              yield { type: 'thinking-start', id };
            } else if (block.type === 'tool_use') {
              blocks.set(ev.index, { kind: 'tool', id: block.id, name: block.name, json: '', thinking: '' });
              yield { type: 'tool-input-start', toolCallId: block.id, toolName: block.name };
            } else if (block.type === 'server_tool_use') {
              // Buffered silently: a provider-executed call is announced whole at block stop.
              blocks.set(ev.index, { kind: 'server-tool', id: block.id, name: block.name, json: '', thinking: '' });
              serverToolNames.set(block.id, block.name);
            } else if (block.type === 'web_search_tool_result') {
              yield {
                type: 'server-tool-result',
                toolCallId: block.tool_use_id,
                toolName: serverToolNames.get(block.tool_use_id) ?? 'web_search',
                output: block.content,
              };
            }
            break;
          }
          case 'content_block_delta': {
            const st = blocks.get(ev.index);
            if (!st) break;
            if (ev.delta.type === 'text_delta') {
              yield { type: 'text-delta', id: st.id, text: ev.delta.text };
            } else if (ev.delta.type === 'thinking_delta') {
              st.thinking += ev.delta.thinking;
              yield { type: 'thinking-delta', id: st.id, text: ev.delta.thinking };
            } else if (ev.delta.type === 'signature_delta') {
              // Accumulated silently: the signature is echo plumbing, not display, and it is
              // announced whole on thinking-end.
              st.signature = (st.signature ?? '') + ev.delta.signature;
            } else if (ev.delta.type === 'input_json_delta') {
              st.json += ev.delta.partial_json;
              if (st.kind === 'tool') yield { type: 'tool-input-delta', toolCallId: st.id, delta: ev.delta.partial_json };
            }
            break;
          }
          case 'content_block_stop': {
            const st = blocks.get(ev.index);
            if (!st) break;
            blocks.delete(ev.index);
            if (st.kind === 'text') {
              yield { type: 'text-end', id: st.id };
            } else if (st.kind === 'thinking') {
              yield {
                type: 'thinking-end', id: st.id, text: st.thinking,
                ...(st.signature !== undefined ? { signature: st.signature } : {}),
                ...(st.redacted !== undefined ? { redacted: st.redacted } : {}),
              };
            } else {
              // A no-argument tool streams no input_json_delta at all: empty accumulation is {}.
              const input: unknown = st.json ? JSON.parse(st.json) : {};
              yield st.kind === 'tool'
                ? { type: 'tool-call', toolCallId: st.id, toolName: st.name, input }
                : { type: 'server-tool-call', toolCallId: st.id, toolName: st.name, input };
            }
            break;
          }
          case 'message_delta': {
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            if (ev.usage?.output_tokens !== undefined) usage.outputTokens = ev.usage.output_tokens;
            break;
          }
          case 'message_stop':
            yield { type: 'finish', reason: mapStop(stopReason), usage };
            return;
          case 'ping':
            break;
          case 'error': {
            // Mid-stream fault: the HTTP status was already 200, so a status is reconstructed —
            // overloaded_error is the streaming face of HTTP 529; anything else reports as 500.
            const status = ev.error?.type === 'overloaded_error' ? 529 : 500;
            throw new LlmHttpError(PROVIDER, status, ev.error?.message ?? 'stream error');
          }
        }
      }
    },
  };
}
