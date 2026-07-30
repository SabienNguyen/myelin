// Wire layer (own-harness phase C): translates first-party loop events into the exact UIMessage
// stream chunks the existing client consumes. THE LOAD-BEARING CONSTRAINT: the client's bundled
// ai@6 validates every SSE chunk against a STRICT zod union (unknown chunk types AND unknown
// fields are rejected), so every chunk emitted here carries only fields that schema allows —
// see "The wire contract, pinned" in docs/superpowers/specs/2026-07-30-own-harness-design.md.
import type { LoopEvent } from './loop.js';
import type { ChatMessage, ContentPart, FinishReason } from './types.js';
import {
  getToolName, isDataUIPart, isToolUIPart,
  type TextUIPart, type ToolUIPart, type UIMessage, type UIPart,
} from '../../shared/uiMessages.js';

// Headers the client's transport expects on a UIMessage stream response, byte for byte.
const UI_STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
} as const;

export type UiFinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';

/** The chunk vocabulary this wire layer can emit — a subset of the client schema's full union
 * (reasoning/source/file/approval chunks exist there but nothing in this app produces them). */
export type UiChunk =
  | { type: 'start'; messageId?: string }
  | { type: 'start-step' }
  | { type: 'finish-step' }
  | { type: 'finish'; finishReason?: UiFinishReason }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
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

function mapFinishReason(reason: FinishReason): UiFinishReason {
  // First-party FinishReason values are all valid wire values verbatim.
  return reason;
}

/** Server-side mirror of the client's stream processor (processUIMessageStream in the bundled
 * ai@6): applies each chunk to a working assistant message so onEnd can persist exactly what
 * the client will have rendered. Seeded from the last original message when that message is the
 * continued assistant message (block resubmit), so new parts merge into IT. */
class MessageAssembler {
  readonly message: UIMessage;
  // Text parts are correlated by chunk id only within a step (the client resets this map at
  // finish-step) — the anthropic adapter reuses block-index ids like '0' across steps, so
  // without the reset a second step's text would append to the first step's part.
  private activeText = new Map<string, TextUIPart>();

  constructor(private readonly originalMessages: UIMessage[], messageId: string) {
    const last = originalMessages[originalMessages.length - 1];
    this.message = last?.role === 'assistant'
      ? structuredClone(last)
      : { id: messageId, role: 'assistant', parts: [] };
  }

  private toolPart(toolCallId: string): ToolUIPart {
    const part = this.message.parts.filter(isToolUIPart).find((p) => p.toolCallId === toolCallId);
    // The client's processor throws on an output chunk for an unknown call — failing the same
    // way here keeps a server bug from persisting a thread the client could never have built.
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
        // The client parses partial JSON into a provisional `input` while streaming; only the
        // final state is observable server-side (tool-input-available overwrites it), so the
        // provisional parse is skipped here.
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
        // persist (the client hands them to onData and drops them) — same here.
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
   * last original in place (same rule the client's onFinish uses). */
  finalMessages(): UIMessage[] {
    const last = this.originalMessages[this.originalMessages.length - 1];
    const isContinuation = last !== undefined && this.message.id === last.id;
    return [...(isContinuation ? this.originalMessages.slice(0, -1) : this.originalMessages), this.message];
  }
}

export interface UiStreamWriter {
  /** Emit a raw chunk: the pre-model tool-output-available grading writes, the transient
   * data-guardrail warning — anything the loop does not produce itself. */
  write(chunk: UiChunk): void;
  /** Translate a first-party loop event into its wire chunk. The loop's per-step 'finish'
   * event emits nothing — it only records the finishReason for the single stream-level
   * 'finish' chunk written at close. */
  forward(event: LoopEvent): void;
}

export interface CreateUiStreamOptions {
  /** The incoming history. Decides message-id continuity: the outgoing 'start' chunk carries
   * the LAST message's id iff that message is an assistant message (block resubmit — the
   * client continues it in place), else a freshly generated id. */
  originalMessages: UIMessage[];
  /** The turn body. May forward events from SEVERAL sequential loop runs (the guardrail retry
   * merges two runs into one HTTP stream); 'start' is emitted once before it begins and
   * 'finish' once after it settles, never per run. A throw becomes an 'error' chunk via
   * onError — the response stays a 200 and the stream still terminates cleanly. */
  execute: (writer: UiStreamWriter) => Promise<void>;
  /** Fires after the stream closes with the full final history (originals plus the assembled
   * assistant message, merged into the continued message on a resubmit) — the server-side
   * saveThread hook. */
  onEnd?: (result: { messages: UIMessage[]; responseMessage: UIMessage }) => void;
  /** Maps an execute() throw to the errorText the client shows. Defaults to the message. */
  onError?: (error: unknown) => string;
}

export function createUiStream(opts: CreateUiStreamOptions): Response {
  const last = opts.originalMessages[opts.originalMessages.length - 1];
  const messageId = last?.role === 'assistant' ? last.id : generateMessageId();
  const assembler = new MessageAssembler(opts.originalMessages, messageId);
  const onError = opts.onError ?? ((e: unknown) => (e instanceof Error ? e.message : String(e)));
  const encoder = new TextEncoder();
  let finishReason: UiFinishReason | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (chunk: UiChunk) => {
        assembler.apply(chunk);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };
      const writer: UiStreamWriter = {
        write: emit,
        forward(event) {
          switch (event.type) {
            case 'step-start': return emit({ type: 'start-step' });
            case 'step-finish': return emit({ type: 'finish-step' });
            case 'text-start': return emit({ type: 'text-start', id: event.id });
            case 'text-delta': return emit({ type: 'text-delta', id: event.id, delta: event.text });
            case 'text-end': return emit({ type: 'text-end', id: event.id });
            case 'tool-input-start':
              return emit({ type: 'tool-input-start', toolCallId: event.toolCallId, toolName: event.toolName });
            case 'tool-input-delta':
              return emit({ type: 'tool-input-delta', toolCallId: event.toolCallId, inputTextDelta: event.delta });
            case 'tool-call':
              return emit({
                type: 'tool-input-available',
                toolCallId: event.toolCallId, toolName: event.toolName, input: event.input,
              });
            case 'server-tool-call':
              return emit({
                type: 'tool-input-available',
                toolCallId: event.toolCallId, toolName: event.toolName, input: event.input,
                providerExecuted: true,
              });
            case 'server-tool-result':
              return emit({
                type: 'tool-output-available',
                toolCallId: event.toolCallId, output: event.output, providerExecuted: true,
              });
            case 'finish':
              finishReason = mapFinishReason(event.reason);
              return;
          }
        },
      };
      // 'start' opens the stream immediately so the client flips to "running" before any slow
      // turn work (grading, bootstrap) begins inside execute.
      emit({ type: 'start', messageId });
      void (async () => {
        try {
          await opts.execute(writer);
        } catch (e) {
          try {
            emit({ type: 'error', errorText: onError(e) });
          } catch { /* the controller already failed; the finally below still runs onEnd */ }
        }
        try {
          emit({ type: 'finish', ...(finishReason !== undefined ? { finishReason } : {}) });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch { /* client disconnected mid-stream — persistence below still happens */ }
        opts.onEnd?.({ messages: assembler.finalMessages(), responseMessage: assembler.message });
      })();
    },
  });

