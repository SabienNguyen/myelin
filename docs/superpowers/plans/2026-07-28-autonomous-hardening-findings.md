# 2026-07-28 — Autonomous hardening pass: findings and open decisions

**Status:** summary of an autonomous session. **Five fixes are shipped** on
`claude/analyze-repos-dinnsr` and green at unit + type + browser tiers. **Four items are left for the
owner** — three product/pedagogy decisions and one verification that needs a real Claude
subscription. None of those four is actioned: each changes behavior on a judgment call (or can't be
verified here), and guessing wrong churns the codebase against intent. This doc exists so they're
actionable from one place instead of a chat transcript.

## What prompted it

"Look up book-to-skill — is any of its code valuable insight for this system?" The answer (one idea
transfers: a structured page template — see `2026-07-28-structured-page-template.md`) seeded a
broader pass: drive every flow in the real app, cross-check state-view and route pairs, sweep bug
classes, and read + test the core engine.

## Shipped fixes (5)

| Commit | Fix | How it was found |
| --- | --- | --- |
| `9e23caa` | `structured_check` renders on the Stage, like every other applied block — it was the lone applied block rendering inline, though the Stage's own empty copy advertises "science checks". | Drove the matching flow; saw the interactive form land in the transcript, not the Stage. |
| `6b1164a` | `/api/status` names the live student, not the one captured in the boot snapshot. The topbar polls it every 60s, so a learner switch silently reverted the displayed name within a minute. | Cross-checked `/api/status` against `/api/students` — they disagreed in the same breath. |
| `0ffa950` | Due-count badge aria-label: "1 page", not "1 pages". | Drove the ReviewQueue with a crafted slipped-page fixture. |
| `0e85603` | Graph node aria-label: "1 day until decay", not "1 days". | Swept the pluralization class the badge bug revealed. |
| `0d55b78` (+ `9c1bd3e` test) | `generate_exercise` restored on the Claude-subscription tutor route — it was wired on the API-key route only, so subscription learners couldn't have the tutor author a practice exercise. See "The port" below. | Cross-checked the two tutor routes against the code's own "keep in sync by hand" invariant. |

Method that worked: drive the actual flow with realistic state, don't trust the happy-path
screenshot; hold two things that should agree up against each other; when a bug reveals a class,
sweep the class.

### The port (`generate_exercise`), in detail

