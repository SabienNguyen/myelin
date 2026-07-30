// Rails mode, phase 1 (docs/superpowers/specs/2026-07-30-rails-mode.md): the HARNESS decides what
// happens next and the model does only narrow generation — plan → assemble → generate → stage →
// (on resubmit) grade + harness-recorded evidence → feedback → next plan. A rails turn never gives
// the model tools, so a small local model cannot wander, hallucinate tool arguments, or forget
// record_evidence: the harness calls it. session.ts branches here for learn/review/quiz when
// models.tutor.rails is set; freeform always runs the full agentic loop.
import { z } from 'zod';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES, type BlockToolName } from '../shared/blocks.js';
import type { UIMessage } from '../shared/uiMessages.js';
import {
  createUiStream, generateStructured, type ChatModel, type UiStreamWriter,
} from './llm/index.js';
import type { HarnessConfig } from './config.js';
import { gradeBlockOutput, type Grade } from './grading.js';
import type { Engram } from './mcp.js';
import { chatModelFor } from './models.js';
import type { Mode } from './prompt.js';
import { saveThread } from './sessionStore.js';
import { recordUsage } from './usageLedger.js';

/** How much page body rides into a generation prompt. Rails prompts must stay bounded and
 * cache-stable for the small models rails exists for; 4k chars ≈ a solid page's teachable core. */
export const RAILS_PAGE_BUDGET = 4000;

/** How many trailing user/assistant TEXT exchanges ride as history. The conversation itself never
 * grounds the question — the page does — so history is only enough for continuity of tone. */
export const RAILS_HISTORY_EXCHANGES = 4;

// One history line longer than this is a pasted wall, not conversation — trim it.
const HISTORY_LINE_CAP = 400;

// How many find_analogies bridges ride into the prompt.
const ANALOGY_CAP = 2;

/** Find block-tool outputs in the tail of the incoming history (since the last user text turn).
 * Shared with session.ts's agentic respond — defined here because session.ts imports this module
 * and the reverse import would be circular. */
export function pendingBlockOutputs(messages: UIMessage[]) {
  const out: { tool: BlockToolName; toolCallId: string; input: any; output: any }[] = [];
  const last = messages[messages.length - 1];
  for (const msg of [last]) {
    if (msg?.role !== 'assistant') continue;
    for (const part of msg.parts as any[]) {
      const name = String(part.type).replace(/^tool-/, '') as BlockToolName;
      if (part.type?.startsWith('tool-') && BLOCK_TOOL_NAMES.includes(name)
        && part.state === 'output-available' && !part.output?.grading) {
        out.push({ tool: name, toolCallId: part.toolCallId, input: part.input, output: part.output });
      }
    }
  }
  return out;
}

// The exact member shape engram's working_set returns (queries.ts workingSet).
export interface WorkingSetMember {
  slug: string;
  title: string;
  level: string;
  effective: string;
  lastEvidence: string | null;
  due: boolean;
  why: string;
  misconceptions?: number;
}

export interface RailsItem {
  slug: string;
  title: string;
  /** The student's effective level for the page — 'unseen' when nothing is known. */
  level: string;
  reason: 'due' | 'lesson' | 'neighbor';
}

/**
 * The item picker, in spec order: due working-set members most-overdue-first (oldest lastEvidence
 * first — the longer since the evidence that decayed, the more overdue), then next_lessons
 * suggestions, then working-set neighbors never exercised. `staged` (what this thread already
 * drilled) is skipped at every rung; null means the session ran out of items.
 */
