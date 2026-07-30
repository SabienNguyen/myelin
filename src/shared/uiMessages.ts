// First-party UIMessage shape (own-harness phase C). This is the message format the wire layer
// streams, session.ts persists via saveThread, and the client renders — kept deliberately
// narrower than the AI SDK's UIMessage: only the part kinds this app can actually produce.
// The assembler in src/server/llm/wire.ts and the client's stream processor both build exactly
// these shapes, so the union growing a member means the wire contract grew first.

export interface TextUIPart {
  type: 'text';
  /** 'streaming' from text-start until text-end, then 'done' — the client's stream processor
   * sets the same two values, so persisted threads carry 'done' on every finished part. */
  state?: 'streaming' | 'done';
  text: string;
}

/** Model reasoning streamed ahead of the answer — ai@6's ReasoningUIPart shape. providerMetadata
 * carries what the provider wire must get back on a block-pause resubmit: the Anthropic thinking
 * `signature`, or a redacted block's `redactedData`. Flat keys, not ai@6's per-provider nesting —
 * both ends are first-party and uiMessagesToChatMessages is the only reader. */
export interface ReasoningUIPart {
  type: 'reasoning';
  /** 'streaming' from reasoning-start until reasoning-end, then 'done' — same protocol as text. */
  state?: 'streaming' | 'done';
  text: string;
  providerMetadata?: Record<string, unknown>;
}

/** Marks a step boundary inside an assistant message; uiMessagesToChatMessages groups on it. */
export interface StepStartUIPart { type: 'step-start' }

export type ToolUIPartState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error';

/** One tool invocation, keyed by toolCallId, updated in place as chunks arrive. The AI SDK's
 * part carries more fields (rawInput, title, toolMetadata, provider metadata); this app reads
 * none of them, and the wire layer never emits chunks that would set them. */
export interface ToolUIPart {
  type: `tool-${string}`;
  toolCallId: string;
  state: ToolUIPartState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  /** Provider-executed (server) tools, e.g. Anthropic web search: the provider ran the call;
   * the loop never executes it and no client resubmit supplies its output. */
  providerExecuted?: boolean;
  preliminary?: boolean;
}

/** Custom app data streamed as a `data-*` chunk. Transient chunks (the guardrail warning) are
 * never persisted, so a part on a message is always non-transient. */
export interface DataUIPart {
  type: `data-${string}`;
  id?: string;
  data: unknown;
}

export type UIPart = TextUIPart | ReasoningUIPart | StepStartUIPart | ToolUIPart | DataUIPart;

export interface UIMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  parts: UIPart[];
  metadata?: unknown;
}

export function isToolUIPart(part: UIPart): part is ToolUIPart {
  return part.type.startsWith('tool-');
}

export function isDataUIPart(part: UIPart): part is DataUIPart {
  return part.type.startsWith('data-');
}

/** 'tool-quick_check' -> 'quick_check' — the inverse of the part-type prefix, same answer the
 * AI SDK's getToolName gives for static tool parts. */
export function getToolName(part: ToolUIPart): string {
  return part.type.slice('tool-'.length);
}
