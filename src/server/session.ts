import { z } from 'zod';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES, type BlockToolName } from '../shared/blocks.js';
import { UI_TOOLS } from '../shared/uiTools.js';
import type { UIMessage } from '../shared/uiMessages.js';
import {
  createUiStream, generateMessageId, runLoop, uiMessagesToChatMessages,
  type ChatMessage, type ChatModel, type LoopTool,
} from './llm/index.js';
import { recentLapses } from './anki/inbound.js';
import type { HarnessConfig } from './config.js';
import { markCorrect, nextProblems, readBank } from './courseBank.js';
import { findCanonicalPapers, findRecentPapers } from './frontierResearch.js';
import { fetchVideoTranscript } from './videoIngest.js';
import { searchVideos } from './videoSearch.js';
import { extractReferences } from './references.js';
import { readQueue } from './queueStore.js';
import { appliedGradeBypass, gradeBlockOutput, untouchedSlugEvidence } from './grading.js';
import { createRailsSession, pendingBlockOutputs } from './rails.js';
import { dietUiMessages } from './historyDiet.js';
import { buildIngestTools } from './ingestTools.js';
import type { Engram } from './mcp.js';
import { chatModelFor } from './models.js';
import { readGoal, pathProgress } from './goalStore.js';
import { buildBootstrapContext, buildInstructions, type Mode } from './prompt.js';
import { logGuardrail, saveThread } from './sessionStore.js';
import { readStance, STANCE_INSTRUCTIONS } from './stanceStore.js';
import { recordUsage } from './usageLedger.js';
import { buildWebTools } from './webTools.js';
import { generateExercise, listGenerated } from './gap/generated.js';
import { builtinPatterns, patternChoices } from './gap/service.js';
import { compileGenerate } from './gap/generateSeam.js';
import { zodTool } from './zodTool.js';

// Tools the tutor may use per mode; write/link/compile only in freeform (spec §5).
const TEACH_TOOLS = ['read_page', 'search', 'get_student_state', 'record_evidence',
  'next_lessons', 'find_analogies', 'list_paths', 'read_path'];

// Tools whose `student` argument must always be the configured student — models
// (especially small local ones) invent ids like "student" otherwise.
const STUDENT_TOOLS = ['record_evidence', 'get_student_state', 'next_lessons', 'find_analogies'];

/** The evidence kinds a MACHINE mints. The README's invariant — "a model's opinion can never mint
 *  the evidence a machine check earns" — is exactly these two: they mean a checker verified the
 *  work. `exposed`, `struggled` and `misconception` are tutor OBSERVATIONS and stay recordable. */
const PROVING_KINDS = new Set(['applied-correctly', 'rubric-passed']);

// Tools whose `slug` argument must name a real vault page.
const SLUG_TOOLS = ['record_evidence', 'read_page', 'find_analogies'];

/** Read-only MCP tools whose answer cannot change unless something writes. Repeating one with the
 *  same arguments inside a single turn re-reads the vault to produce a byte-identical answer — a
 *  live turn called `get_student_state` four times — which costs latency on every model and real
 *  money on a metered one. Cached per turn, and dropped entirely the moment anything writes. */
const CACHEABLE_TOOLS = new Set([
  'get_student_state', 'next_lessons', 'list_paths', 'read_path', 'read_page', 'search',
  'find_analogies',
]);

/** Tools that change what the cacheable ones would return. Any of these clears the turn cache, so
 *  a `get_student_state` after a `record_evidence` sees the new standing rather than a stale copy —
 *  which is exactly the read the tutor makes when deciding what to teach next. */
const INVALIDATING_TOOLS = new Set([
  'record_evidence', 'write_page', 'link_pages', 'unlink_pages', 'create_path',
  'mark_course_problem', 'compile_source',
]);

function levenshtein(a: string, b: string): number {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}

/** Map a (possibly hallucinated) slug onto the closest real vault slug. Models invent slugs
 * like "derivatives-introduction" or "derivative" for the real page "derivatives"; repairing
 * conservatively (containment or small edit distance, unique winner) beats letting every
 * downstream record_evidence/find_analogies call fail. Unmatched slugs pass through untouched
 * so genuine errors stay visible. */
export function repairSlug(slug: string, known: string[]): string {
  if (!slug || known.includes(slug)) return slug;
  const norm = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  if (known.includes(norm)) return norm;
  const scored = known
    .map((k) => ({
      k,
      score: norm.startsWith(`${k}-`) || k.startsWith(`${norm}-`) || norm === `${k}s` || k === `${norm}s`
        ? 0 : levenshtein(norm, k),
    }))
    .filter(({ k, score }) => score <= Math.min(3, Math.floor(k.length / 3)))
    .sort((a, b) => a.score - b.score);
  if (scored.length && (scored.length === 1 || scored[0].score < scored[1].score)) return scored[0].k;
  return slug;
}

/** Drop null/undefined args (MCP zod schemas want optional fields ABSENT, not null). */
export function sanitizeToolArgs(args: any, toolName: string, student: string, knownSlugs: string[] = []): any {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (v != null) out[k] = v;
  if (STUDENT_TOOLS.includes(toolName)) out.student = student;
  if (SLUG_TOOLS.includes(toolName) && typeof out.slug === 'string' && knownSlugs.length)
    out.slug = repairSlug(out.slug, knownSlugs);
  // record_evidence's `misconception` param is the only input that reaches the standing
  // `misconceptions[]` array — the array the graph ⚠ marker, the session plan's repair queue, and
  // the page panel all read; `kind: 'misconception'` alone merely tags the evidence log. The tutor
  // prompt teaches "kind misconception, the confusion verbatim in the note", and a tutor following
  // that convention recorded evidence NO surface could ever show (a lifecycle audit watched every
  // surface stay blank). Every tutor tool call passes through here via guardMcpTools, so
  // defaulting the param from the note makes the documented convention work; an explicit
  // `misconception` still wins.
  if (toolName === 'record_evidence' && out.kind === 'misconception'
    && out.misconception == null && typeof out.note === 'string' && out.note) {
    out.misconception = out.note;
  }
  // Models sometimes double-escape newlines in block-tool JSON, and the learner then reads a
  // literal "\n\n" mid-question (seen live in a structured_check prompt). Only the two-newline
  // signature is unescaped: a lone "\n" is ambiguous with LaTeX commands a prose prompt can
  // legitimately embed ("$\nu$"), but backslash-n-backslash-n collides with nothing.
  if ((BLOCK_TOOL_NAMES as readonly string[]).includes(toolName)) {
    for (const f of ['prompt', 'question', 'title'] as const) {
      if (typeof out[f] === 'string' && (out[f] as string).includes('\\n\\n')) {
        out[f] = (out[f] as string).replaceAll('\\n\\n', '\n\n');
      }
    }
  }
  return out;
}

/** The prompt's slug grounding, capped for scale.
 *
 * Small vaults inline every slug — the original behavior, and the right one: small models invent
 * slugs like "derivatives-introduction" unless shown the real ids. But the list rode EVERY turn,
 * and at 2,000 pages that is thousands of tokens of pure slug text per turn. Past the cap, the
 * turn inlines only the slugs it can actually act on (this sitting's lessons, reviews, goal and
 * course pages) and says how to reach the rest — which stays honest because repairSlug
 * (sanitizeToolArgs) still auto-corrects near-miss slugs against the FULL list server-side,
 * where it costs nothing. */
