// First-party model-layer contract (own-harness phase A). Both adapters translate to and from
// these types over plain fetch; no provider wire types leak past src/server/llm/.

export interface TextPart { type: 'text'; text: string }

/** Extended-thinking output. It round-trips because the Anthropic wire REQUIRES it back: when
 * thinking is active, the thinking block that preceded a tool_use must be echoed with the tool
 * results (tool loop and client block-pause resubmit alike) or the next request 400s. One part
 * type covers both wire shapes — a redacted_thinking block (opaque, arrives whole) sets
 * `redacted` and leaves text empty — so contentBlock() and the UI round-trip branch on a field
 * instead of a second part kind. */
export interface ThinkingPart {
  type: 'thinking';
  text: string;
  /** Verification signature; echoed back verbatim alongside the text. */
  signature?: string;
  /** Opaque redacted_thinking payload; echoed back as { type: 'redacted_thinking', data }. */
  redacted?: { data: string };
}

export interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError?: boolean;
}

/** A learner-attached file on a USER message — the request direction only. Responses never carry
 * files, so StreamEvent and the wire chunk vocabulary know nothing of this part. One part type
 * covers images and PDFs alike: the adapters branch on mediaType (application/pdf → Anthropic
 * document block, image/* → image block / compat image_url; anything else degrades per adapter
 * rather than throwing mid-request). */
export interface FilePart {
  type: 'file';
  /** MIME type, e.g. 'image/png' or 'application/pdf'. */
  mediaType: string;
  /** Bare base64 payload — no data: URL prefix. Each adapter adds the framing its wire wants. */
  data: string;
  filename?: string;
}

export type ContentPart = TextPart | ThinkingPart | ToolCallPart | ToolResultPart | FilePart;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentPart[];
}

/** A tool the loop (or client) executes. inputSchema is a raw JSON Schema object — zod callers
 * convert with z.toJSONSchema upstream, MCP tools arrive as JSON Schema already, and both wires
 * take JSON Schema natively, so the adapters never convert schemas. */
export interface ToolDecl {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Provider-executed tool: the value IS the provider-shaped object and travels to the wire
 * verbatim, e.g. Anthropic's {type: 'web_search_20260209', name: 'web_search', max_uses: 8}.
 * The `type` field is the discriminant against ToolDecl, which has none. */
export interface ServerTool {
  type: string;
  name: string;
  [key: string]: unknown;
}

export function isServerTool(t: ToolDecl | ServerTool): t is ServerTool {
  return 'type' in t;
}

export type ToolChoice = 'auto' | { name: string };

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: (ToolDecl | ServerTool)[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
  temperature?: number;
  /** Lets the anthropic adapter place cache_control breakpoints (tools tail, system, penultimate
   * message, last message — the wire's four-breakpoint budget). The openai-compat adapter ignores
   * it — that wire has no explicit cache placement. */
  cache?: boolean;
  /** Cache-entry lifetime for those breakpoints. '1h' survives a learner's long pause between
   * turns at a higher write cost; absent means the wire's 5m default. Meaningless without cache. */
  cacheTtl?: '5m' | '1h';
  /** Raw JSON Schema the DECODER is held to (constrained decoding). The openai-compat adapter
   * sends it as `response_format: {type: 'json_schema', …}` when no tools ride the request, so a
   * small model cannot emit invalid JSON; an endpoint that rejects it falls back to the forced-tool
   * request inside the adapter. The anthropic adapter ignores it — its forced-tool path already
   * yields schema-shaped tool input. Only generateStructured sets this. */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  /** Decoding knobs beyond temperature, one nested object so config and the withRequestDefaults
   * wrapper move it opaquely — call sites never read individual fields. The openai-compat adapter
   * maps each defined field to its snake_case wire name (endpoints ignore what they don't
   * support); the anthropic adapter ignores the whole object (see its buildBody). topK/minP/
   * repetitionPenalty are the levers that actually tame a 7-9B local model — the reason this
   * exists. */
  sampler?: {
    topP?: number;
    topK?: number;
    minP?: number;
    seed?: number;
    stop?: string[];
    repetitionPenalty?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
  };
  /** Reasoning-depth hint from the role's config. The anthropic adapter sends it as
   * output_config.effort and NOTHING else — never a `thinking` field (current Claude models run
   * adaptive thinking by default, and budget_tokens is rejected outright). The openai-compat
   * adapter sends reasoning_effort, the LiteLLM/OpenRouter convention. */
  effort?: 'low' | 'medium' | 'high';
  /** Caller-side abort (client disconnect, supersession). Both adapters wire it into fetch, so an
   * abort cancels the in-flight provider request AND any open stream body; withRetries stops
   * retrying and cuts its backoff sleep short. Distinct from the adapters' timeoutMs, which only
   * bounds waiting for response headers. */
  signal?: AbortSignal;
}

/** Zeros where the wire does not report a figure. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'other';

export type StreamEvent =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; text: string }
  | { type: 'text-end'; id: string }
  | { type: 'thinking-start'; id: string }
  | { type: 'thinking-delta'; id: string; text: string }
  // End carries the ASSEMBLED block (text plus signature, or the redacted payload) so the loop
  // can echo it without re-accumulating deltas. A redacted block emits start+end with no deltas.
  | { type: 'thinking-end'; id: string; text: string; signature?: string; redacted?: { data: string } }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string }
  | { type: 'tool-input-delta'; toolCallId: string; delta: string }
  // Assembled from input deltas; fires at block end.
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'server-tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'server-tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'finish'; reason: FinishReason; usage: Usage };

export interface GenerateResult {
  text: string;
  toolCalls: ToolCallPart[];
  /** Thinking blocks from the response, kept out of `text` so one-shot callers that only read
   * prose never see reasoning. Present only when the model actually thought — generate() callers
   * are single-turn roles that never echo history, so parsing without dropping is all they need. */
  thinking?: ThinkingPart[];
  usage: Usage;
  finishReason: FinishReason;
}