export function pickRailsItem(
  members: WorkingSetMember[],
  lessons: { slug: string; title?: string }[],
  staged: ReadonlySet<string>,
): RailsItem | null {
  const due = members
    .filter((m) => m.due && !staged.has(m.slug))
    .sort((a, b) => {
      const la = a.lastEvidence ?? '', lb = b.lastEvidence ?? '';
      // Slug tiebreak so the pick is deterministic — ISO dates order lexicographically.
      return la === lb ? (a.slug < b.slug ? -1 : 1) : la < lb ? -1 : 1;
    });
  if (due[0]) return { slug: due[0].slug, title: due[0].title, level: due[0].effective, reason: 'due' };

  const bySlug = new Map(members.map((m) => [m.slug, m]));
  const lesson = lessons.find((l) => l.slug && !staged.has(l.slug));
  if (lesson) {
    return {
      slug: lesson.slug,
      title: lesson.title ?? lesson.slug,
      level: bySlug.get(lesson.slug)?.effective ?? 'unseen',
      reason: 'lesson',
    };
  }

  const neighbor = members.find((m) =>
    m.why.startsWith('neighbor:') && m.lastEvidence === null && !staged.has(m.slug));
  if (neighbor) {
    return { slug: neighbor.slug, title: neighbor.title, level: neighbor.effective, reason: 'neighbor' };
  }
  return null;
}

export function trimToBudget(body: string, budget = RAILS_PAGE_BUDGET): string {
  const trimmed = body.trim();
  return trimmed.length <= budget ? trimmed : `${trimmed.slice(0, budget)}\n[page truncated]`;
}

/** The last few user/assistant text exchanges as "student:"/"tutor:" lines — tool parts and
 * block payloads never ride (that is the point: rails prompts are bounded and page-grounded). */
export function railsHistoryLines(messages: UIMessage[], exchanges = RAILS_HISTORY_EXCHANGES): string[] {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = (m.parts as any[])
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text).join(' ').trim();
    if (!text) continue;
    const capped = text.length > HISTORY_LINE_CAP ? `${text.slice(0, HISTORY_LINE_CAP)}…` : text;
    lines.push(`${m.role === 'user' ? 'student' : 'tutor'}: ${capped}`);
  }
  return lines.slice(-exchanges * 2);
}

// What the generation call must return. expected∈choices is checked after parse (see
// generateRailsQuickCheck) so the retry can name the violation to the model. Exported for
// scripts/eval-local-model.ts, which drives the same schema against a candidate local model.
export const railsCheckSchema = z.object({
  question: z.string().min(1),
  mode: z.literal('choice'),
  choices: z.array(z.string().min(1)).min(3).max(5),
  expected: z.string().min(1),
  framing: z.string().min(1),
});
export type RailsQuickCheck = z.infer<typeof railsCheckSchema>;

const FALLBACK_DISTRACTORS = [
  'This topic is covered in a later chapter.',
  'No page in the vault covers this yet.',
];

/** First markdown heading, else first non-empty line — the deterministic seed for the fallback. */
export function firstHeadingOrLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line === '---') continue;
    const heading = line.match(/^#+\s+(.*)$/);
    const text = (heading ? heading[1] : line).trim();
    if (text) return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  }
  return '';
}

/** The deterministic template question a rails turn falls back to after two rejected
 * generations — a rails session never dies on a malformed generation (spec step 3). Recognition
 * of the page's own opening line: weak pedagogy, but honest, mechanical, and always constructible. */
export function fallbackQuickCheck(title: string, body: string): RailsQuickCheck {
  const line = firstHeadingOrLine(body) || title;
  return {
    question: `Which of these lines is from “${title}”?`,
    mode: 'choice',
    choices: [line, ...FALLBACK_DISTRACTORS],
    expected: line,
    framing: `A quick recognition warm-up on “${title}” before we go on.`,
  };
}

export interface RailsGenDeps {
  model: ChatModel;
  cfg: HarnessConfig;
}

/** Exported for scripts/eval-local-model.ts: the eval must measure a candidate model against the
 * REAL rails prompt, not a paraphrase of it. */
