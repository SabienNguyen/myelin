import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CourseProblem } from './courseBank.js';

export const MODES = ['learn', 'review', 'quiz', 'freeform'] as const;
export type Mode = (typeof MODES)[number];

const here = dirname(fileURLToPath(import.meta.url));
let cached: string | null = null;

/** What is true of THIS turn, for deciding which rules the tutor needs to be told.
 *
 *  The prompt grew one rule per observed failure and nothing ever left, so every turn carried all
 *  of it: ~8,100 tokens before a word of conversation, of which a plain teaching turn uses about
 *  half. That is slower and dearer everywhere, and on a provider with a small per-minute budget
 *  (Groq's free tier: 8,000) a single request could not be sent at all.
 *
 *  `tools` is the names actually on offer this turn. It is the main gate, and the honest one: a
 *  rule about `web_search` on a turn where session.ts withheld `web_search` is not just wasted, it
 *  tells the model to call something that will answer "unknown tool". `facts` covers what a tool
 *  list cannot say — see session.ts's turnFacts for each one's definition. */
export interface TurnFacts { tools: ReadonlySet<string>; facts: ReadonlySet<string> }

const SECTION = /<!-- when: (.+?) -->\n([\s\S]*?)<!-- end -->\n?/g;

/** The tutor's rules. With no `turn`, every section — the whole prompt, as one document.
 *
 *  Conditional sections are fenced in tutor-system-prompt.md itself:
 *      <!-- when: tool:code_exercise -->  …rule…  <!-- end -->
 *  so the prompt stays one readable file, and a rule's condition sits beside the rule. A condition
 *  is `tool:<name>` or `fact:<name>` terms joined by `|` (any one suffices). An unknown term throws
 *  at build time: a typo that silently dropped a rule forever would bring its bug back unnoticed. */
export function buildInstructions(turn?: TurnFacts): string {
  cached ??= readFileSync(join(here, 'tutor-system-prompt.md'), 'utf8');
  return cached.replace(SECTION, (_, condition: string, body: string) => {
    const holds = condition.split('|').map((t) => t.trim()).some((term) => {
      const [kind, name] = term.split(':');
      if ((kind !== 'tool' && kind !== 'fact') || !name) throw new Error(`tutor-system-prompt.md: bad condition "${term}"`);
      return turn === undefined || (kind === 'tool' ? turn.tools : turn.facts).has(name);
    });
    return holds ? body : '';
  });
}

/** Every condition term the prompt file uses — for the test that pins each `tool:` to a tool that
 *  really exists and each `fact:` to one session.ts really computes. */
export function promptConditionTerms(): string[] {
  cached ??= readFileSync(join(here, 'tutor-system-prompt.md'), 'utf8');
  return [...new Set([...cached.matchAll(SECTION)].flatMap((m) => m[1].split('|').map((t) => t.trim())))];
}

const FRAMING: Record<Mode, string> = {
  learn: 'Mode: LEARN. Teach the next suggested lesson.',
  review: 'Mode: REVIEW. Re-prove decayed/due pages before anything new.',
  quiz: 'Mode: QUIZ. Open with a quiz block covering recent pages.',
  freeform: 'Mode: FREEFORM. Follow the student; still record evidence.',
};

export function buildBootstrapContext(a: {
  mode: Mode; state: unknown;
  /** True when the message that opened this session is a greeting and nothing else — see
   *  session.ts's isBareGreeting. The framing changes from "teach the next lesson" to "offer one
   *  and wait", because the student has not said what they want yet. */
  greeting?: boolean;
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
    // A greeting carries no ask, so the mode framing must not read as one. Without this, "hi" on
    // a fresh thread met "Mode: LEARN. Teach the next suggested lesson." plus the suggestions
    // below, and the tutor resumed last session's topic as though it had been asked for. Rule 1b
    // still holds — the tutor names ONE next step rather than offering a menu — it just waits for
    // the answer before teaching.
    a.greeting
      ? `Mode: ${a.mode.toUpperCase()}. The student opened with a greeting and nothing else — they `
        + 'have NOT said what they want to do. Greet them back in one line, say briefly what is '
        + 'waiting (what is due, what you would suggest next, where the goal stands), and name ONE '
        + 'specific next step as a question. Do not stage a block and do not start teaching until '
        + 'they answer. If they want something else, that answer is where you find out.'
      : FRAMING[a.mode],
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
      : `COLD START: the vault has no pages yet. ${a.mode.toUpperCase()} mode unlocks web research `
        + 'AND write_page whenever the vault cannot ground the topic — which, with an empty vault, '
        + 'is always. So: research what the student asks, write the page with the sources you '
        + 'actually read, and record evidence against that page. What you still do NOT have here is '
        + 'ingest or create_path — building a whole curriculum or a curated syllabus is freeform '
        + 'work, so once the subject has legs, offer to switch to freeform (or add a book).');
  }

  return lines.join('\n');
}
