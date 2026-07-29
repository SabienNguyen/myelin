// Mirrors ~/Dev/personal/engram/src/types.ts — source of truth lives there.
export type MasteryLevel = 'unseen' | 'exposed' | 'practicing' | 'mastered';
export const LEVELS: MasteryLevel[] = ['unseen', 'exposed', 'practicing', 'mastered'];
export const DECAY = { masteredDays: 45, practicingDays: 21, rubricDays: 14 };
export type EvidenceKind = 'exposed' | 'explained-correctly' | 'applied-correctly' | 'rubric-passed' | 'struggled' | 'misconception';
export interface PageMasteryDetail {
  level: MasteryLevel;
  effective: MasteryLevel;
  last_reinforced: string; // ISO yyyy-mm-dd
  evidence: { date: string; kind: EvidenceKind; note: string }[];
  misconceptions: string[];
}
export interface LessonSuggestion {
  slug: string; title: string;
  reason: 'review-due' | 'unmet-prereq' | 'frontier';
  detail: string;
}
