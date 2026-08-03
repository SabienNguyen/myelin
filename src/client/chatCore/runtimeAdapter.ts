// Bridge from the ChatStore to @assistant-ui/react's external-store runtime (v0.14.x —
// useExternalStoreRuntime / ExternalStoreAdapter / ThreadMessageLike, re-exported from
// @assistant-ui/core). The adapter's job is shape translation only; all chat behavior lives in
// the store.
import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  useExternalStoreRuntime,
  type AppendMessage, type AssistantRuntime, type ThreadMessageLike,
} from '@assistant-ui/react';
import { getToolName, isDataUIPart, isToolUIPart, type UIMessage } from '../../shared/uiMessages.js';
import { consumeWriteIntent } from '../lib/writeIntent.js';
import { ChatStore } from './chatStore.js';

type ThreadMessagePart = Extract<ThreadMessageLike['content'], readonly unknown[]>[number];
type ToolCallArgs = NonNullable<Extract<ThreadMessagePart, { type: 'tool-call' }>['args']>;

/** Our UIMessage -> assistant-ui's ThreadMessageLike, matching what the react-ai-sdk converter
 * produced so toolkit.tsx's render({ args, result, addResult, isError }) keeps its contract:
 * tool parts become 'tool-call' parts whose `args` is the input object ({} until the input has
 * finished streaming — the reducer keeps no provisional parse), `result` the output once
 * output-available, and output-error becomes `{ error }` with isError. step-start markers are
 * presentation-free and dropped; data-* parts keep their payload under a 'data' part.
 *
 * `error` (the store's turn error, passed for the LAST message only) becomes an explicit
 * incomplete status so MessagePrimitive.Error renders the bubble — the external-store core only
 * auto-derives running/complete, never error. */
export function uiMessageToThreadMessage(message: UIMessage, error?: string): ThreadMessageLike {
  const content: ThreadMessagePart[] = [];
  for (const part of message.parts) {
    if (part.type === 'step-start') continue;
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'reasoning') {
      // providerMetadata (the thinking signature) stays behind: it is resubmit plumbing the
      // renderer must never see. Thread.tsx's Reasoning component decides how much to show.
      content.push({ type: 'reasoning', text: part.text });
    } else if (isToolUIPart(part)) {
      const args = part.input !== null && typeof part.input === 'object' && !Array.isArray(part.input)
        ? part.input : {};
      content.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: getToolName(part),
        // Boundary cast: `input` is unknown on the wire; assistant-ui wants a JSON object.
        args: args as ToolCallArgs,
        ...(part.state === 'output-available' ? { result: part.output } : {}),
        ...(part.state === 'output-error' ? { result: { error: part.errorText }, isError: true } : {}),
      });
    } else if (isDataUIPart(part)) {
      content.push({ type: 'data', name: part.type.slice('data-'.length), data: part.data });
    } else if (part.type === 'file') {
      // Learner attachments (user messages only — the response stream never emits files).
      // ThreadMessageLike carries both natively: images as an Image part whose `image` is the
      // data: URL (rendered inline), PDFs and anything else as a File part (rendered as a
      // filename chip) — Thread.tsx supplies the components for both.
      content.push(part.mediaType.startsWith('image/')
        ? { type: 'image', image: part.url, ...(part.filename !== undefined ? { filename: part.filename } : {}) }
        : { type: 'file', data: part.url, mimeType: part.mediaType, ...(part.filename !== undefined ? { filename: part.filename } : {}) });
    }
  }
  return {
    id: message.id,
    role: message.role,
    content,
    ...(error !== undefined && message.role === 'assistant'
      ? { status: { type: 'incomplete', reason: 'error', error } }
      : {}),
  };
}

/** A turn that errors BEFORE any assistant message exists (dead backend on a fresh send) has no
 * message to carry the error status — the react-ai-sdk stack appended a synthetic empty
 * assistant message for exactly this case (assistant-ui's createErrorAssistantMessage in
 * external-message-converter.ts). Same rule here; the placeholder lives only in the adapter's
 * view, never in the store, so it cannot be sent or persisted. */
export function withErrorPlaceholder(messages: UIMessage[], error: string | undefined): UIMessage[] {
  if (error === undefined || messages[messages.length - 1]?.role === 'assistant') return messages;
  return [...messages, { id: 'chatcore-error-placeholder', role: 'assistant', parts: [] }];
}

