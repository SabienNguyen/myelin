// Ported (subset) from ~/Dev/personal/the-gap apps/web/src/server/handWrittenProse.ts (READ ONLY
// there). The gap's own module applies these + the worked_example/inline_completion prose
// overrides at BOOT, server-side, before serving rungs — so by the time the harness's proxy hits
// GET /api/gap/ladder, rung.prose already carries the hand-written context_line/hint/success_line
// and move explanations. Only the CLIENT-SIDE-only constants (the offer panels' per-artifact
// checklists, keyed by artifactId, never shipped inside a Rung) need porting here — and only the
// stream-consumer entries, since that's the harness's one wired ladder (MVP: one ladder).

export interface PlanConcept {
  label: string;
  pattern: RegExp;
}

const STREAM_CONSUMER_PLAN_CONCEPTS: readonly PlanConcept[] = [
  { label: 'getting a reader from the response body', pattern: /\breader\b|getReader/i },
  { label: 'decoding bytes into text', pattern: /\bdecode\b|TextDecoder/i },
  { label: 'splitting the text into lines', pattern: /\bsplit\b|\bline(s)?\b/i },
  { label: 'reading the "data: " prefix on each line', pattern: /data:/i },
  { label: 'recognizing the [DONE] sentinel', pattern: /\[done\]/i },
  { label: 'handling a stream error', pattern: /\berror(s)?\b|\bcatch\b|\bfail(s|ure)?\b/i },
];

export const PLAN_CONCEPTS_BY_ARTIFACT: Readonly<Record<string, readonly PlanConcept[]>> = {
  'stream-consumer': STREAM_CONSUMER_PLAN_CONCEPTS,
};

export interface PredictItem {
  key: string;
  label: string;
  /** Whether the trace harness (the gap's server) can directly observe this item firing. An
   *  internal branch like the null-body guard has no externally-observable effect of its own — the
   *  panel shows "not directly observed" for such rows instead of a verdict it can't back up. */
  observable: boolean;
}

const STREAM_CONSUMER_PREDICT_ITEMS: readonly PredictItem[] = [
  { key: 'onToken', label: 'onToken fires', observable: true },
  { key: 'onDone', label: 'onDone fires', observable: true },
  { key: 'onError', label: 'onError fires', observable: true },
  { key: 'null-body-guard', label: 'the null-body guard branch runs', observable: false },
];

export const PREDICT_ITEMS_BY_ARTIFACT: Readonly<Record<string, readonly PredictItem[]>> = {
  'stream-consumer': STREAM_CONSUMER_PREDICT_ITEMS,
};

export interface DocCard {
  title: string;
  snippet: string;
  url: string;
}

const STREAM_CONSUMER_DOC_CARDS: readonly DocCard[] = [
  {
    title: 'ReadableStream.getReader()',
    snippet:
      'Calling getReader() on a stream returns a reader locked to that stream, and only one reader can read from a stream at a time. Each call to reader.read() resolves with { value, done } — value holds the next chunk of bytes, done becomes true once the stream has no more data left to deliver.',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream/getReader',
  },
  {
    title: 'TextDecoder streaming decode',
    snippet:
      'A TextDecoder turns raw bytes into text. Passing { stream: true } to decode() tells it more chunks are still coming, so a multi-byte character split across two chunks is held back instead of turning into broken output. A final decode() call with no argument flushes anything still buffered.',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/decode',
  },
  {
    title: 'SSE "data:" line framing',
    snippet:
      'Server-Sent Events format each message as one or more field lines ending in a newline, with a blank line marking the end of an event. A line starting with "data: " carries the payload; other prefixes such as event: or a leading colon for a comment are part of the same format but carry different meaning.',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#event_stream_format',
  },
];

export const DOC_CARDS_BY_ARTIFACT: Readonly<Record<string, readonly DocCard[]>> = {
  'stream-consumer': STREAM_CONSUMER_DOC_CARDS,
};

/**
 * CodeSignal-style problem statement for the Task tab: statement + constraints + examples, in place
 * of a single line of brief copy.
 *
 * Answer-integrity rule for the `examples` field — read before adding any: an example is part of the
 * SPECIFICATION, not a peek at the suite. Examples here cover only the trivial well-formed case (the
 * one a naive implementation already passes). The hazards that the suite actually discriminates on —
 * an event split across reads, a multi-byte character split across reads, a final line with no
 * newline — are stated in `constraints` as PROSE, never as an input/output pair. Adding an example
 * that mirrors a discriminating test case would be equivalent to TestResultsPanel's reveal, except
 * without the evidence ceiling that makes the reveal honest.
 */
export interface ProblemSpec {
  statement: string;
  constraints: readonly string[];
  examples: readonly { input: string; output: string }[];
}

const STREAM_CONSUMER_SPEC: ProblemSpec = {
  statement: 'Decode an SSE token stream into event payloads. Given an async iterable of Uint8Array '
    + 'chunks, yield each event\'s data string in order, and stop when the [DONE] sentinel arrives.',
  constraints: [
    'Chunk boundaries do not align with line boundaries — one event may arrive across two reads, and one read may carry several events.',
    'A multi-byte UTF-8 character can be split across two reads.',
    'Lines that are blank, or that carry a field other than data:, are ignored.',
    'The stream may end with a final data line that has no trailing newline.',
    'Nothing after the [DONE] sentinel is emitted.',
  ],
  examples: [
    { input: 'data: alpha\\ndata: beta\\ndata: [DONE]\\n', output: '"alpha", "beta"' },
  ],
};

export const PROBLEM_SPEC_BY_ARTIFACT: Readonly<Record<string, ProblemSpec>> = {
  'stream-consumer': STREAM_CONSUMER_SPEC,
};

const PLAN_CONCEPT_LABELS = STREAM_CONSUMER_PLAN_CONCEPTS.map((c) => c.label);
const PREDICT_ITEM_LABELS = STREAM_CONSUMER_PREDICT_ITEMS.map((i) => i.label);
const DOC_CARD_STRINGS = STREAM_CONSUMER_DOC_CARDS.flatMap((c) => [c.title, c.snippet]);

/** Every hand-written prose string in this file, flattened — used by the tone test so
 *  assertToneClean runs over the REAL strings this module ships, not a copy. */
export const ALL_HAND_WRITTEN_PROSE: readonly string[] = [
  ...PLAN_CONCEPT_LABELS,
  ...PREDICT_ITEM_LABELS,
  ...DOC_CARD_STRINGS,
  // Problem-spec prose is tone-checked on the same terms as everything else in this file — the
  // statement and constraints are learner-facing copy, so they must not drift into filler or praise.
  STREAM_CONSUMER_SPEC.statement,
  ...STREAM_CONSUMER_SPEC.constraints,
];
