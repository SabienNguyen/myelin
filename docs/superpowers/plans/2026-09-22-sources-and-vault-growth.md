# Real sources on OpenAI + a vault that grows as you learn — implementation plan

Repo: /home/sabien/Dev/personal/myelin (Hono server in src/server, TypeScript, Vitest). Read
`.claude/skills/no-slop-code/SKILL.md` (binding: Engram is the ONLY writer of pages/ and students/;
ledger writes only via queueStore's updateQueue; model routing only via the prefix scheme in
models.ts; degrade loudly — no swallowed catches; tests assert behaviour). For any client edit also
read `.claude/skills/no-slop-ui/SKILL.md`. The user has UNCOMMITTED work in this tree (including in
src/server/session.ts, TopbarStatus.tsx, grading.ts, index.ts) — build on top of it, never revert it,
never run git stash/checkout/reset/restore/add/commit. Touch only the files your task names.

## Why (from a real session, 2026-09-22, tutor on openai:gpt-6-luna)

"teach me inference infra engineering": find_canonical_sources returned keyword junk (a
bioinformatics paper, ImageNet); the tutor had no web search (only Anthropic-routed tutors get
provider search; no SearXNG configured), so it wrote ONE umbrella page with `sources: []` and taught
three further concepts (batching, request lifecycle, queue vs generation latency) as unverified prose,
recording all evidence against the umbrella slug. On every continuation turn ("lets go!", "sure")
vaultGap returned null (no topic tokens), so write_page/research stayed locked and the vault never grew.

