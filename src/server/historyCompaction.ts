// History compaction, layer 2 (historyDiet.ts is layer 1): bounds the NUMBER of turns the model
// sees, where the diet only bounds what each turn COSTS.
//
// The diet shrinks payloads — a graded block collapses to a verdict line, an old page body to a
// stub — but it never drops a message. Prose accumulates, so a long thread grows without limit
// until the provider refuses it. On a hosted provider that is a 400 the retry logic correctly
// does not retry, and because the next send is bigger than the one that just failed, the thread
// is then bricked: every further message fails identically. On a local runtime it is worse, since
// Ollama truncates silently and the lesson is taught from a prompt with its beginning cut off.
//
// So: once the transcript outgrows its budget, the oldest turns are replaced — IN THE MODEL'S
// VIEW ONLY — by a summary. The saved thread, the client and the grading path keep every word;
// this is applied just before uiMessagesToChatMessages, exactly where the diet is.
//
// THE CACHE CONSTRAINT, which shapes everything here. The prompt cache is a prefix match, so a
// summary that were recomputed each turn would change bytes near the front of the transcript on
// every request and defeat the cache completely — a cure worse than the disease. Instead:
//
//   - Compaction happens in BLOCKS. A block covers a contiguous run of messages and is summarized
//     ONCE, then stored under the vault and replayed verbatim on every later turn.
//   - Blocks are append-only. Block 1's bytes never change when block 2 is added, so the shift is
//     one event per compaction rather than one per turn.
//   - Compaction overshoots deliberately (COMPACT_TO of the budget), so it fires rarely instead of
//     nibbling one turn off the front every request.
//
// Blocks are keyed by the id of the last message they cover. Message ids are stable across saves
// (sessionStore merges by id), so a stored block re-applies to the same messages forever.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from './atomicWrite.js';
import { assertThreadId } from './sessionStore.js';
import { isToolUIPart, getToolName, type UIMessage } from '../shared/uiMessages.js';

/** Tokens of history allowed before compaction fires, when the tutor role declares no
 *  `contextTokens`. Deliberately high enough that an ordinary sitting never trips it — about
 *  fifty turns at observed sizes — and low enough to save a 64k-window model, which is the
 *  common case for a model small enough not to advertise its window in config. */
export const DEFAULT_HISTORY_BUDGET_TOKENS = 48_000;

/** Held back from a declared context window for everything that is NOT history: the tutor's
 *  system prompt and tool schemas (~11k, the figure turnError.ts quotes) plus room to answer. */
const NON_HISTORY_RESERVE_TOKENS = 16_000;

/** After compaction, history must fit in this fraction of the budget. Compacting back to exactly
 *  the budget would put the next turn over it again immediately, and every turn after that would
 *  pay a fresh cache miss. */
const COMPACT_TO = 0.6;

/** Turns always kept verbatim, however tight the budget. The tutor grades and responds to what
 *  the learner just did; summarizing that would break the lesson to save tokens. */
const MIN_KEEP_TURNS = 6;

/** Turns a compaction must be able to remove, or it does not happen at all.
 *
 *  Without this, a thread sitting at the MIN_KEEP_TURNS floor and still over budget compacts
 *  ONE turn on every single request — a fresh summarization call and a fresh cache miss each
 *  time, which is worse than the overflow being prevented. The floor is reachable whenever the
 *  budget is small relative to a turn, so this is a real state, not a theoretical one. Requiring
 *  a worthwhile chunk turns per-turn churn into one event per four turns at the very worst. */
const MIN_COMPACT_TURNS = 4;

/** The average that turns characters into tokens. The harness has no cross-provider tokenizer —
 *  pipeline.ts's budgetChars makes the same 4:1 assumption for the same reason. */
const CHARS_PER_TOKEN = 4;

export interface CompactionBlock {
  /** id of the LAST message this block covers. The stable key: everything from the start of the
   *  transcript through this message is what the summary stands for. */
  throughId: string;
  /** How many messages it replaces — reported to the learner and used by the tests. */
  messages: number;
  summary: string;
  openThreads: string[];
  createdAt: string;
}

const dir = (vault: string) => join(vault, '.harness', 'compaction');

export function readBlocks(vault: string, threadId: string): CompactionBlock[] {
  assertThreadId(threadId);
  const p = join(dir(vault), `${threadId}.json`);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed as CompactionBlock[] : [];
  } catch {
    // A corrupt block file must not brick the thread it was meant to save. Treating it as "no
    // blocks yet" costs one re-summarization; throwing here would fail every turn.
    return [];
  }
}

export function writeBlocks(vault: string, threadId: string, blocks: CompactionBlock[]): void {
  assertThreadId(threadId);
  mkdirSync(dir(vault), { recursive: true });
  atomicWrite(join(dir(vault), `${threadId}.json`), JSON.stringify(blocks));
}

export function clearBlocks(vault: string, threadId: string): void {
  assertThreadId(threadId);
  const p = join(dir(vault), `${threadId}.json`);
  if (existsSync(p)) atomicWrite(p, '[]');
}

