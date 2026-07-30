# Backlog — toward "this repo can help someone learn anything"

Written 2026-07-26. Ordered by **distance to the goal**, not by effort or tidiness. Everything here
is something I would actually build; anything I would not build is in the last section, with a
reason.

The goal has a precise failure mode worth stating once, because it decides every ranking below:

> The knowledge half already generalises. Ingest handles PDF/EPUB/DOCX/papers/repos; `web_search`
> and `read_url` cover subjects not in any file — and since the research rework they need no
> infrastructure, so the tutor researches a new subject itself instead of asking the learner to go
> find books for it; the graph queries are pure graph math with no domain knowledge in them; the
> student model is slugs and evidence. Point it at music theory and the memory layer does not care.
>
> **Applied practice is where it stops.** Of six blocks, `math_scratchpad` serves maths,
> `writing_draft` serves prose, `code_exercise` serves programming — and only artifacts someone
> hand-authored. `quick_check`, `quiz` and `structured_check` serve any subject, but the first two
> are model-graded and so (correctly, since `capApplied`) cannot mint `applied-correctly`. So for
> chemistry, statistics, music theory, languages, law: a learner can be probed and can explain, and
> has no way to *apply*. That is the gap.

Two invariants now enforce what the words mean, and both are load-bearing for everything below.
Do not weaken either without deciding to:

- **`capApplied`** (`src/server/grading.ts`) — only mechanically-verified grading may emit
  `applied-correctly`. `ev()` is the only evidence constructor and applies it; `source` is a
  required argument so a new block cannot forget to decide.
- **The `mastered` ceiling** (`engram/src/student/model.ts`) — `explained-correctly` caps at
  `practicing`. Progression is untouched (`isKnown` is true at `practicing`); what changes is that
  the top of the scale requires a machine.

---

## 1. Mechanical checkers for two more subjects

**CLOSED** (structuredCheckers.ts): `unit` (real unit algebra — 72 km/h satisfies 20 m/s),
`chem_equation` (conservation per element and charge, reaction pinned by species), `notes`
(semitone arithmetic, enharmonic-aware). All three both-directions tested; a chemistry or music
learner can now reach `mastered`. What remains of this item: more checkers as subjects demand them.

**Why first:** this is the only item that moves the goal rather than polishing around it. Every
other applied block is domain-locked; `structured_check` is not, and its five checkers
(numeric/set/sequence/matching/pattern) already prove the pattern generalises. Each new checker
unlocks real applied evidence — and therefore `mastered` — for a whole subject, with no
hand-authored content per exercise.

**What I would build**, in this order, because each is progressively less mechanical:

1. **Numeric-with-units, properly.** `gradeStructured`'s numeric checker already does tolerance and
   a substring unit check. Real unit *algebra* (via mathjs units, which is already a dependency)
   would grade physics, chemistry and engineering answers where the learner's unit is equivalent but
   not identical — `N·m` vs `J`, `km/h` vs `m/s`. Today those are marked wrong.
2. **Stoichiometry / equation balancing.** Parse a chemical equation, check conservation per element
   and charge. Entirely deterministic, and it makes chemistry a first-class applied subject.
3. **Interval and chord validation** for music theory. Note names → semitone arithmetic. Also
   deterministic, and it is the subject most obviously served by a checker nobody would think to
   write.

**Deliberately not on this list:** a "rubric checker". A model applying a rubric is still a model;
it belongs under item 6, not here.

**How to know it worked:** a learner studying chemistry can reach `mastered`. Today they cannot,
in any subject outside the three.

---

## 2. Generated exercises where a real suite already exists

**CLOSED, with a stated scope** (gap/generated.ts): a model authors a NEW exercise in the
async-generator-over-byte-chunks family (SSE, NDJSON, line protocols, framing — the family the
built-in runner executes); the harness slices case inputs into hostile chunks ITSELF so a suite can
never be chunk-aligned; the B2 gates run mechanically (reference passes, empty implementation
fails, scaffold fails, names leak nothing) and a failed gate auto-rejects; everything else lands
PENDING HUMAN REVIEW and only approved+verified exercises are served, seeded as pages, and counted
by the routes probe. The tutor can commission one in freeform (`generate_exercise`). NOT covered:
other exercise families, ladder rungs beyond full_body, and the client prose maps (plan/docs
offers) — a generated exercise gets the derived scaffolding only.

