// The shared message reducer (own-harness phase E1): applies UIMessage stream chunks to a
// working assistant message. Extracted from src/server/llm/wire.ts so BOTH ends run the same
// assembly — the server's onEnd persistence (createUiStream) and the client's stream consumer
// (src/client/chatCore) build byte-identical messages by construction, not by test coverage.
// Portable code only: no node: imports, nothing beyond structuredClone and Map.
import {
  isDataUIPart, isToolUIPart,
  type ReasoningUIPart, type TextUIPart, type ToolUIPart, type UIMessage,
} from './uiMessages.js';

export type UiFinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';

/** The chunk vocabulary the wire layer can emit — a subset of the client schema's full union
 * (source/file/approval chunks exist there but nothing in this app produces them). The reasoning
 * chunks are ai@6's shapes; providerMetadata on reasoning-end is where the wire smuggles the
 * Anthropic thinking signature (or a redacted block's data) so the resubmit can echo it. */
export type UiChunk =
  | { type: 'start'; messageId?: string }
  | { type: 'start-step' }
  | { type: 'finish-step' }
  | { type: 'finish'; finishReason?: UiFinishReason }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string; providerMetadata?: Record<string, unknown> }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string; providerExecuted?: boolean }
  | { type: 'tool-input-delta'; toolCallId: string; inputTextDelta: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown; providerExecuted?: boolean; preliminary?: boolean }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string; providerExecuted?: boolean }
  | { type: 'error'; errorText: string }
  | { type: `data-${string}`; id?: string; data: unknown; transient?: boolean };

// Same format as the AI SDK's default generateId (16 chars, [0-9A-Za-z]): the client PUTs its
// own copy of the response message and saveThread unions by id, so the format staying familiar
// keeps saved threads uniform across the migration.
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function generateMessageId(): string {
  let id = '';
  for (let i = 0; i < 16; i++) id += ID_ALPHABET[Math.random() * ID_ALPHABET.length | 0];
  return id;
}

/** Applies each chunk to a working assistant message. Seeded from the last original message when
 * that message is the continued assistant message (block resubmit), so new parts merge into IT. */
export class MessageAssembler {
  readonly message: UIMessage;
  // Text parts are correlated by chunk id only within a step (correlation resets at
  // finish-step) — the anthropic adapter reuses block-index ids like '0' across steps, so
  // without the reset a second step's text would append to the first step's part.
  private activeText = new Map<string, TextUIPart>();
  // Reasoning tracked apart from text, mirroring ai@6's per-kind correlation: both id spaces
  // come from block indexes / fixed strings and are only unique within their own kind.
  private activeReasoning = new Map<string, ReasoningUIPart>();

  constructor(private readonly originalMessages: UIMessage[], messageId: string) {
    const last = originalMessages[originalMessages.length - 1];
    this.message = last?.role === 'assistant'
      ? structuredClone(last)
      : { id: messageId, role: 'assistant', parts: [] };
  }

  private toolPart(toolCallId: string): ToolUIPart {
    const part = this.message.parts.filter(isToolUIPart).find((p) => p.toolCallId === toolCallId);
    // An output chunk for an unknown call is a wire bug on one side or the other — failing
    // identically on both ends keeps a bad stream from persisting a thread the other side
    // could never have built.
    if (!part) throw new Error(`no tool part for toolCallId "${toolCallId}"`);
    return part;
  }

