// First-party model-layer contract (own-harness phase A). Both adapters translate to and from
// these types over plain fetch; no provider wire types leak past src/server/llm/.

export interface TextPart { type: 'text'; text: string }

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

export type ContentPart = TextPart | ToolCallPart | ToolResultPart;

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
  /** Lets the anthropic adapter place cache_control breakpoints (system tail + last message).
   * The openai-compat adapter ignores it — that wire has no explicit cache placement. */
  cache?: boolean;
  /** Raw JSON Schema the DECODER is held to (constrained decoding). The openai-compat adapter
   * sends it as `response_format: {type: 'json_schema', …}` when no tools ride the request, so a
   * small model cannot emit invalid JSON; an endpoint that rejects it falls back to the forced-tool
   * request inside the adapter. The anthropic adapter ignores it — its forced-tool path already
   * yields schema-shaped tool input. Only generateStructured sets this. */
  responseSchema?: { name: string; schema: Record<string, unknown> };
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

  constructor(provider: string, status: number, message: string) {
    super(message);
    this.name = 'LlmHttpError';
    this.provider = provider;
    this.status = status;
    this.retryable = status === 408 || status === 409 || status === 429 || status >= 500;
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
  return new LlmHttpError(provider, res.status, message);
}