/** Characters a message costs on the wire: its text, plus tool inputs and outputs as serialized.
 *  File parts are counted by their data URL, which is what actually rides the request. */
export function messageChars(msg: UIMessage): number {
  let n = 0;
  for (const part of msg.parts as any[]) {
    if (part?.type === 'text') n += String(part.text ?? '').length;
    else if (part?.type === 'reasoning') n += String(part.text ?? '').length;
    else if (part?.type === 'file') n += String(part.url ?? '').length;
    else if (isToolUIPart(part)) {
      n += getToolName(part).length;
      if (part.input !== undefined) n += JSON.stringify(part.input).length;
      if (part.output !== undefined) n += JSON.stringify(part.output).length;
    }
  }
  return n;
}

export function estimateTokens(messages: UIMessage[]): number {
  return Math.ceil(messages.reduce((n, m) => n + messageChars(m), 0) / CHARS_PER_TOKEN);
}

/** History tokens allowed before compaction fires. A declared context window wins; the reserve
 *  comes off it because the window has to hold the system prompt and the answer too. */
export function historyBudgetTokens(contextTokens?: number): number {
  if (!contextTokens) return DEFAULT_HISTORY_BUDGET_TOKENS;
  return Math.max(4_000, contextTokens - NON_HISTORY_RESERVE_TOKENS);
}

/** Index of the first message of each turn. A turn starts at a user message; anything before the
 *  first user message (there is normally nothing) belongs to turn zero. */
export function turnStarts(messages: UIMessage[]): number[] {
  const starts: number[] = [];
  messages.forEach((m, i) => { if (m.role === 'user') starts.push(i); });
  return starts;
}

/**
 * How many messages to compact, or 0 for none.
 *
 * Cuts only at a turn boundary — a turn's assistant reply carries the tool calls whose results
 * live in the same message, and half a turn in the transcript teaches the model a shape that
 * never occurs. Never touches the last MIN_KEEP_TURNS turns, and never the trailing assistant
 * message a resubmit is continuing.
 */
export function planCompaction(
  messages: UIMessage[], budgetTokens: number, alreadyCompacted: number,
): number {
  if (estimateTokens(messages.slice(alreadyCompacted)) <= budgetTokens) return 0;
  const starts = turnStarts(messages);
  // Boundaries we may cut at: a turn start after what is already compacted, leaving at least
  // MIN_KEEP_TURNS turns behind it.
  const cuttable = starts.filter((s, i) => s > alreadyCompacted && i <= starts.length - MIN_KEEP_TURNS);
  // Only cuts that remove a worthwhile chunk — see MIN_COMPACT_TURNS. The nth cuttable boundary
  // removes n turns, so the first acceptable one is at that index.
  const allowed = cuttable.slice(MIN_COMPACT_TURNS - 1);
  if (allowed.length === 0) return 0;
  const target = budgetTokens * COMPACT_TO;
  // The first boundary that brings the remainder under target; failing that, the last one we are
  // allowed to take — an over-budget remainder we cannot legally shrink is still better shrunk as
  // far as the rules permit, and the caller logs that it happened.
  return allowed.find((s) => estimateTokens(messages.slice(s)) <= target)
    ?? allowed[allowed.length - 1]!;
}

const summarySchema = z.object({
  summary: z.string(),
  openThreads: z.array(z.string()),
});
export type HistorySummary = z.infer<typeof summarySchema>;

/** The transcript a summarizer reads: one line per message, tool calls named rather than dumped.
 *  Bounded per message so a pasted wall of text cannot dominate the summarization prompt. */
export function renderForSummary(messages: UIMessage[]): string {
  const LINE_CAP = 600;
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const bits: string[] = [];
    for (const part of msg.parts as any[]) {
      if (part?.type === 'text' && String(part.text ?? '').trim()) {
        bits.push(String(part.text).slice(0, LINE_CAP));
      } else if (isToolUIPart(part)) {
        const name = getToolName(part);
        const verdict = (part.output as any)?.grading?.verdict ?? (part.output as any)?.verdict;
        bits.push(verdict ? `[${name} → ${verdict}]` : `[${name}]`);
      }
    }
    if (bits.length) lines.push(`${msg.role === 'user' ? 'Student' : 'Tutor'}: ${bits.join(' ')}`);
  }
  return lines.join('\n');
}

const SUMMARY_PROMPT = `Summarize this stretch of a tutoring conversation so the tutor can carry on
without the full transcript. Write for the tutor, not the student — it will be shown as background,
never read aloud.

Cover: what subjects were taught, what the student actually did and how it was graded, any
misconception that came up, and where the conversation had got to. Name pages and topics exactly as
the transcript does. Be specific and short — six sentences at most. Do not invent anything that is
not in the transcript below.

openThreads: anything left unfinished — a question asked and not answered, an exercise offered and
not taken, a topic promised for next time. Empty if there is none.

Transcript:
`;

/** Mechanical summary — what a summarizer would have said, minus the judgment. Used when the model
 *  call fails, because a thread being saved from overflow is exactly the wrong moment to throw:
 *  the alternative to a blunt summary is the bricked thread this module exists to prevent. */
