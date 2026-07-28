import { AssistantRuntimeProvider, Tools, useAui } from '@assistant-ui/react';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk';
import type { UIMessage } from 'ai';
import { useEffect, useState, type PropsWithChildren } from 'react';
import { BLOCK_TOOL_NAMES } from '../shared/blocks.js';
import { dedupeById } from '../shared/messages.js';
import { consumeWriteIntent } from './lib/writeIntent.js';
import { toolkit } from './toolkit.js';

/**
 * Auto-resubmit predicate for `sendAutomaticallyWhen` (ai@7's `ChatInit` option, accepted directly
 * by `useChatRuntime` — confirmed against node_modules/@assistant-ui/react-ai-sdk's
 * `UseChatRuntimeOptions = ChatInit<UI_MESSAGE> & ...`).
 *
 * The stock `lastAssistantMessageIsCompleteWithToolCalls` helper resubmits whenever the LAST STEP
 * of the last assistant message has ANY completed tool part. That includes server-side MCP tool
 * parts (e.g. `record_evidence`) which arrive on the harness's own follow-up turn — those
 * re-satisfy the stock predicate and cause an infinite resubmit loop (evidence recorded 6x in the
 * T12 run). This predicate applies the SAME last-step scoping (see below) but only ever looks at
 * BLOCK tool parts (quick_check / quiz / math_scratchpad / writing_draft — the ones a human
 * answers in the browser), so the follow-up turn's record_evidence/text (no block parts in the new
 * step) doesn't re-trigger it.
 *
 * The last-step scoping matters more here than it does for the stock helper: ai@7's `useChat`, on
 * a `sendAutomaticallyWhen`-triggered resubmit, seeds the new response by snapshotting the CURRENT
 * last assistant message and appending a new step onto it (see `AbstractChat.makeRequest` /
 * `createStreamingUIMessageState` in node_modules/ai/dist/index.js) — so the ORIGINAL block tool
 * part that triggered the resubmit stays physically present (in an earlier step) in every later
 * version of "the last message" too. Scanning the whole message, not just the parts after the
 * last 'step-start' marker, would keep matching that stale part and never terminate — confirmed by
 * driving the real E2E flow before this scoping was added.
 */
export function blockOutputsComplete({ messages }: { messages: UIMessage[] }): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return false;
  const parts = last.parts as any[];
  const lastStepStartIndex = parts.reduce((acc, part, i) => (part.type === 'step-start' ? i : acc), -1);
  const blockParts = parts.slice(lastStepStartIndex + 1).filter((part) =>
    BLOCK_TOOL_NAMES.some((name) => part.type === `tool-${name}`));
  return blockParts.length > 0 && blockParts.every((part) => part.state === 'output-available');
}

/** Load the persisted thread once, then mount the chat with it — the server's chatRoute only
 * persists the REQUEST side; the assistant's turns are saved here via onFinish → PUT.
 * `threadId` defaults to 'default'; App.tsx remounts this component (via `key={threadId}`) on
 * every conversation switch so `initial` is always re-fetched for the right thread. */
export function Runtime({ mode, threadId = 'default', children }: PropsWithChildren<{ mode: string; threadId?: string }>) {
  const [initial, setInitial] = useState<UIMessage[] | null>(null);
  useEffect(() => {
    fetch(`/api/thread/${threadId}`).then((r) => r.json())
      .then((msgs) => setInitial(Array.isArray(msgs) ? (dedupeById(msgs) as UIMessage[]) : []))
      .catch(() => setInitial([]));
  }, [threadId]);
  if (initial === null) return null; // one settled frame while the thread restores
  return <RuntimeInner mode={mode} threadId={threadId} initial={initial}>{children}</RuntimeInner>;
}

function RuntimeInner(
  { mode, threadId, initial, children }: PropsWithChildren<{ mode: string; threadId: string; initial: UIMessage[] }>,
) {
  const runtime = useChatRuntime({
    // body is a function so `writeUp` is resolved per REQUEST, not captured once at mount: the
    // "write this up" button (OfferWrite.tsx) arms a one-shot flag just before it sends, and only
    // that single request should carry it. mode/threadId are stable for the transport's life.
    transport: new AssistantChatTransport({
      api: '/api/chat',
      body: () => ({ mode, threadId, writeUp: consumeWriteIntent() }),
    }),
    // Cast: react-ai-sdk types ChatInit against its BUNDLED ai@6; our messages are ai@7.
    // Identical wire shape, incompatible type identities (the repo-wide rule: never let ai
    // types flow through react-ai-sdk's surface without a boundary cast).
    messages: initial.length ? (initial as never[]) : undefined,
    sendAutomaticallyWhen: blockOutputsComplete,
    onFinish: ({ messages }) => {
      void fetch(`/api/thread/${threadId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(messages),
      }).catch(() => {});
    },
  });
  const aui = useAui({ tools: Tools({ toolkit }) });
  return <AssistantRuntimeProvider runtime={runtime} aui={aui}>{children}</AssistantRuntimeProvider>;
}