export interface ChatCoreRuntimeOptions {
  mode: string;
  /** A fact about the vault, not a setting: nothing real to teach from. */
  emptyVault?: boolean;
  threadId: string;
  initialMessages: UIMessage[];
  /** How a mode slash command reaches the topbar selector (App's setMode) — see
   * ChatStoreOptions.onModeCommand. Rides a ref like `mode`, so the store keeps calling the
   * CURRENT setter without remounting. */
  onModeCommand?: (mode: string) => void;
}

/** The live ChatStore, for the ONE consumer that must reach past assistant-ui's composer: the
 * attach-aware composer in Thread.tsx sends text + files straight to the store, because the
 * primitive's own send() only carries attachments through an AttachmentAdapter this app does not
 * configure (and its canSend gate would block a files-only send outright). Provided by
 * runtime.tsx alongside the AssistantRuntimeProvider; everything else keeps going through the
 * runtime. */
export const ChatStoreContext = createContext<ChatStore | null>(null);

export function useChatStore(): ChatStore {
  const store = useContext(ChatStoreContext);
  if (store === null) throw new Error('useChatStore: no ChatStoreContext provider above');
  return store;
}

/** Replacement shape for runtime.tsx's useChatRuntime call: same inputs, an AssistantRuntime out
 * plus the backing store (for ChatStoreContext — see above). The caller remounts per threadId
 * (App's key), so the store is created once per thread; `mode` rides a ref so each request reads
 * the CURRENT topbar selection. */
export function useChatCoreRuntime({ mode, emptyVault, threadId, initialMessages, onModeCommand }: ChatCoreRuntimeOptions): { runtime: AssistantRuntime; store: ChatStore } {
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const emptyVaultRef = useRef(emptyVault);
  emptyVaultRef.current = emptyVault;
  const onModeCommandRef = useRef(onModeCommand);
  onModeCommandRef.current = onModeCommand;
  const [store] = useState(() => new ChatStore({
    threadId,
    initialMessages,
    requestContext: () => ({
      mode: modeRef.current, writeUp: consumeWriteIntent(), emptyVault: emptyVaultRef.current,
    }),
    onModeCommand: (m) => onModeCommandRef.current?.(m),
  }));
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const messages = useMemo(
    () => withErrorPlaceholder(state.messages, state.error),
    [state.messages, state.error],
  );
  // convertMessage MUST keep a stable identity: the external-store core resets its per-message
  // conversion cache whenever the reference changes (external-store-thread-runtime-core.ts), so
  // an every-render closure re-converts the whole thread each render and churns every message
  // resource downstream — observed live as hover dispatches hitting never-mounted resources
  // ("Resource updated before mount") right after a reload. The dynamic inputs ride a ref; the
  // cache is keyed per message object and the store re-clones the last message whenever `error`
  // changes (refreshLast), so a stale error status can never be served from cache.
  const convertContext = useRef({ error: state.error, lastIndex: messages.length - 1 });
  convertContext.current = { error: state.error, lastIndex: messages.length - 1 };
  const convertMessage = useCallback((message: UIMessage, idx: number) => {
    const { error, lastIndex } = convertContext.current;
    return uiMessageToThreadMessage(message, idx === lastIndex ? error : undefined);
  }, []);

  const runtime = useExternalStoreRuntime<UIMessage>({
    isRunning: state.isRunning,
    messages,
    setMessages: (messages) => { store.setMessages([...messages]); },
    onCancel: async () => { store.abort(); },
    onNew: async (message: AppendMessage) => {
      // The programmatic send paths (example asks, Ask-Tutor bridge, session-plan CTA) reach
      // here through composer.send() as user text; anything else is a bug. The composer FORM
      // itself no longer does — its submit goes straight to store.sendMessage so attachments can
      // ride along (Thread.tsx's Composer) — so no files ever arrive on this path.
      if (message.role !== 'user') throw new Error(`chatCore only sends user messages, got "${message.role}"`);
      const text = message.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text).join('\n');
      store.sendMessage(text);
    },
    onAddToolResult: ({ toolCallId, result, isError }) => {
      store.addToolOutput({ toolCallId, output: result, isError });
    },
    convertMessage,
  });
  return { runtime, store };
}
