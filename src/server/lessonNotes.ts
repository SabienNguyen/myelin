// Lesson notes -> vault pages (spec E): after a teaching turn ends, the concepts it actually
// taught get queued through the EXISTING compile pipeline (ingest.ts's compileNext/compileOne,
// the ledger in queueStore.ts) instead of staying locked inside the thread transcript. This module
// owns exactly two things: recognizing a turn worth compiling, and turning it into a ledger entry.
// Everything downstream — extracting concepts, writing new pages, linking to existing ones — is the
// compile model's job, steered by ingest.ts's lesson branch (buildLessonCompilePrompt). Whether a
// concept becomes a NEW page or a link to an existing one is not left to the model, though: ingest.ts's
// write_page wrapper for `mode: 'lesson'` (withLessonRules) mechanically refuses to overwrite a page
// that predates the compile (unless it's a stub) and filters `sources` down to this entry's own
// sourceUrls — closing the data-loss incident where a lesson compile, following the old prompt's
// "extend that page with write_page", silently replaced a real page's real citations with a draft
// and invented ones. Single-writer rule intact: this module only ever writes under vault/raw/uploads/
// (harness territory) and the compile-queue ledger via updateQueue/enqueueChapters — never pages/ or
// students/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isToolUIPart, getToolName, type UIMessage } from '../shared/uiMessages.js';
import { BLOCK_TOOL_NAMES } from '../shared/blocks.js';
import type { HarnessConfig } from './config.js';
import { ensureCompileDrain } from './ingest.js';
import type { Engram } from './mcp.js';
import { enqueueChapters, updateQueue } from './queueStore.js';

/** A teaching turn worth (maybe) compiling into vault pages. Pure data — everything about WHERE
 *  it came from (threadId, topicSlug) and WHAT happened (prose, exchanges, research) is captured
 *  up front so enqueueLessonNotes never has to re-derive it from UI parts. */
export interface LessonTurn {
  threadId: string;
  topicSlug: string | null;
  endedAt: string; // ISO
  tutorText: string; // the assistant's prose this turn
  exchanges: { prompt: string; answer: string; verdict?: string }[]; // blocks + learner answers
  sources: { url: string; title?: string }[]; // research this turn (server-tool-result / read_url)
}

/** A page this short is not a lesson, whatever else is true of the turn — matches the vault's own
 *  THIN_BODY_CHARS threshold in session.ts (a real page/turn worth acting on says more than this).
 *  Measured against tutor prose plus block prompts combined (see isTeachingTurn), since the concept
 *  a turn taught often lives in the block's prompt rather than the surrounding prose. */
export const MIN_LESSON_CHARS = 400;

/** Whether a turn is worth compiling: not a bare greeting, not a progress question, not a
 *  grading-only turn (the client's auto-resubmit — landing a grade is not teaching), and the
 *  teaching content said enough to be worth a page. "Teaching content" is the tutor's prose PLUS
 *  every exchange's block prompt (never the learner's answer) — a live turn can carry the actual
 *  concept in a quick_check prompt ("A serving system waits briefly to combine several model
 *  requests into one batch...") with only a couple hundred chars of prose around it, so a
 *  prose-only gate silently drops turns that plainly taught something. The three flags are handed
 *  in rather than recomputed here because session.ts already has
 *  isBareGreeting/isProgressQuestion/resubmitPending in hand at the point it calls this —
 *  recomputing them here would mean importing session.ts from a module session.ts itself imports,
 *  a needless cycle for logic that already exists. */