export const SLUG_LIST_CAP = 150;
export function slugListLine(slugs: string[], relevant: string[] = []): string {
  if (slugs.length <= SLUG_LIST_CAP) {
    return `Vault pages (the ONLY valid slugs — use them verbatim): ${slugs.join(', ')}`;
  }
  const shown = [...new Set(relevant.filter((r) => slugs.includes(r)))];
  return `This sitting's pages (valid slugs, verbatim): ${shown.join(', ') || '(none yet)'} — `
    + `plus ${slugs.length - shown.length} more in the vault. Find others with the search tool; `
    + 'a near-miss slug is auto-corrected to the nearest real page.';
}

/** Wrap MCP tools so every execute() sees sanitized args — the model cannot send a wrong
 * student id, a null optional field, or (where repairable) a hallucinated slug. Failed calls
 * are logged server-side so journalctl shows WHY a tool chip went ⚠. */
export function guardMcpTools(
  tools: LoopTool[], student: string, knownSlugs: string[],
  // Evidence THIS TURN's grading actually produced. The proving kinds are refused unless they
  // appear here — see PROVING_KINDS below.
  earned: { slug: string; kind: string }[] = [],
  vault?: string,
): LoopTool[] {
  const earnedKeys = new Set(earned.map((e) => `${e.slug}|${e.kind}`));
  // One cache per guardMcpTools call, and guardMcpTools is called once per turn — so its lifetime
  // is exactly the turn, with no cross-turn staleness to reason about.
  const readCache = new Map<string, unknown>();
  return tools.map((t) => ({
    ...t,
    execute: t.execute
      ? async (args: unknown) => {
        const clean = sanitizeToolArgs(args, t.name, student, knownSlugs);
        if (t.name === 'record_evidence') {
          const a = clean as { slug?: unknown; kind?: unknown };
          const kind = String(a?.kind ?? '');
          const slug = String(a?.slug ?? '');
          if (PROVING_KINDS.has(kind) && !earnedKeys.has(`${slug}|${kind}`)) {
            // A learner talked a tutor into eight pages of `applied-correctly` with three
            // messages — one a fake "SYSTEM:" line — staging no block and grading nothing; two
            // pages reached `mastered` on the strength of a note reading "System-provided
            // evidence". appliedGradeBypass is blind to that: it compares against slugs the
            // machine graded this turn, and here nothing was graded at all. The README's
            // invariant is exact — a model's opinion can never mint the evidence a machine check
            // earns — so these two kinds are refused outright rather than logged after the fact.
            const why = `refused ${kind} for "${slug}" — this turn's grading did not earn it`;
            console.error(`[evidence-guard] ${why}`);
            if (vault) logGuardrail(vault, why);
            return {
              isError: true,
              content: [{
                type: 'text',
                text: `refused: "${kind}" is minted by a machine grade, not by conversation. `
                  + `Nothing this turn graded "${slug}". Stage a block and let it be graded, or `
                  + 'record an observation kind (exposed, struggled, misconception) instead.',
              }],
            };
          }
        }
        const cacheKey = CACHEABLE_TOOLS.has(t.name)
          ? `${t.name}|${JSON.stringify(clean ?? null)}`
          : null;
        if (cacheKey !== null && readCache.has(cacheKey)) return readCache.get(cacheKey);

        const result = await t.execute!(clean);

        if (INVALIDATING_TOOLS.has(t.name)) readCache.clear();
        // Errors are never cached: a failed read is exactly the call worth making again, and the
        // retry logic elsewhere would otherwise be handed the same failure from memory.
        else if (cacheKey !== null && !(result as any)?.isError) readCache.set(cacheKey, result);

        // A page written THIS TURN has to become recordable immediately. knownSlugs was read once
        // at turn start, and sanitizeToolArgs runs every slug through repairSlug against it — so
        // without this, the tutor writes "frontal-neocortex", then record_evidence's brand-new slug
        // gets "repaired" to whatever unrelated page happens to be nearest, filing the learner's
        // evidence under the wrong page. Mutating the array the closure already holds keeps every
        // later call in this turn consistent.
        if (t.name === 'write_page' && !(result as any)?.isError) {
          const written = (clean as { slug?: unknown })?.slug;
          if (typeof written === 'string' && written && !knownSlugs.includes(written)) {
            knownSlugs.push(written);
          }
        }
        if (result && typeof result === 'object' && (result as any).isError) {
          const text = ((result as any).content ?? []).map((c: any) => c?.text ?? '').join(' ');
          console.error(`[tool-error] ${t.name} args=${JSON.stringify(clean)} -> ${text.slice(0, 300)}`);
        }
        return result;
      }
      : undefined,
  }));
}

/**
 * Which block tools the tutor may use: all of them, including `code_exercise`.
 *
 * That last one was briefly withheld when no the-gap sidecar was configured, because a tool whose
 * backend cannot exist is not a tool — a fresh install's first programming lesson ended in "This
 * exercise can't start right now." The right fix turned out to be one level down: the sandbox now
 * ships INSIDE the harness (gap/service.ts, child-process runner and all), so the backend always
 * exists and the gate came back out. Kept as a named function so the next conditional block (if
 * one ever appears) belongs here rather than inline at a call site.
 */
export function availableBlocks(): BlockToolName[] {
  return [...BLOCK_TOOL_NAMES];
}

/** The turn's block toolset under structural rule 1a: a pure grading turn withholds every block
 *  except open_source (navigation is not staging work) — two live probes showed prompt wording
 *  alone does not stop the model staging a block over its own next-step offer. Exported for tests. */
export function turnBlockTools(gradingOnly: boolean, patterns: string[] = []): LoopTool[] {
  if (!gradingOnly) return blockTools(patterns);
  const keep = new Set(['open_source', 'speak', 'offer_write']); // navigation, not staging work
  return blockTools(patterns).filter((t) => keep.has(t.name));
}

/** Frontend tools: no execute — the loop pauses on them (runLoop's external-tool halt); the
 *  browser supplies output via addToolOutput and the resubmit carries it back. */
