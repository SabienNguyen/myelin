import { Component as ReactComponent, type ReactNode } from 'react';
import { defineToolkit } from '@assistant-ui/react';
import { BLOCK_TOOLS } from '../shared/blocks.js';
import { UI_TOOLS } from '../shared/uiTools.js';
import { OpenSource } from './components/blocks/OpenSource.js';
import { QuickCheck } from './components/blocks/QuickCheck.js';
import { Quiz } from './components/blocks/Quiz.js';
import { StructuredCheck } from './components/blocks/StructuredCheck.js';
import { MathScratchpad } from './components/blocks/MathScratchpad.js';
import { WritingDraft } from './components/blocks/WritingDraft.js';
import { CodeExercise } from './components/blocks/CodeExercise.js';
import { LabelDiagram } from './components/blocks/LabelDiagram.js';
import { Speak } from './components/blocks/Speak.js';

/** Two different failures wear the error flag: a call the server REJECTED (schema mismatch —
 *  the tutor's mistake) and a call that was CANCELLED because the conversation moved on (the
 *  learner's choice). "Could not be shown" was honest for the first and an accusation for the
 *  second — the live sitting hit exactly that. Sniff the error text; default to the neutral
 *  reading, because blaming a malformed call requires evidence of one. */
const errorNote = (name: string, result: any) => {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  const malformed = /invalid|validation|schema|expected .* received/i.test(text);
  return malformed
    ? `✗ ${name.replace('_', ' ')} could not be shown — the tutor sent it malformed`
    : `— ${name.replace('_', ' ')} skipped; the conversation moved on`;
};

const malformedNote = (name: string) => (
  <span className="tool-note failed" title={name}>
    ✗ {name.replace('_', ' ')} could not be shown — the tutor sent it malformed
  </span>
);

/** The LAST line of defence: a block component that throws while rendering must cost one card,
 *  never the app. Before this existed, a math_scratchpad whose (SDK-rejected, still bridged)
 *  args lacked problemLatex reached KaTeX as undefined and unmounted the entire React root
 *  mid-lesson — a blank window, on the live video-transcript sitting. Schema validation below
 *  catches the malformed-args class; this boundary catches whatever class is invented next. */
class BlockBoundary extends ReactComponent<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) {
      return (
        <span className="tool-note failed" title={this.props.name}>
          ✗ {this.props.name.replace('_', ' ')} crashed while rendering — continuing without it
        </span>
      );
    }
    return this.props.children;
  }
}

const human = (name: keyof typeof BLOCK_TOOLS, description: string, Component: any) => ({
  type: 'human' as const,
  description,
  parameters: BLOCK_TOOLS[name].input,
  // isError: the rejection/cancellation reaches the renderer as `result`. Handing it to the
  // block used to produce a done-looking card claiming the learner answered "(blank)" — a
  // fabricated submission. Same honesty rule as ToolStatusChip's failed column.
  render: ({ args, result, addResult, isError }: any) => {
    if (isError) return <span className="tool-note failed" title={name}>{errorNote(name, result)}</span>;
    // The claude-sdk route bridges EVERY tool_use to the client, including ones the SDK's own
    // validation then rejects (the model sees the rejection and retries; the client used to keep
    // the rejected call as a live block). Re-validate here against the same schema the server
    // uses — the parsed value also applies schema defaults, so components see canonical args.
    const parsed = BLOCK_TOOLS[name].input.safeParse(args);
    if (!parsed.success) return malformedNote(name);
    return (
      <BlockBoundary name={name}>
        <Component args={parsed.data} result={result} addResult={addResult} />
      </BlockBoundary>
    );
  },
});

export const toolkit = defineToolkit({
  quick_check: human('quick_check', 'Quick inline probe', QuickCheck),
  quiz: human('quiz', 'Multi-item quiz', Quiz),
  // The generic applied block — mechanical checkers, any subject (src/shared/blocks.ts).
  structured_check: human('structured_check', 'Applied check with a mechanical checker (numeric, set, sequence, matching, pattern)', StructuredCheck),
  math_scratchpad: human('math_scratchpad', 'Math work with steps', MathScratchpad),
  writing_draft: human('writing_draft', 'Writing exercise with annotations', WritingDraft),
  code_exercise: human('code_exercise', 'Programming-pattern code exercise (the Gap ladder)', CodeExercise),
  // The picture-subject applied block: label regions of a tutor-drawn SVG, graded mechanically.
  label_diagram: human('label_diagram', 'Label regions of a diagram', LabelDiagram),
  // UI tool, not a block: navigation with a receipt, never graded (src/shared/uiTools.ts).
  open_source: {
    type: 'human' as const,
    description: 'Open an ingested source in the reader',
    parameters: UI_TOOLS.open_source.input,
    render: ({ args, result, addResult, isError }: any) =>
      isError
        ? <span className="tool-note failed">✗ source could not be opened</span>
        : <OpenSource args={args} result={result} addResult={addResult} />,
  },
  // UI tool: speak a word/phrase via the browser's speech engine (src/shared/uiTools.ts).
  speak: {
    type: 'human' as const,
    description: 'Speak a word or phrase aloud in a target language',
    parameters: UI_TOOLS.speak.input,
    render: ({ args, result, addResult, isError }: any) =>
      isError
        ? <span className="tool-note failed">✗ could not attach audio</span>
        : <Speak args={args} result={result} addResult={addResult} />,
  },
});