The two tutor routes must offer the same tools — `claudeSdkTutor.ts` says so outright ("keep in sync
by hand; a divergence here means the two tutor routes disagree on tool access"). `session.ts` (ai-sdk
/ API-key) wired `generate_exercise` in freeform; `claudeSdkTutor.ts` (Agent-SDK / subscription) did
not — silently, unlike the research tools it *deliberately* swaps for the SDK's WebFetch (which carry
a "these DO NOT EXIST here" note). "Keep in sync by hand" is the maintenance MECHANISM (the two SDKs'
tool shapes are incompatible, so there's no shared source), not deliberate per-route curation — so
the gap was a bug.

Ported by mirroring `courseMcpTools`: a `generate` MCP server whose handler wraps the SAME shared
`generateExercise` call session.ts uses, freeform-gated in `buildOptions`'s `allowedTools`. Verified
at every tier this environment reaches — tsc; a direct-handler unit test (the dup-guard fires before
any model call); a gating test (freeform includes it, teaching modes don't); full harness suite
(1187) and e2e browser suite (10/10). The one step this environment CANNOT run — **a real
Claude-subscription drive confirming the live Agent SDK offers `generate_exercise` in freeform and
withholds it in teaching modes** — is the owner's (item A below). It's de-risked (mirrors
`course_problems`, proven in production; worst unverified case is the tool simply not appearing, never
a regression), but it's the honest last mile.

## Swept clean (no defects)

- **Staleness** (boot-snapshot vs live cfg): tutor + student re-read; `autoCompile` is immutable.
- **Pluralization**: two aria-labels fixed; no other unguarded `${n} nouns` in the client.
- **Capped-count / honest-total**: `/api/due` returns an uncapped `total`; ReviewQueue shows it.
- **Swallowed errors** (degrade-loudly): every silent catch is a malformed-body→400, a title→slug
  fallback, or a genuinely best-effort op. None hide a failure that should be loud.
- **Core durability**: `atomicWrite` is deliberately scoped to student state ("the one irreplaceable
  thing this vault holds"); review-log and rationales are non-atomic by design.
- **Core queries / parsing** (`frontier`/`nextLessons`/`unmetPrereqs`/`parsePage`): correct.
- **Accessibility**: 0 unnamed interactive elements across every surface; WCAG AA contrast in light
  AND dark (min 4.71:1, deliberately AA-tuned); a quiz is fully completable keyboard-only (Tab to
  reach, Space to select, Enter to submit — no focus trap).
- **Anki sync**: outbound/inbound share one ledger (`anki-map.json`); the `_cursor` key is filtered
  on both sides.

Coverage: every block type (8) driven or e2e-covered; Add-material ingest (temp-dir fix re-validated
live); SourceReader + select-to-ask on real ingested prose; graph/page/library/review/student-switcher
/cold-start/Anki-badge; responsive (900/1360) + dark passes; a full multi-step journey with zero
console warnings. Both suites green (harness 1187, core 101).

## Left for the owner

### A. Verify the `generate_exercise` port on a real subscription (verification, not a decision)

Everything unit/type/browser-testable is green; the live Agent-SDK exposure under a real
Claude-subscription login is the one thing this environment can't drive. Log in, enter freeform, and
confirm the tutor can call `generate_exercise` (and cannot in learn/review/quiz).

### B. Decay cascade: should long-stale `mastered` pages reach `exposed`?

`effectiveLevel` (`loreweaver/src/student/model.ts:29-34`) demotes `mastered`→`practicing` after 45
days, but the `practicing`→`exposed` rule checks the RAW level — which never becomes `practicing` for
a stored-`mastered` page. Verified empirically: a page mastered 6 years ago reports effective
**practicing** (counts in ProgressCard's "pages you can do right now"), while a page merely practicing
6 years ago correctly decays to `exposed`. Two readings: deliberate durability (surfaced via `slipped`
regardless) OR a broken cascade (the raw-vs-effective slip that's easy to write by accident). Three
things tilt toward bug: the parallel `if` structure implies cascade; no comment explains the
stop-one-rung choice in a codebase that comments every honesty tradeoff; no test pins the case. But
the FIX is a pedagogy call — a naive "check effective level" makes `mastered` skip the practicing
grace and hit `exposed` at 45d (45 > the 21d window from the same date); correct cascade needs an
explicit threshold (e.g. `masteredDays + practicingDays` = 66d), and that number is a judgment.
**Decision: cascade or not, and the threshold.**

### C. Voice scoping: per-student or global?

The teaching-style ("voice") preference lives in the per-student StudentSwitcher dialog and its
comment says it "lives with the profile", but `PUT /api/voice` stores it in the global harness config
(`restRoutes.ts:433`), and the core student model has no voice field. Two learners sharing a vault
share one teaching style. Recommendation: per-student — implementable harness-only (a per-student
voice map in config with `cfg.voice` as the global fallback, backward-compatible, no core change).
**Decision: per-student, or keep global and drop the per-student framing.**

Why this is held while `generate_exercise` (a structurally-similar UI-says-X / code-does-Y gap) was
shipped: that one had an EXPLICIT code invariant mandating the fix (the "keep in sync by hand"
comment). Voice has only INFERRED intent with a counter-signal — the UI implies per-student, the
config stores + comments it as global, and "should teaching style be per-learner?" is a user-facing
product question, not a code-internal correctness property. Explicit invariant → ship; inferred
product intent with tension → document. The change is bounded and backward-compatible whenever you
want it, though — say the word.

### D. Structured page template (`2026-07-28-structured-page-template.md`)

The one transferable book-to-skill idea — a section skeleton for compiled pages (Core idea /
Frameworks / Anti-patterns / Mental models / Connects-to / Worked example). Changes what every future
page looks like and what the grading model + graph see. **Decision: accept / reject / amend.**

## Also noted (not blocking)

- **Tutor-route drift is structural**: `session.ts` auto-exposes every core tool in freeform;
  `claudeSdkTutor.ts` uses a hand-maintained allowlist. Any tool added to core drifts until the
  allowlist is edited. It bit twice — `generate_exercise` (fixed) and `list_pages` (a vault-survey
  read tool exposed incidentally on session.ts's freeform, absent from the curated allowlist; whether
  the tutor should have a list-all tool at all is a judgment call, so it's left as-is). A shared
  source of truth for "freeform loreweaver tools" would close the class; that's a refactor decision.
- `ingest_paper` is also absent from the subscription route, but is covered by the prompt's deliberate
  "use WebFetch" note — a documented, arguably-intended read-vs-ingest gap.
- Minor: core `reviewDue` is unsorted, so `nextLessons`' "top 2 review" is arbitrary order — harmless,
  the harness session-plan sorts its own review queue.
- **`npm audit`**: core is fully clean (0, prod + dev); harness production is clean (0), with 16
  high-severity DEV-only advisories, all one transitive dep — `brace-expansion` (a
  DoS-via-unbounded-expansion, GHSA-mh99-v99m-4gvg) pulled in under `electron-builder`'s packaging
  chain (@electron/asar, dmg-builder, electron-winstaller, …). It ships nothing to users, and the DoS
  is fed by the developer's own build-config globs, not remote input — low priority. The vulnerable
  copies are `brace-expansion@1.1.16`/`2.1.3` (nested under `electron-builder` → `minimatch@3`); the
  top-level dep is already patched (5.0.8). The catch: the only patched line is 5.0.8+, so a fix is a
  1.x/2.x→5.x MAJOR jump — either `npm audit fix --force` (electron-builder major bump, npm confirms
  `isSemVerMajor: true`) or an `overrides: { "brace-expansion": "^5.0.8" }`. Its `expand()` API is
  stable across those majors so it would likely work, but the only thing that exercises the vulnerable
  path is a full `electron-builder` packaging run (tests/tsc/vite/e2e don't), so it can't be validated
  here — forcing a 4-major override onto the release toolchain unverified, for a non-exploitable dev
  DoS, isn't worth it. Left for you: apply the override + run a packaging build to confirm installers
  still build.