  return new Response(stream, { headers: UI_STREAM_HEADERS });
}

/** First-party replacement for the SDK's convertToModelMessages, matched to how session.ts
 * uses it: text parts become text, tool parts with results become assistant tool-call plus
 * user tool-result pairs, and step-start parts split an assistant message so each step's calls
 * are grouped with THEIR results (the transcript shape both provider wires demand).
 *
 * Deliberate narrowings against the SDK version:
 * - system messages throw: the system prompt rides ChatRequest.system, and silently dropping
 *   one from a transcript would change the prompt.
 * - provider-executed tool parts are skipped: ContentPart has no server-tool representation
 *   (the provider ran the call inside its own turn; replaying it as a client tool_use would
 *   misstate history on the Anthropic wire), and the model's own prose keeps what it learned.
 * - data-* parts, step-start markers, and never-completed (input-streaming) calls are skipped.
 *   A paused block tool (input-available) keeps its tool-call; the resubmit supplies the result. */
export function uiMessagesToChatMessages(messages: UIMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        throw new Error('system messages ride ChatRequest.system, not the transcript');
      case 'user': {
        const content: ContentPart[] = msg.parts
          .filter((p): p is TextUIPart => p.type === 'text')
          .map((p) => ({ type: 'text', text: p.text }));
        if (content.length) out.push({ role: 'user', content });
        break;
      }
      case 'assistant': {
        let block: UIPart[] = [];
        const flush = () => {
          if (block.length === 0) return;
          const calls: ContentPart[] = [];
          const results: ContentPart[] = [];
          for (const part of block) {
            if (part.type === 'text') {
              calls.push({ type: 'text', text: part.text });
            } else if (isToolUIPart(part)) {
              if (part.providerExecuted === true || part.state === 'input-streaming') continue;
              const toolName = getToolName(part);
              calls.push({ type: 'tool-call', toolCallId: part.toolCallId, toolName, input: part.input });
              if (part.state === 'output-available') {
                results.push({ type: 'tool-result', toolCallId: part.toolCallId, toolName, output: part.output });
              } else if (part.state === 'output-error') {
                results.push({
                  type: 'tool-result', toolCallId: part.toolCallId, toolName,
                  output: part.errorText ?? 'unknown error', isError: true,
                });
              }
            }
          }
          if (calls.length) out.push({ role: 'assistant', content: calls });
          if (results.length) out.push({ role: 'user', content: results });
          block = [];
        };
        for (const part of msg.parts) {
          if (part.type === 'step-start') flush();
          else block.push(part);
        }
        flush();
        break;
      }
    }
  }
  return out;
}
