import type { Mode } from './prompt.js';
import type { UIMessage } from '../shared/uiMessages.js';

/** The text of the most recent user message. Lives here rather than in session.ts because the chat
 *  route needs it to derive a mode, and importing it from session.ts would drag the entire tutor
 *  loop into the route's dependency graph. */
export function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    return (messages[i].parts as any[])
      .filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
  }
  return '';
}

/**
 * Which mode a turn should run in, decided by the harness instead of by a dropdown.
 *
 * The mode selector asks the learner to answer a question the system is better placed to answer.
 * Three of the four modes were never enforced by anything — `learn`, `review` and `quiz` differ
 * only by one framing sentence, while what they nominally steer (what is due, what is next, what
 * is worth batching) the harness already computes. And the codebase had grown three separate
 * mechanisms to route around the selector: coldStartMode picking freeform on an empty vault,
 * writeIntent promoting a single turn so the learner need not "hunt for the mode selector", and
 * the /review and /freeform commands overriding it per turn.
 *
 * `Mode` survives as an internal representation — it is a perfectly good one. What goes is asking
 * a human to set it.
 *
 * Deliberately keyword-based rather than model-judged: this runs before the turn, on every turn,
 * and a wrong guess must be cheap and predictable. An explicit command still wins over everything
 * here (chatRoute applies commandMode first), so the escape hatch is never more than a slash away.
 */

/** Asking for the vault to be RESTRUCTURED — a syllabus built, material added. These are the only
 *  capabilities with no automatic trigger: writing a page already unlocks on a vault gap, so this
 *  is all that is left of what `freeform` used to mean. */
const AUTHORING = [
  /\b(build|make|create|set ?up|design|plan)\b[^.?!]{0,40}\b(path|syllabus|curriculum|course|roadmap|track)\b/i,
  /\b(add|ingest|import|compile|pull in)\b[^.?!]{0,40}\b(this|these|book|paper|repo|repository|video|pdf|page|site|url|material|source)\b/i,
  // "Keep this" is asked in many more ways than the first cut allowed: a live sitting said "save
  // what we covered as a page I can come back to", which matched none of `save (this|that|it)` and
  // so never unlocked writing at all.
  /\bwrite\s+(it|this|that|what|everything|them)?\s*(up|down)\b/i,
  /\b(save|keep|store)\b[^.?!]{0,40}\b(page|note|vault|for later|come back|reference)\b/i,
  /\b(save|keep|store)\s+(this|that|it|what|everything|our|the)\b/i,
  /\bmake (me )?a page\b|\bturn (this|that) into a page\b/i,
];

/** Asking to be TESTED across what they know, rather than taught something. */
const QUIZ = [
  /\bquiz me\b/i,
  /\btest me\b/i,
  /\bexam me\b/i,
  /\bgive me a (quiz|test)\b/i,
];

/** Asking to go back over old ground. */
const REVIEW = [
  // NOT a bare /review/ — "teach me how code review works at Google" is a topic, not a request to
  // go back over old ground. The word only means the mode when it is addressed at the session or
  // at the learner's own material.
  /^\s*review\b/i,
  /\b(let'?s|lets|can we|could we|shall we|i want to|i'?d like to|time to)\s+review\b/i,
  /\breview\s+(my|what|that|those|these|it|them|again|everything|the material)\b/i,
  /\bgo over\b[^.?!]{0,30}\b(again|old|previous|earlier|before)\b/i,
  /\bwhat (have i|did i) (forgotten|forgot|forget)\b/i,
  /\brefresh\b[^.?!]{0,25}\bmemory\b/i,
  /\bwhat.{0,20}\bslipped\b/i,
];

export interface DeriveInput {
  /** The learner's message for this turn. Empty for a bare command or a block resubmission. */
  text: string;
  /** Kinds present in the current session plan, most important first. */
  planKinds?: string[];
  /** True when the vault holds nothing real to teach from — every turn is then necessarily
   *  research-and-write, which is what coldStartMode existed to express. */
  emptyVault?: boolean;
}

/**
 * Order matters, and it is the same precedence a careful reader would apply:
 * an explicit ask beats the plan, and the plan beats the default.
 */
export function deriveMode({ text, planKinds = [], emptyVault = false }: DeriveInput): Mode {
  const t = (text ?? '').trim();

  // An explicit ask always wins — this is the half of the selector worth keeping, expressed in the
  // learner's own words rather than as a control they have to find first.
  if (AUTHORING.some((re) => re.test(t))) return 'freeform';
  if (QUIZ.some((re) => re.test(t))) return 'quiz';
  if (REVIEW.some((re) => re.test(t))) return 'review';

  // Nothing to teach from: research-and-write is the only thing a turn can usefully be.
  if (emptyVault) return 'freeform';

  // Otherwise follow the plan's own leading item. A continuation ("ok", "next") carries no ask, so
  // this is what decides — and it is exactly the signal rule 2c says should never be OVERRIDDEN by
  // the suggestions mid-topic, only used to choose what to start.
  if (planKinds[0] === 'quiz') return 'quiz';
  if (planKinds[0] === 'review' || planKinds[0] === 'misconception') return 'review';

  return 'learn';
}
