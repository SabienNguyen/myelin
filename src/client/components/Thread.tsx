import { ThreadPrimitive, MessagePrimitive, ComposerPrimitive } from '@assistant-ui/react';
import { MarkdownText } from './MarkdownText.js';

export function Thread() {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <ThreadPrimitive.Messages components={{
          UserMessage: () => (
            <MessagePrimitive.Root className="msg user">
              <MessagePrimitive.Parts />
            </MessagePrimitive.Root>
          ),
          AssistantMessage: () => (
            <MessagePrimitive.Root className="msg assistant">
              <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
            </MessagePrimitive.Root>
          ),
        }} />
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input placeholder="Ask your tutor…" />
        <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