export function blockTools(patterns: string[] = []): LoopTool[] {
  // code_exercise's `pattern` is an id from a RUNTIME list, not free text. Without the list in the
  // description a tutor asked for "something to DO" staged a whole prose paragraph as the pattern
  // and the block hung at input-available forever (observed on a PyTorch vault). Advertise what
  // exists — and when nothing does, say so, so the tutor reaches for another instrument instead of
  // inventing an id.
  // Ids alone were not enough: offered `stream-consumer, pytorch-bytes-to-hex-array,
  // pytorch-construct-name`, a tutor asked for "a coding exercise from the pytorch repo" staged
  // stream-consumer — the built-in SSE demo. The list has to say what each id IS so the choice can
  // be about the subject rather than the order they happen to appear in.
  const codeExerciseHelp = patterns.length > 0
    ? `Present a code_exercise block to the student and wait for their work. \`pattern\` MUST be one `
      + `of these exact ids — do not invent one, and do not put a task description here. Pick the `
      + `one whose subject matches what the student is learning:\n`
      + patterns.map((p) => `  - ${p}`).join('\n')
      // Every pattern is pre-authored, so a freshly compiled topic usually has none that fits. Told
      // only to "pick the closest", a model picks one regardless: a learner who asked for practice
      // on Python class-vs-instance variables was handed a stream-consumer exercise, which teaches
      // the wrong thing while LOOKING like the right kind of work. A near-miss is worse than a
      // different instrument, because the grade it mints attaches to the page the student asked
      // about.
      + '\nIf NONE of these is genuinely about the student\'s current subject, do not force-fit one — '
      + 'say the vault has no coding exercise for this topic yet and use a different instrument '
      + '(structured_check, math_scratchpad, writing_draft) instead.'
    : 'Present a code_exercise block to the student and wait for their work. NONE AVAILABLE right '
      + 'now: no exercises exist in this vault, so do not call this tool — use another instrument '
      + '(writing_draft, structured_check, math_scratchpad) or generate_exercise in freeform.';
  const blocks = availableBlocks().map((name) => zodTool(name, {
    description: name === 'code_exercise'
      ? codeExerciseHelp
      : `Present a ${name} block to the student and wait for their work.`,
    input: BLOCK_TOOLS[name].input as z.ZodTypeAny,
  }));
  // UI tools ride the same frontend transport but are navigation, not graded work — the client
  // resolves and answers them itself (src/shared/uiTools.ts; grading never sees them because
  // pendingBlockOutputs filters on BLOCK_TOOL_NAMES).
  blocks.push(zodTool('open_source', {
    description: 'Open an ingested source (book chapter, paper, notes) in the reading surface '
      + 'beside the conversation — BRING the student to the artifact instead of describing it. '
      + 'Pass the source title as the Library shows it. Then direct their reading and probe on it.',
    input: UI_TOOLS.open_source.input as z.ZodTypeAny,
  }));
  blocks.push(zodTool('offer_write', {
    description: 'Offer the learner a one-click "write this up" button. Use ONLY in a teaching '
      + 'mode (learn/review/quiz) when you have taught something worth keeping but cannot write '
      + 'it yourself — instead of telling them to switch to freeform, call this so one click '
      + 'saves it. Pass `title` (the page name) and an optional `why`. Do not call it in freeform '
      + '(you can just write there) or for something already covered by a solid page.',
    input: UI_TOOLS.offer_write.input as z.ZodTypeAny,
  }));
  blocks.push(zodTool('speak', {
    description: 'Attach a "hear this" button to a word or short phrase, spoken aloud by the '
      + "browser's speech engine. Use for pronunciation in ANY language the learner is studying — "
      + 'essential for tone languages (Vietnamese, Mandarin, Thai) where the text alone cannot '
      + 'convey the sound. Pass `text`, a BCP-47 `lang` (e.g. "vi", "zh-CN"), and an optional '
      + '`gloss`. The client reports whether a voice was available; if not, teach from the tone '
      + 'map and point the learner to a native recording.',
    input: UI_TOOLS.speak.input as z.ZodTypeAny,
  }));
  return blocks;
}

/** Words that carry no topic, so a page whose body happens to contain them is not evidence that
 *  the vault covers what the student just asked about. Engram's `search` scores +1 per body
 *  token, so without this every page in the vault matches "what is the derivative of x" via
 *  "what"/"is"/"the" and the coverage test below would always say "covered". */
const STOPWORDS = new Set([
  'the', 'and', 'but', 'for', 'are', 'was', 'were', 'can', 'you', 'your', 'his', 'her', 'its',
  'this', 'that', 'these', 'those', 'what', 'why', 'how', 'who', 'when', 'where', 'which',
  'does', 'did', 'has', 'have', 'had', 'not', 'with', 'from', 'about', 'into', 'than', 'then',
  'them', 'they', 'there', 'here', 'some', 'any', 'all', 'more', 'most', 'much', 'many',
  'explain', 'tell', 'teach', 'show', 'help', 'want', 'like', 'know', 'learn', 'understand',
  'please', 'thanks', 'okay', 'yes', 'sure', 'next', 'again', 'let', 'lets', 'get', 'got',
]);

/** A hit at this score means a TITLE or tag matched, or three separate content words did — either
 *  way the vault has something genuinely on-topic. Body-only coincidences score below it. */
const COVERED_SCORE = 3;

/** The topic words in a student message: long enough to mean something, not a stopword. */
export function topicTokens(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/))]
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    return (messages[i].parts as any[])
      .filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
  }
  return '';
}

/** A page this short is a placeholder, whatever its frontmatter claims. Engram's own auto-stub
 *  body is one sentence; a real page that teaches something is not 400 characters long. */
const THIN_BODY_CHARS = 400;

/** Why the tutor is allowed to research this turn. Each kind is a different KIND of gap, and the
 *  tutor is told which — "there is no page" and "the page is guesswork" call for different work. */
export type GapReason =
  | 'empty-vault'      // nothing in the vault at all
  | 'no-page'          // pages exist, none on this topic
  | 'stub'             // the on-topic page is a stub (usually auto-created from a dangling link)
  | 'unsourced'        // the page exists but cites nothing — written from model memory
  | 'thin'             // the page exists and says almost nothing
  | 'freeform';        // not a gap: freeform mode researches by design

export interface VaultGap { reason: GapReason; slug?: string; detail: string }

interface GapDeps {
  search: (query: string) => Promise<{ slug: string; score: number; status?: string }[]>;
  /** Only called for the single best-matching page, so this costs one file read per turn. */
  readPage: (slug: string) => Promise<{ meta: { sources?: string[]; status?: string }; body: string }>;
}

/**
 * Where the tutor's memory falls short of what the student just asked — and therefore when it may
 * go and research.
 *
 * Freeform: always, as before. That is where a subject gets researched, sourced and compiled.
 *
 * Teaching modes (`learn`/`review`/`quiz`): whenever there is a real GAP. That word is doing work.
 * The first version of this only unlocked when the vault had no page at all, which missed the more
 * common and more damaging case — a page that EXISTS but is not worth being grounded in:
 *
 *   * a `stub`, which Engram creates automatically for any prereq nobody has written yet, so
 *     "the vault has a page on it" can mean "the vault has a sentence saying it should have one";
 *   * a page with an empty `sources` list, which is the vault's own record that it was written from
 *     model memory and never verified — exactly the thing research exists to fix;
 *   * a page too short to teach from.
 *
 * In all three the tutor previously had to either teach from a placeholder or improvise, with no way
 * to go and find out. Now it researches and says which of the three it hit.
 *
 * Still deliberately narrow. A solid, sourced, substantial page wins over any search result, because
 * a page carries the student's own evidence and edges and a search result carries neither. Writing
 * stays freeform-only, so the single-writer rule is untouched.
 *
 * Failures fail CLOSED: if the vault cannot be read we do not know whether it covers the topic, and
 * staying grounded is the safer of the two wrong answers.
 */
