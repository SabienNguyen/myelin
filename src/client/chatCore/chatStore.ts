// Chat state for the first-party runtime (own-harness phase E1): messages, running flag, error,
// behind a subscribe/notify store small enough to hand to useSyncExternalStore. Replaces the
// chat state machine inside the bundled ai@6 (AbstractChat) — every behavior here ports a rule
// that machine enforced, called out inline.
import { generateMessageId } from '../../shared/uiMessageReducer.js';
import { commandMode, type Command } from '../../shared/commands.js';
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
  requestContext: () => {
    /** Empty string means "derive it" — see chatStore's send. */
    mode: string;
    writeUp: boolean;
    emptyVault?: boolean;
  };
  /** A mode slash command (/study, /learn, /review, /quiz, /freeform, /chat) must set the sticky
   * mode too — the server only overrides the ONE turn the command rides, and it is this callback
   * that makes the following turns keep the new mode (requestContext reads it per request). /study
   * arrives as 'learn'; /chat arrives as '' — see sendMessage. */
  onModeCommand?: (mode: string) => void;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class ChatStore {
  private state: ChatState;
  private listeners = new Set<() => void>();
  private inflight: AbortController | null = null;
  private recoveryGeneration = 0;
  // Tool outputs added while a stream is RUNNING. Every onUpdate/onFinish snapshot comes from
  // the stream's assembler, which knows nothing of client-added outputs — without re-applying
  // them to each snapshot, the next chunk silently undoes the learner's answer (ai@6 never had
  // the race: its addToolResult wrote into the stream's own working state). Cleared at run
  // start: by then any patch is already part of the history being POSTed.
  private midRunOutputs = new Map<string, { output: unknown; isError: boolean }>();
  // Parts added while a stream is RUNNING (an aside asked on an earlier message), keyed by
  // messageId + part id. Same hazard as midRunOutputs: the next chunk's snapshot knows nothing of
  // them, so the aside showed for one chunk and vanished until a reload.
  private midRunParts = new Map<string, { messageId: string; part: UIPart & { id?: string } }>();
  // The slash command riding the NEXT run only — armed by sendMessage, consumed by run(), so a
  // block-answer resubmit (which reuses run()) never replays the command that staged the block.
  private pendingCommand: Command | undefined;
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

  /** The thread this store is bound to — read by callers that need it alongside the store
   * (askAside's request needs threadId, messageId and question; only the store knows threadId). */
  get threadId(): string {
    return this.opts.threadId;
  }

  /** Insert (or replace, matched by part.id) a part on an existing message — how an aside answer
   * lands on the tutor message it was asked about, without a chat turn or a server round-trip
   * through run(). No-ops (with a console.error, same as addToolOutput's own guard) when the
   * message is gone, which the caller cannot be responsible for by the time an async answer
   * resolves. */
  addPartToMessage(messageId: string, part: UIPart & { id?: string }): void {
    const messages = withPart(this.state.messages, messageId, part);
    if (messages === null) {
      console.error(`addPartToMessage: no message "${messageId}" in the thread`);
      return;
    }
    this.setState({ messages });
    if (this.state.isRunning) this.midRunParts.set(`${messageId}\0${part.id ?? this.midRunParts.size}`, { messageId, part });
  }

  sendMessage(text: string, files: FileUIPart[] = [], opts: { command?: Command } = {}): void {
    const messages = closePendingToolCalls(this.state.messages);
    // The data-command part LEADS (runtimeAdapter maps data parts; the transcript chip renders
    // from it), then attachments, then text — the media-then-question order both provider wires
    // read best, and the order uiMessagesToChatMessages preserves verbatim (it skips data-*
    // parts, so the model transcript never sees slash syntax). A files-only send carries no text
    // part; so does a bare command ("/beginner" alone) — an empty text part beside a command
    // would reach the wire as an empty text block. With none of the three, the legacy
    // single-empty-text-part message is kept (every UI caller gates on having something to send,
    // so this is unreachable from the composer — but a byte-identical no-files path beats a new
    // special case).
    const parts: UIPart[] = [
      ...(opts.command !== undefined ? [{ type: 'data-command', data: { command: opts.command } } as UIPart] : []),
      ...files,
    ];
    if (text !== '' || (files.length === 0 && opts.command === undefined)) parts.push({ type: 'text', text });
    const user: UIMessage = { id: generateMessageId(), role: 'user', parts };
    this.pendingCommand = opts.command;
    const mode = opts.command !== undefined ? commandMode(opts.command) : undefined;
    // Chat is what the harness derives when a request carries no mode, so returning to chat means
    // sending none from here on. An explicit 'chat' would outrank derivation (chatRoute), and
    // "quiz me" would stop reaching quiz.
    if (mode !== undefined) this.opts.onModeCommand?.(mode === 'chat' ? '' : mode);
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

  /** Explicit retry only: never re-grade successful work or loop automatically on a failure. */
  retryGrading(toolCallId: string): boolean {
    if (this.state.isRunning) return false;
    const part = this.state.messages.flatMap((m) => m.parts).filter(isToolUIPart)
      .find((p) => p.toolCallId === toolCallId);
    const output = part?.output as Record<string, unknown> | undefined;
    const grading = output?.grading as { verdict?: string; retryable?: boolean } | undefined;
    if (part?.state !== 'output-available' || grading?.verdict !== 'ungraded' || !grading.retryable) return false;
    const { grading: _previousGrade, ...answer } = output!;
    const messages = patchToolOutput(this.state.messages, toolCallId, answer, false);
    if (!messages) return false;
    this.setState({ messages });
    this.resubmit();
    return true;
  }

  /** Run the learner's last message again when it never got an answer (the harness refused it or
   * was unreachable). The message is re-POSTed as it stands, so the transcript keeps one copy of
   * the question; its attachments are already parts of it, and its slash command is re-armed
   * because the server reads the command from the request body, not from the message. */
  resendLast(): void {
    const last = this.state.messages[this.state.messages.length - 1];
    if (this.state.isRunning || last?.role !== 'user') return;
    const command = last.parts.find((p) => p.type === 'data-command') as { data?: { command?: Command } } | undefined;
    this.pendingCommand = command?.data?.command;
    void this.run();
  }

  /** Reattach by polling saved state, never by replaying a POST or model call. */
  async recover(signal: AbortSignal): Promise<void> {
    const generation = ++this.recoveryGeneration;
    try {
      while (!signal.aborted && generation === this.recoveryGeneration) {
        const res = await this.fetchImpl(`/api/thread/${this.opts.threadId}/run`, { signal });
        // A non-ok RESPONSE took neither the throw path below nor any state change, so the poll's
        // answer was simply discarded. After a poll has already reported running that leaves the
        // spinner up forever; on the first poll of a cold mount it leaves the thread's real state
        // unknown. Either way the learner is owed the status rather than silence.
        if (!res.ok) {
          if (!signal.aborted && generation === this.recoveryGeneration) {
            this.setState({ isRunning: false, error: `Could not reconnect to the running turn: the harness answered ${res.status}.` });
          }
          return;
        }
        const status = await res.json() as { running: boolean; messages: UIMessage[] };
        if (signal.aborted || generation !== this.recoveryGeneration || this.inflight) return;
        if (!Array.isArray(status.messages)) return;
        // A dropped stream set `error` before recovery started. Once the server shows the turn
        // still running, or finished with an answer, the saved state supersedes that note.
        const reattached = status.running || status.messages[status.messages.length - 1]?.role === 'assistant';
        this.setState({ messages: status.messages, isRunning: status.running, ...(reattached ? { error: undefined } : {}) });
        if (!status.running) return;
        await new Promise<void>(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      if (!signal.aborted && generation === this.recoveryGeneration) {
        this.setState({ isRunning: false, error: `Could not reconnect to the running turn: ${String(error)}` });
      }
    }
  }

  abort(): void {
    this.recoveryGeneration++;
    void this.fetchImpl(`/api/thread/${this.opts.threadId}/stop`, { method: 'POST' })
      .catch(() => this.setState({ error: 'Could not stop the server turn. Reconnect and try Stop again.' }));
    this.inflight?.abort();
    this.inflight = null;
    this.setState({ isRunning: false });
  }

  /** Re-apply mid-run tool outputs and added parts over a stream snapshot (they are absent from
   * the assembler's view of the message). A patch that no longer finds its target passes through
   * unchanged. */
  private withMidRunOutputs(messages: UIMessage[]): UIMessage[] {
    let out = messages;
    for (const [toolCallId, { output, isError }] of this.midRunOutputs) {
      out = patchToolOutput(out, toolCallId, output, isError) ?? out;
    }
    for (const { messageId, part } of this.midRunParts.values()) {
      out = withPart(out, messageId, part) ?? out;
    }
    return out;
  }

  private async run(): Promise<void> {
    this.recoveryGeneration++;
    this.inflight?.abort(); // a superseded send loses the stream, not the history
    const controller = new AbortController();
    this.inflight = controller;
    this.midRunOutputs.clear();
    this.midRunParts.clear();
    const command = this.pendingCommand;
    this.pendingCommand = undefined; // one-shot, same lifetime rule as writeUp
    const { mode, writeUp, emptyVault } = this.opts.requestContext();
    // Clearing a previous turn's error re-clones the last message: assistant-ui's converter
    // caches per message reference and an explicit error status is sticky in that cache, so
    // without a fresh identity the error bubble would survive into the retry.
    const messages = this.state.error !== undefined ? refreshLast(this.state.messages) : this.state.messages;
    this.setState({ messages, isRunning: true, error: undefined });

    let finished: UIMessage[] | null = null;
    let turnFailed = false;
    const result = await consumeChatStream({
      body: {
        messages: this.state.messages, threadId: this.opts.threadId, writeUp,
        // `mode` is OMITTED unless something explicitly set one. An absent mode is the signal for
        // the server to derive it (deriveMode.ts) from what the learner just said plus the plan —
        // the selector asked a human to answer a question the harness answers better.
        ...(mode ? { mode } : {}),
        ...(emptyVault ? { emptyVault } : {}),
        ...(command !== undefined ? { command } : {}),
      },
      signal: controller.signal,
      fetchImpl: this.fetchImpl,
      onUpdate: (inProgress) => { this.setState({ messages: this.withMidRunOutputs(inProgress) }); },
      // Setting the error also re-clones the last message, for the same converter-cache reason
      // clearing one does (refreshLast below): the error status rides the last assistant
      // message's conversion, and without a fresh identity the cached conversion would win.
      onError: (errorText) => {
        this.setState({ messages: refreshLast(this.state.messages), error: errorText });
      },
      onFinish: (finalMessages, { failed }) => { finished = finalMessages; turnFailed = failed; },
    });
    if (result === 'aborted') return; // the superseding run owns the state now
    this.inflight = null;

    if (finished === null) {
      this.setState({ isRunning: false });
      // The server keeps running a turn whose stream was cut, then saves it; the half answer on
      // screen is not the last word. Reattach the way a reload would.
      if (result === 'dropped') void this.recover(new AbortController().signal);
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
    // `turnFailed` is the server's own verdict on a turn that explained itself in the message
    // instead of raising an error bubble; `error` still covers the failures that never produced
    // a stream. Either one blocks the resubmit — retrying a failing turn loops.
    if (!turnFailed && this.state.error === undefined
      && blockOutputsComplete({ messages: settled })) this.resubmit();
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

/** Insert (or replace, matched by part.id) `part` on message `messageId`; null when the message
 * is not in the history. */
function withPart(messages: UIMessage[], messageId: string, part: UIPart & { id?: string }): UIMessage[] | null {
  const index = messages.findIndex((m) => m.id === messageId);
  if (index === -1) return null;
  const message = messages[index]!;
  const partIndex = part.id === undefined ? -1 : message.parts.findIndex((p) => 'id' in p && p.id === part.id);
  const parts = [...message.parts];
  if (partIndex === -1) parts.push(part); else parts[partIndex] = part;
  const next = [...messages];
  next[index] = { ...message, parts };
  return next;
}

function refreshLast(messages: UIMessage[]): UIMessage[] {
  const last = messages[messages.length - 1];
  return last === undefined ? messages : [...messages.slice(0, -1), { ...last }];
}