export function fallbackSummary(messages: UIMessage[]): HistorySummary {
  const asked: string[] = [];
  const graded: string[] = [];
  for (const msg of messages) {
    for (const part of msg.parts as any[]) {
      if (msg.role === 'user' && part?.type === 'text' && String(part.text ?? '').trim()) {
        asked.push(String(part.text).trim().slice(0, 80));
      } else if (msg.role === 'assistant' && isToolUIPart(part)) {
        const verdict = (part.output as any)?.grading?.verdict;
        const slug = (part.input as any)?.pageSlug;
        if (verdict && slug) graded.push(`${slug} → ${verdict}`);
      }
    }
  }
  const parts = [
    `Earlier turns of this conversation could not be summarized by a model, so this is a mechanical record of them.`,
    asked.length ? `The student asked about: ${[...new Set(asked)].slice(0, 8).join('; ')}.` : '',
    graded.length ? `Graded work: ${[...new Set(graded)].slice(0, 12).join('; ')}.` : '',
    'Read the student state and the pages themselves rather than relying on this summary.',
  ].filter(Boolean);
  return { summary: parts.join(' '), openThreads: [] };
}

export interface CompactionDeps {
  /** Produces the summary. Real callers pass the compile role (historyCompactionSeam.ts); tests
   *  inject. A throw here is caught and the mechanical fallback stands in. */
  summarize: (prompt: string, schema: typeof summarySchema) => Promise<HistorySummary>;
}

/** The synthetic message that stands in for every compacted turn. One message however many blocks
 *  there are, so the transcript shape does not change as a thread ages. */
export function blocksToMessage(blocks: CompactionBlock[]): UIMessage {
  const total = blocks.reduce((n, b) => n + b.messages, 0);
  const body = blocks.map((b) => b.summary).join('\n\n');
  const open = [...new Set(blocks.flatMap((b) => b.openThreads))];
  const text = [
    `[HARNESS: the first ${total} messages of this conversation are summarized below — the full `
    + 'transcript no longer fits the model\'s context window. The student still sees every word; '
    + 'you are reading a precis. Treat the vault and get_student_state as the record of what they '
    + 'know, not this text.]',
    '',
    body,
    ...(open.length ? ['', `Left unfinished: ${open.join('; ')}`] : []),
  ].join('\n');
  // A deterministic id: the assembler and sessionStore both key by id, and this message must
  // never collide with a real one or change identity between turns.
  return { id: `compaction-${blocks[blocks.length - 1]!.throughId}`, role: 'user', parts: [{ type: 'text', text }] };
}

/**
 * The model's view of the thread, with anything over budget replaced by stored summaries.
 *
 * Returns the messages unchanged — same array identity — when nothing needs compacting, which is
 * the overwhelmingly common case and must cost nothing.
 */
export async function compactHistory(opts: {
  vault: string;
  threadId: string;
  messages: UIMessage[];
  budgetTokens: number;
  deps: CompactionDeps;
}): Promise<{ messages: UIMessage[]; compacted: number; newBlock: boolean }> {
  const { vault, threadId, messages, budgetTokens, deps } = opts;
  const blocks = readBlocks(vault, threadId);
  // Where the stored blocks reach in THIS message list. A thread can be deleted and recreated
  // under the same id, so a block whose throughId is absent is stale and everything from it on is
  // dropped rather than trusted.
  let covered = 0;
  const live: CompactionBlock[] = [];
  for (const b of blocks) {
    const at = messages.findIndex((m) => m.id === b.throughId);
    if (at < 0) break;
    covered = at + 1;
    live.push(b);
  }
  const cut = planCompaction(messages, budgetTokens, covered);
  let newBlock = false;
  if (cut > covered) {
    const span = messages.slice(covered, cut);
    let summary: HistorySummary;
    try {
      summary = await deps.summarize(SUMMARY_PROMPT + renderForSummary(span), summarySchema);
    } catch (e) {
      console.error('[compaction] summarizer failed, using the mechanical fallback:',
        e instanceof Error ? e.message : String(e));
      summary = fallbackSummary(span);
    }
    live.push({
      throughId: messages[cut - 1]!.id,
      messages: cut,
      summary: summary.summary,
      openThreads: summary.openThreads,
      createdAt: new Date().toISOString(),
    });
    covered = cut;
    newBlock = true;
    // Written whether or not the summarizer succeeded: a fallback summary stored is a fallback
    // summary that stays byte-stable, which is the property the cache needs. Re-deriving it every
    // turn would be the prefix churn this module exists to avoid.
    try {
      writeBlocks(vault, threadId, live);
    } catch (e) {
      console.error('[compaction] could not persist blocks:', e instanceof Error ? e.message : String(e));
    }
  }
  if (live.length === 0 || covered === 0) return { messages, compacted: 0, newBlock: false };
  return {
    messages: [blocksToMessage(live), ...messages.slice(covered)],
    compacted: covered,
    newBlock,
  };
}
