import { ThreadPrimitive, MessagePrimitive, ComposerPrimitive, ErrorPrimitive, useComposerRuntime } from '@assistant-ui/react';
import { MarkdownText } from './MarkdownText.js';
import { ToolStatusChip } from './ToolStatusChip.js';

// P1 FIX (docs/superpowers/plans/2026-07-20-gap-integration.md — post-review): these two must be
// stable module-scope function references, NOT inline arrow functions inside Thread()'s render
// body. `ThreadPrimitive.Messages` uses `components.UserMessage`/`components.AssistantMessage` as
// React component TYPES for the per-role message subtree — a fresh function identity every time
// Thread() renders reads to React as "a different component type at this position", which
// unmounts and remounts the ENTIRE message subtree (including whatever's portaled into the Stage
// from inside it) on every single Thread re-render. That was already true before P1 but harmless
// (nothing downstream reacted to the churn). P1's CodeExerciseInner mount effect
// (panelBus.setFocusMode(true)/cleanup(false), CodeExercise.tsx) turned it into a feedback loop:
// App re-render -> Thread re-renders -> new inline component identity -> AssistantMessage subtree
// remounts -> CodeExerciseInner's unmount(false)-then-mount(true) cycle flips App's focusMode
// state -> App re-renders again -> repeat, until React's nested-update-count guard throws
// "Maximum update depth exceeded" and tears the tree down (the browser symptom: chip visible,
// #stage-root empty, .focus-mode gone). Fix is this hoist alone — StagePortal's target
// (#stage-root, SidePanel.tsx) is a permanently-mounted DOM node and was never actually churning.
function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg user">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}
function AssistantMessage() {
  return (
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
  );
}

/**
 * The three example asks on the empty thread.
 *
 * They were `<li>` elements, styled as bordered boxes — so on the very first screen of the app they
 * looked exactly like buttons and did nothing when clicked. Now they are buttons that fill the
 * composer and send, which is what they always looked like they would do.
 *
 * They stay across three unrelated SUBJECTS on purpose: the most valuable thing to convey in the
 * first three seconds is that this is not a programming tutor, it is a tutor.
 */
const EXAMPLES = [
  'Teach me how derivatives work',
  'I want to understand counterpoint',
  'Walk me through consideration in contract law',
];

function ExampleAsks() {
  const composer = useComposerRuntime();
  return (
    <ul className="thread-empty-examples">
      {EXAMPLES.map((text) => (
        <li key={text}>
          <button
            type="button"
            onClick={() => { composer.setText(text); composer.send(); }}
          >
            “{text}”
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Thread() {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport">
        {/* First run showed a blank half-screen and a placeholder — the single most important
            moment in the app said nothing about what it is or what to type. The suggestions are
            deliberately across different SUBJECTS: the thing most worth conveying in the first
            three seconds is that this is not a programming tutor, it is a tutor. */}
        <ThreadPrimitive.Empty>
          <div className="thread-empty">
            <h2>What do you want to learn?</h2>
            <p>
              Ask for anything — a topic, a paper, a book you are stuck in. Your tutor writes pages
              as you go, links them into a graph, and tracks what you have actually shown you know.
            </p>
            <ExampleAsks />
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        <ThreadPrimitive.If running>
          <div className="working" role="status">
            <span className="dot" /><span className="dot" /><span className="dot" />
            <em>tutor is working…</em>
          </div>
        </ThreadPrimitive.If>
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input placeholder="Ask your tutor…" autoFocus />
        <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
