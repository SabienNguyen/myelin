// Chat state for the first-party runtime (own-harness phase E1): messages, running flag, error,
// behind a subscribe/notify store small enough to hand to useSyncExternalStore. Replaces the
// chat state machine inside the bundled ai@6 (AbstractChat) — every behavior here ports a rule
// that machine enforced, called out inline.
import { generateMessageId } from '../../shared/uiMessageReducer.js';
import { isToolUIPart, type FileUIPart, type ToolUIPart, type UIMessage, type UIPart } from '../../shared/uiMessages.js';
import { blockOutputsComplete } from './blockOutputsComplete.js';
import { consumeChatStream } from './streamConsumer.js';

export interface ChatState {
  messages: UIMessage[];
  isRunning: boolean;
  error?: string;
}

export interface ChatStoreOptions {
  threadId: string;
  initialMessages: UIMessage[];
  /** Resolved per REQUEST, not captured at construction: `mode` must track the topbar selector
   * (which changes without remounting the store), and `writeUp` is a one-shot flag armed just
   * before a single send — only that request should carry it. */
  requestContext: () => { mode: string; writeUp: boolean };
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class ChatStore {
  private state: ChatState;
  private listeners = new Set<() => void>();
  private inflight: AbortController | null = null;
  // Tool outputs added while a stream is RUNNING. Every onUpdate/onFinish snapshot comes from
  // the stream's assembler, which knows nothing of client-added outputs — without re-applying
  // them to each snapshot, the next chunk silently undoes the learner's answer (ai@6 never had
  // the race: its addToolResult wrote into the stream's own working state). Cleared at run
  // start: by then any patch is already part of the history being POSTed.
  private midRunOutputs = new Map<string, { output: unknown; isError: boolean }>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ChatStoreOptions) {
    this.state = { messages: opts.initialMessages, isRunning: false };
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  // Stable function identities: useSyncExternalStore resubscribes on every new subscribe
  // reference, and getState must return the same snapshot object between notifications.
  getState = (): ChatState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private setState(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Thread restore / external replacement. */
  setMessages(messages: UIMessage[]): void {
    this.setState({ messages });
  }

  sendMessage(text: string, files: FileUIPart[] = []): void {
    const messages = closePendingToolCalls(this.state.messages);
    // Attachments LEAD, text follows — the media-then-question order both provider wires read
    // best, and the order uiMessagesToChatMessages preserves verbatim. A files-only send carries
    // no text part at all; with neither text nor files the legacy single-empty-text-part message
    // is kept (every UI caller gates on having something to send, so this is unreachable from
    // the composer — but a byte-identical no-files path beats a new special case).
    const parts: UIPart[] = [...files];
    if (text !== '' || files.length === 0) parts.push({ type: 'text', text });
    const user: UIMessage = { id: generateMessageId(), role: 'user', parts };
    this.setState({ messages: [...messages, user] });
    void this.run();
  }

  /** POST the current history as-is — how an answered block's output returns to the server
   * (the server patches grading into the part and continues the same assistant message). */
  resubmit(): void {
    void this.run();
  }

  /** Write a tool result into its part, then apply the auto-resubmit predicate — the
   * sendAutomaticallyWhen equivalent. Mid-run results patch AND are recorded for re-application
   * over later stream snapshots (see midRunOutputs); the finish-time check in run() picks them
   * up once the stream settles, same as ai@6 deferring auto-send to run end. */
  addToolOutput({ toolCallId, output, isError = false }: { toolCallId: string; output: unknown; isError?: boolean }): void {
    const messages = patchToolOutput(this.state.messages, toolCallId, output, isError);
    if (messages === null) {
      // A result for a part that is not in the history is a real bug (the part supplied its own
      // toolCallId to the block that answered it) — but a UI click handler must not throw.
      console.error(`addToolOutput: no tool part for toolCallId "${toolCallId}"`);
      return;
    }
    this.setState({ messages });
    if (this.state.isRunning) {
      this.midRunOutputs.set(toolCallId, { output, isError });
      return;
    }
    if (blockOutputsComplete({ messages })) this.resubmit();
  }

  abort(): void {
    this.inflight?.abort();
    this.inflight = null;
    this.setState({ isRunning: false });
  }

  /** Re-apply mid-run tool outputs over a stream snapshot (they are absent from the assembler's
   * view of the message). A patch that no longer finds its part passes through unchanged. */
  private withMidRunOutputs(messages: UIMessage[]): UIMessage[] {
    let out = messages;
    for (const [toolCallId, { output, isError }] of this.midRunOutputs) {
      out = patchToolOutput(out, toolCallId, output, isError) ?? out;
    }
    return out;
  }

  private async run(): Promise<void> {
    this.inflight?.abort(); // a superseded send loses the stream, not the history
    const controller = new AbortController();
    this.inflight = controller;
    this.midRunOutputs.clear();
    const { mode, writeUp } = this.opts.requestContext();
    // Clearing a previous turn's error re-clones the last message: assistant-ui's converter
    // caches per message reference and an explicit error status is sticky in that cache, so
    // without a fresh identity the error bubble would survive into the retry.
    const messages = this.state.error !== undefined ? refreshLast(this.state.messages) : this.state.messages;
    this.setState({ messages, isRunning: true, error: undefined });

    let finished: UIMessage[] | null = null;
    const result = await consumeChatStream({
      body: { messages: this.state.messages, mode, threadId: this.opts.threadId, writeUp },
      signal: controller.signal,
      fetchImpl: this.fetchImpl,
      onUpdate: (inProgress) => { this.setState({ messages: this.withMidRunOutputs(inProgress) }); },
      // Setting the error also re-clones the last message, for the same converter-cache reason
      // clearing one does (refreshLast below): the error status rides the last assistant
      // message's conversion, and without a fresh identity the cached conversion would win.
      onError: (errorText) => {
        this.setState({ messages: refreshLast(this.state.messages), error: errorText });
      },
      onFinish: (finalMessages) => { finished = finalMessages; },
    });
    if (result === 'aborted') return; // the superseding run owns the state now
    this.inflight = null;

    if (finished === null) {
      this.setState({ isRunning: false });
      return;
    }
    const settled = this.withMidRunOutputs(finished);
    this.setState({ messages: settled, isRunning: false });
    // Response-side persistence: the server's chatRoute only saves the REQUEST side; the
    // assembled response is saved here. Fire-and-forget, same as the runtime it replaces.
    void this.fetchImpl(`/api/thread/${this.opts.threadId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settled),
    }).catch(() => {});
    // The finish-time predicate check (a result added while the previous stream was still
    // running). Never after an errored turn — a resubmit that errors again would loop.
    if (this.state.error === undefined && blockOutputsComplete({ messages: settled })) this.resubmit();
  }
}

/** Port of react-ai-sdk's completePendingToolCalls (on by default there): a block the learner
 * typed past instead of answering must not stay open — the transcript would carry a tool call
 * with no result, which the provider wire rejects. Closing it as output-error with this exact
 * text also keeps toolkit.tsx's errorNote reading it as "the conversation moved on", not as a
 * malformed call. */
function closePendingToolCalls(messages: UIMessage[]): UIMessage[] {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== 'assistant') return messages;
  let changed = false;
  const parts = last.parts.map((part) => {
    if (!isToolUIPart(part) || part.state === 'output-available' || part.state === 'output-error') return part;
    changed = true;
    return { ...part, state: 'output-error', errorText: 'User cancelled tool call by sending a new message.' } as ToolUIPart;
  });
  return changed ? [...messages.slice(0, -1), { ...last, parts }] : messages;
}

/** Immutable patch of the part carrying toolCallId, searched from the newest message backwards
 * (a block answers its own, most recent call). Returns null when no such part exists. */
function patchToolOutput(messages: UIMessage[], toolCallId: string, output: unknown, isError: boolean): UIMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const index = message.parts.findIndex((p) => isToolUIPart(p) && p.toolCallId === toolCallId);
    if (index === -1) continue;
    const part = message.parts[index] as ToolUIPart;
    const patched: ToolUIPart = isError
      ? { ...part, state: 'output-error', errorText: typeof output === 'string' ? output : JSON.stringify(output) }
      : { ...part, state: 'output-available', output };
    const parts = [...message.parts];
    parts[index] = patched;
    const next = [...messages];
    next[i] = { ...message, parts };
    return next;
  }
  return null;
}

function refreshLast(messages: UIMessage[]): UIMessage[] {
  const last = messages[messages.length - 1];
  return last === undefined ? messages : [...messages.slice(0, -1), { ...last }];
}