export function buildCheckPrompt(
  item: RailsItem,
  page: { title: string; body: string },
  analogies: { slug: string; title: string }[],
  history: string[],
): string {
  // Rule 3 (tutor-system-prompt.md): first contact is a calibration, not a test, and must read
  // that way. 'unseen'/'exposed' means nothing has probed this page yet.
  const firstContact = item.level === 'unseen' || item.level === 'exposed';
  const framingRule = firstContact
    ? "This is the student's first contact with this page: the framing must say, in one line, that "
      + 'they are not expected to know this yet and a wrong guess is useful because it decides '
      + 'where teaching starts. The question must be answerable by reasoning from its own options — '
      + 'never demand vocabulary the page has not introduced.'
    : 'One line that sets up the question without giving the answer away.';
  return [
    'Write ONE multiple-choice quick check for a tutoring app. Ground it entirely in the page '
    + 'below — never in knowledge the page does not carry.',
    '',
    `Page “${page.title}” (student's level: ${item.level}):`,
    '---',
    trimToBudget(page.body),
    '---',
    ...(analogies.length
      ? [`Pages the student already knows that bridge to this one: ${analogies.map((a) => a.title).join('; ')}. `
        + 'You may lean on one for the framing.']
      : []),
    ...(history.length ? ['Recent conversation:', ...history] : []),
    '',
    'Fields:',
    '- question: one question about the page, answered by picking an option. It is choice mode, so '
    + 'NEVER append "and why?" or ask for reasoning a pick cannot carry.',
    '- choices: 3-5 options, exactly one correct, the others plausible.',
    '- expected: the correct choice, copied verbatim from choices.',
    `- framing: ${framingRule}`,
    'The framing and question describe only what the page says — never attribute knowledge, words, '
    + 'or progress to the student.',
  ].join('\n');
}

/**
 * One generation, one retry with the rejection appended, then the deterministic fallback.
 * Validation failures throw inside generateStructured (schema.parse) or here (expected must be
 * one of choices, verbatim) — either way the model gets told exactly what was wrong once.
 */
export async function generateRailsQuickCheck(
  deps: RailsGenDeps,
  item: RailsItem,
  page: { title: string; body: string },
  analogies: { slug: string; title: string }[],
  history: string[],
): Promise<RailsQuickCheck> {
  const prompt = buildCheckPrompt(item, page, analogies, history);
  const once = async (rejection?: string): Promise<RailsQuickCheck> => {
    const { object, usage } = await generateStructured({
      model: deps.model,
      prompt: rejection
        ? `${prompt}\n\nYour previous attempt was rejected: ${rejection}. Return a corrected quick check.`
        : prompt,
      schema: railsCheckSchema,
      schemaName: 'rails_quick_check',
    });
    recordUsage(deps.cfg.vault, {
      role: 'tutor', model: deps.cfg.models?.tutor?.model ?? 'unknown', usage,
    });
    if (!object.choices.includes(object.expected)) {
      throw new Error(`expected ${JSON.stringify(object.expected)} is not one of choices — copy one choice verbatim`);
    }
    return object;
  };
  try {
    return await once();
  } catch (first) {
    try {
      return await once(first instanceof Error ? first.message : String(first));
    } catch (second) {
      console.error('[rails] generation fell back to the template question:',
        second instanceof Error ? second.message : second);
      return fallbackQuickCheck(page.title, page.body);
    }
  }
}

// Exported for scripts/eval-local-model.ts, same as railsCheckSchema.
export const railsFeedbackSchema = z.object({
  feedback: z.string().min(1),
  next: z.enum(['continue', 'stop-offer']),
});
export type RailsFeedback = z.infer<typeof railsFeedbackSchema>;

/** Exported for scripts/eval-local-model.ts — the real feedback prompt, same rule as
 * buildCheckPrompt. */
