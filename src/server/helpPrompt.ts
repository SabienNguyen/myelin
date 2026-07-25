// Track A (docs/superpowers/plans/2026-07-21-coding-stage.md "A. In-IDE tutor help"): the
// answer-integrity invariant for /api/gap/help is enforced HERE, mechanically, not by prompt
// wording. `HelpRungContext` below is an INDEPENDENT type from gapProxy.ts's `GapRung` — it does
// not `Pick<>` fields off that wire type, it simply never declares a `reference_answer` slot at
// all. That means there is no field for gapHelp.ts's route handler to accidentally forward into
// `buildHelpPrompt`, and no field for this file's implementation to accidentally read out of
// `input.rung` even if a careless caller passed a wider object through (see helpPrompt.test.ts's
// "even if a caller mistakenly includes it" case, which does exactly that and asserts nothing
// leaks). The only inputs this pure function accepts are what the learner can already see: the
// visible pre/post code around their own gap, their own draft, the tests they've already run
// against their own code, the pattern's public vault page, and their own question.

export interface HelpRungContext {
  template: 'worked_example' | 'inline_completion' | 'full_body';
  artifactId: string;
  visiblePre: string;
  visiblePost: string;
  contextLine?: string;
}

export interface BuildHelpPromptInput {
  pattern: string;
  rung: HelpRungContext;
  /** The learner's own current gap contents — never the reference solution. */
  draft: string;
  /** Failing test names (and/or short messages) from the learner's own last run. */
  failures: string[];
  /** The pattern's vault page body, or undefined when no page exists yet (tolerated, not an error). */
  vaultPage?: string;
  question: string;
  /**
   * Hints already given during THIS exercise, oldest first.
   *
   * Without these the help route is stateless, so the escalation ladder in the system prompt could
   * only ever run inside a single reply: a learner who was still stuck and asked again got a fresh
   * concept-level nudge every time, with no signal that the previous one had not landed. That is the
   * difference between "escalating help" and "the same hint rephrased".
   *
   * Safe to include: every string here is something the learner has already read, so this widens no
   * answer-integrity surface. `reference_answer` still has no slot anywhere in this type.
   */
  priorHints?: string[];
}

export interface HelpPrompt {
  system: string;
  prompt: string;
}

// Prompt rules (spec): proximity hints that escalate concept -> strategy -> structure, never
// complete the learner's gap for them, <=180 words, no praise/emoji (gap tone rules apply inside
// the IDE — see src/client/components/blocks/gap/tone.ts for the client-side equivalent list).
export const HELP_SYSTEM_PROMPT = [
  'You are a coding tutor giving in-exercise help. The learner is stuck on a code exercise and',
  'asked a question. Reply with exactly ONE proximity hint, escalating only as far as needed:',
  '(1) a CONCEPT-level nudge naming the idea they seem to be missing; if that alone would not be',
  'enough given their draft and failing tests, (2) a STRATEGY-level nudge naming the approach',
  'without describing exact code; only as a last resort (3) a STRUCTURE-level nudge naming which',
  'part of their own code or control flow needs to change — still without writing code.',
  'Never write, dictate, or complete the code that fills their gap. Describe what is missing or',
  'wrong; do not supply it. Ground the hint in their specific failing tests and their own draft,',
  'not generic advice. Keep the entire reply to 180 words or fewer. No praise, no encouragement,',
  'no emoji — plain, direct, technical tone only.',
  'If the prompt lists hints already given for this exercise, the learner tried them and is STILL',
  'stuck: do not restate or rephrase any of them. Start at least one level higher than the highest',
  'you already gave (concept -> strategy -> structure), and if you are already at structure, name',
  'the single specific line or branch of their own draft that is wrong. Even then, do not write the',
  'replacement code.',
].join(' ');

export function buildHelpPrompt(input: BuildHelpPromptInput): HelpPrompt {
  const { pattern, rung, draft, failures, vaultPage, question, priorHints = [] } = input;

  const lines: string[] = [
    `Pattern: ${pattern} (${rung.template} rung, artifact "${rung.artifactId}")`,
  ];
  if (rung.contextLine) lines.push(`Exercise context: ${rung.contextLine}`);
  lines.push(
    '',
    'Code visible to the learner before the gap:',
    '```',
    rung.visiblePre || '(nothing before the gap)',
    '```',
    'Code visible to the learner after the gap:',
    '```',
    rung.visiblePost || '(nothing after the gap)',
    '```',
    '',
    "Learner's current draft for the gap:",
    '```',
    draft.trim() === '' ? '(empty — nothing written yet)' : draft,
    '```',
    '',
    failures.length > 0
      ? `Currently failing tests (from the learner's own last run):\n${failures.map((f) => `- ${f}`).join('\n')}`
      : 'No failing tests reported (either everything passes, or the learner has not run yet).',
    '',
    vaultPage !== undefined
      ? `Reference material — this pattern's vault page:\n${vaultPage}`
      : 'No vault page exists for this pattern yet.',
    '',
    priorHints.length > 0
      ? 'Hints already given for this exercise, oldest first — the learner has read all of these and '
        + `is still stuck, so go further than the last one:\n${priorHints.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
      : 'No hints have been given for this exercise yet.',
    '',
    `Student question: ${question}`,
  );

  return { system: HELP_SYSTEM_PROMPT, prompt: lines.join('\n') };
}
