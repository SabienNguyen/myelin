// First-party stream consumer (own-harness phase E1): POSTs a turn to /api/chat and drives the
// shared reducer with the SSE chunks, replacing the bundled ai@6 processUIMessageStream. The
// server's onEnd persistence runs the SAME reducer (src/server/llm/wire.ts), so what onFinish
// hands back here is byte-identical to what the server saved.
import {
  generateMessageId, MessageAssembler, type UiChunk,
} from '../../shared/uiMessageReducer.js';
import type { UIMessage } from '../../shared/uiMessages.js';

/** The request body the server reads (chatRoute.ts). The old transport also sent
 * id/trigger/tools/system — all ignored server-side, dropped here. */
export interface ChatRequestBody {
  messages: UIMessage[];
  /** Absent means "derive it" — the server picks the mode from the learner's words and the plan
   *  (deriveMode.ts). Present only when something explicitly chose one. */
  mode?: string;
  threadId: string;
  writeUp: boolean;
  /** Kinds in the current session plan, leading item first — an input to that derivation. */
  planKinds?: string[];
  /** True when the vault holds nothing real to teach from. */
  emptyVault?: boolean;
  /** Structured slash command for THIS turn only (shared/commands.ts) — absent on ordinary
   * sends and on resubmits, so a block answer can never replay the command that staged it. */
  command?: string;
}

export interface ConsumeChatStreamOptions {
  body: ChatRequestBody;
  /** Aborting mid-stream returns 'aborted' with NO further callbacks — the superseding send
   * owns the state from that point. */
  signal: AbortSignal;
  /** In-progress history after each chunk. The working message is re-cloned per chunk so every
   * update carries a fresh object identity — assistant-ui's converter caches per message
   * REFERENCE (a WeakMap), so mutating in place would render nothing. */
  onUpdate: (messages: UIMessage[]) => void;
  /** Fires only on clean termination ([DONE] seen) — the server terminates cleanly even when
   * the turn itself errored, so an error chunk still reaches onFinish and persistence. A cut
   * connection never does. */
  onFinish: (finalMessages: UIMessage[]) => void;
  onError: (errorText: string) => void;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export async function consumeChatStream(opts: ConsumeChatStreamOptions): Promise<'done' | 'aborted'> {
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  // The 'start' chunk always carries the server's message id (fresh, or the continued assistant
  // message's id on a block resubmit) and overwrites this placeholder via apply().
  const assembler = new MessageAssembler(opts.body.messages, generateMessageId());
  let terminated = false;

  const snapshot = (): UIMessage[] => {
    const messages = assembler.finalMessages();
    return [...messages.slice(0, -1), structuredClone(messages[messages.length - 1]!)];
  };

  try {
    const res = await doFetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    });
    if (!res.ok || res.body === null) {
      opts.onError(`The tutor is unreachable right now (HTTP ${res.status}).`);
      return 'done';
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE framing as the wire emits it: one `data: <json>\n\n` per chunk, `data: [DONE]` last.
      // Splitting on newlines and taking complete lines handles chunks split mid-line.
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice('data: '.length);
        if (payload === '[DONE]') {
          terminated = true;
          continue;
        }
        const chunk = JSON.parse(payload) as UiChunk;
        if (chunk.type === 'error') opts.onError(chunk.errorText);
        assembler.apply(chunk);
        opts.onUpdate(snapshot());
      }
    }
  } catch (e) {
    if (opts.signal.aborted) return 'aborted';
    opts.onError(e instanceof Error ? e.message : String(e));
    return 'done';
  }
  if (opts.signal.aborted) return 'aborted';
  if (terminated) opts.onFinish(assembler.finalMessages());
  else opts.onError('The connection to the tutor dropped mid-turn.');
  return 'done';
}