  apply(chunk: UiChunk): void {
    switch (chunk.type) {
      case 'start':
        if (chunk.messageId !== undefined) this.message.id = chunk.messageId;
        return;
      case 'start-step':
        this.message.parts.push({ type: 'step-start' });
        return;
      case 'finish-step':
        this.activeText.clear();
        this.activeReasoning.clear();
        return;
      case 'text-start': {
        const part: TextUIPart = { type: 'text', text: '', state: 'streaming' };
        this.activeText.set(chunk.id, part);
        this.message.parts.push(part);
        return;
      }
      case 'text-delta': {
        const part = this.activeText.get(chunk.id);
        if (!part) throw new Error(`text-delta for unknown text id "${chunk.id}"`);
        part.text += chunk.delta;
        return;
      }
      case 'text-end': {
        const part = this.activeText.get(chunk.id);
        if (!part) throw new Error(`text-end for unknown text id "${chunk.id}"`);
        part.state = 'done';
        this.activeText.delete(chunk.id);
        return;
      }
      case 'reasoning-start': {
        const part: ReasoningUIPart = { type: 'reasoning', text: '', state: 'streaming' };
        this.activeReasoning.set(chunk.id, part);
        this.message.parts.push(part);
        return;
      }
      case 'reasoning-delta': {
        const part = this.activeReasoning.get(chunk.id);
        if (!part) throw new Error(`reasoning-delta for unknown reasoning id "${chunk.id}"`);
        part.text += chunk.delta;
        return;
      }
      case 'reasoning-end': {
        const part = this.activeReasoning.get(chunk.id);
        if (!part) throw new Error(`reasoning-end for unknown reasoning id "${chunk.id}"`);
        part.state = 'done';
        if (chunk.providerMetadata !== undefined) part.providerMetadata = chunk.providerMetadata;
        this.activeReasoning.delete(chunk.id);
        return;
      }
      case 'tool-input-start': {
        this.message.parts.push({
          type: `tool-${chunk.toolName}`,
          toolCallId: chunk.toolCallId,
          state: 'input-streaming',
          ...(chunk.providerExecuted !== undefined ? { providerExecuted: chunk.providerExecuted } : {}),
        });
        return;
      }
      case 'tool-input-delta':
        // A provisional parse of the partial JSON would only ever be overwritten by
        // tool-input-available; only the final input is observable, so it is skipped.
        return;
      case 'tool-input-available': {
        const existing = this.message.parts.filter(isToolUIPart)
          .find((p) => p.toolCallId === chunk.toolCallId);
        const part = existing ?? (() => {
          const created: ToolUIPart = {
            type: `tool-${chunk.toolName}`, toolCallId: chunk.toolCallId, state: 'input-available',
          };
          this.message.parts.push(created);
          return created;
        })();
        part.state = 'input-available';
        part.input = chunk.input;
        if (chunk.providerExecuted !== undefined) part.providerExecuted = chunk.providerExecuted;
        return;
      }
      case 'tool-output-available': {
        const part = this.toolPart(chunk.toolCallId);
        part.state = 'output-available';
        part.output = chunk.output;
        if (chunk.providerExecuted !== undefined) part.providerExecuted = chunk.providerExecuted;
        if (chunk.preliminary !== undefined) part.preliminary = chunk.preliminary;
        return;
      }
      case 'tool-output-error': {
        const part = this.toolPart(chunk.toolCallId);
        part.state = 'output-error';
        part.errorText = chunk.errorText;
        return;
      }
      case 'finish':
      case 'error':
        return;
      default: {
        // Only data-* chunks remain in the union. Transient ones are display-only and never
        // persist.
        if (chunk.transient) return;
        const existing = chunk.id !== undefined
          ? this.message.parts.filter(isDataUIPart)
            .find((p) => p.type === chunk.type && p.id === chunk.id)
          : undefined;
        if (existing) existing.data = chunk.data;
        else {
          this.message.parts.push({
            type: chunk.type, data: chunk.data,
            ...(chunk.id !== undefined ? { id: chunk.id } : {}),
          });
        }
      }
    }
  }

  /** The originals with the assembled response appended — or, on a continuation, replacing the
   * last original in place (the rule both persistence paths share). */
  finalMessages(): UIMessage[] {
    const last = this.originalMessages[this.originalMessages.length - 1];
    const isContinuation = last !== undefined && this.message.id === last.id;
    return [...(isContinuation ? this.originalMessages.slice(0, -1) : this.originalMessages), this.message];
  }
}
