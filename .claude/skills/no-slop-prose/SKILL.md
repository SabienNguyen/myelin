---
name: no-slop-prose
description: House writing style for this repo — use whenever producing or editing prose here: READMEs, docs/superpowers specs and plans, code comments, commit messages, PR titles and bodies, user-facing UI copy, and replies about this codebase. Also use when reviewing prose in a diff. The goal is prose that reads as though a careful engineer wrote it for one specific reader, not as though a model filled a template.
---

# No-Slop Prose

Slop is not bad grammar. Slop is text that is *structurally indifferent to its reader*: padded,
hedged, symmetrical, and confident about nothing. It passes a spellcheck and teaches nothing.

Every sentence must carry information the previous sentence did not. If you delete a sentence and
the reader loses nothing, it was slop — delete it.

## The tells

**Throat-clearing.** Never open by announcing what you are about to say, restating the request, or
summarizing the document inside the document.

- Slop: "This document provides a comprehensive overview of the various considerations involved in..."
- House: "Mastery decays: `mastered` needs reinforcement within 45 days, `practicing` within 21."

**Filler vocabulary.** These words almost never survive a rewrite. Delete or replace with the
specific thing:

`comprehensive` · `robust` · `seamless` · `leverage` · `utilize` · `delve` · `crucial` ·
`vital` · `elevate` · `unlock` · `harness the power of` · `it's important to note that` ·
`it's worth mentioning` · `at its core` · `in today's landscape` · `best practices` ·
`cutting-edge` · `game-changing` · `simply` · `just` · `easily` · `powerful` · `rich`

**Empty intensifiers on your own work.** Do not call your change robust, thorough, clean, or
elegant. State what it does; let the reader judge.

**Hedge stacking.** One qualifier is honest, three are cowardice. "This may potentially help in
some cases" → say what it does, and separately say what it does not cover.

**Symmetry padding.** Rule-of-three triads (`fast, simple, and reliable`), paired clauses that
restate each other, and "not only X but also Y" are rhythm standing in for content.

**Bold-everything.** If four phrases per paragraph are bold, none are. Bold marks the one term a
scanning reader must not miss.

**Emoji.** None. Not in commits, comments, docs, headings, or UI copy. The repo has zero and stays
that way. Icons come from `@phosphor-icons/react`.

**Closing summaries.** A short document does not need a "Summary" or "Conclusion" restating itself.
End when you are done.

**False completion.** Never write "verified", "tested", "all passing", or "works" for something you
did not run. If tests failed, say so and paste the output. If a step was skipped, say which.

## Em dashes: this repo uses them, correctly

Do not cargo-cult a ban. The house style uses `—` for appositives and for cross-references,
tightly bound to the clause it modifies:

> External vault edits (e.g. a user editing Obsidian directly) aren't covered here and fall
> through to the cache's own TTL — see `graphCache.ts`.

That earns its dash: it appends a pointer the sentence needs. What is banned is the *decorative*
dash — one per sentence, three per paragraph, used where a comma or full stop belongs.

## Code comments

The house pattern is **incident-driven**: a comment exists to record the failure mode that made the
code look strange, so the next reader does not "simplify" the fix back into the bug. Read
`src/server/mcp.ts` and `src/server/session.ts` for the standard.

Good — names the hazard, the cause, and the consequence of reverting:

```ts
// Ledger only on delivery — a headless boot's failed notify-send must retry next tick.
```

```ts
// predictable: true makes functions like log()/sqrt() return NaN (not a Complex) outside
// their real domain, so the NaN-equality short-circuit below actually fires
```

Slop — restates the line beneath it:

```ts
// Create the MCP client
const client = await createMCPClient(...)
// Loop through the pages
for (const p of pages.values()) {
```

Rules:
- Comment the **why**, never the **what**. The code already says what.
- Prefer a comment that would stop a future refactor from reintroducing a bug.
- Record deviations from a plan honestly, with how you verified (see `convert.ts` on `pypdf` vs
  `pypdfium2`).
- Never annotate authorship or recency: no `// NEW:`, `// Added per request`, `// Updated`,
  `// AI-generated`. Git owns that.
- Do not leave commented-out code. Delete it.

## Commit messages

Imperative mood, and the subject line must name the *mechanism*, not the vibe. Real examples from
this log:

```
Fix lost-update bug in compile-queue ledger: serialize writes via updateQueue
Cache GET /api/graph (TTL + stale-while-revalidate)
Graph tab: replace layered DAG diagram with an Obsidian-style force graph
Export compileOne as the targeted per-chapter recompile seam
```

Slop equivalents to avoid: `fix: various improvements`, `refactor: improve code quality`,
`Update graph endpoint`, `chore: cleanup`.

Body (when one is needed): why the change was necessary, and what a reader would otherwise get
wrong. Not a bulleted restatement of the diff.

## PR bodies

Describe the change and its risk. No "Summary / Changes / Testing" scaffold unless the repo
template asks for it. No emoji headers. If you did not run the tests, the Testing section says
which ones you did not run.

## UI and tutor copy

Terse, lowercase-leaning, no exclamation marks, no praise theatre. `auto-compiling in the
background` is the register. Never `Oops!`, `Great job!`, `Let's get started!`.

The tutor system prompt already bans narrating block mechanics ("The block is displayed", "Go ahead
and answer above"). Hold UI strings to the same bar: say the new thing or say nothing.

## Self-check before writing prose out

1. Delete every sentence whose removal loses no information. Is anything left?
2. Search your draft for the filler list above. Zero hits?
3. Does any sentence claim work you did not do?
4. Would a busy engineer who knows this codebase learn something in the first ten words?