export async function vaultGap(
  mode: Mode,
  messages: UIMessage[],
  slugs: string[],
  deps: GapDeps,
): Promise<VaultGap | null> {
  if (mode === 'freeform') return { reason: 'freeform', detail: 'freeform mode researches by design' };
  if (slugs.length === 0) {
    return { reason: 'empty-vault', detail: 'the vault has no pages at all' };
  }

  const tokens = topicTokens(lastUserText(messages));
  // "ok", "next", "go on" — the student is continuing, not naming a subject. Continuing a lesson the
  // vault already holds is precisely the case that should stay grounded.
  if (tokens.length === 0) return null;

  try {
    const hits = await deps.search(tokens.join(' '));
    const best = hits.find((h) => h.score >= COVERED_SCORE);
    if (!best) {
      return { reason: 'no-page', detail: 'no page covers what the student just asked about' };
    }

    // There IS an on-topic page. Whether it is worth teaching from is a different question.
    const page = await deps.readPage(best.slug);
    const status = page.meta?.status ?? best.status;
    const sources = page.meta?.sources ?? [];
    const body = (page.body ?? '').trim();

    if (status === 'stub') {
      return { reason: 'stub', slug: best.slug, detail: `“${best.slug}” is only a stub` };
    }
    if (sources.length === 0) {
      return {
        reason: 'unsourced',
        slug: best.slug,
        detail: `“${best.slug}” cites no sources — it was written from memory, not checked`,
      };
    }
    if (body.length < THIN_BODY_CHARS) {
      return {
        reason: 'thin',
        slug: best.slug,
        detail: `“${best.slug}” is too thin to teach from (${body.length} characters)`,
      };
    }
    return null; // a real page on the topic. Teach from it.
  } catch {
    return null;
  }
}

/**
 * The course bank's session tools — available in EVERY mode, because drilling a banked problem is
 * a teaching activity, not a vault-writing one. The contract they serve (courseBank.ts): banked
 * problems are drilled VERBATIM, so course_problems hands the tutor the exact text plus a stable
 * id, and mark_course_problem is how a correct answer reaches the bank's spacing.
 */
export function buildCourseTools(vault: string): LoopTool[] {
  return [
    zodTool('course_problems', {
      description: 'The next banked course problems (past exams, problem sets) worth drilling — '
        + 'never-answered first, then correct-longest-ago. Each comes with a stable id and its '
        + 'VERBATIM text: present that text word for word as the prompt of a quick_check or '
        + 'structured_check; never paraphrase it.',
      input: z.object({
        k: z.number().int().min(1).max(5).optional().describe('how many problems (default 5)'),
      }),
      execute: async ({ k }) => {
        const problems = nextProblems(vault, k ?? 5);
        return problems.length
          ? {
            problems: problems.map((p) => ({
              id: p.id, source: p.source, n: p.n, text: p.text,
              ...(p.answer ? { answer: p.answer } : {}),
              ...(p.lastCorrect ? { lastCorrect: p.lastCorrect } : {}),
            })),
          }
          : { problems: [], note: 'the course bank is empty — no problem set or past exam has been added' };
      },
    }),
    zodTool('mark_course_problem', {
      description: 'Record that the learner just answered a banked course problem correctly in a '
        + 'graded block — spacing uses it to stop re-asking. Call it alongside record_evidence, '
        + 'never for an answer that was not graded correct.',
      input: z.object({
        id: z.string().describe('the problem id from course_problems, e.g. "midterm-2#3"'),
      }),
      execute: async ({ id }) => (markCorrect(vault, id)
        ? { marked: id }
        : { error: `no banked problem with id "${id}"` }),
    }),
  ];
}

/**
 * Frontier research: "what is the newest work on X" answered by LOOKING — arXiv + Crossref,
 * sorted by recency — never from training memory, whose cutoff is exactly what the question is
 * about. Every mode gets it: asking about the frontier is a reading activity, not a vault write.
 * `fetchImpl` injected for tests.
 */
export function buildFrontierTools(
  vault?: string, fetchImpl: typeof fetch = fetch,
  // yt-dlp seams, injected by tests so no suite ever needs the binary or a network.
  video: { search?: typeof searchVideos; transcript?: typeof fetchVideoTranscript } = {},
): LoopTool[] {
  return [
    zodTool('find_recent_papers', {
      description: 'Search the live literature indices (arXiv preprints + Crossref published '
        + 'work) for the NEWEST papers on a topic, sorted by date. Use this whenever the student '
        + 'asks what is new, recent, state-of-the-art, or frontier in any field — your training '
        + 'knowledge has a cutoff and this tool does not. Present results with their dates and '
        + 'offer to ingest any of them (ingest_url with the pdfUrl) as course pages.',
      input: z.object({
        topic: z.string().describe('the research topic, e.g. "KV cache compression"'),
      }),
      execute: async ({ topic }) => {
        try {
          const { papers, sourceErrors } = await findRecentPapers(topic, fetchImpl);
          return {
            papers,
            ...(sourceErrors.length ? { note: `partial results — ${sourceErrors.join('; ')}` } : {}),
          };
        } catch (e: any) {
          return { error: `could not reach the literature indices: ${e?.message ?? e}` };
        }
      },
    }),
    zodTool('paper_references', {
      description: 'The references of an INGESTED paper or book chapter, parsed from the source '
        + 'itself — citation chasing. Use when the student wants to go deeper than the current '
        + 'paper: present the actionable ones (those with a url) as next reads and offer '
        + 'ingest_url (pdfUrl when present, else url). Entries without an id are listed for '
        + 'manual searching — say so.',
      input: z.object({
        title: z.string().describe('the source title as the Library shows it'),
      }),
      execute: async ({ title }) => {
        if (!vault) return { error: 'no vault configured for reference lookup' };
        const want = title.trim().toLowerCase();
        const entry = readQueue(vault).find((e) => e.chapter?.startsWith('raw/')
          && (e.title?.toLowerCase().includes(want) || e.book?.toLowerCase().includes(want)));
        if (!entry) return { error: `no ingested source matches "${title}"` };
        try {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const refs = extractReferences(readFileSync(join(vault, entry.chapter), 'utf8'));
          return refs.length
            ? { source: entry.title, references: refs }
            : { source: entry.title, references: [], note: 'no references section found in this source' };
        } catch (e: any) {
          return { error: `could not read the source: ${e?.message ?? e}` };
        }
      },
    }),
    zodTool('find_canonical_sources', {
      description: 'The LOAD-BEARING literature of a field: Crossref sorted by citation count — '
        + 'who to read first, not what is newest. Use it when a student is STARTING a subject, so '
        + 'you can route them to the canonical human artifacts (and name the researchers behind '
        + 'them) rather than teaching from your own memory. Offer to ingest the best ones.',
      input: z.object({
        topic: z.string().describe('the field or topic, e.g. "spaced repetition learning"'),
      }),
      execute: async ({ topic }) => {
        try {
          return await findCanonicalPapers(topic);
        } catch (e: any) {
          return { error: `could not reach the literature index: ${e?.message ?? e}` };
        }
      },
    }),
    zodTool('find_video', {
      description: 'Search YouTube for teaching videos on a topic (yt-dlp, no API key). Returns '
        + 'title, url, channel, durationSeconds, views. Prefer a short well-viewed explainer over '
        + 'a long lecture unless the student asked for depth. Then call video_transcript on your '
        + 'pick to find the EXACT passage, and assign it with a watch_video block '
        + '(startSeconds/endSeconds) — never make the student scrub a 40-minute video for a '
        + '3-minute idea.',
      input: z.object({
        query: z.string().describe('what to search for, e.g. "quadratic formula derivation"'),
        limit: z.number().int().min(1).max(10).optional().describe('results to return (default 5)'),
      }),
      execute: async ({ query, limit }) => {
        try {
          return { videos: await (video.search ?? searchVideos)(query, limit ?? 5) };
        } catch (e: any) {
          return { error: `video search failed: ${e?.message ?? e}` };
        }
      },
    }),
    zodTool('video_transcript', {
      description: "A YouTube video's own captions as a timestamped transcript ([M:SS] marks), no "
        + 'download. Use it BEFORE assigning watch_video: find where the topic is actually '
        + 'covered, convert the [M:SS] you picked to seconds, and pass startSeconds/endSeconds so '
        + 'the assignment is the snippet, not the whole video. Works for any YouTube URL, '
        + 'ingested or not.',
      input: z.object({
        url: z.string().describe('the YouTube URL from find_video or the student'),
      }),
      execute: async ({ url }) => {
        try {
          const { title, markdown } = await (video.transcript ?? fetchVideoTranscript)(url);
          // A long lecture's transcript can be book-sized; cap what enters the turn and say so —
          // the tutor can still deep-link anywhere the kept range covers.
          const capped = markdown.length > 16_000;
          return {
            title,
            transcript: capped ? markdown.slice(0, 16_000) : markdown,
            ...(capped ? { note: 'transcript truncated at 16k characters — the tail is not shown' } : {}),
          };
        } catch (e: any) {
          return { error: `could not fetch the transcript: ${e?.message ?? e}` };
        }
      },
    }),
  ];
}

