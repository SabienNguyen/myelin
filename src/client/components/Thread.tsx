import { ThreadPrimitive, MessagePrimitive, ComposerPrimitive, ErrorPrimitive } from '@assistant-ui/react';
import { MarkdownText } from './MarkdownText.js';
import { ToolStatusChip } from './ToolStatusChip.js';

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
              <MessagePrimitive.Parts components={{
                Text: MarkdownText,
                Reasoning: () => null, // thinking models: never show raw reasoning to the learner
                tools: { Fallback: ToolStatusChip }, // MCP tools → quiet status chip, not JSON
              }} />
              <MessagePrimitive.Error>
                <ErrorPrimitive.Root className="error-bubble">
                  ⚠ <ErrorPrimitive.Message />
                </ErrorPrimitive.Root>
              </MessagePrimitive.Error>
            </MessagePrimitive.Root>
          ),
        }} />
        <ThreadPrimitive.If running>
          <div className="working" role="status">
            <span className="dot" /><span className="dot" /><span className="dot" />
            <em>tutor is working…</em>
          </div>
        </ThreadPrimitive.If>
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input placeholder="Ask your tutor…" />
        <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
