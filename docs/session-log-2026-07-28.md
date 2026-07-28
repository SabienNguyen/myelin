# Session log — 2026-07-28 (the overnight audit arc)

You were away; the standing instruction was "keep working, find things to do." The method stayed
the same as yesterday: drive the real app in a real browser, fix what breaks, prove every fix
live, ship each one to master. Twelve fixes shipped across both repos; CI stayed green
throughout. The verdict doc (`learning-ui-verdict.md`) has the blow-by-blow; this is the arc.

## The cold-start story (the best product change of the day)

A brand-new vault opened in `learn` mode — whose single-writer rule deliberately forbids
`write_page` — so a newcomer's very first lesson was researched well, taught well, and then
**evaporated**: no page, no graph node, nowhere for evidence to land. The empty-state hero
promises "your tutor writes pages as you go"; the default mode couldn't keep that promise.

The fix: the client asks the graph before settling on an opening mode. Nothing real to teach
from → open in **freeform** (the mode that writes pages); the first real page flips future
sessions back to `learn`. Re-driven live: the same first question now produces a 7-stop
backprop syllabus path and seven sourced pages in a single turn. The newcomer vault built that
day became the standing audit fixture — a realistic mid-journey learner with mixed mastery.

## Fixes shipped (harness, all live-found and live-verified)

1. **Cold-start mode from vault state** — above.
2. **MathLive's private LaTeX dialect** (`\differentialD` and friends) rendered as red error
   text in the learner's own derivation; KaTeX macros now translate it.
3. **Mid-thread mode switches acted on stale context** — session context was first-turn-only,
   so "review" over an old thread lectured about forgetting curves instead of re-proving the
   slipped page. Both tutor routes now re-inject fresh, marked context on a switch.
4. **A tab closed mid-answer lost the whole assistant turn** (the cause of yesterday's quiz
   "still open above" divergence). The server now persists the turn itself when the query work
   completes, with an id handshake so the client's own save converges instead of duplicating.
   The first attempt (an onEnd tap) failed exactly the way it was meant to fix — documented.
5. **"resume at nn-forward-pass"** — raw slug in learner-facing copy; the server now resolves
   the next page's real title, degrading to the slug only when unreadable.
6. **A shown-work numeric answer read as "no number found"** — the extractor only looked at the
   string's start. It now finds the number a derivation means (after the last `=`, or a lone
   number in prose) and still refuses to guess on genuine ambiguity.

## Fixes shipped (loreweaver)

7. **A misconception no longer resets the decay clock.** Every evidence kind stamped
   `last_reinforced = today` — so recording a learner's *confusion* extended the system's trust
   in their mastery by a whole fresh window. `last_reinforced` now means "when the current
   standing was established"; struggled still restarts it (the demotion's clock), misconception
   never does.

## Verified clean (driven live, no fix needed)

- Thread history switching, deep links, dark mode (a suspected dark-theme bug was chased to raw
  pixels and found false — lesson recorded about judging themes from downscaled screenshots).
- Quiz multi-item flow **keyboard-only** (five tabs to fill four items), including the
  interrupted-stream recovery: told honestly "the quiz vanished," the tutor re-staged it
  identically.
- Anki backlog badge in its real trigger state, both themes, fresh-install guard intact.
- The review queue on honestly-crafted decay: slipped-first ordering, count badge, decay-aware
  path meter; the full decay → review → re-proof → un-slip loop closed on the newcomer vault.
- The session-plan CTA: right plan, right order, probe-before-reteach honored (its first probe
  is what exposed fix #6).
- "Set as goal": persists, renders, and orients the next sitting unprompted. A hallucinated
  wrong-prefix block call exercised the whole degrade-loudly chain live — SDK refusal, honest
  ✗ marker, same-turn retry, no duplicate block — and was deliberately left as designed.
- A RoPE deep-dive on the marathon vault: researched teaching, graded rotation-math probe, and
  the material folded into the existing positional-encoding page (canonical sources) rather
  than fragmenting — augment-don't-fragment observed unprompted.
- writing_draft on live content: exact span annotations, honest 2/4 rubric, and a correct
  audience-fit judgment (accurate-but-jargon statements flagged for the stated junior reader).

## Process notes (honesty section)

- Two "live verifications" early in the arc ran against a **stale server**: killing by config
  path matched wrapper shells, not the node children holding the port. Both proofs were re-run
  against clean boots (one passed as-is, one — the persistence fix — was actually broken and
  got rebuilt properly because of the re-run). Backend restarts now kill by PID.
- Three drive scripts lost turns by closing the browser mid-stream before fix #4 existed; the
  reliable turn-complete signal is the thread-save PUT, not the working indicator.

## State when you read this

- Both repos: masters green, branches in sync, worktrees clean. Harness CI green through every
  completed run; suite crossed **1,000 unit tests** plus 8 browser specs.
- The AppImage is rebuilt current and its contents verified by inspection (every fix above is
  in the artifact, including the bundled loreweaver decay fix).
- loreweaver was still **private** at every check — the flip watch (and the full-CI trigger it
  fires) remains armed.
