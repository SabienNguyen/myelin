// Ported VERBATIM from ~/Dev/personal/the-gap packages/core/src/tone.ts (READ ONLY there) —
// copied rather than depended on because the harness has no dependency on @the-gap/core.
//
// assertToneClean(text) enforces the "no motivational filler / praise / emoji" constraint the
// gap's spec applies to hand-written prose slots. Rule:
//   1. Any emoji character anywhere in the text is rejected.
//   2. Any of a fixed list of praise phrases, matched case-insensitively as a substring, is
//      rejected (covers "great job", "awesome", "excellent!"-class phrases, etc.).
//   3. More than one '!' anywhere in the text is rejected ("exclamation-heavy prose"). A single
//      '!' is tolerated so ordinary prose isn't over-constrained.

const EMOJI_PATTERN =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

const PRAISE_PHRASES: readonly string[] = [
  'great job',
  'good job',
  'nice work',
  'well done',
  'awesome',
  'excellent',
  'amazing',
  'fantastic',
  'perfect!',
  "you're crushing it",
  'you got it',
  'nailed it',
  'way to go',
  'good work',
  'keep it up',
  'you rock',
];

export function assertToneClean(text: string): void {
  if (EMOJI_PATTERN.test(text)) {
    throw new Error('tone violation: emoji is not allowed in prose slots');
  }

  const lower = text.toLowerCase();
  for (const phrase of PRAISE_PHRASES) {
    if (lower.includes(phrase)) {
      throw new Error(`tone violation: praise phrase "${phrase}" is not allowed in prose slots`);
    }
  }

  const exclamationCount = (text.match(/!/g) ?? []).length;
  if (exclamationCount > 1) {
    throw new Error('tone violation: exclamation-heavy prose is not allowed (more than one "!")');
  }
}