export function buildFeedbackPrompt(
  graded: { question: string; answer: string; grade: Grade }[],
): string {
  const lines = graded.map((g) =>
    `Question: ${g.question}\nStudent's answer: "${g.answer}"\nMachine grade: ${g.grade.verdict} — ${g.grade.detail}`);
  return [
    "Write the tutor's feedback after a machine-graded quick check.",
    ...lines,
    '',
    'Fields:',
    '- feedback: at most 2 sentences. Describe only what the student actually did — quote their '
    + 'pick; never attribute reasoning or words they did not write, and never claim a concept is '
    + 'landed from one answer.',
    "- next: 'continue' stages the next drill immediately; 'stop-offer' pauses and asks whether "
    + 'to stop or go on.',
  ].join('\n');
}

/**
 * One feedback call, honesty-bound per rule 3a: describe only what the student actually did.
 * A failed call falls back to reading the machine grade out loud with a stop-offer — deterministic
 * and honest by construction, same never-dies rule as the question generation.
 */
export async function generateRailsFeedback(
  deps: RailsGenDeps,
  graded: { question: string; answer: string; grade: Grade }[],
): Promise<RailsFeedback> {
  const prompt = buildFeedbackPrompt(graded);
  try {
    const { object, usage } = await generateStructured({
      model: deps.model, prompt, schema: railsFeedbackSchema, schemaName: 'rails_feedback',
    });
    recordUsage(deps.cfg.vault, {
      role: 'tutor', model: deps.cfg.models?.tutor?.model ?? 'unknown', usage,
    });
    return object;
  } catch (e) {
    console.error('[rails] feedback fell back to the machine grade:',
      e instanceof Error ? e.message : e);
    const g = graded[0];
    return {
      feedback: `You answered "${g.answer}" — machine grade: ${g.grade.verdict} (${g.grade.detail}).`,
      next: 'stop-offer',
    };
  }
}

/** The next `rails-<n>` toolCallId, seeded from the thread so ids stay unique across server
 * restarts (the in-memory counter alone would restart at 1 and collide inside the same thread). */
