import { z } from 'zod';

const quickCheck = {
  input: z.object({
    question: z.string(),
    mode: z.enum(['text', 'choice']),
    choices: z.array(z.string()).optional(),
    expected: z.string().optional(), // exact-match target for mechanical grading
    // BCP-47 tag when the ANSWER should be typed in a specific language — the text field then
    // offers that language's input method (e.g. "vi" → Vietnamese Telex, ImeInput.tsx) so the
    // learner can type diacritics from an ASCII keyboard. Per-block, not a sticky global, so a
    // later math answer never transliterates. Omit for ordinary answers.
    lang: z.string().optional(),
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
    // An explicit rubric turns this from skill-annotation into rubric judgment: the grader marks
    // each criterion pass/fail, and passing ALL of them mints 'rubric-passed' — the evidence kind
    // for essay subjects (history, law, literature) where nothing mechanical can check the work.
    // Write criteria the learner could read beforehand: "thesis is arguable", "cites a primary
    // source", "addresses one counterargument".
    rubric: z.array(z.string()).min(2).max(6).optional(),
    prompt: z.string(),
    round: z.number().int().min(1),
    priorDraft: z.string().optional(),
    pageSlug: z.string(),
  }),
  // mechanicalIssues: how many grammar/style lints Harper (harperLinter.ts) still found in the
  // submitted draft — a deterministic mechanics signal the grader can weigh instead of the model's
  // read of the same. Optional: older results and any non-browser producer omit it.
  result: z.object({ draft: z.string(), mechanicalIssues: z.number().int().optional() }),
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
    // Names of the cases still failing at submit/stop time. Case names describe REQUIREMENTS
    // ("single event split across two chunks"), so this set is a diagnosis, not a score — it is
    // how grading's struggled note can say WHAT was missed, and how the tutor can infer and
    // record the misconception behind a pattern of misses. Optional: older stored results and the
    // external sidecar's producers never sent it.
    failingTests: z.array(z.string()).optional(),
    // The exercise could not be loaded at all (the coding sandbox is down). This is an
    // INFRASTRUCTURE failure, not a learner outcome — without it the only way out of an unloadable
    // block is `completed: false`, which grading maps to 'struggled' and blames the learner for a
    // service being offline. grading.ts returns no evidence at all for this.
    unavailable: z.boolean().optional(),
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
      // sides double as the option list. The describe() reaches the model (inline // comments do
      // not) — it steers the tutor to include DISTRACTORS so a matching can't be solved by
      // elimination, which is what keeps its applied-correctly honest. grading.ts refuses to mint
      // applied evidence from a 4+-pair matching that ships no distractors (owner decision: C + a
      // light A); this guidance is the C half that keeps that refusal from ever firing in practice.
      z.object({
        kind: z.literal('matching'),
        items: z.array(z.object({ left: z.string(), right: z.string() })).min(1),
        options: z.array(z.string()).optional().describe(
          'The choices the learner picks from (one dropdown per left item). INCLUDE DISTRACTORS: '
          + 'a few plausible-but-wrong options beyond the correct right-hand values, so the last '
          + 'pick is never forced by elimination. Required once there are 4 or more pairs — a '
          + 'matching that big with no distractors will not count as applied practice.'),
      }),
      // Normalised free text: nomenclature, notation, a term of art.
      z.object({ kind: z.literal('pattern'), expected: z.string() }),
      // A quantity where the UNIT is part of being right and equivalent units must count — graded
      // by real unit algebra (mathjs), so "1 N·m" satisfies an expected "1 J" and "72 km/h"
      // satisfies "20 m/s". Physics, chemistry, engineering.
      z.object({
        kind: z.literal('unit'),
        expected: z.number(),
        unit: z.string(),
        // Relative by default (0.5%): conversion multiplies magnitudes, so absolute tolerance is
        // wrong at one end of the scale or the other. `relative: false` for exact-count questions.
        tolerance: z.number().optional(),
        relative: z.boolean().optional(),
      }),
      // A balanced chemical equation, checked by conservation per element and per charge. Give
      // reactants/products (formulas, no coefficients) so a DIFFERENT balanced equation is not
      // accepted as the answer to this one.
      z.object({
        kind: z.literal('chem_equation'),
        reactants: z.array(z.string()).min(1).optional(),
        products: z.array(z.string()).min(1).optional(),
      }),
      // Note names graded by semitone arithmetic: C# and Db name the same pitch and both are
      // right. Octaves compared only when the expected note carries one. Music theory's
      // intervals, chord spellings, scale degrees.
      z.object({
        kind: z.literal('notes'),
        expected: z.array(z.string()).min(1),
        ordered: z.boolean().optional(),
      }),
      // An ORDERED tuple of numbers — a coordinate (3, 4), a vector ⟨1, 0, -2⟩, a complex number as
      // (re, im), an interval's endpoints. Compared componentwise with tolerance: order matters
      // (unlike `set`) and the parts are numeric (unlike `sequence`, which is exact strings), so
      // "(3, 4)", "3,4" and "⟨3 4⟩" all read the same. Physics, linear algebra, graphics. Any
      // trailing `unit` is checked as a normalised substring, exactly like the numeric checker.
      z.object({
        kind: z.literal('vector'),
        expected: z.array(z.number()).min(1),
        tolerance: z.number().optional(),  // per-component; absolute by default
        relative: z.boolean().optional(),  // compare against |component| instead
        unit: z.string().optional(),
      }),
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

/**
 * label_diagram — the applied block for subjects that are pictures.
 *
 * Anatomy, circuits, graph theory, chord voicings, chemical structures: until this block, the app
 * could only DESCRIBE them. The tutor draws an inline SVG and names regions; the learner assigns
 * labels to regions; grading is region-membership equality — pure arithmetic, no model — so this
 * mints real applied-correctly for any subject with a picture.
 *
 * The SVG is rendered INERT client-side (an <img> data URI, where scripts never run), so a
 * model-authored drawing cannot script the page.
 */
const labelDiagram = {
  input: z.object({
    prompt: z.string(),
    pageSlug: z.string(),
    // Inline SVG the tutor draws. Keep it simple: shapes, paths, text callout lines.
    svg: z.string(),
    // Anchor points in PERCENT coordinates of the image box, each with its correct term.
    regions: z.array(z.object({
      id: z.string(),
      x: z.number().min(0).max(100),
      y: z.number().min(0).max(100),
      label: z.string(),
    })).min(2),
    // Wrong labels mixed into the tray, so the exercise is not solvable by elimination alone.
    distractors: z.array(z.string()).optional(),
  }),
  result: z.object({
    // regionId -> the label the learner placed there. A region they left blank is simply absent.
    placements: z.array(z.object({ regionId: z.string(), label: z.string() })),
  }),
};

/**
 * pronounce — the APPLIED block for a spoken language, and the first block that grades DOING rather
 * than knowing for sound. A tone language's tones ARE pitch contours (docs/pronunciation-roadmap.md),
 * so a learner's attempt is graded the same mechanical way a numeric answer is: their microphone
 * pitch track is compared in shape against the reference tone template (toneContour.gradeTone), no
 * model opinion. The audio never leaves the browser — capture, pitch tracking, and grading are all
 * client-side (Pronounce.tsx), a privacy property worth keeping; the block reports only the outcome.
 *
 * requiredPasses is why this can mint 'applied-correctly' honestly: a single lucky attempt is not
 * mastery, so the block withholds `applied` until the learner hits the intended tone cleanly that
 * many separate times in the sitting (the "require several passes" rule).
 */
const pronounce = {
  input: z.object({
    word: z.string(),                    // the syllable/word to say, in the target script
    lang: z.string(),                    // BCP-47 tag for the hear-it voice (e.g. "vi", "zh-CN")
    // Which tone system, and which of its tones. Vietnamese (default): ngang/huyen/sac/hoi/nga/nang.
    // Mandarin (toneSystem "zh"): tone1..tone4.
    toneSystem: z.enum(['vi', 'zh']).optional(),
    tone: z.enum(['ngang', 'huyen', 'sac', 'hoi', 'nga', 'nang', 'tone1', 'tone2', 'tone3', 'tone4']),
    gloss: z.string().optional(),        // meaning, shown beside the word
    requiredPasses: z.number().int().min(1).max(5).optional(), // clean attempts to mint applied; default 3
    pageSlug: z.string(),
  }),
  result: z.object({
    passes: z.number(),                  // clean attempts achieved
    required: z.number(),                // how many were needed
    applied: z.boolean(),                // passes >= required — the only path to applied-correctly
    attempts: z.number().optional(),     // total tries, for the struggled note
    bestSimilarity: z.number().optional(),
  }),
};

/**
 * watch_video — an assigned viewing, in place, as a step INSIDE the evidence loop.
 *
 * The tutor names a video snippet (typically found via find_video and located to the second from
 * the transcript), says what to watch FOR, and the Stage plays it right there — YouTube's embed
 * honors start AND end, so the snippet is enforced, not suggested. A deep link rides alongside for
 * the two honest failure modes (offline, embedding disabled by the video's owner).
 *
 * Why it is a BLOCK and not a UI tool: "done watching" mints evidence — 'exposed', the encounter
 * kind, which engram's clock rules already refuse to let refresh a standing the learner didn't
 * re-earn. Watching alone therefore never inflates mastery; the graded check the tutor issues
 * AFTER the video is where viewing becomes demonstrated knowledge. That one-two is the point:
 * the video is a step in the loop, not an exit from it.
 */
const watchVideo = {
  input: z.object({
    /** YouTube URL (watch / youtu.be / shorts / embed). Other hosts render as a plain link. */
    url: z.string(),
    /** Where the relevant passage begins, in seconds — from the transcript's [M:SS] marks. */
    startSeconds: z.number().int().min(0).optional(),
    /** Where it ends; the embedded player stops here, keeping the assignment a snippet. */
    endSeconds: z.number().int().min(0).optional(),
    /** The video's title, shown above the player. */
    title: z.string().optional(),
    /** One line: what to watch FOR ("how completing the square becomes the formula"). */
    why: z.string(),
    pageSlug: z.string(),
  }),
  result: z.object({
    /** True when the learner pressed "done watching". Never set by the client otherwise. */
    watched: z.boolean(),
  }),
};

export const BLOCK_TOOLS = {
  quick_check: quickCheck,
  structured_check: structuredCheck,
  label_diagram: labelDiagram,
  pronounce,
  quiz,
  math_scratchpad: mathScratchpad,
  writing_draft: writingDraft,
  code_exercise: codeExercise,
  watch_video: watchVideo,
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
