// OpenAI chat-completions adapter over plain fetch: Ollama, OpenRouter, Nous, and a LiteLLM
// proxy all speak this one wire format.
import {
  errorFromResponse, isServerTool, zeroUsage, LlmHttpError,
  type ChatModel, type ChatRequest, type FinishReason, type GenerateResult,
  type StreamEvent, type ThinkingPart, type ToolCallPart, type Usage,
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
  /** Milliseconds allowed for the endpoint to return response HEADERS, per attempt. Not a
   * whole-request deadline — a local model streams for minutes, but even a busy Ollama answers
   * with headers long before this. Expiry surfaces as a retryable 408. Default 120s. */
  timeoutMs?: number;
}

const PROVIDER = 'openai-compat';
const DEFAULT_TIMEOUT_MS = 120_000;

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
      /** DeepSeek/LiteLLM reasoning convention; absent on providers without thinking models. */
      reasoning_content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: WireUsage | null;
}

/** Endpoints (by baseUrl) that rejected `response_format: json_schema`. Module-level because
 * models.ts builds a fresh adapter per call — instance state would forget every turn and pay the
 * rejected round-trip on every structured generation instead of once per endpoint. */
const responseFormatRejected = new Set<string>();

/** Test seam: forget rejected endpoints, so one fake server can exercise both paths. */
export function resetResponseFormatMemory(): void {
  responseFormatRejected.clear();
}

/** A rejection OF response_format, as opposed to a call that failed for its own reasons: the
 * 400/422 validation band, or an error message naming the feature. A 5xx or auth failure must
 * throw through — falling back there would mask a real outage as a capability gap. */
function isResponseFormatRejection(e: unknown): boolean {
  if (!(e instanceof LlmHttpError)) return false;
  return e.status === 400 || e.status === 422 || /response_format|json_schema/i.test(e.message);
}

/** The forced-tool form of a responseSchema request — what the same call looked like before
 * constrained decoding, and what an endpoint without response_format still understands. The
 * description matches generateStructured's synthetic tool so both paths read the same to a model. */
function toolFallback(req: ChatRequest): ChatRequest {
  const { responseSchema, ...rest } = req;
  if (!responseSchema) return req;
  return {
    ...rest,
    tools: [{
      name: responseSchema.name,
      description: 'Report the result in the required structure.',
      inputSchema: responseSchema.schema,
    }],
    toolChoice: { name: responseSchema.name },
  };
}

function wireMessages(req: ChatRequest): Json[] {
  const out: Json[] = [];
  if (req.system !== undefined) out.push({ role: 'system', content: req.system });
  for (const msg of req.messages) {
    if (msg.role === 'assistant') {
      let text = '';
      const calls: Json[] = [];
      for (const part of msg.content) {
        // Thinking parts are DROPPED here on purpose: this wire has no echo requirement (no
        // reasoning field on assistant request messages), so replaying them has nothing to ride.
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
      // Text and image parts also accumulate in ORIGINAL order for the array-content form. Only
      // a message that actually carries an image switches to that form — a text-only message
      // keeps the plain-string body it always had, byte for byte, so the transcript prefix stays
      // stable for endpoints that cache by content.
      const parts: Json[] = [];
      let hasImage = false;
      for (const part of msg.content) {
        if (part.type === 'text') {
          text += part.text;
          parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'file') {
          // Only images have a portable chat-completions encoding (the data-URL image_url part).
          // PDFs and unknown types are DROPPED on this wire: there is no compat document shape,
          // and the local 7-9B models this adapter serves cannot read a PDF anyway.
          if (part.mediaType.startsWith('image/')) {
            hasImage = true;
            parts.push({ type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } });
          }
        } else if (part.type === 'tool-result') {
          out.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            content: typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
          });
        }
      }
      if (hasImage) out.push({ role: 'user', content: parts });
      else if (text) out.push({ role: 'user', content: text });
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
  // Constrained decoding: the schema binds the decoder itself, never alongside forced tools —
  // generate() strips responseSchema before any fallback tool request reaches this builder.
  if (req.responseSchema && !fnTools.length) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: req.responseSchema.name, schema: req.responseSchema.schema, strict: true },
    };
  }
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  // Sampler breadth, each field only when set. Ollama's /v1 endpoint, vLLM, and OpenRouter all
  // accept these; an endpoint ignores what it doesn't support, so nothing is gated by provider.
  // top_k / min_p / repetition_penalty are the local-model levers — the knobs that tame a 7-9B
  // model's rambling and loops — which is why the harness carries them at all.
  const s = req.sampler;
  if (s?.topP !== undefined) body.top_p = s.topP;
  if (s?.topK !== undefined) body.top_k = s.topK;
  if (s?.minP !== undefined) body.min_p = s.minP;
  if (s?.seed !== undefined) body.seed = s.seed;
  if (s?.stop !== undefined) body.stop = s.stop;
  if (s?.repetitionPenalty !== undefined) body.repetition_penalty = s.repetitionPenalty;
  if (s?.frequencyPenalty !== undefined) body.frequency_penalty = s.frequencyPenalty;
  if (s?.presencePenalty !== undefined) body.presence_penalty = s.presencePenalty;
  // The LiteLLM/OpenRouter spelling; endpoints without reasoning models ignore it.
  if (req.effort !== undefined) body.reasoning_effort = req.effort;
  if (stream) {
    body.stream = true;
    // Without this, most providers omit usage from the stream entirely.
    body.stream_options = { include_usage: true };
  }
  return body;
}

