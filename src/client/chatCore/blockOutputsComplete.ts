import { BLOCK_TOOL_NAMES } from '../../shared/blocks.js';
import type { UIMessage } from '../../shared/uiMessages.js';

/**
 * Auto-resubmit predicate — chatCore's copy of runtime.tsx's `blockOutputsComplete`, identical
 * in semantics (runtime.tsx keeps its own until E2 swaps the runtime and consolidates). Its two
 * load-bearing narrowings, each pinned by tests:
 *
 * - BLOCK tool parts only (quick_check / quiz / … — the ones a human answers in the browser).
 *   The stock "any completed tool call" rule re-fires on the follow-up turn's server-side MCP
 *   parts (record_evidence) and loops forever — evidence recorded 6x in the T12 run.
 * - LAST STEP only. A resubmitted response continues the same assistant message, so the block
 *   part that triggered the resubmit stays physically present in an earlier step of every later
 *   version of "the last message"; scanning the whole message re-matches it and never
 *   terminates — confirmed by driving the real E2E flow before this scoping was added.
 */
export function blockOutputsComplete({ messages }: { messages: UIMessage[] }): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return false;
  const parts = last.parts as any[];
  const lastStepStartIndex = parts.reduce((acc, part, i) => (part.type === 'step-start' ? i : acc), -1);
  const blockParts = parts.slice(lastStepStartIndex + 1).filter((part) =>
    BLOCK_TOOL_NAMES.some((name) => part.type === `tool-${name}`));
  return blockParts.length > 0 && blockParts.every((part) => part.state === 'output-available');
}
