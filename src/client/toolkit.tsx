import { Component as ReactComponent, Suspense, lazy, type ReactNode } from 'react';
import { defineToolkit } from '@assistant-ui/react';
import { BLOCK_TOOLS } from '../shared/blocks.js';
import { UI_TOOLS } from '../shared/uiTools.js';
import { OpenSource } from './components/blocks/OpenSource.js';
import { QuickCheck } from './components/blocks/QuickCheck.js';
import { Quiz } from './components/blocks/Quiz.js';
import { StructuredCheck } from './components/blocks/StructuredCheck.js';
import { MathScratchpad } from './components/blocks/MathScratchpad.js';
import { WritingDraft } from './components/blocks/WritingDraft.js';
import { LabelDiagram } from './components/blocks/LabelDiagram.js';
import { Speak } from './components/blocks/Speak.js';
import { OfferWrite } from './components/blocks/OfferWrite.js';
import { Pronounce } from './components/blocks/Pronounce.js';
import { WatchVideo } from './components/blocks/WatchVideo.js';

// CodeMirror and the gap ladder are ~960 kB that every load parsed for an exercise most sessions
// never open; it loads on first use. A failed chunk load throws into BlockBoundary like any crash.
const CodeExercise = lazy(() => import('./components/blocks/CodeExercise.js').then((m) => ({ default: m.CodeExercise })));

/** Two different failures wear the error flag: a call the server REJECTED (schema mismatch —
 *  the tutor's mistake) and a call that was CANCELLED because the conversation moved on (the
 *  learner's choice). "Could not be shown" was honest for the first and an accusation for the
 *  second — the live sitting hit exactly that. Sniff the error text; default to the neutral
 *  reading, because blaming a malformed call requires evidence of one. */
const errorNote = (name: string, result: any) => {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  const malformed = /invalid|validation|schema|expected .* received/i.test(text);
  // A skip is the learner moving on, not a fault, so it wears neither the failure colour nor the
  // done tick — it reads like a folded card, the way a skipped exercise does in any study app.
  return malformed
    ? <span className="tool-note failed" title={name}>✗ {name.replace('_', ' ')} could not be shown — the tutor sent it malformed</span>
    : <span className="tool-note skipped" title={`${name} — the conversation moved on`}>Skipped the {name.replace('_', ' ')}.</span>;
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
    if (isError) return errorNote(name, result);
    // Re-validate against the same schema the server uses: a malformed tool call must render as
    // a note, never mount a block over garbage args — and the parsed value applies schema
    // defaults, so components see canonical args.
    const parsed = BLOCK_TOOLS[name].input.safeParse(args);
    if (!parsed.success) return malformedNote(name);
    return (
      <BlockBoundary name={name}>
        <Suspense fallback={<span className="tool-note" role="status">loading the {name.replace('_', ' ')}…</span>}>
          <Component args={parsed.data} result={result} addResult={addResult} />
        </Suspense>
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
  // The spoken-language applied block: say a word, graded on its tone contour, client-side.
  pronounce: human('pronounce', 'Say a word, graded on its tone', Pronounce),
  // Assigned viewing, embedded in place: watching mints 'exposed' only, never a mastery refresh.
  watch_video: human('watch_video', 'Assign a video snippet, played in place', WatchVideo),
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
  // UI tool: a one-click "write this up" button from a teaching mode (src/shared/uiTools.ts).
  offer_write: {
    type: 'human' as const,
    description: 'Offer a one-click button to write the current topic up as a page',
    parameters: UI_TOOLS.offer_write.input,
    render: ({ args, result, addResult, isError }: any) =>
      isError
        ? <span className="tool-note failed">✗ could not offer the write</span>
        : <OfferWrite args={args} result={result} addResult={addResult} />,
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
