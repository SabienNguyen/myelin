import { z } from 'zod';

const quickCheck = {
  input: z.object({
    question: z.string(),
    mode: z.enum(['text', 'choice']),
    choices: z.array(z.string()).optional(),
    expected: z.string().optional(), // exact-match target for mechanical grading
    pageSlug: z.string(),
  }),
  result: z.object({ answer: z.string() }),
};

const quiz = {
  input: z.object({
    title: z.string(),
    items: z.array(z.object({
      id: z.string(),
      type: z.enum(['choice', 'short', 'cloze']),
      prompt: z.string(),
      choices: z.array(z.string()).optional(),
      expected: z.string().optional(),
      pageSlug: z.string(),
    })).min(1),
  }),
  result: z.object({ answers: z.array(z.object({ id: z.string(), answer: z.string() })) }),
};

const mathScratchpad = {
  input: z.object({
    problemLatex: z.string(),
    stepMode: z.boolean(),
    expectedLatex: z.string(), // final answer for numeric-equivalence grading
    variable: z.string().default('x'),
    pageSlug: z.string(),
  }),
  result: z.object({
    steps: z.array(z.object({ latex: z.string() })),
    finalLatex: z.string(),
  }),
};

const writingDraft = {
  input: z.object({
    prompt: z.string(),
    round: z.number().int().min(1),
    priorDraft: z.string().optional(),
    pageSlug: z.string(),
  }),
  result: z.object({ draft: z.string() }),
};

// The Gap inside the Stage (docs/superpowers/plans/2026-07-20-gap-integration.md, Pinned
// Contracts — schema copied VERBATIM from that plan).
const codeExercise = {
  input: z.object({
    pattern: z.string(),          // e.g. 'stream-consumer' (the ladder id, MVP: one ladder)
    rung: z.enum(['worked_example', 'inline_completion', 'full_body', 'ladder']),
    pageSlug: z.string(),         // vault page that receives evidence
  }),
  result: z.object({
    completed: z.boolean(),
    rungReached: z.string(),      // last rung completed
    testsPassed: z.number(),
    testsTotal: z.number(),
    wroteCode: z.boolean(),       // true only if learner-authored code passed full_body
  }),
};

export const BLOCK_TOOLS = {
  quick_check: quickCheck,
  quiz,
  math_scratchpad: mathScratchpad,
  writing_draft: writingDraft,
  code_exercise: codeExercise,
} as const;
export type BlockToolName = keyof typeof BLOCK_TOOLS;
export const BLOCK_TOOL_NAMES = Object.keys(BLOCK_TOOLS) as BlockToolName[];

export const annotationSchema = z.object({
  annotations: z.array(z.object({
    span: z.string(),           // exact substring of the draft
    category: z.enum(['strong', 'wordy', 'vague', 'structure', 'grammar']),
    note: z.string(),
  })),
  skillGrades: z.record(z.string(), z.enum(['good', 'weak'])), // e.g. {claim: 'good', concision: 'weak'}
});
export type WritingAnnotations = z.infer<typeof annotationSchema>;
