import { defineToolkit } from '@assistant-ui/react';
import { BLOCK_TOOLS } from '../shared/blocks.js';
import { QuickCheck } from './components/blocks/QuickCheck.js';
import { Quiz } from './components/blocks/Quiz.js';
import { MathScratchpad } from './components/blocks/MathScratchpad.js';
import { WritingDraft } from './components/blocks/WritingDraft.js';
import { CodeExercise } from './components/blocks/CodeExercise.js';

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
  math_scratchpad: human('math_scratchpad', 'Math work with steps', MathScratchpad),
  writing_draft: human('writing_draft', 'Writing exercise with annotations', WritingDraft),
  code_exercise: human('code_exercise', 'Programming-pattern code exercise (the Gap ladder)', CodeExercise),
});