Approved fixes: D (research/write stay unlocked for the thread's current topic while its page is weak),
`oai:` (first-class OpenAI route on the Responses API with OpenAI's built-in web_search), and E (after
each teaching turn, compile the concepts taught into pages in the background).

## Order

D ∥ O1 → O2 → E

---

## D — vaultGap falls back to the thread's current topic

In `src/server/session.ts`:

```ts
/** The page this thread is currently about: the slug of the most recent record_evidence, write_page
 *  or read_page tool part (by message order, last part wins) in the UI history, or null. Pure. */
export function threadTopic(messages: UIMessage[]): string | null;
```
Tool parts look like `{ type: 'tool-record_evidence' | 'tool-write_page' | 'tool-read_page', input: { slug } }`
(see how session.ts already reads tool parts, e.g. toolsUsed). Ignore parts whose input has no string slug.

Change `vaultGap`: where it currently returns null for `tokens.length === 0` ("ok", "next", "go on"),
instead: `const topic = threadTopic(messages); if (!topic) return null;` then read that page with
`deps.readPage(topic)` and apply the SAME stub / unsourced / thin checks the search-hit path applies,
returning the same reasons with `slug: topic` and a detail that says it is the lesson's current topic.
A solid page (sourced, not stub, not thin) still returns null — continuing a lesson on a good page stays
grounded. Greetings and progress questions must still return null BEFORE this (keep their order).
Refactor the stub/unsourced/thin checks into one local helper used by both paths rather than
duplicating them.

Also: the trailing `catch { return null; }` in vaultGap must log: `console.error('[vault-gap] check
failed, treating the turn as covered:', e)` and still return null.

Tests (extend tests/greetingOpening.test.ts's vaultGap style, or a new tests/vaultGapTopic.test.ts):
threadTopic picks the latest slug across the three tool kinds and returns null with none; a
continuation message ("sure") after a record_evidence on an unsourced page returns reason
'unsourced' with that slug and never calls deps.search; same with a solid page returns null; a bare
greeting after the same history still returns null; the catch path logs '[vault-gap]'.
Touch only: src/server/session.ts, the test file.

## O1 — Responses API adapter (`src/server/llm/openaiResponses.ts`)

```ts
export interface OpenAIResponsesModelOptions {
  modelId: string;
  apiKey?: string;               // resolved per call by the caller (process.env.OPENAI_API_KEY)
  baseUrl?: string;              // default 'https://api.openai.com/v1'; tests point it at a stub
  retry?: RetryOptions;
  timeoutMs?: number;            // headers deadline per attempt, default 120_000 (as openaiCompat)
}
export function openaiResponsesModel(opts: OpenAIResponsesModelOptions): ChatModel;
```
Export it from `src/server/llm/index.ts` next to openaiCompatModel.

Must implement the SAME `ChatModel` contract (`generate` + `stream`) and emit the SAME `StreamEvent`
sequence semantics as `openaiCompat.ts` / `anthropic.ts` (read src/server/llm/types.ts and both
adapters first; reuse retry.ts, sse.ts, wire.ts helpers where they fit — do not copy them). Before
coding, fetch and read OpenAI's current Responses API docs (WebFetch
https://platform.openai.com/docs/api-reference/responses and the streaming-events and
web-search-tool guides; if a page will not load, say so in the report and code to what you verified).
Requirements:
- POST `${baseUrl}/responses`, `stream: true`, `store: false`,
  `include: ['reasoning.encrypted_content']`.
- System prompt → `instructions`. ChatMessages → `input` items: user/assistant text as message items;
  ToolCallPart → `{ type: 'function_call', call_id, name, arguments }`; ToolResultPart →
  `{ type: 'function_call_output', call_id, output }` (stringify non-string results).
- Reasoning continuity across tool steps: emit the response's reasoning items so they come back on
  the next request. Map them onto the existing ThinkingPart round-trip (the anthropic adapter carries
  a signature/redacted payload the same way — use `signature` for the encrypted_content and keep the
  reasoning item id) so loop.ts needs NO changes; document the mapping at the code.
- Function tools: `{ type: 'function', name, description, parameters, strict: false }`.
- ServerTool `{ type: 'web_search', name: 'web_search' }` (the shape O2 will pass) →
  `{ type: 'web_search' }` in `tools`. Any other ServerTool type → throw a clear Error (it would be
  silently dropped otherwise).
- `req.effort` → `reasoning: { effort }` (sent WITH tools — that is the point of this route).
  `req.toolChoice` → 'auto' / `{ type: 'function', name }`. `req.responseSchema` →
  `text: { format: { type: 'json_schema', name, schema, strict: true } }` when no function tools.
  `req.maxTokens` → `max_output_tokens`. Temperature/sampler: send only `temperature`/`top_p` when
  set; skip the local-model knobs (top_k, min_p, repetition_penalty) — OpenAI rejects them.
- Stream mapping: output_text deltas → text-start/text-delta/text-end; function_call items →
  tool-input-start / tool-input-delta / tool-call (parse arguments JSON; a parse failure sets
  `inputError` exactly as openaiCompat does); `web_search_call` items → `server-tool-call` then
  `server-tool-result` with `output` = `{ query, sources: [{ url, title }] }` built from the call's
  action and the message's `url_citation` annotations (so downstream code can cite URLs);
  reasoning summary deltas → thinking-* events; `response.completed` → finish with usage mapped to
  the `Usage` shape; `response.failed` / `error` events → throw LlmHttpError-equivalent (reuse the
  existing error type) with the provider message.
- Non-2xx → the same LlmHttpError handling openaiCompat uses (so retry.ts classification works).

Tests: tests/llm/openaiResponses.test.ts, written first, against a local stub server or an injected
fetch (follow how tests/llm/*.test.ts test openaiCompat — reuse their approach). Cover: request body
shape (instructions, input items for a tool round-trip, reasoning.effort alongside tools, web_search
tool, include/store), streamed text, a function call with valid and invalid JSON arguments, a
web_search_call surfacing as server-tool-call + server-tool-result with URLs, reasoning items
round-tripping into the next request's input, usage on finish, an error event, a non-2xx response.
Touch only: src/server/llm/openaiResponses.ts, src/server/llm/index.ts, tests/llm/openaiResponses.test.ts.

## O2 — `oai:` route wiring

- `src/server/models.ts`: `const OAI_PREFIX = 'oai:'`; `ModelRoute` gains `'oai'`; `modelRouteFor`
  checks it BEFORE `openai:` (prefix collision is impossible — 'oai:' vs 'openai:' — but keep the
  ordering explicit); `chatModelFor` returns `wrap(openaiResponsesModel({ modelId: id, apiKey:
  process.env.OPENAI_API_KEY }))` — env read per call like the others. Comment why `oai:` is its own
  route (the `openai:` slot stays free for a custom OpenAI-compatible server; the Responses API gives
  built-in web search and effort-with-tools).
- `src/server/webTools.ts`: provider search for `oai` → `serverTools: [{ type: 'web_search', name:
  'web_search' }]` (same place the Anthropic web_search_20260209 is returned; keep that one for
  anthropic). Update the doc comments that say only Anthropic gets provider search.
- `src/server/settings.ts`: add `'OPENAI_API_KEY'` to PROVIDER_ENV_KEYS.
- `src/server/setupRoutes.ts`: an `oai:` role with no OPENAI_API_KEY (in the request env or
  process.env) is refused at save time with an actionable message, mirroring the groq check; the GET
  state exposes `OPENAI_API_KEY: { set, shadowed }` like the other keys; `needsApiKey`/route logic
  treats `oai` like groq (keyed provider, not Anthropic). Model discovery (`discoverModels`), if it
  lists provider models, may list `oai:` ids via GET https://api.openai.com/v1/models when the key is
  set — only if that function already does per-provider discovery; otherwise skip.
- Client `src/client/components/TopbarStatus.tsx`: add an "openai api key" secret field next to the
  others (same pattern as GROQ_API_KEY, including the blank-means-unchanged behaviour), and make the
  model id help text mention `oai:<model>` for OpenAI. FirstRun.tsx only if it enumerates providers.
- Tests: extend the existing tests for modelRouteFor / chatModelFor / webTools / setupRoutes
  (find them under tests/) with the oai cases: routing, provider search tool present for oai and
  absent for openai:, save refused without key and accepted with it, key visible as set in GET.
  Client: extend the TopbarStatus/models-menu test that covers GROQ_API_KEY with the new field.
Touch only the files named above and their tests.

## E — lesson notes compile into pages after each teaching turn

Goal: after a TEACHING turn ends and is saved, the concepts taught that turn become (or extend) vault
pages in the background, through the EXISTING compile pipeline (src/server/ingest.ts compileNext /
compileOne, queue in src/server/queueStore.ts). Read those first, end to end, including how a
chapter file's content and `sourceUrl` reach Engram's compile contract and how the drain is started
("auto-compiling in the background"). If the pipeline cannot express the requirements below without
invasive changes, STOP and report what blocks it instead of improvising.

Design:
- New module `src/server/lessonNotes.ts`:
  ```ts
  export interface LessonTurn {
    threadId: string; topicSlug: string | null; endedAt: string;   // ISO
    tutorText: string;                    // the assistant's prose this turn
    exchanges: { prompt: string; answer: string; verdict?: string }[];  // blocks + learner answers
    sources: { url: string; title?: string }[];   // research this turn (server-tool-result / read_url)
  }
  /** True for a turn worth compiling: not a bare greeting, not a progress question, not a
   *  grading-only turn, and tutorText has at least MIN_LESSON_CHARS (400) of prose. */
  export function isTeachingTurn(...): boolean;   // signature per what session.ts has in hand
  export function lessonTurnFromParts(...): LessonTurn;  // pure, from the turn's UI message parts
  /** Writes raw/uploads/lesson-notes/<threadId>/<endedAt-safe>.md (harness territory) and enqueues
   *  it via updateQueue as a queue entry with book 'lesson-notes', title from the topic, and
   *  `mode: 'lesson'`, then kicks the drain the same way uploads do. */
  export async function enqueueLessonNotes(vault: string, turn: LessonTurn, ...): Promise<void>;
  ```
- `QueueEntry` gains `mode?: 'repo' | 'lesson'`, `lessonTopic?: string`, `sourceUrls?: string[]`
  (extend, don't repurpose `sourceUrl`).
- compileOne: for `mode: 'lesson'` entries, add to what the compile model is told: extract AT MOST 3
  concepts that the turn actually taught; for each, `search` the vault first and extend the matching
  page rather than writing a duplicate; new pages link to `lessonTopic` (prereqs/deepens as fits);
  cite `sourceUrls` in `sources` when the concept came from them, otherwise status `draft` with no
  invented sources; skip anything too thin to be a page. Everything else about compileOne unchanged.
- Hook: in session.ts where the turn ends and the thread is saved (onEnd / saveThread), when
  isTeachingTurn → `enqueueLessonNotes(...)` fire-and-forget with `.catch((e) =>
  console.error('[lesson-notes] could not queue this turn:', e))`. Must never delay or fail the
  learner's turn.
- Failures during the compile show in the queue entry's status/error like any chapter (existing UI).

Tests: tests/lessonNotes.test.ts — isTeachingTurn (greeting/progress/grading-only/short → false;
real teaching → true), lessonTurnFromParts extracts prose, exchanges and research URLs from realistic
UI parts, enqueueLessonNotes writes the file under raw/uploads/lesson-notes and a queue entry with
mode 'lesson' + lessonTopic + sourceUrls (read back from the ledger file on disk), and never
enqueues twice for the same turn; a session-level test that a teaching turn enqueues and a greeting
turn does not; compileOne's lesson branch puts the 3-concept / search-first / link / sources rules
into the compile prompt (assert on the prompt text the injected compile model receives).
Touch only: src/server/lessonNotes.ts, src/server/queueStore.ts (types), src/server/ingest.ts
(lesson branch only), src/server/session.ts (the hook only), tests/lessonNotes.test.ts, and the
existing ingest/session test files if an added case belongs there.
