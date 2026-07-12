import { AssistantRuntimeProvider, Tools, useAui } from '@assistant-ui/react';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk';
import type { PropsWithChildren } from 'react';
import { toolkit } from './toolkit.js';

export function Runtime({ mode, children }: PropsWithChildren<{ mode: string }>) {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: '/api/chat', body: { mode, threadId: 'default' } }),
  });
  const aui = useAui({ tools: Tools({ toolkit }) });
  return <AssistantRuntimeProvider runtime={runtime} aui={aui}>{children}</AssistantRuntimeProvider>;
}
