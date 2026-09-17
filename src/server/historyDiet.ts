// History diet, layer 1 (Tier-2 efficiency): trims what OLD turns cost the model's context
// window. This is the MODEL's view only — the caller applies it just before
// uiMessagesToChatMessages, so persistence, the client, and grading all still see full payloads.
//
// Compacted:
//   - A graded block's own payload (quick_check, writing_draft, code_exercise, …), once it ages
//     out of the current turn's `keepIds`: the submission/diagram/draft collapses to a short
//     verdict line. The latest submitted writing draft is exempt so it can still be revised.
//   - A reading tool's result (read_page, video_transcript, web_search, find_recent_papers,
//     course_problems) once it is older than the last two turns: the page body, transcript, or
//     search hits collapse to a one-line stub naming the tool and what it was asked for
//     (slug/url/query/topic). Nothing later re-derives from that payload once the turn that
//     needed it has passed.
//   - Every user message's file attachments (screenshots, PDFs) except the LAST user message's —
//     earlier ones become a one-line stub naming what was attached.
//
// NOT compacted:
//   - The current turn's own pending/fresh block outputs (keepIds), and any reading-tool result
//     from the last two turns — the model is actively working with that material.
//   - Any tool result outside the reading-tool set above (record_evidence, write_page, …): their
//     outputs are already small, and record_evidence in particular is the audit trail itself.
//   - Ungraded block outputs (e.g. a UI tool ack) — this diet only fires once a MACHINE has
//     graded the block.
//
// Compaction is deterministic, so a part compacts identically on every later turn and the
// transcript prefix stays stable for the prompt cache (one small shift when something first ages
// out, then never again).
import { BLOCK_TOOL_NAMES, type BlockToolName } from '../shared/blocks.js';
import { isToolUIPart, getToolName, type UIMessage, type UIPart } from '../shared/uiMessages.js';

const CAP = 160;

/** Tool results whose payload (a page body, a transcript, a page of search hits) is only useful
 *  to the turns immediately around the call — not something a later turn re-reads from history. */
const READING_TOOLS = new Set([
  'read_page', 'video_transcript', 'web_search', 'find_recent_papers', 'course_problems',
]);

const firstString = (...candidates: unknown[]): string => {
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c;
  return '';
};

const trim = (s: string): string => (s.length > CAP ? `${s.slice(0, CAP)}…` : s);

/** Keep the input's argument SHAPE (a later turn may imitate it) while capping any string
 *  argument's length — the opposite failure of rewriting the shape, which had the model emit
 *  `{compacted:true, prompt}` for tools whose real field is `question`. */
function capInputStrings(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return trim(value);
  if (Array.isArray(value) && depth < 4) return value.map((v) => capInputStrings(v, depth + 1));
  if (value && typeof value === 'object' && depth < 4) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, capInputStrings(v, depth + 1)]));
  }
  return value;
}

/** What a later turn needs to know a reading-tool call happened, without the material it
 *  returned: the tool name plus whichever of slug/url/query/topic it was called with. Some
 *  reading tools (course_problems) take no such argument — the name alone stands. */
function readingStub(name: string, input: unknown): string {
  const a = input as Record<string, unknown> | undefined;
  const arg = firstString(a?.slug, a?.url, a?.query, a?.topic);
  return arg ? `${name}(${arg})` : name;
}

/** UIMessages for the model with old graded block payloads compacted to verdict lines, old
 * reading-tool results compacted to one-line stubs, and old user attachments compacted to
 * one-line stubs (see the header for exactly what qualifies as "old" in each case).
 * Untouched parts are shared by reference; only compacted parts (and their ancestors) are new. */
export function dietUiMessages(messages: UIMessage[], keepIds: Set<string>): UIMessage[] {
  // Attachments are the other payload class that rides every request forever: one screenshot is
  // hundreds of KB of base64. Only the LAST user message keeps its file parts — those are what
  // the model is being asked about this turn; every earlier user message's files become text
  // stubs. Deterministic like the block compaction: a message compacts identically on every
  // later turn (one prefix shift when a newer user message arrives, then stable).
  const lastUserIndex = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);
  // One turn = one user message plus whatever the assistant does in reply. `turnOf[i]` is which
  // turn message i belongs to; `maxTurn` is the current (most recent) turn. A reading-tool result
  // compacts once it belongs to a turn older than the last two.
  let turn = 0;
  const turnOf = messages.map((m) => { if (m.role === 'user') turn++; return turn; });
  const maxTurn = turn;
  // Keep one complete submitted draft for revision, even after intervening quiz turns.
  let latestDraft: UIPart | undefined;
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.parts) {
      if (isToolUIPart(part) && getToolName(part) === 'writing_draft'
        && part.state === 'output-available' && typeof (part.output as any)?.draft === 'string') {
        latestDraft = part;
      }
    }
  }
  return messages.map((msg, index) => {
    if (msg.role === 'user') {
      if (index === lastUserIndex || !msg.parts.some((p) => p.type === 'file')) return msg;
      const parts = msg.parts.map((part): UIPart => (part.type !== 'file' ? part : {
        type: 'text',
        text: `[${part.mediaType.startsWith('image/') ? 'image' : 'file'} attached earlier: `
          + `${part.filename ?? part.mediaType}]`,
      }));
      return { ...msg, parts };
    }
    if (msg.role !== 'assistant') return msg;
    let changed = false;
    const parts = msg.parts.map((part) => {
      if (!isToolUIPart(part) || part.state !== 'output-available') return part;
      const name = getToolName(part);
      if (READING_TOOLS.has(name)) {
        if (turnOf[index] > maxTurn - 2) return part;
        changed = true;
        return { ...part, output: { compacted: true, note: readingStub(name, part.input) } };
      }
      if (!BLOCK_TOOL_NAMES.includes(name as BlockToolName)) return part;
      if (keepIds.has(part.toolCallId) || part === latestDraft) return part;
      const grading = (part.output as any)?.grading;
      if (!grading) return part; // ungraded output (e.g. a UI tool ack) — not this diet's business
      changed = true;
      const input = part.input as any;
      const output = part.output as any;
      // Preserve argument keys so historical calls do not advertise a different tool schema.
      return {
        ...part,
        input: capInputStrings(input),
        output: {
          compacted: true,
          answer: trim(firstString(
            output?.answer, output?.draft, output?.transcript,
            typeof output?.code === 'string' ? output.code : '',
          )),
          verdict: grading.verdict,
          detail: typeof grading.detail === 'string' ? trim(grading.detail) : undefined,
        },
      };
    });
    return changed ? { ...msg, parts } : msg;
  });
}
