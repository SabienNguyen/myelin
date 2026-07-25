# Paradigm teardown — what to take, what to refuse

**Date:** 2026-07-25
**Status:** Research. No implementation committed.

## Sourcing caveat

`producthunt.com/products/paradigm-3` and `paradigm.study` both return **403** to automated fetches,
so nothing here is quoted from the product itself. Every claim below comes from search-result
snippets of the Product Hunt listing and press coverage (PR Newswire, July 2026). Treat the feature
list as *approximately* what they advertise, not as verified behavior. Anything we build on top of it
should be re-checked against the live product first.

## Why this product matters to us

Paradigm is the closest public analogue to loreweaver-harness: "turn any goal into a personalized,
adaptive learning path," with an AI tutor (**Clover**) where "notes feed the tutor, the tutor knows
what you've practiced, and your practice adapts to where you're struggling." It ranked #1 on Product
Hunt for 2026-07-16.

The overlap is not superficial — it is the same thesis. Where we differ is instructive:

| | Paradigm | loreweaver-harness |
| --- | --- | --- |
| Knowledge store | opaque, cloud | plain Obsidian markdown vault you own |
| Student model | "graded as it happens" | evidence-graded, typed kinds, 45/21-day decay |
| Writer boundary | unknown | Loreweaver is the only writer of pages/students |
| Models | hosted | Anthropic API, local Ollama, or subscription via Agent SDK |
| Coding practice | cloud machine + terminal + Claude Code | the-gap sidecar, gauntlet-graded ladders |
| Reach | consumer, free tier | single-user localhost |

We are architecturally stronger on ownership, honesty of the mastery signal, and offline/local
operation. They are ahead on **surface area per unit of student effort** — the same evidence we
already collect gets turned into more useful artifacts. That is the gap worth closing.

## Ranked recommendations

Ordered by leverage per unit of work. Each names what already exists so the estimate is real.

### 1. Weak-topic cheat sheet generator — highest leverage, smallest change

**Theirs:** Clover "notices when your professor allows a cheat sheet and can build one around exactly
the topics you're weakest on."

**Ours today:** we have strictly better raw material and expose none of it. `get_student_state` with
a slug already returns effective level, the full evidence list, `misconceptions[]`, and
`last_reinforced`. Nothing in the UI turns that into an artifact.

**Build:** a route that ranks pages by weakness (effective level ascending, then misconception count,
then decay proximity), pulls their bodies via `read_page`, and renders a one-page condensed sheet —
misconceptions first, since those are the known failure modes.

- Model role: reuse `card_gen` (already tuned for atomic, compressed output). No new role, no config
  change.
- Surface: a button in `LibraryPanel`, output written to `vault/.harness/sheets/<date>-<scope>.md` so
  it is a file the learner keeps, and rendered through the existing `MarkdownText`.
- Scope argument: a goal slug or a path slug, so "cheat sheet for the exam on X" narrows the set.

**Why it fits:** read-only against the vault, writes only to `.harness/` — no single-writer violation.
The hard part (knowing what the learner is weak at, with evidence) is done.

### 2. Past-paper ingestion → pattern-matched question bank

**Theirs:** upload past papers, the platform analyzes the patterns and generates questions from them.

**Ours today:** `ingestBook` already switches on `mode: 'book' | 'paper'`. `quiz_gen` is a configured
role with no dedicated pipeline feeding it. The `quiz` block schema already carries per-item `type`,
`prompt`, `choices`, `expected`, and `pageSlug`, and `gradeBlockOutput` already grades per item and
emits per-slug evidence.

**Build:** a third mode, `mode: 'exam'`. It converts like any other upload but does **not** compile to
concept pages. Instead it extracts a pattern profile — question format mix, topic distribution
against existing page slugs, marks, recurring stems — into
`vault/.harness/exam-patterns/<slug>.json`. `quiz_gen` then generates quiz blocks matching that
distribution, tagged to real slugs.

- Reuses: `convert.ts` end to end, the ledger, and the entire grading and evidence path unchanged.
- The new code is the extraction prompt plus a small profile schema.

**Watch:** an exam paper is not a concept source. It must not enter the compile queue as `pending`, or
the compiler will write concept pages out of exam questions.

### 3. Learner-authored notes as a first-class source

**Theirs:** "your notes feed the tutor."

**Ours today:** the vault is model-compiled. Every page is written by Loreweaver on an agent's
instruction. The learner has nowhere to put their own words that the tutor will read, and
`buildBootstrapContext` has no notes channel.

**Build:** `vault/notes/` — the learner's territory, never rewritten by the compiler. Surface recent
or goal-relevant notes in the bootstrap context, and make them searchable alongside pages.