function post(opts: OpenAICompatModelOptions, body: Json, signal?: AbortSignal): Promise<Response> {
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
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
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

// ---- small-model output parsing: <think> and <tool_call> tags inside content ------------------
//
// Qwen3-class models inline their reasoning as a leading <think>…</think> block in
// message.content; Hermes/NousResearch-tuned models emit tool calls as
// <tool_call>{"name": …, "arguments": …}</tool_call> blocks there instead of the tool_calls API
// field. Both must come OUT of the text: thinking pollutes prose and breaks JSON parsing in
// structured calls, and an unparsed tool_call block is a dead turn. When delta.reasoning_content
// is ALSO present, that convention wins and think tags pass through as literal text — the two
// never co-occur in practice, and a dual state machine would buy nothing.

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';
const CALL_OPEN = '<tool_call>';
const CALL_CLOSE = '</tool_call>';

/** Longest k < tag.length such that s ends with tag.slice(0, k) — how many trailing characters
 * of s might be an incomplete tag and must be held back until the next delta disambiguates. This
 * bound is what keeps the stream flowing: at most tag.length-1 characters are ever withheld. */
function partialTagSuffix(s: string, tag: string): number {
  for (let k = Math.min(s.length, tag.length - 1); k > 0; k--) {
    if (s.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

/** Whether s opens (after optional whitespace — qwen pads the tag with a newline) with tag:
 * 'match' with the index just past it, 'partial' while s could still grow into one (all-whitespace
 * included), 'no' the moment a character diverges. */
function leadingTag(s: string, tag: string): { state: 'match'; end: number } | { state: 'partial' } | { state: 'no' } {
  let i = 0;
  while (i < s.length && /\s/.test(s[i])) i++;
  const rest = s.slice(i);
  if (rest.startsWith(tag)) return { state: 'match', end: i + tag.length };
  return tag.startsWith(rest) ? { state: 'partial' } : { state: 'no' };
}

/** Leading-<think> split of a COMPLETE message. Only a block at the very start counts — a
 * mid-text <think> is a model quoting the token (a tutor explaining the syntax), and real inlined
 * thinking always leads. An unclosed block is a model cut off mid-thought: everything is
 * thinking, text empty — better a blank answer than reasoning graded as prose. The model's own
 * separator whitespace after </think> is stripped so structured JSON starts at text[0]. */
function splitLeadingThink(content: string): { thinking?: string; text: string } {
  const lead = leadingTag(content, THINK_OPEN);
  if (lead.state !== 'match') return { text: content };
  const rest = content.slice(lead.end);
  const close = rest.indexOf(THINK_CLOSE);
  if (close === -1) return { thinking: rest, text: '' };
  return { thinking: rest.slice(0, close), text: rest.slice(close + THINK_CLOSE.length).replace(/^\s+/, '') };
}

/** One <tool_call> payload → a call, or undefined when the JSON is mangled — the caller keeps the
 * block as literal text, because a weak model's malformed call must not kill the turn.
 * `arguments` may be an object (Hermes proper) or a JSON string (OpenAI-style leakage); a string
 * that itself fails to parse counts as mangled. */
function parseHermesPayload(inner: string): { name: string; input: unknown } | undefined {
  try {
    const obj = JSON.parse(inner) as { name?: unknown; arguments?: unknown };
    if (typeof obj.name !== 'string' || !obj.name) return undefined;
    const input: unknown = typeof obj.arguments === 'string' ? JSON.parse(obj.arguments) : (obj.arguments ?? {});
    return { name: obj.name, input };
  } catch {
    return undefined;
  }
}

/** Every well-formed <tool_call> block in a COMPLETE text → synthetic-id tool calls, blocks
 * stripped; a malformed block stays in place, tags included. Ids count valid calls only. */
function extractHermesCalls(text: string): { text: string; calls: ToolCallPart[] } {
  const calls: ToolCallPart[] = [];
  let out = '';
  let pos = 0;
  for (;;) {
    const open = text.indexOf(CALL_OPEN, pos);
    if (open === -1) break;
    const innerStart = open + CALL_OPEN.length;
    const close = text.indexOf(CALL_CLOSE, innerStart);
    if (close === -1) break; // unterminated block: literal to the end
    const end = close + CALL_CLOSE.length;
    const parsed = parseHermesPayload(text.slice(innerStart, close));
    if (parsed) {
      out += text.slice(pos, open);
      calls.push({ type: 'tool-call', toolCallId: `hermes_${calls.length}`, toolName: parsed.name, input: parsed.input });
    } else {
      out += text.slice(pos, end);
    }
    pos = end;
  }
  return { text: out + text.slice(pos), calls };
}

/** What ContentTagScanner hands back per delta; stream() maps these onto StreamEvents (text
 * block bookkeeping — text-start/-end — stays in stream(), which owns the block ids). */
type ScanOp =
  | { kind: 'text'; text: string }
  | { kind: 'think-start' }
  | { kind: 'think-delta'; text: string }
  // Carries the assembled block, matching thinking-end's promise.
  | { kind: 'think-end'; text: string }
  | { kind: 'call-start'; id: string }
  | { kind: 'call'; id: string; name: string; input: unknown };

/**
 * Stateful scanner lifting <think> (message-leading only) and <tool_call> (anywhere, only when
 * hermes is on — i.e. the request declared function tools) out of streamed content deltas. Tags
 * split at ANY byte across deltas, so each phase holds back exactly as much as is still
 * ambiguous: the lead phase holds while the content is whitespace + a proper prefix of <think>;
 * the think and text phases hold at most partialTagSuffix() characters of a possible closing/
 * opening tag; only an open <tool_call> block buffers to its close, because the payload is one
 * JSON value that cannot be parsed or attributed until complete. Nothing ever holds the whole
 * stream.
 */
class ContentTagScanner {
  private phase: 'lead' | 'think' | 'text' | 'call' = 'lead';
  private buf = '';
  private thinkText = '';
  // Set when </think> closes: the model's own separator whitespace is dropped before the first
  // real text character, mirroring splitLeadingThink.
  private trimLead = false;
  private callCount = 0;
  private callId = '';

  constructor(private readonly hermes: boolean) {}

  /** reasoning_content appeared: that convention wins, so <think> stays literal from here on.
   * Idempotent — after the first call the phase has left 'lead' for good. */
  disableThink(): ScanOp[] {
    if (this.phase !== 'lead') return [];
    this.phase = 'text';
    const held = this.buf;
    this.buf = '';
    return held ? this.push(held) : [];
  }

  push(delta: string): ScanOp[] {
    const ops: ScanOp[] = [];
    // Each step consumes under the current phase and returns whatever belongs to the NEXT phase
    // (the text after </think>, the text after a block close) for reprocessing.
    let pending = delta;
    while (pending !== '') pending = this.step(pending, ops);
    return ops;
  }

  /** Stream over: resolve whatever is held. An unclosed <think> means the model was cut off
   * mid-thought (the held close-prefix is thinking too — deltas must sum to the assembled end
   * text); an unterminated <tool_call> degrades to literal text, same rule as extractHermesCalls;
   * a lead buffer that never became <think> was ordinary text all along. */
  flush(): ScanOp[] {
    const ops: ScanOp[] = [];
    if (this.phase === 'think') {
      if (this.buf) {
        this.thinkText += this.buf;
        ops.push({ kind: 'think-delta', text: this.buf });
      }
      ops.push({ kind: 'think-end', text: this.thinkText });
    } else if (this.phase === 'call') {
      ops.push({ kind: 'text', text: CALL_OPEN + this.buf });
    } else if (this.buf) {
      ops.push({ kind: 'text', text: this.buf });
    }
    this.buf = '';
    return ops;
  }

  private step(input: string, ops: ScanOp[]): string {
    switch (this.phase) {
      case 'lead': {
        this.buf += input;
        const lead = leadingTag(this.buf, THINK_OPEN);
        if (lead.state === 'partial') return ''; // could still become <think> — hold
        const held = this.buf;
        this.buf = '';
        if (lead.state === 'no') {
          this.phase = 'text';
          return held;
        }
        this.phase = 'think';
        ops.push({ kind: 'think-start' });
        return held.slice(lead.end);
      }
      case 'think': {
        this.buf += input;
        const close = this.buf.indexOf(THINK_CLOSE);
        if (close === -1) {
          const hold = partialTagSuffix(this.buf, THINK_CLOSE);
          const emit = this.buf.slice(0, this.buf.length - hold);
          this.buf = this.buf.slice(this.buf.length - hold);
          if (emit) {
            this.thinkText += emit;
            ops.push({ kind: 'think-delta', text: emit });
          }
          return '';
        }
        const last = this.buf.slice(0, close);
        if (last) {
          this.thinkText += last;
          ops.push({ kind: 'think-delta', text: last });
        }
        ops.push({ kind: 'think-end', text: this.thinkText });
        const rest = this.buf.slice(close + THINK_CLOSE.length);
        this.buf = '';
        this.phase = 'text';
        this.trimLead = true;
        return rest;
      }
      case 'text': {
        let s = this.buf + input;
        this.buf = '';
        if (this.trimLead) {
          s = s.replace(/^\s+/, '');
          if (!s) return ''; // still in the post-</think> separator — drop and keep waiting
          this.trimLead = false;
        }
        if (!this.hermes) {
          // No declared function tools: <tool_call> stays literal (a tutor explaining the format
          // must not trigger phantom calls), so nothing needs holding back either.
          ops.push({ kind: 'text', text: s });
          return '';
        }
        const open = s.indexOf(CALL_OPEN);
        if (open === -1) {
          const hold = partialTagSuffix(s, CALL_OPEN);
          const emit = s.slice(0, s.length - hold);
          this.buf = s.slice(s.length - hold);
          if (emit) ops.push({ kind: 'text', text: emit });
          return '';
        }
        if (open > 0) ops.push({ kind: 'text', text: s.slice(0, open) });
        this.phase = 'call';
        this.callId = `hermes_${this.callCount++}`;
        // Announced as soon as the open tag is confirmed — the name arrives only with the JSON,
        // so it starts empty, the same default the native fragment path uses for a missing name;
        // the wire keys tool parts by toolCallId, and the 'call' op carries the real name.
        ops.push({ kind: 'call-start', id: this.callId });
        return s.slice(open + CALL_OPEN.length);
      }
      case 'call': {
        this.buf += input;
        const close = this.buf.indexOf(CALL_CLOSE);
        if (close === -1) return ''; // buffering the one block, bounded by its payload
        const inner = this.buf.slice(0, close);
        const rest = this.buf.slice(close + CALL_CLOSE.length);
        this.buf = '';
        this.phase = 'text';
        const parsed = parseHermesPayload(inner);
        // Malformed: the whole block reverts to literal text. The call-start already emitted is
        // inert — the loop only acts on 'tool-call' events, and a wire tool part that never
        // completes beats killing the turn on a weak model's mangled JSON.
        ops.push(parsed
          ? { kind: 'call', id: this.callId, name: parsed.name, input: parsed.input }
          : { kind: 'text', text: CALL_OPEN + inner + CALL_CLOSE });
        return rest;
      }
    }
  }
}

export function openaiCompatModel(opts: OpenAICompatModelOptions): ChatModel {
  const baseKey = opts.baseUrl.replace(/\/$/, '');

  async function generateOnce(req: ChatRequest): Promise<GenerateResult> {
    const res = await post(opts, buildBody(opts.modelId, req, false), req.signal);
    const data = await res.json() as {
      choices?: {
        message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: WireToolCall[] };
        finish_reason?: string | null;
      }[];
      usage?: WireUsage;
    };
    const choice = data.choices?.[0];
    const toolCalls: ToolCallPart[] = (choice?.message?.tool_calls ?? []).map((c) => ({
      type: 'tool-call',
      toolCallId: c.id,
      toolName: c.function.name,
      input: parseArgs(c.function.arguments),
    }));
    let text = choice?.message?.content ?? '';
    const reasoning = choice?.message?.reasoning_content;
    const thinking: ThinkingPart[] = reasoning ? [{ type: 'thinking', text: reasoning }] : [];
    if (!reasoning) {
      // No reasoning_content (the winning convention when both appear): lift a leading
      // <think> block out of content instead. This is what lets a qwen3-class model's
      // structured JSON parse — the think prefix otherwise lands in parseStructuredText.
      const split = splitLeadingThink(text);
      if (split.thinking !== undefined) {
        thinking.push({ type: 'thinking', text: split.thinking });
        text = split.text;
      }
    }
    // Hermes-style content calls, only when the request DECLARED function tools — a model merely
    // shown the syntax in conversation must not fire phantom calls. The forced-tool fallback
    // qualifies: it declares the synthetic schema tool.
    if (text.includes(CALL_OPEN) && (req.tools ?? []).some((t) => !isServerTool(t))) {
      const extracted = extractHermesCalls(text);
      text = extracted.text;
      toolCalls.push(...extracted.calls);
    }
    return {
      text,
      toolCalls,
      ...(thinking.length ? { thinking } : {}),
      usage: usageOf(data.usage),
      finishReason: mapFinish(choice?.finish_reason),
    };
  }

  return {
    supportsResponseFormat: true,

    async generate(req: ChatRequest): Promise<GenerateResult> {
      if (!req.responseSchema || req.tools?.length) return generateOnce(req);
      // Attempt-and-remember: try constrained decoding, and on a rejection fall back to the
      // forced-tool form ONCE — the endpoint is remembered so every later call skips straight to
      // the tool path with no double round-trip.
      if (responseFormatRejected.has(baseKey)) return generateOnce(toolFallback(req));
      try {
        return await generateOnce(req);
      } catch (e) {
        if (!isResponseFormatRejection(e)) throw e;
        responseFormatRejected.add(baseKey);
        return generateOnce(toolFallback(req));
      }
    },

    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      const res = await post(opts, buildBody(opts.modelId, req, true), req.signal);
      if (!res.body) throw new LlmHttpError(PROVIDER, res.status, 'response had no body');
      const TEXT_ID = '0';
      const REASONING_ID = 'reasoning-0';
      const THINK_TAG_ID = 'think-tag-0';
      let textOpen = false;
      // reasoning_content precedes content on this wire, so the block closes on the first
      // regular delta (or at stream end); the accumulated text rides thinking-end, matching the
      // anthropic adapter's assembled-block promise.
      let reasoningOpen = false;
      let reasoningText = '';
      // Content deltas route through the tag scanner (leading <think>, hermes <tool_call>);
      // its ops map onto the same event vocabulary here, so the loop and wire never know which
      // convention the model spoke.
      const scanner = new ContentTagScanner((req.tools ?? []).some((t) => !isServerTool(t)));
      function* opEvents(scanOps: ScanOp[]): Generator<StreamEvent> {
        for (const op of scanOps) {
          switch (op.kind) {
            case 'text':
              if (!textOpen) {
                textOpen = true;
                yield { type: 'text-start', id: TEXT_ID };
              }
              yield { type: 'text-delta', id: TEXT_ID, text: op.text };
              break;
            case 'think-start': yield { type: 'thinking-start', id: THINK_TAG_ID }; break;
            case 'think-delta': yield { type: 'thinking-delta', id: THINK_TAG_ID, text: op.text }; break;
            case 'think-end': yield { type: 'thinking-end', id: THINK_TAG_ID, text: op.text }; break;
            case 'call-start': yield { type: 'tool-input-start', toolCallId: op.id, toolName: '' }; break;
            case 'call': yield { type: 'tool-call', toolCallId: op.id, toolName: op.name, input: op.input }; break;
          }
        }
      }
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
        if (choice.delta?.reasoning_content) {
          if (!reasoningOpen) {
            reasoningOpen = true;
            yield { type: 'thinking-start', id: REASONING_ID };
          }
          reasoningText += choice.delta.reasoning_content;
          yield { type: 'thinking-delta', id: REASONING_ID, text: choice.delta.reasoning_content };
          // reasoning_content wins over <think> tags: any tag in content stays literal text.
          yield* opEvents(scanner.disableThink());
        }
        if (reasoningOpen && (choice.delta?.content || choice.delta?.tool_calls?.length)) {
          reasoningOpen = false;
          yield { type: 'thinking-end', id: REASONING_ID, text: reasoningText };
        }
        if (choice.delta?.content) {
          yield* opEvents(scanner.push(choice.delta.content));
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

      // Held scanner state resolves before the blocks close: an unclosed <think> ends its block,
      // an ambiguous tag prefix or unterminated <tool_call> reverts to text.
      yield* opEvents(scanner.flush());
      // A reasoning-only stream (model cut off mid-thought) still closes its block.
      if (reasoningOpen) yield { type: 'thinking-end', id: REASONING_ID, text: reasoningText };
      if (textOpen) yield { type: 'text-end', id: TEXT_ID };
      for (const [, st] of [...calls.entries()].sort(([a], [b]) => a - b)) {
        yield { type: 'tool-call', toolCallId: st.id, toolName: st.name, input: parseArgs(st.args) };
      }
      yield { type: 'finish', reason: mapFinish(finishReason), usage };
    },
  };
}