export function createTutorSession(
  lw: Engram, cfg: HarnessConfig,
  opts: { model?: ChatModel; now?: () => Date } = {},
) {
  const model = opts.model ?? chatModelFor('tutor', cfg);
  // Which model id the WEB TOOLS should assume — deliberately not the same question as `model`
  // above. A provider-executed search tool is a request-shape feature of Anthropic's API, so it
  // only means anything on a real Anthropic route; an injected model (tests) or the scripted e2e
  // model would carry the declaration to a provider that has never heard of it. `undefined` here
  // makes buildWebTools fall back to SearXNG-or-nothing, which is the honest answer for those.
  const searchModelId = opts.model || process.env.LW_MOCK_MODEL
    ? undefined : cfg.models?.tutor?.model;

  async function bootstrap(mode: Mode, slugs: string[]): Promise<string> {
    const activeGoal = readGoal(cfg.vault);
    const [state, lessonsRes] = await Promise.all([
      lw.call('get_student_state', { student: cfg.student }),
      // A page-kind goal narrows next_lessons to the prerequisite walk toward it (queries.ts's
      // unmetPrereqs) instead of the whole-vault frontier. Guarded: next_lessons errors on a goal
      // that is not a real page, and a stale goal must not break the session — fall back to the
      // unscoped call and let the goal line still report itself.
      (async () => {
        if (activeGoal?.kind === 'page') {
          try { return await lw.call('next_lessons', { student: cfg.student, goal: activeGoal.slug }); }
          catch (e) { console.error('[goal] next_lessons rejected goal', activeGoal.slug, e); }
        }
        return lw.call('next_lessons', { student: cfg.student });
      })(),
    ]);
    const lessons = lessonsRes.lessons ?? [];
    // Path-kind goals get their progress folded in so the tutor can resume at the right step.
    let goalCtx = activeGoal as any;
    if (activeGoal?.kind === 'path') {
      try {
        const doc = await lw.call('read_path', { slug: activeGoal.slug });
        // pathProgress already carries the path's title, so it must not be set separately here.
        goalCtx = { ...activeGoal, ...pathProgress(doc, state) };
      } catch (e) {
        console.error('[goal] read_path failed for goal', activeGoal.slug, e);
      }
    }
    const ctx = buildBootstrapContext({
      voice: cfg.voice,
      mode, state,
      lessons,
      reviewsDue: lessons.filter((l: any) => l.reason === 'review-due').map((l: any) => l.slug),
      ankiLapses: recentLapses(cfg.vault),
      goal: goalCtx,
      emptyVault: slugs.length === 0,
      courseBank: readBank(cfg.vault),
    });
    // Ground the model in the REAL page ids — small models otherwise invent slugs like
    // "derivatives-introduction" and every downstream slug-taking call fails. Capped at scale:
    // see slugListLine.
    const relevant = [
      ...lessons.map((l: any) => l.slug),
      ...(goalCtx?.pages ?? []),
      ...readBank(cfg.vault).map((p) => `course-${p.source}`),
    ];
    return `${ctx}\n${slugListLine(slugs, relevant)}`;
  }

  // Block/tool names a protocol-failing model writes as literal `name:` prose lines. Anchored to
  // a line start (optionally behind markdown heading marks, which the 7B run produced) so a
  // sentence that merely discusses "a quick_check" never matches.
  const PSEUDO_BLOCK_RE = /(^|\n)[ \t]*(?:#{1,6}[ \t]+)?(?:quick_check|write_page|record_evidence|quiz|code_exercise|structured_check|math_scratchpad|label_diagram)[ \t]*:/;

  function turnError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[turn-error]', msg);
    return `The tutor hit an error and this turn was lost: ${msg.slice(0, 200)}`;
  }

  // Which mode each thread's LAST turn ran in. Session context is first-turn-only, so a mid-thread
  // mode switch left the tutor acting on the context of the mode the learner left (a decay sitting
  // watched "review" answered from a history where nothing was due). In-memory on purpose:
  // post-restart the map is empty and no re-injection happens — pre-existing behavior, not a new
  // failure.
  const lastModeByThread = new Map<string, Mode>();

  // The rails branch shares this session's model so injected fakes (tests) and the scripted e2e
  // model drive rails turns exactly as they drive agentic ones.
  const rails = createRailsSession(lw, cfg, { model });

  async function respond(
    messages: UIMessage[], mode: Mode, threadId = 'default', signal?: AbortSignal,
  ): Promise<Response> {
    // Rails mode (docs/superpowers/specs/2026-07-30-rails-mode.md): teaching modes hand the loop
    // to the harness when the flag is set — read per turn so the models-dialog toggle is live.
    // Freeform always runs the full agentic loop (writing pages needs real tool use), which also
    // keeps chatRoute's one-shot writeUp promotion agentic.
    if (cfg.models?.tutor?.rails && mode !== 'freeform') return rails.respond(messages, mode, threadId, signal);

    const pending = pendingBlockOutputs(messages);
    // A PURE grading turn is the client's auto-resubmit: the history still ENDS on the answered
    // block, no new words. A stranded block swept from earlier history (its grading continuation
    // was aborted) arrives ALONGSIDE a fresh user message — the stale grade lands, but the new
    // words deserve a full turn: block tools available, vaultGap consulted, mode switch honored.
    const resubmitPending = pending.length > 0 && messages[messages.length - 1]?.role === 'assistant';
    const userTurn = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });

    // Everything slow (grading, bootstrap, model turns) runs INSIDE the stream's execute so the
    // HTTP response starts immediately — the client flips to "running" and can show a working
    // indicator during grading instead of a dead pause.
    return createUiStream({
      // Continuation, not a new sibling message: when this response is a resubmit whose incoming
      // history already ends in an assistant message (the block output that triggered the
      // resubmit), createUiStream puts THAT message's id on the outgoing 'start' chunk. The client
      // (ai@7's AbstractChat.makeRequest) seeds its streaming state from a snapshot of that same
      // last message and only REPLACES it in place when the ids match — without this, the ids
      // mismatch (a fresh one vs the snapshot's), the client falls back to pushing the
      // snapshot-plus-new-content as an extra sibling message, and the turn-1 content (e.g.
      // "Let's warm up.") ends up rendered twice.
      originalMessages: messages,
      // Server-side turn persistence (the disconnect fix): the client's own PUT only happens when
      // ITS stream finishes, so a disconnect mid-answer lost the assistant turn the server had
      // completed. createUiStream mints response ids in the same format the client does, so this
      // save and the client's PUT converge in saveThread's union-by-id.
      onEnd: ({ messages: finalMessages }) => {
        try {
          saveThread(cfg.vault, threadId, finalMessages as unknown[]);
        } catch (e) {
          console.error('[server-side thread save]', e);
        }
      },
      // Surface failures to the learner ("degrade loudly") — and to journalctl. A model throw
      // mid-run propagates out of execute and lands here as an error chunk on the open stream.
      // Client disconnect propagation (T1): the request's own signal feeds the stream, and the
      // stream's combined signal (below) feeds the loop, so an abandoned turn stops the provider
      // request instead of streaming tokens nobody will see.
      signal,
      onError: turnError,
      execute: async (writer, runSignal) => {
        // 1. Grade fresh block outputs BEFORE the model sees them.
        const grades: Awaited<ReturnType<typeof gradeBlockOutput>>[] = [];
        for (const p of pending) {
          // A grader that throws must never take the TURN down with it. One malformed checker arg
          // (a boolean `expected` reaching a string normaliser) threw here, the exception escaped
          // to the turn handler, and the learner got a completely empty reply to "ok next" — no
          // text, no block, no error, nothing to retry. The grade is the recoverable part: a
          // 'reviewed' verdict lets the turn continue and the tutor respond to the work, while the
          // real cause goes to the log where it can be fixed.
          let grading: Awaited<ReturnType<typeof gradeBlockOutput>>;
          try {
            grading = await gradeBlockOutput(p.tool, p.input, p.output, cfg);
          } catch (e) {
            const why = (e as Error)?.message ?? String(e);
            console.error(`[grade-error] ${p.tool}: ${why}`);
            grading = {
              verdict: 'reviewed',
              source: 'model',
              detail: `grading failed (${why}) — judge the student's work yourself and say so plainly`,
              evidence: [],
            };
          }
          p.output.grading = grading; // model sees student work + machine grade together
          grades.push(grading);
        }

        const slugs = await lw.listSlugs();
        const mcpTools = guardMcpTools(
          await lw.tools(), cfg.student, slugs, grades.flatMap((g) => g.evidence), cfg.vault,
        );
        // Research rides with the vault-writing tools in freeform, and unlocks in teaching modes
        // wherever the vault has a GAP — no page, a stub, an unsourced page, a page too thin to
        // teach from. See vaultGap above for why each of those counts.
        //
        // NOT on a grade turn: vaultGap keys off the last USER text, which on a block submission is
        // the already-answered message that staged the block — re-running it re-issues the same
        // research directive over the graded card, so the tutor re-researches and re-teaches the
        // whole topic instead of landing the grade.
        const gap = resubmitPending ? null : await vaultGap(mode, messages, slugs, {
          search: (query) => lw.call('search', { query }) as Promise<any>,
          readPage: async (slug) => (await lw.call('read_page', { slug })).page,
        });
        // A researched topic must be able to LAND. Teaching modes used to research a gap and then
        // hold no way to keep what they found: the tutor taught it, the harness demanded
        // record_evidence for the grade, and the guard refused the slug because no such page
        // existed — so a learner who answered correctly was told "evidence not recorded" and the
        // work evaporated. write_page unlocks on exactly the gaps that opened research, so the page
        // the tutor just grounded in real sources becomes the page the evidence attaches to.
        // The single-writer rule is untouched: write_page IS Engram's tool, so Engram still does
        // every write.
        const canWrite = mode === 'freeform' || gap !== null;
        const activeMcp = mcpTools.filter((t) => mode === 'freeform'
          || TEACH_TOOLS.includes(t.name)
          || (canWrite && t.name === 'write_page'));

        const webTools = gap ? buildWebTools(cfg, searchModelId) : { tools: [], serverTools: [] };
        const hasWebSearch = [...webTools.tools, ...webTools.serverTools].some((t) => t.name === 'web_search');
        // ingest_paper needs cfg (to queue) AND lw (to kick a background compile) — same
        // freeform-only gate as webTools: a subject gets researched, sourced, and compiled in
        // freeform; teaching modes stay grounded in the vault.
        const ingestTools = mode === 'freeform' ? buildIngestTools(lw, cfg) : [];
        // Freeform-only, like every other content-creating tool: the tutor can commission a NEW
        // coding exercise when a learner wants practice no ladder covers. The result is pending
        // review — the tutor must say so, not promise the exercise for this session.
        const generateTool: LoopTool[] = mode !== 'freeform' ? [] : [
          zodTool('generate_exercise', {
            description: 'Author a new coding exercise — for subjects where CODE IS THE SKILL: '
              + 'programming itself, or a domain the student chose to practice through code (data '
              + 'analysis, scripting, infra). Non-coding subjects take their own applied routes '
              + '(structured_check, math_scratchpad, label_diagram) — do not code-ify them uninvited. '
              + 'Family "function" (the default): one plain function, JSON args in, JSON value out, '
              + 'graded by deep comparison. '
              + 'Family "manifest": the student writes a YAML manifest from an exam-style task '
              + '(Kubernetes/CKA prep, CI configs, any YAML-configured system), graded by '
              + 'mechanical assertions over the parsed document. '
              + 'Family "exec": the student writes a WHOLE PROGRAM in a named runtime (python3, '
              + 'bash, ruby, node, sqlite, ...), judged per test case on stdin/argv in and exact '
              + 'stdout out — use it for algorithm practice, CLI tools, text processing, and any '
              + 'language the student wants that their machine has. The sqlite runtime judges SQL: '
              + 'each case is a schema+data fixture and the expected rows of the student\'s query. '
              + 'Family "stream": async-generator-over-byte-chunks (SSE, NDJSON, line protocols, '
              + 'framing). The result is verified mechanically and stored PENDING REVIEW — tell the '
              + 'student it is waiting in the Library\'s Practice section for their approval, and do '
              + 'not promise it mid-conversation.',
            input: z.object({
              pattern: z.string().describe('kebab-case pattern id, e.g. dilution-calculator'),
              description: z.string().describe('what the exercise should teach, 1-3 sentences'),
              family: z.enum(['function', 'manifest', 'exec', 'stream']).optional()
                .describe('function (default) for any-domain computations; manifest for YAML-writing tasks (e.g. Kubernetes); exec for whole programs in a chosen language; stream only for byte-stream parsing'),
              runtime: z.enum(['python3', 'bash', 'ruby', 'node', 'typescript', 'sqlite', 'c', 'rust', 'cuda', 'go', 'java']).optional()
                .describe('exec family only: which runtime the program targets. node and typescript always work (the app itself runs them); python3/bash/ruby need a local install; sqlite needs the sqlite3 shell and judges SQL against an in-memory database; c needs cc, rust needs rustc; go and java run in Docker containers and need Docker running with the image pulled. Generation fails loudly with the exact fix when something is missing.'),
              environment: z.enum(['redis', 'postgres']).optional()
                .describe('exec family only: a real service composed up fresh for every suite run — the program gets its connection string via REDIS_URL / DATABASE_URL. Needs Docker with the compose plugin and the image pulled; generation fails loudly with the exact fix when it is missing. Use for exercises about caching, queues, SQL — anything worth practicing against the real thing.'),
            }),
            execute: async ({ pattern, description, family, runtime, environment }) => {
              const slug = pattern.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
              if (builtinPatterns(cfg.vault).includes(slug) || listGenerated(cfg.vault).some((e) => e.pattern === slug)) {
                return { error: `an exercise for "${slug}" already exists` };
              }
              try {
                const ex = await generateExercise(cfg.vault, slug, description, {
                  generate: compileGenerate(cfg), modelName: cfg.models.compile.model,
                }, family ?? 'function', runtime, environment);
                return {
                  pattern: ex.pattern, status: ex.status,
                  gates: ex.verification.gates.map((g) => `${g.ok ? 'PASS' : 'FAIL'} ${g.gate}`),
                  note: ex.status === 'pending'
                    ? 'verified mechanically; waiting in the Library tab\'s Practice section for the student to approve it'
                    : 'rejected by the verification gates — do not retry with the same content',
                };
              } catch (e: any) {
                return { error: e?.message ?? String(e) };
              }
            },
          }),
        ];

        // STRUCTURAL "let a win land" (rule 1a): in a pure grading turn — block outputs arriving,
        // no new words from the student — the block tools are WITHHELD, not just discouraged. Two
        // live probes showed the model asks the right next-step question and then stages a block
        // over it anyway; wording was tried twice and did not hold. With the tools absent the
        // offer is the only possible ending, and the student's "yes" is a real user turn where
        // the tools return. open_source stays available: navigation is not staging work.
        const gradingOnly = resubmitPending;
        const system = `${buildInstructions()}\nThe student's id is "${cfg.student}" — always pass exactly this as the \`student\` argument.`
          + (gradingOnly
            ? '\nTHIS TURN: the block tools are withheld — it is a grading turn. Deliver the grade, record evidence, and END on your offer of the next step; the student will answer.'
            : '');
        const tools: LoopTool[] = [
          ...activeMcp, ...buildCourseTools(cfg.vault), ...buildFrontierTools(cfg.vault),
          ...webTools.tools, ...ingestTools, ...generateTool,
          // Read per turn, not per boot: an exercise mined or generated mid-session becomes
          // stageable in the very next turn.
          ...turnBlockTools(gradingOnly, patternChoices(cfg.vault)),
        ];

        const isFirstTurn = messages.filter((m) => m.role === 'assistant').length === 0;
        // A mode switch mid-thread re-arms the context injection (see lastModeByThread above).
        // Block submissions are excluded: they arrive under the mode that staged the block, and a
        // grade turn must stay a grade turn.
        const prevMode = lastModeByThread.get(threadId);
        const modeSwitched = !isFirstTurn && !resubmitPending && prevMode !== undefined && prevMode !== mode;
        lastModeByThread.set(threadId, mode);
        // Context placement is a caching decision as much as a prompting one. The transcript's
        // prefix (system + history) is what the anthropic adapter's cache breakpoints reuse turn
        // to turn, so per-turn HARNESS notes must sit at the TAIL — a message prepended before
        // the history shifts every byte of it and forces a full input re-read this turn AND next
        // (when the prepend disappears again). Only the first turn's bootstrap leads, where it is
        // the natural head of a brand-new transcript.
        const leading: ChatMessage[] = [];
        const trailing: ChatMessage[] = [];
        if (isFirstTurn) leading.push(userTurn(await bootstrap(mode, slugs)));
        else if (modeSwitched) trailing.push(userTurn(
          `HARNESS: the student just switched the tutor mode to ${mode.toUpperCase()}. `
          + 'Fresh session context follows — trust it over anything earlier in this conversation '
          + '(mastery and due reviews may have changed since the conversation started).\n\n'
          + await bootstrap(mode, slugs),
        ));
        // The thread's stance (/beginner|/intermediate|/advanced — stanceStore.ts) rides EVERY
        // turn while set, as a tail note under the same Tier-2 cache-prefix rule as the notes
        // below: after the history, so the cached prefix stays byte-stable. It leads the other
        // tail notes because it frames HOW the work they direct (research, grading) should read.
        const stance = readStance(cfg.vault, threadId);
        if (stance) trailing.push(userTurn(
          `HARNESS STANCE (persists for this thread): teach at ${stance} level — `
          + `${STANCE_INSTRUCTIONS[stance]}. Research accordingly.`,
        ));
        // The unlock is decided per turn, so it can happen mid-conversation — after the bootstrap
        // has already been sent. Say it here or the tutor holds a tool it was told it does not have.
        // The REASON goes in too: "there is no page" and "the page is unsourced guesswork" call for
        // visibly different work, and the second one should not be taught from as if it were fine.
        if (gap && gap.reason !== 'freeform' && hasWebSearch) trailing.push(userTurn(
          `HARNESS: your memory has a gap here — ${gap.detail}. `
          + 'web_search and read_url are unlocked for this turn. Research it, cite what you read '
          + 'in your answer, and teach from that rather than from '
          + `${gap.slug ? 'the existing page' : 'memory'}. `
          + `write_page is unlocked too: once you have researched it, ${gap.slug ? `rewrite “${gap.slug}”` : 'write the page'} `
          + 'with the sources you actually read in its `sources` frontmatter, BEFORE you record any '
          + 'evidence — evidence attaches to a page, so a topic with no page loses the student\'s '
          + 'work entirely. Write the page first, then grade, then record against that slug.',
        ));
        if (grades.length) trailing.push(userTurn(
          `HARNESS: graded block results attached above: ${grades.map((g) => `${g.verdict} (${g.detail})`).join('; ')}. `
          + `You MUST now call record_evidence for: ${JSON.stringify(grades.flatMap((g) => g.evidence))} — then respond to the student.`,
        ));

        // History diet: blocks graded in EARLIER turns ride as verdict lines, not full payloads
        // (historyDiet.ts). This turn's pending blocks stay full — they are what the model is
        // about to grade-and-discuss, and their payload carries the machine grade merged above.
        const keepIds = new Set(pending.map((p) => p.toolCallId));
        const dieted = dietUiMessages(messages, keepIds);
        const model_messages = [...leading, ...uiMessagesToChatMessages(dieted), ...trailing];
        // The transcript must END on a user turn. A bare slash-command send (a user message whose
        // only part is data-command, which uiMessagesToChatMessages rightly drops) can otherwise
        // leave the assistant's own last message final — and the Anthropic wire reads a trailing
        // assistant message as a prefill to CONTINUE, not a turn to answer.
        if (model_messages[model_messages.length - 1]?.role === 'assistant') {
          model_messages.push(userTurn(
            'HARNESS: the student sent a command with no message text. Acknowledge the change briefly and continue.',
          ));
        }

        // Bug 2 fix: the grading above only mutated the REQUEST's copy of the tool output
        // (p.output.grading, kept so the model sees student work + machine grade together in the
        // prompt below) — the browser never sees that mutation on its own. This is where the
        // `originalMessages` continuation wiring above pays off twice over: because this response
        // continues (replaces in place) the incoming history's last assistant message, ai@7's
        // client-side stream processor seeds its working message state from THAT message — meaning
        // it already contains a part with this toolCallId. So a normal `tool-output-available`
        // chunk finds and patches it directly, same as any other tool result; no custom data part
        // or client-side merge code needed. (A `data-grading` data-part sibling was tried first,
        // merged client-side via onData/setMessages — but it raced the continuation's own
        // replace-in-place write and got clobbered; this doesn't have that problem because it's
        // processed as part of the SAME stream/write sequence.)
        // Only for parts of the message this stream CONTINUES (the resubmit case): the assembler
        // holds no parts from older messages, and writing a swept stranded block's toolCallId
        // throws ("no tool part for toolCallId") and kills the turn. A swept block's grade still
        // lands everywhere durable — the model prompt, record_evidence, and the saved thread (the
        // graded output mutation rides originalMessages into onEnd's save); the card shows it
        // graded on the next thread load.
        const lastMsg = messages[messages.length - 1];
        const continuable = new Set(lastMsg?.role === 'assistant'
          ? (lastMsg.parts as any[]).map((part) => part.toolCallId).filter(Boolean) : []);
        for (const p of pending) {
          if (!continuable.has(p.toolCallId)) continue;
          writer.write({ type: 'tool-output-available', toolCallId: p.toolCallId, output: p.output });
        }
        // Returns the record_evidence tool inputs the model actually emitted this run — the count
        // gates the guardrail below, and the (slug, kind) inside each drives the recording-integrity
        // check after (appliedGradeBypass). Prompt caching is live here: the anthropic adapter
        // places the breakpoints (system tail + last message); scripted/compat models ignore it.
        let loopToolCalls = 0;
        let loopText = '';
        // Which pages this turn actually touched — the provenance the evidence check below needs.
        const touched = { read: [] as string[], staged: [] as string[], written: [] as string[] };
        const run = async (msgs: ChatMessage[]) => {
          const result = await runLoop({
            model, system, messages: msgs, tools, serverTools: webTools.serverTools,
            maxSteps: 24, cache: true, cacheTtl: cfg.cacheTtl, signal: runSignal,
            onEvent: (e) => writer.forward(e),
          });
          // Charged to the CONFIGURED tutor id even when opts.model/LW_MOCK_MODEL injected the
          // model — the role is what the ledger tracks, and the injected cases report zeros anyway.
          recordUsage(cfg.vault, {
            role: 'tutor', model: cfg.models?.tutor?.model ?? 'unknown', usage: result.usage,
          });
          loopToolCalls += result.steps.reduce((n, s) => n + s.toolCalls.length, 0);
          loopText += result.steps.map((s) => s.text).join('\n');
          for (const tc of result.steps.flatMap((s) => s.toolCalls)) {
            const a = (tc.input ?? {}) as { slug?: unknown; pageSlug?: unknown };
            const slug = typeof a.slug === 'string' ? a.slug : undefined;
            const pageSlug = typeof a.pageSlug === 'string' ? a.pageSlug : undefined;
            if (tc.toolName === 'read_page' && slug) touched.read.push(slug);
            else if (tc.toolName === 'write_page' && slug) touched.written.push(slug);
            else if (pageSlug) touched.staged.push(pageSlug);
          }
          return result.steps.flatMap((s) => s.toolCalls)
            .filter((tc) => tc.toolName === 'record_evidence')
            .map((tc) => (tc.input ?? {}) as any);
        };
        const recordedCalls: any[] = await run(model_messages);
        // Gate on evidence, not on grade COUNT: a grade can legitimately carry none (an unavailable
        // code_exercise — see grading.ts), and nagging the tutor to record evidence that does not
        // exist would train it to invent some.
        if (grades.some((g) => g.evidence.length > 0) && recordedCalls.length === 0) {
          // Guardrail: one nudged retry, forwarded into the SAME stream (one start/finish pair).
          const nudged = await run([...model_messages, userTurn(
            'HARNESS GUARDRAIL: you did not call record_evidence for the graded block result. Do it now, then continue.',
          )]);
          recordedCalls.push(...nudged);
          if (nudged.length === 0) {
            logGuardrail(cfg.vault, `unrecorded evidence for ${pending.map((p) => p.tool).join(',')}`);
            writer.write({ type: 'data-guardrail', data: { warning: 'evidence not recorded' }, transient: true });
          }
        }
        // Recording-integrity detection (DETECTION ONLY): capApplied guarantees the machine grade,
        // but record_evidence's kind is the model's own argument. Flag — never block — a turn where
        // the tutor recorded 'applied-correctly' for a page whose machine grade this turn was
        // lesser. Wrapped so a telemetry slip can never break the turn.
        try {
          // A page the turn never read, staged, or wrote has no business gaining mastery. Seen
          // live: an FSDP2 question on a vault with no FSDP page recorded 'exposed' against
          // pytorch-build-command. Detection only — the turn still stands.
          const stray = untouchedSlugEvidence(
            recordedCalls.map((c) => ({ slug: String(c?.slug ?? ''), kind: c?.kind })), touched,
          );
          if (stray.length) {
            logGuardrail(cfg.vault, `record_evidence named pages this turn never read, staged or wrote: ${stray.join(', ')}`);
          }
          const laundered = appliedGradeBypass(
            grades.flatMap((g) => g.evidence),
            recordedCalls.map((c) => ({ slug: String(c?.slug ?? ''), kind: c?.kind })),
          );
          if (laundered.length) {
            logGuardrail(cfg.vault, `record_evidence claimed applied-correctly past the machine grade for: ${laundered.join(', ')}`);
          }
        } catch { /* detection is telemetry; it must never affect the turn */ }

        // A tutor that cannot hold the tool protocol "stages" its work as prose — literal
        // `quick_check:` / `write_page:` lines with ZERO tool calls, observed live from both a 7B
        // and a 14.8B ollama tutor on the same freeform turn a hosted tutor tools through. The
        // learner reads promises of interactive work that never arrives, so say what happened IN
        // the transcript (the data-guardrail channel is telemetry the client never renders). Any
        // real tool call this turn clears the check: a model that tools can also mention a block
        // name in prose legitimately.
        if (loopToolCalls === 0 && PSEUDO_BLOCK_RE.test(loopText)) {
          logGuardrail(cfg.vault, 'tutor emitted block syntax as prose with zero tool calls');
          const noteId = generateMessageId();
          writer.write({ type: 'text-start', id: noteId });
          writer.write({
            type: 'text-delta', id: noteId,
            delta: `\n\n— Myelin: ${cfg.models?.tutor?.model ?? 'this model'} wrote its checks as `
              + 'plain text — no interactive blocks were staged, so nothing in this turn can be '
              + 'answered or graded. Small local models often cannot drive freeform teaching: '
              + 'drills in learn, review, and quiz still work, or point the tutor role at a '
              + 'stronger model (the model badge in the top bar).',
          });
          writer.write({ type: 'text-end', id: noteId });
        }
      },
    });
  }

  return { respond };
}
export type TutorSession = ReturnType<typeof createTutorSession>;
