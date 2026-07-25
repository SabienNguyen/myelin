// Ported VERBATIM from ~/Dev/personal/the-gap apps/web/src/failureMessages.ts (READ ONLY there).
//
// Per-pattern proximity messages: "a message from a per-artifact failureMessages.ts map keyed by
// the SET of failing test names — messages name what's left ('nothing handles a null body yet'),
// never code." Rules are tried in order, first match wins. These are hand-written (the gap's spec
// principle 1: "LLMs never decide ... those live in hand-written templates").
//
// Test names below are the vitest JSON reporter's `fullName` for each
// packages/artifacts/store/stream-consumer/artifact.test.ts case — see the gap's
// packages/gauntlet/src/suite-runner.ts's runArtifactSuiteJson, which is what produces the
// `results[].name` values the sidecar's /api/run (proxied here as /api/gap/run) hands back.

const TEST = {
  ORDER: 'consumeStream emits onToken in order for well-formed SSE lines, one chunk per line',
  SPLIT_LINE: 'consumeStream reassembles a single SSE line split arbitrarily across multiple chunks',
  STOPS_AT_DONE: 'consumeStream stops emitting tokens once [DONE] fires, even if more data follows in the stream',
  NULL_BODY: 'consumeStream calls onError and returns early when response.body is null, without touching a reader',
  UTF8_FLUSH: 'consumeStream flushes a multi-byte UTF-8 character split across two chunks correctly',
  READ_ERROR: 'consumeStream propagates a mid-stream read error to onError and does not call onDone',
  IGNORES_NON_DATA: 'consumeStream ignores blank keep-alive lines and non-data SSE fields (event:, comments)',
  FINAL_LINE: 'consumeStream emits a final data line that has no trailing newline before the stream closes',
} as const;

export interface FailureMessageRule {
  when: (failing: Set<string>) => boolean;
  message: string;
}

/** Ordered rules for the stream-consumer pattern. First rule whose `when` returns true wins. */
export const streamConsumerMessages: FailureMessageRule[] = [
  {
    when: (failing) => failing.has(TEST.NULL_BODY),
    message: 'nothing handles a null body yet',
  },
  {
    when: (failing) => failing.has(TEST.STOPS_AT_DONE),
    message: 'tokens arrive but [DONE] never fires onDone',
  },
  {
    when: (failing) => failing.has(TEST.READ_ERROR),
    message: 'a stream read error never reaches onError',
  },
  {
    when: (failing) => failing.has(TEST.FINAL_LINE),
    message: 'the last line without a trailing newline never arrives',
  },
  {
    when: (failing) => failing.has(TEST.UTF8_FLUSH),
    message: 'a multi-byte character split across chunks comes out mangled',
  },
  {
    when: (failing) => failing.has(TEST.SPLIT_LINE) || failing.has(TEST.IGNORES_NON_DATA) || failing.has(TEST.ORDER),
    message: 'tokens are read, but line splitting across chunks is not right yet',
  },
];

/**
 * Drops the leading subject from a gap test name so the predicate can be read as prose:
 * "consumeStream reassembles a single SSE line split across chunks" -> "reassembles a single SSE
 * line split across chunks".
 *
 * Only strips a token that looks like a camelCase identifier — it must carry an uppercase letter
 * somewhere after the first character. That is what distinguishes the artifact's function name
 * (`consumeStream`, `parseSSE`) from a test name that simply opens with a lowercase verb
 * (`handles a null body`), whose first word must be kept.
 */
export function testPredicate(name: string): string {
  return name.replace(/^[a-z][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\s+/, '').trim();
}

/**
 * Artifact-agnostic proximity message, derived from the suite's OWN test names.
 *
 * The previous fallback — "N tests still failing — read their names in the panel." — carried no
 * information, so any artifact without a hand-written rule set above gave the learner nothing. Since
 * the per-artifact rule sets are hand-authored, that was every artifact but one, which is exactly
 * the bottleneck that stops this scaling to arbitrary subjects.
 *
 * This names what is left using the suite's own words, which is the same thing the hand-written
 * rules do ("nothing handles a null body yet") — just mechanically, and less polished. It cannot leak
 * an answer: a test name states a requirement, not how to satisfy it. Hand-written rules still win
 * when one matches, because a human sentence beats a derived one.
 */
export function derivedProximityMessage(failing: Set<string>): string {
  const preds = [...failing].sort().map(testPredicate).filter(Boolean);
  if (preds.length === 0) return '';
  if (preds.length === 1) return `still to handle: ${preds[0]}.`;
  if (preds.length === 2) return `still to handle: ${preds[0]}; and ${preds[1]}.`;
  return `still to handle: ${preds[0]}; and ${preds.length - 1} more.`;
}

/** Applies streamConsumerMessages to a set of currently-failing test names, first match wins, then
 *  falls back to a message DERIVED from the failing test names. Returns '' for an empty failing set
 *  (callers decide what to show when everything is passing). */
export function proximityMessage(failing: Set<string>): string {
  if (failing.size === 0) return '';
  const rule = streamConsumerMessages.find((r) => r.when(failing));
  if (rule) return rule.message;
  const derived = derivedProximityMessage(failing);
  // Only if every name somehow reduced to nothing — keep a grammatical count rather than the old
  // "1 tests still failing".
  return derived || `${failing.size} test${failing.size === 1 ? '' : 's'} still failing — read their names in the panel.`;
}