**Why second:** it unlocks breadth *inside* programming at near-zero content cost, and it is the
only place generated content is already safe, because the artifact's own test suite does the
grading. A model writes the prose; the sandbox decides correctness.

The bottleneck is concrete and countable: four maps in
`src/client/components/blocks/gap/handWrittenProse.ts` —
`PLAN_CONCEPTS_BY_ARTIFACT`, `PREDICT_ITEMS_BY_ARTIFACT`, `DOC_CARDS_BY_ARTIFACT`,
`PROBLEM_SPEC_BY_ARTIFACT` — plus `failureMessages.ts` and `seedPatternPages.ts`'s `PATTERN_PAGES`.
**Every one has exactly one entry: `stream-consumer`.** Practising a second pattern means
hand-authoring five more.

**What I would build:** a compile step that fills those four maps for a mined artifact from the
artifact itself — its tests, its names, its diff — and a review gate before any of it reaches a
learner. Plan in `docs/superpowers/plans/2026-07-25-generated-artifacts.md`, section B.

**Self-criticism to carry forward:** commit `23ed9fd` (mine) added `PROBLEM_SPEC_BY_ARTIFACT`, a
fifth hand-written per-artifact map. Good feature, and it made this bottleneck worse. No future pass
should widen it without saying so.

---

## 3. Say when a subject has no applied route

**CLOSED** (appliedRoutes.ts): the Page panel names the route that could confirm a page, derived
from what exists (ladder → code exercise; LaTeX in the body → scratchpad; structured_check always;
rubric last, labelled as capping below mastered) — and says outright when a programming page has no
ladder yet. No subject registry, as this item's own trap-warning demanded.

**Why third:** it is the honest completion of the ceiling I just shipped, and without it the ceiling
is quietly unfair. A learner studying contract law will now watch every page cap at `practicing`
forever, and the Page panel says "No exercise has confirmed it" — true, and impossible to act on,
because no exercise *exists*.

**What I would build:** a capability probe — given a page's domain/tags, which applied blocks could
serve it? — and copy that distinguishes *you have not done the exercise* from *there is no exercise
here yet*. Same sentence position, opposite meaning.

**The trap:** the obvious implementation is a per-subject registry, which is the same hand-authoring
bottleneck this whole backlog is about. Derive it from which checkers exist, not from a list.

---

## 4. Comprehension before production

**CLOSED** (PredictGate + /api/gap/predict): production rungs open with "what does the finished
function yield for this input?", graded by running the rung's reference server-side. The sibling-
artifact blocker died with per-rung entry points. First miss reveals nothing; second miss teaches;
skip always available; no evidence recorded.

**Why here and not higher:** it is the top *beginner* gap — nothing asks "what does this code do?"
before asking the learner to write it — but I attempted it and it is blocked on the sidecar.

**What I tried, and why it failed:** the clean mechanical version is *predict the reference's
output, graded by actually running it*. It cannot work: the worked_example rung's reference is a
**sibling artifact** (`frame-consumer`, whose entry point is `consumeStream`), and the sidecar's
harness only invokes the artifact under practice. Verified against the stand-in:
`ReferenceError: parseSSE is not defined`.

**What it needs:** either a sandbox endpoint that grades a prediction server-side (so the expected
value never reaches the client), or per-artifact hand-authored items — which is item 2's bottleneck.
Since the sandbox now ships inside the harness (src/server/gap/), that endpoint is ours to add
rather than a change to someone else's service — the blocker got strictly smaller.
`PredictRunPanel` already exists but is reactive (fires after 3 identical failing runs) and
hand-authored per artifact.

---

## 5. Visual and diagram modality

