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

const DEFAULT_FALLBACK = (count: number): string => `${count} tests still failing — read their names in the panel.`;

/** Applies streamConsumerMessages to a set of currently-failing test names, first match wins, and
 *  falls back to the generic "N tests still failing" message when nothing matches. Returns '' for
 *  an empty failing set (callers decide what to show when everything is passing). */
export function proximityMessage(failing: Set<string>): string {
  if (failing.size === 0) return '';
  const rule = streamConsumerMessages.find((r) => r.when(failing));
  return rule ? rule.message : DEFAULT_FALLBACK(failing.size);
}