export function nextRailsSeq(messages: UIMessage[]): number {
  let max = 0;
  for (const m of messages) {
    for (const p of (m.parts as any[]) ?? []) {
      const match = typeof p?.toolCallId === 'string' && p.toolCallId.match(/^rails-(\d+)$/);
      if (match) max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

/** Slugs this thread has already staged, read from the thread itself (rails toolCallIds), so the
 * skip survives a server restart and a handcrafted resubmit alike. */
function seedStaged(messages: UIMessage[], staged: Set<string>): void {
  for (const m of messages) {
    for (const p of (m.parts as any[]) ?? []) {
      if (typeof p?.toolCallId === 'string' && /^rails-\d+$/.test(p.toolCallId)
        && typeof p.input?.pageSlug === 'string') {
        staged.add(p.input.pageSlug);
      }
    }
  }
}

const STOP_OFFER = 'Stop here, or keep going? Say "go on" for another.';
const EXHAUSTED = 'Nothing left to drill right now — everything due or suggested has been staged '
  + 'this session. Switch modes, or come back after some review has decayed.';

export function createRailsSession(
  lw: Engram, cfg: HarnessConfig, opts: { model?: ChatModel } = {},
) {
  const model = opts.model ?? chatModelFor('tutor', cfg);
  // Per-thread memory of what this session already staged — same in-memory lifetime as
  // session.ts's lastModeByThread; seedStaged() rebuilds it from the thread after a restart.
  const stagedByThread = new Map<string, Set<string>>();

  async function planNext(staged: ReadonlySet<string>): Promise<RailsItem | null> {
    const [ws, nl] = await Promise.all([
      lw.call('working_set', { student: cfg.student }),
      lw.call('next_lessons', { student: cfg.student }),
    ]);
    return pickRailsItem(ws.members ?? [], nl.lessons ?? [], staged);
  }

  async function assemble(item: RailsItem): Promise<{
    page: { title: string; body: string };
    analogies: { slug: string; title: string }[];
  }> {
    const { page } = await lw.call('read_page', { slug: item.slug });
    let analogies: { slug: string; title: string }[] = [];
    try {
      const res = await lw.call('find_analogies', { student: cfg.student, slug: item.slug, k: ANALOGY_CAP });
      analogies = (res.analogies ?? []).slice(0, ANALOGY_CAP);
    } catch { /* analogies are optional bridges — no embeddings, no bridges */ }
    return { page: { title: page.meta?.title ?? item.slug, body: page.body ?? '' }, analogies };
  }

  async function respond(messages: UIMessage[], _mode: Mode, threadId = 'default'): Promise<Response> {
    const pending = pendingBlockOutputs(messages);
    const staged = stagedByThread.get(threadId) ?? new Set<string>();
    stagedByThread.set(threadId, staged);
    seedStaged(messages, staged);
    let seq = nextRailsSeq(messages);
    let textSeq = 0;

    return createUiStream({
      // Same continuation rule as the agentic respond: a resubmit continues the incoming
      // history's last assistant message in place (see session.ts's originalMessages comment).
      originalMessages: messages,
      onEnd: ({ messages: finalMessages }) => {
        try {
          saveThread(cfg.vault, threadId, finalMessages as unknown[]);
        } catch (e) {
          console.error('[server-side thread save]', e);
        }
      },
      onError: (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[rails-turn-error]', msg);
        return `The tutor hit an error and this turn was lost: ${msg.slice(0, 200)}`;
      },
      execute: async (writer) => {
        const say = (text: string) => {
          const id = `rails-say-${textSeq++}`;
          writer.write({ type: 'text-start', id });
          writer.write({ type: 'text-delta', id, delta: text });
          writer.write({ type: 'text-end', id });
        };

        const stageNext = async (w: UiStreamWriter): Promise<void> => {
          const item = await planNext(staged);
          if (!item) { say(EXHAUSTED); return; }
          staged.add(item.slug);
          const { page, analogies } = await assemble(item);
          const gen = await generateRailsQuickCheck(
            { model, cfg }, item, page, analogies, railsHistoryLines(messages),
          );
          const input = {
            question: gen.question, mode: 'choice' as const,
            choices: gen.choices, expected: gen.expected, pageSlug: item.slug,
          };
          // Validate against the client's own schema so a drifted block contract fails the
          // server (and its tests), never the renderer.
          BLOCK_TOOLS.quick_check.input.parse(input);
          say(gen.framing);
          w.write({ type: 'tool-input-available', toolCallId: `rails-${seq++}`, toolName: 'quick_check', input });
        };

        if (pending.length === 0) {
          writer.write({ type: 'start-step' });
          await stageNext(writer);
          writer.write({ type: 'finish-step' });
          return;
        }

        // Resubmit: grade with the same path the agentic loop uses, round-trip the grading to the
        // already-rendered card, then record the evidence OURSELVES — rails changes WHO calls
        // record_evidence, never what is recorded (spec invariant).
        const graded: { question: string; answer: string; grade: Grade }[] = [];
        for (const p of pending) {
          const grade = await gradeBlockOutput(p.tool, p.input, p.output, cfg);
          p.output.grading = grade;
          writer.write({ type: 'tool-output-available', toolCallId: p.toolCallId, output: p.output });
          graded.push({
            question: String(p.input?.question ?? p.input?.prompt ?? ''),
            answer: String(p.output?.answer ?? ''),
            grade,
          });
        }
        for (const g of graded) {
          for (const e of g.grade.evidence) {
            await lw.call('record_evidence', {
              student: cfg.student, slug: e.slug, kind: e.kind, note: e.note,
            });
          }
        }

        writer.write({ type: 'start-step' });
        const fb = await generateRailsFeedback({ model, cfg }, graded);
        say(fb.feedback);
        if (fb.next === 'continue') await stageNext(writer);
        else say(STOP_OFFER);
        writer.write({ type: 'finish-step' });
      },
    });
  }

  return { respond };
}
export type RailsSession = ReturnType<typeof createRailsSession>;