export function isTeachingTurn(
  turn: LessonTurn,
  flags: { gradingOnly: boolean; bareGreeting: boolean; progressQuestion: boolean },
): boolean {
  if (flags.gradingOnly || flags.bareGreeting || flags.progressQuestion) return false;
  const teachingChars = turn.tutorText.trim().length
    + turn.exchanges.reduce((sum, e) => sum + e.prompt.trim().length, 0);
  return teachingChars >= MIN_LESSON_CHARS;
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Best-effort prompt/answer/verdict out of one graded block's input/output. Block shapes vary
 *  (quick_check's `question`/`answer`, quiz's `items`/`answers`, math_scratchpad's
 *  `problemLatex`/`finalLatex`, writing_draft's `prompt`/`draft`, ...) — this reads the field names
 *  common across them and falls back to a truncated JSON dump rather than guessing wrong, since a
 *  lesson note that says too much verbatim is far cheaper than one that silently drops the answer. */
function exchangeFromBlock(
  input: unknown, output: unknown,
): { prompt: string; answer: string; verdict?: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const o = (output ?? {}) as Record<string, unknown>;
  const prompt = pickString(i.question) ?? pickString(i.prompt) ?? pickString(i.problemLatex)
    ?? pickString(i.title) ?? JSON.stringify(i).slice(0, 300);
  const answers = Array.isArray(o.answers)
    ? (o.answers as { id?: unknown; answer?: unknown }[])
      .map((a) => `${pickString(a.id) ?? ''}: ${pickString(a.answer) ?? ''}`).join('; ')
    : undefined;
  const answer = pickString(o.answer) ?? answers ?? pickString(o.draft) ?? pickString(o.finalLatex)
    ?? JSON.stringify(o).slice(0, 300);
  const grading = o.grading as { verdict?: unknown } | undefined;
  const verdict = pickString(grading?.verdict);
  return { prompt, answer, ...(verdict ? { verdict } : {}) };
}

/** Research URLs a tool part names, in the shapes the two search backends actually produce:
 *  Anthropic's web_search_tool_result content (an array of `{ url, title? }` results, riding
 *  straight through as a server-tool-result's `output`), the OpenAI Responses route's
 *  `{ query, sources: [{ url, title }] }`, and a plain `read_url` call's `input.url`. */
export function sourcesFromToolPart(name: string, providerExecuted: boolean | undefined, input: unknown, output: unknown): { url: string; title?: string }[] {
  const found: { url: string; title?: string }[] = [];
  const add = (url: unknown, title?: unknown) => {
    if (typeof url === 'string' && url) found.push({ url, title: typeof title === 'string' ? title : undefined });
  };
  if (name === 'read_url') {
    add((input as { url?: unknown } | undefined)?.url);
    return found;
  }
  if (!providerExecuted) return found;
  if (Array.isArray(output)) {
    for (const r of output) add((r as { url?: unknown })?.url, (r as { title?: unknown })?.title);
  } else if (output && typeof output === 'object' && Array.isArray((output as { sources?: unknown }).sources)) {
    for (const r of (output as { sources: unknown[] }).sources) {
      add((r as { url?: unknown })?.url, (r as { title?: unknown })?.title);
    }
  }
  return found;
}

/** Builds a LessonTurn from the one assistant UIMessage this turn produced (or updated in place —
 *  see session.ts's "originalMessages" convergence note for why a resubmit continuation keeps the
 *  same message id). Pure: threadId/topicSlug/endedAt all arrive from the caller, which already
 *  knows them (threadTopic(messages), the turn's own clock read) — this function only reads parts. */
export function lessonTurnFromParts(
  threadId: string, topicSlug: string | null, endedAt: string, message: UIMessage,
): LessonTurn {
  const tutorText = message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text).join('\n\n').trim();

  const exchanges: LessonTurn['exchanges'] = [];
  const sources: LessonTurn['sources'] = [];
  const seenUrls = new Set<string>();

  for (const part of message.parts) {
    if (!isToolUIPart(part) || part.state !== 'output-available') continue;
    const name = getToolName(part);
    if ((BLOCK_TOOL_NAMES as readonly string[]).includes(name)) {
      exchanges.push(exchangeFromBlock(part.input, part.output));
    }
    for (const s of sourcesFromToolPart(name, part.providerExecuted, part.input, part.output)) {
      if (seenUrls.has(s.url)) continue;
      seenUrls.add(s.url);
      sources.push(s);
    }
  }

  return { threadId, topicSlug, endedAt, tutorText, exchanges, sources };
}

function lessonNotesMarkdown(turn: LessonTurn): string {
  const header = `<!-- lesson notes: thread "${turn.threadId}", ended ${turn.endedAt} -->\n\n`;
  const exchangesMd = turn.exchanges.length
    ? `\n\n## Exchanges\n\n${turn.exchanges.map((e, i) => `### ${i + 1}\n\n`
      + `**Asked:** ${e.prompt}\n\n**Answered:** ${e.answer}`
      + (e.verdict ? `\n\n**Verdict:** ${e.verdict}` : '')).join('\n\n')}`
    : '';
  const sourcesMd = turn.sources.length
    ? `\n\n## Sources\n\n${turn.sources.map((s) => `- ${s.title ? `${s.title} — ` : ''}${s.url}`).join('\n')}`
    : '';
  return `${header}${turn.tutorText}${exchangesMd}${sourcesMd}\n`;
}

/** Writes this turn's lesson notes under raw/uploads/lesson-notes/<threadId>/ (harness territory —
 *  Engram never sees this file, only the compiled pages that come out of it) and queues it as a
 *  `mode: 'lesson'` ledger entry, then kicks the drain the same way an upload does. Idempotent per
 *  turn: `chapter` is built from threadId + endedAt, and enqueueChapters upserts by that identity —
 *  the same mechanism every other ingest door already relies on (see queueStore.ts), so calling
 *  this twice for the same turn overwrites the file and the ledger row rather than duplicating
 *  either. Never throws into a learner's turn on its own — callers (session.ts's onEnd hook) are
 *  responsible for the fire-and-forget `.catch`. */
export async function enqueueLessonNotes(
  vault: string, turn: LessonTurn, deps: { lw: Engram; cfg: HarnessConfig },
): Promise<void> {
  const safeEndedAt = turn.endedAt.replace(/[^0-9a-zA-Z]+/g, '-');
  const chapter = `raw/uploads/lesson-notes/${turn.threadId}/${safeEndedAt}.md`;
  const dir = join(vault, 'raw', 'uploads', 'lesson-notes', turn.threadId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(vault, chapter), lessonNotesMarkdown(turn));

  const title = turn.topicSlug ? `Lesson notes: ${turn.topicSlug}` : 'Lesson notes';
  await updateQueue(vault, (entries) => {
    enqueueChapters(entries, [{
      book: 'lesson-notes',
      chapter,
      title,
      status: 'pending',
      mode: 'lesson',
      ...(turn.topicSlug ? { lessonTopic: turn.topicSlug } : {}),
      ...(turn.sources.length ? { sourceUrls: turn.sources.map((s) => s.url) } : {}),
    }]);
  });

  if (deps.cfg.autoCompile !== false) ensureCompileDrain(deps.lw, deps.cfg);
}
