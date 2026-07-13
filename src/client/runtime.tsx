import { AssistantRuntimeProvider, Tools, useAui } from '@assistant-ui/react';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk';
import type { UIMessage } from 'ai';
import type { PropsWithChildren } from 'react';
import { BLOCK_TOOL_NAMES } from '../shared/blocks.js';
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

export function Runtime({ mode, children }: PropsWithChildren<{ mode: string }>) {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: '/api/chat', body: { mode, threadId: 'default' } }),
    sendAutomaticallyWhen: blockOutputsComplete,
  });
  const aui = useAui({ tools: Tools({ toolkit }) });
  return <AssistantRuntimeProvider runtime={runtime} aui={aui}>{children}</AssistantRuntimeProvider>;
}
