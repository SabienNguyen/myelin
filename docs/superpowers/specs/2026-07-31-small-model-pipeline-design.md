# The small-model pipeline: one engine for compile, research, and rails

The harness already knows the trick that makes small local models useful: invert control, so the
HARNESS decides what happens and the model fills one narrow, schema-locked slot per call. Rails
proved it for drills; the weak-compile fallback re-implemented it by hand for ingestion. This spec
extracts that trick into ONE engine and puts three consumers on it — a rebuilt compile, a new
background research drain, and (last, once proven) rails generation itself.

The governing principle, enforced rather than prompted: **this system conveys sourced human
knowledge; it does not generate knowledge.** Machine-written pages carry mechanically-verified
sources or stay `draft` forever.

## 1. The engine (`src/server/pipeline.ts`)

A harness-driven orchestrator for jobs too big or too hard for one small-model call.

- **Fit check first, arithmetic not vibes.** Before any call: estimate tokens (chars/4 is fine as
  a floor) against the model's known context. Too big → split; never send a prompt that will be
  silently truncated.
- **Recursive split.** A unit that fails the fit check is bisected on natural boundaries
  (headings, then paragraphs, then hard length) until every piece fits a single call.
- **Parallel map.** Pieces run concurrently (bounded, default 4 — ollama serves parallel requests;
  the cap is VRAM respect, configurable per role).
- **One call per piece**: structured generation, constrained decoding where the provider supports
  it, exactly one rejection-retry (the rails recipe).
- **Vote for hard steps.** A step marked `vote: n` runs n calls and takes the majority /
  best-scored result. Off by default; synthesis and ranking steps opt in.
- **Diagnosed failure, never mystery.** Every failure is classified before any fallback:
  `overflow` (fit-check math), `weak-output` (schema rejection after retry), `transport`
  (endpoint down — always re-throws so queues retry later, matching today's compile contract).
  The class and message ride the ledger receipt. "It fell back" without a why is a bug.
- **Merge step.** A consumer-supplied reducer runs over piece results (writes the MOC, or joins
  extracts). Merge calls go through the same fit/retry machinery.
- **Floor.** Consumer-supplied deterministic fallback per piece (compile: verbatim draft), always
  labeled with the diagnosed reason. Model weakness never surfaces as an error at the learner.

Interface sketch (final shape belongs to the plan, not this spec):

```ts
runPipeline({ role, steps, concurrency }, job) -> { results, receipts }
// step: { name, prompt(piece), schema, vote?, floor?(piece, reason) }
```

Usage lands in the usage ledger per role, receipts in the compile/research queue ledgers.

## 2. Compile, rebuilt on the engine

Chapter → fit check → recursive split → **parallel** distillation (one page per part, 150–400
words, faithful to the text) → **MOC merge**: one hub page per chapter — the Obsidian
map-of-content idiom — titled from the chapter, one line per part, `prereqs`/`deepens` edges to
every part page. Parts stay individually drillable with their own mastery.

- Citation wrapping stays mechanical and unchanged: every part page carries the book/chapter
  source the ingest already threads through.
- The verbatim floor survives, but only after diagnosis, and the ledger phase names the class:
  `part 3: verbatim (weak-output: schema rejected twice)`, not just "fallback".
- The agentic compile path (strong models driving write_page) is untouched; the engine replaces
  only the weak-model ladder in `src/server/ingest.ts`.

## 3. The research drain (new, on the engine)

Background-first, compile-drain-shaped: a queue, a drain loop, ledger receipts. Drills never wait.

**Triggers**: a planner-picked page that is a vaultGap (stub / unsourced / too thin); a cold-topic
request (learn-mode ask for something the vault has never heard of); an explicit ask.

**Steps** (each a pipeline step; model calls marked ●):

1. ● Write 2–3 search queries from the topic + what the vault already has.
2. Harness hits SearXNG (`search.searxng` — required; no searxng → the drain refuses loudly at
   enqueue time, it does not pretend).
3. ● Rank result snippets for relevance (classification — small models are good at this; `vote`).
4. Harness fetches the top pages (readable-text extraction, the existing read_url machinery).
5. ● Extract the passages relevant to the topic from each fetched page (parallel per page).
6. ● Synthesize page(s) from the extracted passages ONLY, with inline citations; more than one
   concept → part pages + MOC, same shape as compile.
7. **Mechanical citation check** (harness, no model): every cited quote must appear verbatim
   (whitespace-normalized) in the fetched source text. A claim whose quote fails the check is cut,
   not shipped. A page that loses all its citations is not written; the receipt says why.
8. Write pages as `draft` with `sources:` = the verified URLs, via Engram (single-writer rule).

**Dead ends degrade loudly**: no results, all fetches fail, or all citations cut → a ledger
receipt saying exactly that. Nothing is invented to fill the gap — that is the whole point.

## 4. The enforcement rule

- Pages written by compile or research always carry sources (mechanical: the book, or the
  verified URLs).
- A page with no sources can never be promoted past `draft` by machinery. (Humans can do what
  they like with their own vault — the rule binds the harness, not the learner.)
- vaultGap already treats unsourced as a gap; the research drain is what finally closes that loop
  for local-model setups.

## 5. UX parity

Same surfaces a strong model produces, powered by the harness:

- Tool-chip-style status while the drain works a visible request: "searching…", "reading
  <domain>…", "writing <page>…" (transient data parts, the existing chip machinery).
- Receipts in the library exactly like compile receipts today; the progress card counts new pages.
- A cold-topic ask stages its first drill the moment the first page lands — not when the whole
  topic finishes.
- The visible difference from a frontier model is wall-clock only, and background-first hides
  most of it.

## 6. Config

- New model role: `research` (defaults to the compile model). Rides the existing prefix routing,
  sampler blocks, and usage ledger.
- `search.searxng` is the retrieval backend, unchanged.
- Engine concurrency: per-role `concurrency` knob, default 4.

## 7. Testing

- Engine: pure unit tests — fit math, recursive split boundaries, parallel map, vote, failure
  classification, merge, floor labeling. Fully offline.
- Compile-on-engine: the existing ingest tests carry over; new ones pin the MOC (hub page exists,
  links every part, edges present) and the diagnosed-reason ledger text. The CI weak-model server
  (`npm run weak:model`) drives the whole ladder, including the reject-rf variant.
- Research: unit tests with a fake SearXNG + fake fetch pin ranking, extraction bounds, the
  citation check (a fabricated quote is cut; a page losing all citations is not written), and
  dead-end receipts. One e2e with the scripted model drives trigger → receipt → page + MOC in the
  library.
- Rails migration happens only after all of the above is green, and rails' own e2e must not
  change at all — byte-identical behavior is the acceptance test.

## Build order

1. Engine + unit tests.
2. Compile refit (offline-testable end to end, weak-model CI coverage).
3. Research drain + UX receipts.
4. Rails generation migrates onto the engine; specs above all stay green.