**Why this one is architecturally clean:** it *strengthens* the single-writer rule rather than bending
it. Three territories, one writer each: `pages/` + `students/` → Loreweaver; `.harness/` + `raw/` →
the harness; `notes/` → the human. Obsidian already edits all of it.

**Design question to settle first:** do notes become evidence? Recommendation: **no.** A note is
unverified self-report; promoting mastery from it would breach the rule that mastery comes only from
graded work. Notes should *inform what the tutor probes*, then the probe produces the evidence.

### 4. Goal → auto-generated learning path

**Theirs:** "turn any goal into a step-by-step path that evolves with your progress."

**Ours today:** we have every piece and never assemble it. `unmetPrereqs` already does the topological
walk from a goal through unknown prerequisites, `next_lessons` already accepts a `goal`, and
`create_path` already persists an ordered path with narrative. Nobody chains them.

**Build:** given a goal slug, run `unmetPrereqs`, hand the ordered list to the tutor to write the
narrative, and persist via `create_path`. Then the existing Library path UI shows progress.

This is the cheapest item on the list — mostly wiring, and the graph math is already tested.

### 5. Surface "proof of skill", not a transcript

**Theirs:** "every interaction is graded as it happens, so what you walk away with is proof of skill,
not a transcript."

**Ours today:** we are *already* the stricter system and get no credit for it. Evidence kinds
distinguish explained from applied; Anki reviews are capped at `exposed` and can never fake
application; mastery decays; the guardrail logs when the tutor fails to record.

**Build:** a skills report — per page, the effective level, the specific evidence that earned it with
dates, the decay clock, and open misconceptions. Export as markdown.

This is presentation over an existing model, and it is the most defensible thing we have. The
`GraphPanel` already visualizes mastery; this is its per-page, evidence-level companion.

### 6. Multi-modal tutor surfaces — take the framing, not the scope

**Theirs:** "one tutor that builds whatever the moment calls for (a spoken conversation, a coding
sandbox, a full desktop)."

**Ours today:** five block types plus the-gap sidecar. The *framing* is already ours — the tutor picks
the block, the harness grades it. What we lack is voice.

**Recommendation:** note it, do not schedule it. Speech would need a new duplex transport, and every
block currently grades a text or code artifact. The architectural cost is high and the mastery signal
gained is low. Their "full desktop" is closer to our coding-stage plan than to a new modality.

### 7. Cloud machine with Claude Code — we are already aimed here

Paradigm "spins up a real cloud machine — terminal, Claude Code, the works — and walks you through it
keystroke by keystroke." That is adjacent to `docs/superpowers/plans/2026-07-21-coding-stage.md`
(in-IDE tutor help, repo mining, improvement loop) plus the-gap ladders.

Difference worth noting: theirs is an open-ended machine; ours is a gauntlet-graded ladder where a
rung only passes on real tests. Ours produces a trustworthy `applied-correctly`; an open desktop
mostly cannot. **Keep the ladder.** Borrow only the onboarding idea — walk the learner to something
running end to end, rather than starting at an isolated exercise.

## What we must refuse

Feature-mining a consumer product is how architecture erodes. These are not up for trade:

1. **Single-writer vault.** Anything that writes `pages/` or `students/` outside Loreweaver.
2. **Evidence integrity.** No feature may promote mastery without graded work. Notes, uploads,
   time-on-task, and self-report are not evidence. The Anki ceiling stays.
3. **Decay.** A cheat sheet or a skills report must read *effective* level. Reporting raw `mastered`
   for a page untouched for 60 days is exactly the flattery this system exists to refuse.
4. **Plain-markdown ownership.** No feature justifies a proprietary store. New artifacts land as files
   in the vault.
5. **Offline/local operation.** Every addition must survive `embeddings: "none"`, Anki closed, and no
   the-gap sidecar — the established "feature off when absent" pattern.

## Suggested order

Items 1, 4, and 5 are small and touch no invariant — they turn existing data into artifacts. Item 3
needs the notes-are-not-evidence decision made first. Item 2 is the largest and should follow the
existing plan format under `docs/superpowers/plans/` before any code.

## Sources

- [Paradigm on Product Hunt](https://www.producthunt.com/products/paradigm-3) (403 to fetch; via search snippets)
- [Best of Product Hunt: July 16, 2026](https://www.producthunt.com/leaderboard/daily/2026/7/16)
- [Paradigm: The AI Education Start-up Fighting to Save Learning](https://www.prnewswire.com/news-releases/paradigm-the-ai-education-start-up-fighting-to-save-learning-302549051.html)
- [paradigm.study](https://www.paradigm.study/) (403 to fetch)
