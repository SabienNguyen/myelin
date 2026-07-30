import { AssistantRuntimeProvider, Tools, useAui } from '@assistant-ui/react';
import { useEffect, useLayoutEffect, useState, type PropsWithChildren } from 'react';
import type { UIMessage } from '../shared/uiMessages.js';
import { dedupeById } from '../shared/messages.js';
import { useChatCoreRuntime } from './chatCore/index.js';
import { toolkit } from './toolkit.js';

/** Load the persisted thread once, then mount the chat with it — the server's chatRoute only
 * persists the REQUEST side; the assistant's turns are saved by the chat store's onFinish PUT.
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
  // mode changes WITHOUT remounting (only threadId remounts, via App's key); the hook tracks it
  // per render so each request carries the CURRENT topbar selection.
  const runtime = useChatCoreRuntime({ mode, threadId, initialMessages: initial });
  const aui = useAui({ tools: Tools({ toolkit }) });
  // Mounting a NON-EMPTY thread races assistant-ui v0.14's store: message DOM (with MessageRoot's
  // hover listeners) attaches at React's commit, but the store's per-message tap resources only
  // mount in a PASSIVE effect — so a pointer already over the transcript (a reload mid-page) gets
  // a synthesized mouseenter between first paint and that effect, and the dispatch throws
  // "Resource updated before mount" (reproduced ~50% of reloads; setIsHovering in MessageRoot.tsx
  // is the sender). A sync update from a layout effect makes React flush pending passive effects
  // BEFORE first paint, so the resources are mounted before any mouse event can exist.
  const [, setPainted] = useState(false);
  useLayoutEffect(() => { setPainted(true); }, []);
  return <AssistantRuntimeProvider runtime={runtime} aui={aui}>{children}</AssistantRuntimeProvider>;
}
