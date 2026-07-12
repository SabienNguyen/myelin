import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk';
import type { PropsWithChildren } from 'react';

export function Runtime({ mode, children }: PropsWithChildren<{ mode: string }>) {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: '/api/chat', body: { mode, threadId: 'default' } }),
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
// Task 7 extends this file with the block toolkit via `useAui`; keep the provider here.
