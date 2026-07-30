// OpenAI chat-completions adapter over plain fetch: Ollama, OpenRouter, Nous, and a LiteLLM
// proxy all speak this one wire format.
import {
  errorFromResponse, isServerTool, zeroUsage, LlmHttpError,
  type ChatModel, type ChatRequest, type FinishReason, type GenerateResult,
  type StreamEvent, type ToolCallPart, type Usage,
} from './types.js';
import { sseFrames } from './sse.js';
import { withRetries, type RetryOptions } from './retry.js';

export interface OpenAICompatModelOptions {
  modelId: string;
  baseUrl: string;
  /** Absent means no Authorization header — the common local (Ollama) case. */
  apiKey?: string;
  /** Request-initiation retry knobs (retry.ts). Tests shrink the delays; callers rarely should. */
  retry?: RetryOptions;
}

const PROVIDER = 'openai-compat';

type Json = Record<string, unknown>;

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface WireToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface WireChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: WireUsage | null;
}

function wireMessages(req: ChatRequest): Json[] {
  const out: Json[] = [];
  if (req.system !== undefined) out.push({ role: 'system', content: req.system });
  for (const msg of req.messages) {
    if (msg.role === 'assistant') {
      let text = '';
      const calls: Json[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') text += part.text;
        else if (part.type === 'tool-call') {
          calls.push({
            id: part.toolCallId,
            type: 'function',
            function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
          });
        }
      }
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      // Tool results become role:'tool' messages, emitted before any user text so they sit
      // directly after the assistant tool_calls message they answer.
      let text = '';
      for (const part of msg.content) {
        if (part.type === 'text') text += part.text;
        else if (part.type === 'tool-result') {
          out.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            content: typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
          });
        }
      }
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

function buildBody(modelId: string, req: ChatRequest, stream: boolean): Json {
  const body: Json = { model: modelId, messages: wireMessages(req) };
  // Server tools are provider-executed Anthropic surface; this wire has no equivalent, so they
  // are dropped rather than sent as malformed function tools.
  const fnTools = (req.tools ?? []).filter((t) => !isServerTool(t));
  if (fnTools.length) {
    body.tools = fnTools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  if (req.toolChoice) {
    body.tool_choice = req.toolChoice === 'auto'
      ? 'auto'
      : { type: 'function', function: { name: req.toolChoice.name } };
  }
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (stream) {
    body.stream = true;
    // Without this, most providers omit usage from the stream entirely.
    body.stream_options = { include_usage: true };
  }
  return body;
}

function post(opts: OpenAICompatModelOptions, body: Json): Promise<Response> {
  return withRetries(async () => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await errorFromResponse(PROVIDER, res);
    return res;
  }, opts.retry);
}

function usageOf(u?: WireUsage | null): Usage {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0, // this wire has no cache-write accounting
  };
}

function mapFinish(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'tool_calls': return 'tool-calls';
    default: return 'other';
  }
}

function parseArgs(args: string): unknown {
  return args ? JSON.parse(args) : {};
}

export function openaiCompatModel(opts: OpenAICompatModelOptions): ChatModel {
  return {
    async generate(req: ChatRequest): Promise<GenerateResult> {
      const res = await post(opts, buildBody(opts.modelId, req, false));
      const data = await res.json() as {
        choices?: { message?: { content?: string | null; tool_calls?: WireToolCall[] }; finish_reason?: string | null }[];
        usage?: WireUsage;
      };
      const choice = data.choices?.[0];
      const toolCalls: ToolCallPart[] = (choice?.message?.tool_calls ?? []).map((c) => ({
        type: 'tool-call',
        toolCallId: c.id,
        toolName: c.function.name,
        input: parseArgs(c.function.arguments),
      }));
      return {
        text: choice?.message?.content ?? '',
        toolCalls,
        usage: usageOf(data.usage),
        finishReason: mapFinish(choice?.finish_reason),
      };
    },

    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      const res = await post(opts, buildBody(opts.modelId, req, true));
      if (!res.body) throw new LlmHttpError(PROVIDER, res.status, 'response had no body');
      const TEXT_ID = '0';
      let textOpen = false;
      // Tool calls assemble BY INDEX: id and name arrive on the first fragment only; later
      // fragments carry just {index, function: {arguments}}.
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: string | null | undefined;
      let usage = zeroUsage();

      for await (const frame of sseFrames(res.body)) {
        if (frame.data === '[DONE]') break;
        const chunk = JSON.parse(frame.data) as WireChunk;
        // The usage-bearing final chunk may have EMPTY choices — read usage before bailing.
        if (chunk.usage) usage = usageOf(chunk.usage);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          if (!textOpen) {
            textOpen = true;
            yield { type: 'text-start', id: TEXT_ID };
          }
          yield { type: 'text-delta', id: TEXT_ID, text: choice.delta.content };
        }
        for (const frag of choice.delta?.tool_calls ?? []) {
          let st = calls.get(frag.index);
          if (!st) {
            st = { id: frag.id ?? `call_${frag.index}`, name: frag.function?.name ?? '', args: '' };
            calls.set(frag.index, st);
            yield { type: 'tool-input-start', toolCallId: st.id, toolName: st.name };
          }
          const args = frag.function?.arguments;
          if (args) {
            st.args += args;
            yield { type: 'tool-input-delta', toolCallId: st.id, delta: args };
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      if (textOpen) yield { type: 'text-end', id: TEXT_ID };
      for (const [, st] of [...calls.entries()].sort(([a], [b]) => a - b)) {
        yield { type: 'tool-call', toolCallId: st.id, toolName: st.name, input: parseArgs(st.args) };
      }
      yield { type: 'finish', reason: mapFinish(finishReason), usage };
    },
  };
}