export interface ChatModel {
  generate(req: ChatRequest): Promise<GenerateResult>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  /** True on adapters that honor ChatRequest.responseSchema (openai-compat). generateStructured
   * checks it to pick constrained decoding over the forced-tool mechanism; absent means forced
   * tool. A flag rather than a capability probe on purpose: attempt-and-remember is the design —
   * the adapter itself falls back and remembers endpoints that reject response_format. */
  readonly supportsResponseFormat?: boolean;
}

export class LlmHttpError extends Error {
  readonly status: number;
  readonly provider: string;
  /** Worth retrying: timeout, conflict, rate limit, and every server error — the >= 500 band
   * covers Anthropic's 529 overloaded. */
  readonly retryable: boolean;
  /** How long the PROVIDER says to wait, in ms, when it says so. A rate limit is the one failure
   *  that reports its own cure — "try again in 6.826s" — and guessing instead of reading it is why
   *  a 429 could still exhaust the retries: blind 2s+4s backoff totals 6s against a limit that
   *  wanted 6.8s, so every attempt landed early and the turn died with no output at all. */
  readonly retryAfterMs?: number;

  constructor(provider: string, status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'LlmHttpError';
    this.provider = provider;
    this.status = status;
    this.retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Build an LlmHttpError from a non-2xx response, preferring the provider's own message —
 * both wires report errors as {"error": {"message": ...}}. */
export async function errorFromResponse(provider: string, res: Response): Promise<LlmHttpError> {
  const text = await res.text().catch(() => '');
  let message = `${provider} HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed?.error?.message) message = parsed.error.message;
  } catch { /* non-JSON error body: keep the status-line message */ }
  return new LlmHttpError(provider, res.status, message, retryAfterMs(res, message));
}

/** The provider's own stated wait: the standard `retry-after` header (seconds, or an HTTP date),
 *  falling back to the seconds OpenAI embeds in the rate-limit message itself
 *  ("Please try again in 6.826s") — which is often present when the header is not. */
export function retryAfterMs(res: Response, message: string): number | undefined {
  const header = res.headers?.get?.('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(header);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  const m = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(message);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return m[2].toLowerCase() === 'ms' ? n : n * 1000;
  }
  return undefined;
}
