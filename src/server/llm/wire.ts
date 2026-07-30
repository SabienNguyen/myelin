// Wire layer (own-harness phase C): translates first-party loop events into the exact UIMessage
// stream chunks the existing client consumes. THE LOAD-BEARING CONSTRAINT: the client's bundled
// ai@6 validates every SSE chunk against a STRICT zod union (unknown chunk types AND unknown
// fields are rejected), so every chunk emitted here carries only fields that schema allows —
// see "The wire contract, pinned" in docs/superpowers/specs/2026-07-30-own-harness-design.md.
import type { LoopEvent } from './loop.js';
import type { ChatMessage, ContentPart, FinishReason } from './types.js';
import {
  getToolName, isToolUIPart,
  type TextUIPart, type UIMessage, type UIPart,
} from '../../shared/uiMessages.js';
import {
  generateMessageId, MessageAssembler, type UiChunk, type UiFinishReason,
} from '../../shared/uiMessageReducer.js';

// Message assembly and the chunk vocabulary moved to src/shared/uiMessageReducer.ts (phase E1)
// so the client's chatCore drives the identical reducer; re-exported here so the server surface
// (src/server/llm/index.ts) is unchanged.
export { generateMessageId, type UiChunk, type UiFinishReason };

// Headers the client's transport expects on a UIMessage stream response, byte for byte.
const UI_STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
} as const;

function mapFinishReason(reason: FinishReason): UiFinishReason {
  // First-party FinishReason values are all valid wire values verbatim.
  return reason;
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
   * onError — the response stays a 200 and the stream still terminates cleanly.
   *
   * The second argument aborts when the client is gone — the HTTP request's own signal fired or
   * the response stream was cancelled. Thread it into runLoop/generate so the in-flight provider
   * request is cancelled too, instead of streaming tokens nobody will see. An execute that throws
   * BECAUSE of that abort produces no error chunk (there is no one to show it to); onEnd still
   * fires so the partial turn persists. */
  execute: (writer: UiStreamWriter, signal: AbortSignal) => Promise<void>;
  /** Upstream abort — pass the HTTP request's `signal` here so a client disconnect detected by
   * the server runtime propagates into execute's signal. */
  signal?: AbortSignal;
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

  // The signal execute() receives: fired by the upstream request signal (server runtime noticed
  // the disconnect) OR by the ReadableStream's cancel (the consumer let go of the body). Either
  // way the client is gone, and the provider request downstream should stop.
  const abort = new AbortController();
  const linkUpstream = () => abort.abort(opts.signal!.reason);
  if (opts.signal?.aborted) abort.abort(opts.signal.reason);
  else opts.signal?.addEventListener('abort', linkUpstream, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    cancel(reason) {
      abort.abort(reason);
    },
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
            case 'tool-result':
              return emit(event.isError
                ? {
                  type: 'tool-output-error', toolCallId: event.toolCallId,
                  errorText: typeof event.output === 'string' ? event.output : JSON.stringify(event.output),
                }
                : { type: 'tool-output-available', toolCallId: event.toolCallId, output: event.output });
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
          await opts.execute(writer, abort.signal);
        } catch (e) {
          // No error chunk on an aborted turn: the client is gone, and were it somehow still
          // reading, "aborted" is not a turn failure worth an error bubble.
          if (!abort.signal.aborted) {
            try {
              emit({ type: 'error', errorText: onError(e) });
            } catch { /* the controller already failed; the finally below still runs onEnd */ }
          }
        }
        try {
          emit({ type: 'finish', ...(finishReason !== undefined ? { finishReason } : {}) });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch { /* client disconnected mid-stream — persistence below still happens */ }
        opts.signal?.removeEventListener('abort', linkUpstream);
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
