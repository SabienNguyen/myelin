# 2026-07-28 — A structured page template for compiled pages (proposal)

**Status:** proposal only, owner decision. Nothing here is implemented. The change it describes edits
`src/server/compile-prompt.md`, which shapes every future compiled page and therefore what the
grading model and the graph see — a pedagogy/product call, not a mechanical fix. Written to be
accepted, rejected, or amended, not merged as-is.

## Where this came from

A request to evaluate the trending [`virgiliojr94/book-to-skill`](https://github.com/virgiliojr94/book-to-skill)
repo for transferable insight. book-to-skill turns a technical-book PDF into a compact Claude Code
*skill* — a read-only reference artifact for an agent. Engram and it share the whole front half
(book → structured knowledge, chunk large sources, keep cost proportional to output) and then
diverge completely: book-to-skill emits a static reference; Engram emits *tutored learning* with
a typed knowledge graph, mechanical honest grading, and mastery/decay. Engram is the more
ambitious system, not the one behind.

But book-to-skill does one thing Engram currently does not: it compiles each chapter against a
**fixed section template** rather than freeform prose. That single idea is the only part worth
importing, and only if it earns its place against the tool's own ethos.

## The current shape

`compile-prompt.md` step 2 asks the compile model for:

> `body`: a self-contained explanatory body written from THIS chapter's content only. Use
> `[[wiki-links]]` to reference other concepts where relevant.

That's the entire instruction for the body. The result is well-grounded prose (the hard rules keep it
honest — never invent facts, keep it short when the chapter is thin), but its internal *shape* is
whatever the model chooses per page. Two pages compiled from the same book can be organised
completely differently.

## The proposal

Give the `body` an optional section skeleton, adapted from book-to-skill's chapter template and pared
to what Engram's own machinery already values:

| Section | Why it belongs in Engram specifically |
| --- | --- |
| **Core idea** | one-paragraph atom — matches "extract 2-6 teachable, atomic concepts" |
| **Key concepts** | the substance; this is today's freeform body |
| **Mental models** | the intuition a tutor reaches for — good raw material for `quick_check` comprehension probes |
| **Anti-patterns** | the specific misconceptions to test — feeds `structured_check`/`quiz` distractors and the `misconception` node state the graph already renders |
| **Worked example** | the applied instance — what an `math_scratchpad`/`code_exercise` can be grounded in |
| **Connects to** | prose statement of the edges the model *already emits* as `prereqs`/`deepens` — surfaced to the reader instead of living only in frontmatter |

The last row is the strongest argument. The compile model **already** decides prereq/deepens edges
(step 2, with `proposedLinks` verification). "Connects to" asks it to say *why* in one line — which is
exactly the edge rationale the graph shows on hover. No new work for the model; it just writes down a
judgment it was already making.

"Anti-patterns" and "Mental models" are the second argument: they are the atomic, testable content
the honest-grading side is starved for. A page that names its misconceptions hands the quiz/structured
generators better distractors, and distractors are what keep `applied-correctly` honest (see the
matching checker's distractor rule).

## Why this is genuinely owner-gated, not a fix I should just ship

1. **It feeds the grading model and the graph.** The body is not decoration — downstream, the quiz and
   card generators read pages, and the tutor teaches from them. A format change is a change to the
   substrate every other subsystem stands on.
2. **Rigidity risk.** The tool's ethos is "density over completeness" and "keep the page short rather
   than filling gaps." A fixed template invites the model to pad thin chapters to fill empty sections —
   the exact failure the current hard rule forbids. Any template MUST be explicitly optional
   ("omit a section rather than invent its content"), or it fights the honesty rule.
3. **It is subjective pedagogy.** Whether a learner is served better by shaped sections or by prose the
   model organised for *this* concept is a teaching judgment, and the current freeform choice may be
   deliberate.

## A minimal, reversible experiment (if accepted)

Not a rewrite — a bounded A/B a human can judge:

1. Add the section skeleton to `compile-prompt.md` as **optional** guidance, with an explicit
   "omit any section rather than invent content for it; a thin concept is still one page" rule that
   preserves the density ethos.
2. Compile the same 2-3 chapters both ways (the prompt is the only variable — the harness already
   supports re-compiling from the queue).
3. Diff the pages and read them as a learner: is the structured version denser and better-connected,
   or is it padded and repetitive? Check the "Connects to" lines against the actual emitted edges.
4. Keep only if the structured pages are honestly better. The change is one prompt file; reverting is
   one commit.

## What is explicitly NOT proposed

- No schema change. `write_page`'s contract is untouched; this is prose guidance only.
- No change to grading, mastery, decay, or the graph.
- Not the rest of book-to-skill: its REPL grep/sed probing is largely covered by `chunkChapter`, and
  its `cheatsheet.md` decision-rules idea is a separate, smaller note (could seed applied `matching`
  exercises) parked here deliberately.

## Recommendation

Worth the experiment specifically for the "Connects to" and "Anti-patterns" sections, because both map
onto machinery Engram already has (graph edges; distractor-hungry checkers) rather than bolting on
a new idea. But it is the owner's call to run it, and the template must stay optional to survive
contact with a thin chapter.
