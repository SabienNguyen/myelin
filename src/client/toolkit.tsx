import { defineToolkit } from '@assistant-ui/react';
import { BLOCK_TOOLS } from '../shared/blocks.js';
import { QuickCheck } from './components/blocks/QuickCheck.js';
import { Quiz } from './components/blocks/Quiz.js';
import { StructuredCheck } from './components/blocks/StructuredCheck.js';
import { MathScratchpad } from './components/blocks/MathScratchpad.js';
import { WritingDraft } from './components/blocks/WritingDraft.js';
import { CodeExercise } from './components/blocks/CodeExercise.js';
import { LabelDiagram } from './components/blocks/LabelDiagram.js';

const human = (name: keyof typeof BLOCK_TOOLS, description: string, Component: any) => ({
  type: 'human' as const,
  description,
  parameters: BLOCK_TOOLS[name].input,
  render: ({ args, result, addResult }: any) =>
    <Component args={args} result={result} addResult={addResult} />,
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
});
