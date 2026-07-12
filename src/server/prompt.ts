import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODES = ['learn', 'review', 'quiz', 'freeform'] as const;
export type Mode = (typeof MODES)[number];

const here = dirname(fileURLToPath(import.meta.url));
let cached: string | null = null;
export function buildInstructions(): string {
  cached ??= readFileSync(join(here, 'tutor-system-prompt.md'), 'utf8');
  return cached;
}

const FRAMING: Record<Mode, string> = {
  learn: 'Mode: LEARN. Teach the next suggested lesson.',
  review: 'Mode: REVIEW. Re-prove decayed/due pages before anything new.',
  quiz: 'Mode: QUIZ. Open with a quiz block covering recent pages.',
  freeform: 'Mode: FREEFORM. Follow the student; still record evidence.',
};

export function buildBootstrapContext(a: {
  mode: Mode; state: unknown;
  lessons: { slug: string; title: string; reason: string; detail: string }[];
  reviewsDue: string[];
  ankiLapses: { slug: string; count: number }[];
}): string {
  return [
    'SESSION CONTEXT (auto-injected by harness — not visible to the student):',
    FRAMING[a.mode],
    `Student state: ${JSON.stringify(a.state)}`,
    `Suggested lessons: ${a.lessons.map((l) => `${l.slug} (${l.reason}: ${l.detail})`).join('; ') || 'none'}`,
    `Reviews due: ${a.reviewsDue.join(', ') || 'none'}`,
    a.ankiLapses.length
      ? `Anki trouble: ${a.ankiLapses.map((l) => `${l.slug} — ${l.count} lapses this week; probe for misconceptions`).join('; ')}`
      : 'Anki trouble: none',
  ].join('\n');
}
