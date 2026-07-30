// History diet, layer 1 (Tier-2 efficiency): a block graded in an EARLIER turn does not need its
// full payload in the model transcript — the code submission, SVG diagram, or annotated draft can
// be kilobytes, it rides every subsequent request forever, and the vault already holds the truth
// as evidence. After grading, the verdict line is what future turns actually use.
//
// This trims the MODEL's view only: the caller applies it just before uiMessagesToChatMessages,
// so persistence, the client, and grading all still see full payloads. The current turn's
// freshly-graded blocks (keepIds) stay full — the model is about to discuss exactly that work.
// Compaction is deterministic, so a block compacts identically on every later turn and the
// transcript prefix stays stable for the prompt cache (one small shift when a block first ages
// out of keepIds, then never again).
import { BLOCK_TOOL_NAMES, type BlockToolName } from '../shared/blocks.js';
import { isToolUIPart, getToolName, type UIMessage } from '../shared/uiMessages.js';

const CAP = 160;

const firstString = (...candidates: unknown[]): string => {
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c;
  return '';
};

const trim = (s: string): string => (s.length > CAP ? `${s.slice(0, CAP)}…` : s);

/** UIMessages for the model with old graded block payloads compacted to verdict lines.
 * Untouched parts are shared by reference; only compacted parts (and their ancestors) are new. */
export function dietUiMessages(messages: UIMessage[], keepIds: Set<string>): UIMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'assistant') return msg;
    let changed = false;
    const parts = msg.parts.map((part) => {
      if (!isToolUIPart(part) || part.state !== 'output-available') return part;
      if (!BLOCK_TOOL_NAMES.includes(getToolName(part) as BlockToolName)) return part;
      if (keepIds.has(part.toolCallId)) return part;
      const grading = (part.output as any)?.grading;
      if (!grading) return part; // ungraded output (e.g. a UI tool ack) — not this diet's business
      changed = true;
      const input = part.input as any;
      const output = part.output as any;
      return {
        ...part,
        input: {
          compacted: true,
          prompt: trim(firstString(input?.question, input?.prompt, input?.title, input?.pattern)),
        },
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