**CLOSED** (Mermaid.tsx + LabelDiagram.tsx): ```mermaid fences render as diagrams (correction to
this item's own claim: mermaid was NOT already a dependency here — it is now, lazy-loaded), and
`label_diagram` is the seventh block — tutor-drawn SVG rendered inert, click-click label placement,
region-membership grading, real applied-correctly for picture subjects.

**Why it matters to the goal:** several subjects are not primarily verbal. Anatomy, circuits, graph
theory, chord voicings, chemical structures. Today the app can only ever *describe* them. This is a
whole class of subject the system cannot currently teach well, not merely one it cannot grade.

**What I would build, smallest first:** render diagrams the tutor emits (Mermaid is already
supported by the artifact runtime and needs no new dependency), then a `label_diagram` block whose
grading is mechanical — the learner drags labels to regions, and region membership is arithmetic.
That last part is the interesting bit: it is an applied block that works for any subject with a
picture.

---

## 6. Decide the rubric question, with the mechanism now in place

**DECIDED AND CLOSED** (user said build it): `rubric-passed` is the third evidence kind — minted by
`writing_draft` with an explicit rubric where the rubric's list is authoritative over the model's,
capped at practicing, decaying on its own 14-day window, named separately everywhere the learner
looks. It can never launder into `applied-correctly`.

**Why last, and why not "never":** for history, law, literature and philosophy there is no
mechanical check and there will not be one. Either those subjects never get applied evidence, or
something judges quality. The reason this is *possible* to consider now and was not before: the
firewall exists. `capApplied` and the ceiling mean a rubric grade cannot silently launder itself
into `applied-correctly`.

**What I would build if you want it:** a third evidence kind — not a break in the firewall. A rubric
pass becomes visible in the graph as its own thing, with its own decay window, rather than borrowing
either existing label. That keeps `mastered` meaning what it now means and stops those subjects
being permanently second-class.

**This needs your decision, not my judgement.** It changes what the product claims.

---

## Craft debt worth clearing (small, real, no goal impact)

Ranked, and honestly labelled: none of these move the goal.

1. **Deterministic graph label placement.** Currently 0 overlaps measured across 4 viewports × 2
   scopes — but that rests on a collision-radius heuristic plus randomised seeding, so it is not
   guaranteed. A post-layout placement pass is the real fix.
2. **Per-panel loading states.** Error and empty states are consistent across Graph/Page/Library
   now; loading is still ad hoc ("Loading…", "laying out the graph…").
3. **`quiz` per-item source in the UI.** The evidence note says `(model-graded)` and the graded card
   does not. A learner cannot see which items were checked and which were judged.
3a. ~~`structured_check` answer inputs are plain text.~~ **Closed**: answers preview as they type
   (`answerDisplay.ts` — H2O reads as H₂O, SO4^2- as SO₄²⁻, `$…$` through KaTeX) and the graded
   card shows the same form. Display only; grading still sees the raw string, pinned by test.
4. **The flaky test, now named.** "CodeExercise — single-rung mined flow completes via Submit with
   the pinned result contract" failed once in a full run (2026-07-26, audit loop iteration 2) and
   passed twice in isolation immediately after, and the full suite passed on re-run. Timing-shaped,
   full-suite-only. Next occurrence: capture the seed/order vitest used.
5. **`structured_check` placement.** Renders inline; the other applied blocks use the Stage. Decide
   which, deliberately.

## Research: what the rework closed, and what it left open

Closed: research no longer needs a self-hosted SearXNG. An Anthropic-routed tutor gets
`web_search` from Anthropic's server-side search (`web_search_20260209`, dynamic filtering), so the
API key the tutor already requires is the entire setup — and `read_url` is now ungated, because it
never needed infrastructure in the first place. Research also unlocks in `learn`/`review`/`quiz`
when the vault has no page for what the learner asked, which removes a dead end: that turn used to
have no search, no `write_page` and no ingest, so its only honest move was to refuse.

Still open, and deliberately so:

1. **An `ollama:` tutor with no SearXNG has `read_url` but no search.** A provider-executed tool has
   no meaning off Anthropic's servers. The fix, if it is ever worth it, is a locally-executed
   `web_search` that makes its own one-shot Anthropic call and returns the results — that would make
   research infra-free for *every* route, at one extra model call per search. Not built because it
   serves only the local-model path, which already requires configuration.
2. **Not verified against the live API.** No `ANTHROPIC_API_KEY` was available, so what is proven is
   the request shape — a fake Anthropic endpoint records `type: web_search_20260209`,
   `max_uses: 8`, with `read_url` surviving the same tool-set merge (`tests/webtools.test.ts`). The
   first run with a real key should confirm results actually come back and land in `sources`.
3. **Nothing found in a teaching-mode turn is saved.** By design — writing stays freeform-only, so
   the single-writer rule holds — but it means the learner has to switch modes to keep what they
   just learned. Whether that is the right trade is a product question, not a bug.

## Setup and packaging: what shipped, and what is left

Closed: the app starts with nothing but an API key, and `npm run dist` produces one downloadable
file. Every config field now has a working default, the config file itself is optional, the vault is
created at boot in `~/Documents/Engram`, Engram is found rather than configured, and the API
key has a real first-run flow that probes Anthropic before saving and stores the key outside the
vault. The desktop shell bundles both repos: the harness serves its own built client on one port and
spawns the vendored Engram over stdio exactly as in development.

Still open:

1. **No application icon** — the default Electron icon ships. Cosmetic, and the first thing anyone
   will notice.
2. **No code signing or notarization.** On macOS that means Gatekeeper blocks it; on Windows,
   SmartScreen warns. Both need certificates, which is a purchasing decision, not a coding one.
3. **Only the Linux AppImage has been built and launched.** The mac and win targets are configured
   and unverified, and both need to run on their own OS to be built at all.
4. **No auto-update.** `publish` is deliberately null. Adding an update channel means picking a place
   to host releases.
5. **230MB.** Electron is ~180MB of that and there is no cheap fix; the app's own asar is 131MB,
   which is worth a look (mathlive, katex and codemirror are large and only some paths need them).
6. ~~The gap sidecar is absent by default, so a fresh install has no `code_exercise` block.~~
   **Closed by building the sandbox in** (`src/server/gap/`): the stream-consumer ladder and a
   child-process grader now ship inside the harness, so a fresh install — including the packaged
   AppImage, verified live — runs real code exercises with zero config. The external sidecar
   remains the fuller thing and takes precedence when configured. What stays true: one pattern.
   Widening that is item 2 of the main list, unchanged.

## Closed by measuring — do not re-open

- **Focus indicators.** All 16 tab stops with five blocks rendered, checking outline, box-shadow and
  the graph's ring child. Nothing missing.
- **Touch targets.** Smallest is 29×29. WCAG 2.2 SC 2.5.8 (AA) wants 24×24; everything clears it.
  Recorded in `design.md` as an accepted deviation from the AAA 44px.
- **`font-display`.** @fontsource ships `swap` on all three families. FOUT against Georgia and
  system-mono, not FOIT.

## Not to be re-raised (settled — see design.md § Accepted deviations)

hex over OKLCH · informal rem spacing · no macrostructure/nav/footer on an app shell · no CSS
Hallmark stamp · `--border` at 1.30:1 by default, mitigated and 3.05:1 under `prefers-contrast: more`.

## A note on method, from getting it wrong twice this session

Both mistakes had the same shape: a claim asserted from reading rather than measuring.

- The graph was reported fixed at "74% fill" by an earlier pass. It measured **7%**. The cause was
  visible only by instrumenting the fit, not by looking at it.
- The `mastered` ceiling's obvious one-line implementation **demoted** a learner who had earned
  `mastered` and then explained the topic. Caught only because the test was written before the
  implementation was trusted.

So: a fill/overlap/contrast claim needs numbers from several viewport sizes, taken *after* the
simulation settles. A grading-rule claim needs a mutation test — break the rule deliberately and
confirm the suite notices, in **both** directions. When the over-broad mutation of `capApplied`
failed only 2 tests where the neutered one failed 6, that asymmetry was the bug report.
