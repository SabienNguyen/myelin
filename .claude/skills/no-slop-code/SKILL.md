---
name: no-slop-code
description: Implementation standards for myelin — use before writing or editing any TypeScript/TSX here, and when reviewing a diff. Covers the architectural invariants an unfamiliar contributor would break (single-writer vault, model-route prefixes, ledger writes, degrade-loudly error handling), plus the code-slop patterns this repo rejects: comments that restate the line, speculative abstraction, swallowed errors, mock-asserting tests, and casual dependencies.
---

# No-Slop Code (harness)

This codebase is ~4.5k LOC of server and ~4.2k LOC of client against ~7.3k LOC of tests across 51
files. It is dense on purpose. The failure mode to avoid is not "too few lines" — it is lines that
add surface without adding behavior.

Read the surrounding module before writing. Match its density, naming, and comment style.

## Architectural invariants — breaking these is the worst slop

**1. Engram is the only writer of `pages/` and `students/`.** The harness reaches them
exclusively through the MCP client in `src/server/mcp.ts`. Never `writeFileSync` into the vault's
`pages/` or `students/`. The harness's own territory is `vault/.harness/` (ledgers, logs, session
maps) and `vault/raw/uploads/`.

The one acknowledged exception — `compileOne` spawning a second MCP server — is documented in the
README as a known gap. Do not add a second exception; do not "clean up" the first by writing
directly.

**2. Never parse vault markdown in harness code.** `Engram.listSlugs()` deliberately reads
filenames only. Page structure is Engram's business; ask it via `read_page`.

**3. Model routing goes through the prefix scheme.** A role's model id is a plain id (Anthropic
API), `ollama:` (local, OpenAI-compatible), or `claude-sdk:` (Agent SDK, subscription login). Add
capability by extending `modelFor` in `src/server/models.ts` — never by hardcoding a provider at a
call site.

**4. Ledger writes go through `updateQueue`.** `src/server/queueStore.ts` exists because a
hand-rolled `readQueue`-then-`writeQueue` pair caused a lost-update bug. Never reintroduce that
pair in production code.

**5. Mastery changes only through `record_evidence`.** No harness code may promote a level by
another route, and the evidence guardrail in `session.ts` must keep its teeth: grade, order the
call, verify it happened, nudge once, then log.

## Comments

See the `no-slop-prose` skill for the full standard. In short: comment the failure mode, not the
line. `src/server/mcp.ts`'s stale-closure note and `session.ts`'s `originalMessages` note are the
bar — each one stops a future refactor from reintroducing a real bug.

Delete on sight: `// Create the client`, `// Loop through pages`, `// Error handling`,
`// NEW:`, commented-out blocks.

## Error handling: degrade loudly

The house rule is that failures reach a human. They do not vanish into a `catch {}`.

- Surface to the learner *and* to stderr, like `session.ts`'s `turnError`.
- A fallback path logs why it fell back — see `claudeSdkTutor.ts`'s stale-session resume, which
  overwrites the stored id and `console.error`s loudly.
- Only mark a side effect done when it actually succeeded. The notification ledger is written on
  delivery, not on attempt, so a headless boot retries.

Slop patterns, all rejected:

```ts
try { await doTheThing() } catch {}                     // swallowed
try { await doTheThing() } catch (e) { return null }     // silent null, caller can't tell
catch (e) { console.log('error') }                       // no message, no context
if (!x) return                                           // guard with no reason and no log
```

An empty catch is acceptable only when the failure is genuinely expected and irrelevant, and the
comment says which — e.g. `readRationales()` treating a corrupt cache as empty.

## Abstraction: earned, not speculative

This repo *does* use injected seams — `CompileDeps`, `GradingDeps`, `IngestRepoDeps`. They exist so
`ingestRepo()` is testable without a network, a git binary, the-gap's CLI, or systemd. That is
earned abstraction: a test consumes it today.

Do not add:
- an interface with one implementation and no test consuming it,
- a config option nothing reads,
- a factory or wrapper layer "for future flexibility",
- a generic helper for a single call site.

If you cannot name the caller that needs it now, do not build it.

## Do not re-implement what exists

Search before writing. Known utilities: `slugify` (`ingest.ts`), `sanitizeToolArgs` / `repairSlug`
(`session.ts`, shared with the Agent SDK path), `splitChapters` (`convert.ts`), `panelBus`
(client cross-component events), `urlState` (hash deep-links), `graphCache`.

`slugify` already exists in three places across the two repos, and `DECAY`/`MasteryLevel` are
mirrored in `src/shared/engram.ts`. These are documented divergence risks. Do not add a fourth
copy of anything; import it or extend the existing one.

## Tests must assert behavior

The standard is set by the E2E suite: it drives a real browser against the real Hono server and a
real Engram process, then asserts the evidence landed in the student's file on disk.

Write tests that would fail if the feature broke:

- Assert observable state — response bodies, file contents, rendered DOM, recorded evidence.
- Cover the failure path you just wrote the guard for.
- Use the injectable deps to avoid network, not to assert that a mock was called.

Slop tests to avoid: asserting a spy was invoked and nothing else; `expect(true).toBe(true)`;
snapshotting a whole payload so any change "passes" after a re-record; a test whose name describes
the implementation rather than the behavior.

## Dependencies and types

- Adding a dependency needs a reason in the commit body. Engram next door ships three.
- No CDN fetches at runtime — fonts are bundled via `@fontsource` for a reason.
- `any` is used pragmatically at the AI-SDK boundary where upstream types are loose. Elsewhere it
  needs a justification. Never add `any` to silence a compiler error you have not read.
- Run `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/vitest run` before claiming done.

## Self-check before committing

1. Does any new line write to `pages/` or `students/` outside the MCP client?
2. Does every `catch` either recover meaningfully or log why it could not?
3. Can you name today's caller for every new abstraction?
4. Would each new test fail if you reverted the feature?
5. Did you actually run the typecheck and the suite, and are you reporting the real result?
