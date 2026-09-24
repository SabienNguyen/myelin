// One name per mastery level, for every surface that shows a level as words: notebook topic rows,
// the Stage outline, the Page tab, the palette and the graph legend. The stored value stays
// engram's ('exposed'); the learner reads "seen", which is true however much evidence came after.
export type MasteryLevel = 'mastered' | 'practicing' | 'exposed' | 'unseen';

export const MASTERY_LEVELS: readonly MasteryLevel[] = ['mastered', 'practicing', 'exposed', 'unseen'];

export const LEVEL_LABEL: Record<MasteryLevel, string> = {
  mastered: 'mastered',
  practicing: 'practicing',
  exposed: 'seen',
  unseen: 'not started',
};

export function asMasteryLevel(v: unknown): MasteryLevel {
  return v === 'mastered' || v === 'practicing' || v === 'exposed' ? v : 'unseen';
}
