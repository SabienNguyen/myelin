import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CourseProblem } from './courseBank.js';

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
  /** Active goal plus its progress, when one is set — see goalStore.ts. */
  goal?: { kind: 'path' | 'page'; slug: string; title?: string; known?: number; total?: number; nextSlug?: string | null } | null;
  /** True when the vault has no pages at all. Drives the cold-start line below. */
  emptyVault?: boolean;
  /** The course bank's contents (courseBank.ts's readBank), when the caller has one. */
  courseBank?: CourseProblem[];
  /** Free-text teaching-style preference from config (cfg.voice) — tone, pace, jargon level. */
  voice?: string;
}): string {
  const lines = [
    'SESSION CONTEXT (auto-injected by harness — not visible to the student):',
    FRAMING[a.mode],
    ...(a.voice ? [`Teaching style the student asked for: ${a.voice}. Honor it in tone, pace and
vocabulary — it changes HOW you teach, never what counts as evidence.`] : []),
    `Student state: ${JSON.stringify(a.state)}`,
    `Suggested lessons: ${a.lessons.map((l) => `${l.slug} (${l.reason}: ${l.detail})`).join('; ') || 'none'}`,
    `Reviews due: ${a.reviewsDue.join(', ') || 'none'}`,
    a.ankiLapses.length
      ? `Anki trouble: ${a.ankiLapses.map((l) => `${l.slug} — ${l.count} lapses this week; probe for misconceptions`).join('; ')}`
      : 'Anki trouble: none',
  ];

  // The course bank is invisible unless named here: nothing else tells the tutor the learner has a
  // past exam waiting, so without this line course_problems only ever gets called when a session
  // plan happens to carry a [course] item.
  if (a.courseBank?.length) {
    const fresh = a.courseBank.filter((p) => !p.lastCorrect).length;
    const sources = [...new Set(a.courseBank.map((p) => p.source))];
    lines.push(`Course bank: ${a.courseBank.length} problems from ${sources.join(', ')}`
      + ` (${fresh} never answered) — fetch with course_problems and drill them verbatim.`);
  }

  // The goal is what makes "how far through this subject am I" answerable. Without it every session
  // starts from the whole vault and the learner has no spine to follow.
  lines.push(a.goal
    ? `Active goal: ${a.goal.kind} "${a.goal.title ?? a.goal.slug}" (${a.goal.slug})`
      + (a.goal.total ? ` — ${a.goal.known ?? 0}/${a.goal.total} pages known`
        + (a.goal.nextSlug ? `, resume at ${a.goal.nextSlug}` : ', complete') : '')
      + '. Teach toward this unless the student asks otherwise.'
    : 'Active goal: none. If the student names something they want to learn, offer to set it as a goal '
      + '(a curated path via create_path in freeform mode) so progress becomes trackable.');

  // Cold start. Without this the tutor is silently unable to act: `learn`/`review`/`quiz` expose no
  // write_page, no search and no ingest (freeform only — session.ts's TEACH_TOOLS), so against an
  // empty vault it can neither teach an existing page nor create one, and nothing tells it why.
  if (a.emptyVault) {
    lines.push(a.mode === 'freeform'
      ? 'COLD START: the vault has no pages yet. Research the subject the student names, then write '
        + 'its first pages (write_page) and a curated path (create_path) before teaching.'
      : `COLD START: the vault has no pages yet. ${a.mode.toUpperCase()} mode gives you web `
        + 'research (the vault cannot ground anything, so it is unlocked) but NO page-writing or '
        + 'ingest tools — so you can answer what the student asks, from sources you cite, and you '
        + 'cannot yet build the curriculum or record evidence against it. Answer the question, then '
        + 'ask them to switch to freeform mode (or add a book) so the subject gets compiled into '
        + 'pages that track their progress.');
  }

  return lines.join('\n');
}
