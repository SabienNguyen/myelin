# 2026-07-28 — Autonomous hardening pass: findings and open decisions

**Status:** summary of an autonomous session. The four fixes below are shipped on
`claude/analyze-repos-dinnsr` (harness) and green. The three decisions at the end are deliberately
NOT actioned — each changes product/pedagogy behavior on a judgment call, and guessing wrong churns
the codebase against intent. This doc exists so the decisions are actionable from one place instead
of a chat transcript.

## What prompted it

"Look up book-to-skill — is any of its code valuable insight for this system?" The answer (one idea
transfers: a structured page template — see `2026-07-28-structured-page-template.md`) became the
seed of a broader pass: drive every flow in the real app, cross-check state, sweep bug classes,
then read and test the core engine.

## Shipped fixes (4)

| Commit | Fix | How it was found |
| --- | --- | --- |
| `9e23caa` | `structured_check` renders on the Stage, like every other applied block — it was the lone applied block rendering inline, though the Stage's own empty copy advertises "science checks". | Drove the matching flow; saw the interactive form land in the transcript, not the Stage. |
| `6b1164a` | `/api/status` names the live student, not the one captured in the boot snapshot. The topbar polls it every 60s, so a learner switch silently reverted the displayed name within a minute. | Cross-checked `/api/status` against `/api/students` — they disagreed in the same breath. |
| `0ffa950` | Due-count badge aria-label: "1 page", not "1 pages". | Drove the ReviewQueue with a crafted slipped-page fixture. |
| `0e85603` | Graph node aria-label: "1 day until decay", not "1 days". | Swept the pluralization class the badge bug revealed. |

Method that worked: drive the actual flow with realistic state, don't trust the happy-path
screenshot; when a bug reveals a class (pluralization, staleness), sweep the class.

## Swept clean (no defects)

- **Staleness** (boot-snapshot vs live cfg): tutor + student now re-read; `autoCompile` is immutable.
- **Pluralization**: two aria-labels fixed; no other unguarded `${n} nouns` in the client.
- **Capped-count / honest-total**: `/api/due` returns an uncapped `total`; ReviewQueue shows it.
- **Swallowed errors** (degrade-loudly): every silent catch is a malformed-body→400, a title→slug
  fallback, or a genuinely best-effort op. None hide a failure that should be loud.
- **Core durability**: `atomicWrite` is deliberately scoped to student state ("the one irreplaceable
  thing this vault holds"); review-log and rationales are non-atomic by design (regenerable / not
  load-bearing).
- **Core queries** (`frontier`/`nextLessons`/`unmetPrereqs`): correct. Minor: `reviewDue` is unsorted
  so `nextLessons`' "top 2 review" is arbitrary order — harmless, the harness session-plan sorts its
  own review queue.

Coverage: every block type (8) driven or e2e-covered; Add-material ingest (temp-dir fix re-validated
live — scratch cleaned, learner's file preserved); SourceReader + select-to-ask on real ingested
prose; graph/page/library/review/student-switcher/cold-start/Anki-badge; a full multi-step journey
with zero console warnings. Both suites green (harness full, core 101).

## Confirmed feature drift — highest priority (bounded fix, needs greenlight)

### 0. `generate_exercise` is missing from the Claude-subscription tutor route

The two tutor routes must offer the same tools — `claudeSdkTutor.ts:30-32` says so outright: "keep in
sync by hand; a divergence here means the two tutor routes disagree on tool access." They have
diverged. `session.ts` (the ai-sdk / API-key route) wires `generate_exercise` in freeform
(`session.ts:617`); `claudeSdkTutor.ts` (the Agent-SDK / Claude-subscription route) does not wire it
at all. So a learner on a Claude subscription cannot have the tutor author a practice exercise
(function / manifest / exec / stream families — the entire generated-exercises feature), while an
API-key learner can.

This is almost certainly an oversight, not a deliberate exclusion: the research tools that ARE
deliberately absent from this route (`web_search`, `read_url`, `ingest_url`, …) carry an explicit
"these DO NOT EXIST on this route, use WebFetch instead" note in the prompt (`claudeSdkTutor.ts:296`),
because the Agent SDK ships its own WebSearch/WebFetch. `generate_exercise` has no such note and no SDK
equivalent — it is silently gone.

The fix is bounded: the exercise logic (`generateExercise`) is shared, so porting is re-expressing the
tool in the Agent SDK's `tool(name, desc, schema, handler)` shape (the `course_problems` port at
`claudeSdkTutor.ts:201` is the template — handler returns MCP content blocks), adding it to the
freeform `allowedTools`, and naming it in the prompt. Not a pedagogy call — the intent (parity) is
unambiguous. Held for greenlight only because it edits the tutor query pipeline that subscription
users depend on, and a subtly-wrong port there is the kind of thing an absent owner shouldn't inherit
unverified. **On your word I'll port it, with tsc + the route's tests + a live drive confirming the
tool is callable.** (Separately: `ingest_paper` is also absent, but that one IS covered by the
prompt's deliberate "use WebFetch" note — read-vs-ingest is a real capability gap but a documented,
arguably-intended one; flagging for completeness, lower priority.)

## Open decisions (owner)

### 1. Decay cascade: should long-stale `mastered` pages reach `exposed`?

`effectiveLevel` (`loreweaver/src/student/model.ts:29-34`) demotes `mastered`→`practicing` after 45
days, but the `practicing`→`exposed` rule checks the RAW level — which never becomes `practicing` for
a stored-`mastered` page. Verified empirically:

| Page | effective now |
| --- | --- |
| mastered 6 years ago | **practicing** (counts as "you can do this right now") |
| practicing 6 years ago | exposed |

So a page mastered years ago and never touched is still counted in ProgressCard's "pages you can do
right now" (while also flagged slipping). Two readings: deliberate durability (mastery is durable,
degrades to "needs a refresher", surfaced via `slipped`) OR a broken cascade (the raw-vs-effective
slip that's easy to write by accident). Three things tilt toward bug: the parallel `if` structure
implies cascade; no comment explains the stop-one-rung choice in a codebase that comments every
honesty tradeoff; no test pins the long-stale-mastered case. But the FIX is a pedagogy call, not
mechanical — a naive "check effective level" makes `mastered` skip the practicing grace and hit
`exposed` at 45d (since 45 > the 21d window from the same date); correct cascade needs an explicit
threshold (e.g. `masteredDays + practicingDays` = 66d), and that number is a judgment. **Decision
needed: cascade or not, and the threshold.**

### 2. Voice scoping: per-student or global?

The teaching-style ("voice") preference lives in the per-student StudentSwitcher dialog and its
comment says it "lives with the profile", but `PUT /api/voice` stores it in the global harness config
(`restRoutes.ts:433`), and the core student model has no voice field. Two learners sharing a vault
share one teaching style. Recommendation: per-student — implementable harness-only (a per-student
voice map in config, backward-compatible, no core change). **Decision needed: per-student, or keep
global and drop the per-student framing.**

### 3. Structured page template (`2026-07-28-structured-page-template.md`)

The one transferable book-to-skill idea. **Decision needed: accept / reject / amend.**
