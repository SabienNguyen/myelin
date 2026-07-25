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
    // Multivariate maths (learn-anything pass): physics/stats/engineering problems have more than
    // one free variable. Optional and additive — grading detects free variables from the expressions
    // themselves, so this is only needed to name one the expressions don't mention.
    variables: z.array(z.string()).optional(),
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
    // CodeSignal-style expected-vs-actual reveal (see TestResultsPanel). Optional so every existing
    // producer and stored result stays valid. TRUE means the learner revealed at least one test's
    // expected value before passing, which is why grading.ts caps the evidence: the same reasoning
    // as the Anki ceiling — assistance that could substitute for understanding must not be able to
    // mint 'applied-correctly'. Recording it is what keeps the reveal honest rather than forbidden.
    revealedExpected: z.boolean().optional(),
  }),
};

/**
 * structured_check — the generic APPLIED block (learn-anything pass).
 *
 * Why it exists: of the other four blocks, only quick_check and quiz work in every subject, and both
 * grade recall or explanation. Applied evidence — the harder, more trustworthy kind — was reachable
 * only through math_scratchpad (maths), writing_draft (prose), and code_exercise (programming). A
 * chemistry, statistics, music-theory, or law learner could be probed and could explain, but had no
 * way to *apply*. This block is the missing primitive.
 *
 * How it stays trustworthy: every checker below is MECHANICAL — graded in grading.ts with no model
 * call, exactly like quick_check's exact match and math_scratchpad's numeric sampling. A model may
 * author the question; only arithmetic and string comparison decide whether it was answered. That is
 * the seam that lets the system generalise without the evidence becoming a model's opinion.
 *
 * KNOWN LIMITATION, shared with quick_check and quiz: the answer key travels in the block's tool
 * input, which is rendered client-side, so it is visible in devtools. Acceptable for a single-user
 * localhost tutor and consistent with the existing blocks; the fix (a server-side key store keyed by
 * toolCallId, as the gap sidecar effectively does) is a larger change than this block.
 */
const structuredCheck = {
  input: z.object({
    prompt: z.string(),
    pageSlug: z.string(),
    // Shown above the input; use for units, significant figures, or "one per line" guidance.
    hint: z.string().optional(),
    checker: z.discriminatedUnion('kind', [
      // Any quantitative subject: physics, chemistry, stats, finance, engineering.
      z.object({
        kind: z.literal('numeric'),
        expected: z.number(),
        // Absolute by default; `relative: true` compares against |expected| instead, which is what
        // you want for large or tiny magnitudes (Avogadro, Planck).
        tolerance: z.number().optional(),
        relative: z.boolean().optional(),
        // Checked case-insensitively against whatever trails the number, when given.
        unit: z.string().optional(),
      }),
      // "Name all X" — order irrelevant. Cardinality is deliberately NOT sent to the client.
      z.object({ kind: z.literal('set'), expected: z.array(z.string()).min(1) }),
      // "Put these in order" — order is the whole point.
      z.object({ kind: z.literal('sequence'), expected: z.array(z.string()).min(1) }),
      // "Match term to definition". `options` are what the learner picks from; without it the right
      // sides double as the option list.
      z.object({
        kind: z.literal('matching'),
        items: z.array(z.object({ left: z.string(), right: z.string() })).min(1),
        options: z.array(z.string()).optional(),
      }),
      // Normalised free text: nomenclature, notation, a term of art.
      z.object({ kind: z.literal('pattern'), expected: z.string() }),
    ]),
  }),
  result: z.object({
    // One unified shape across every checker so the client and grader stay simple:
    //   numeric / pattern -> a single value
    //   set / sequence    -> the learner's list
    //   matching          -> the chosen right for each item, in `items` order
    values: z.array(z.string()),
  }),
};

export const BLOCK_TOOLS = {
  quick_check: quickCheck,
  structured_check: structuredCheck,
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
