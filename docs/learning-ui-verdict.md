# Learning-UI verdict — 17 audits (27–43) across every subject family

The session goal was "the most optimal UI for learning any subject — run through all subjects and
different scenarios." This is the cross-scenario verdict, written against the audit record in the
rotation tally, the persona backlog, and the shipped commits, with screenshots re-read as a fresh
cross-check rather than re-driving the app.

## Verdict

What can be claimed today: every subject family a learner is likely to bring — code, Kubernetes
YAML, chemistry, physics, calculus, anatomy, music theory, essays, vocabulary — has an applied
route that grades mechanically, and each route has been driven in the packaged Electron app with
verdicts, evidence chips, and ledger writes asserted from traces (mechanically asserted in a live
drive: audits 28, 32, 34–43 in this window; exec, manifest, and the spacing loop in earlier
audits). The cross-cutting loops — spacing/decay/review, one-click session plan, misconception
repair, course bank — were each driven the same way (audits 35, 42, 43). Layout, dark mode, and
narrow viewports rest on screenshots read, not asserted (judged from screenshots). What cannot be
claimed: that the app *teaches* well. Every drive used a scripted tutor, so all of the above
proves the UI, the grading, and the loops — not exercise selection, pacing, or repair judgment by
a real model, which remain unverified. Also unverified: the CUDA runtime against a real nvcc
(unit-tested only — no toolkit in this environment), the Agent-SDK route's course tools and its
graph-cache invalidation, the repo-URL branch of Add material, paper ingest as a live in-app drive
(unit- and route-tested), and screen-reader output on the math field and diagram. "Optimal" is
therefore true of the machinery and unproven of the pedagogy.

## Subject-modality matrix

"Live" means driven in the packaged app with a scripted model and the outcome asserted from the
trace, not inferred from a screenshot. Audits 10–26 predate this window; they are cited where
that is where the live verification actually happened.

| Subject family | Applied route | Verified live | Residual gaps |
| --- | --- | --- | --- |
| Programming | code_exercise ladder + exec family (node, python, typescript, c, rust; go/java via Docker; environment tier vs composed services) | audits 10–14 pre-window (9b8fb14, 4d7e7d4, 92415af, 81819e1); audit 34 scoped commissioning to code-skill pages (b8ccde6) | expert quality dimension stops at suite-green; hint escalation is one-shot |
| — repo learning | repo miner (JS/TS/Python) → mined exec exercises behind a review gate | audit 32, three variants driven in-app (f2fb928, 3204d0d) | repo-URL happy path through Add material never e2e-driven (deferred, audit 42); no languages beyond JS/TS/Py |
| — CUDA | cuda exec runtime via nvcc, compile-once like c/rust | **not live** — unit-tested only (e410fb3, tests/exec.test.ts); no nvcc here | needs one pass on a CUDA machine; correctness-only, no profiling feedback |
| Infra/K8s | manifest family — write-from-spec YAML, mechanically checked | audit 12 pre-window (044a47e) | not re-driven in this window; no open defects on record |
| Chemistry | chem_equation + unit checkers (structured_check) | audit 38, 15/15 (c037117) | unit-glyph inserts; equation-format hint upfront |
| Physics | unit-math checker, unicode superscript units | audit 38 (c037117) | same backlog as chemistry; stage empty-state copy |
| Math | math_scratchpad (MathLive): step chain, numeric equivalence, step notes | audit 28 (a891efd); audit 41 deep math, 5 fixes (e9c3b37) | step-chain break detection; SR announcements on the math field unverified; nothing claimed beyond numeric equivalence (no symbolic/multivariate) |
| Biology/anatomy | label_diagram + spaced review; wrong labels reveal the correct one | audit 39 (f20aeb4) | matching answer-count leak; pin overflow + keyboard hint; SR announcements on the diagram |
| Music | notes checker — interval/chord spelling | audit 39 (f20aeb4) | no audio out: the checker is silent, which is absurd to a musician; notes-case preview |
| History/essay | writing_draft: rubric shown upfront, marginalia, per-criterion verdicts with quoted evidence | audit 40, 21/21 (4d71d79) | revise-round-2 affordance (highest learning value); criterion-to-span links; judged tag on the card |
| Language/vocab | vocab quizzes riding the spacing loop | audit 40 (4d71d79) | no audio in or out; tone/pacing is one prompt for everyone |
| Papers/research | ingest → concept pages; ingest_paper / web_search / read_url | **not live in this window** — unit- and route-tested (ingest.test.ts, ingestRoutes.test.ts, webtools.test.ts) | a live paper drive is owed; no citation chasing |
| Spacing/decay/review | decay-adjusted mastery, review queue, due badge on every tab | pre-window live (e58ab25); overflow honesty audit 26 (a4c5454); exercised again in 35 and 39 | — |
| Session plan | one click starts an interleaved sitting; plan rotates course problems | audits 21 (af15abb), 29 cold start (704695e), 42 course entries (900d294) | plan-chip click-through |
| Misconception repair | wrong answers mint misconceptions; graph marker; repair question; cleared on repair | audit 43, 25/25 after a blocker fix (c5b64f4) | SDK-path cache invalidation; misconception history |
| Course bank | problem sets banked verbatim; course_problems / mark_course_problem; Library section | audit 42, 27/27 (900d294, 4c08f13) | Agent-SDK-route course tools e2e |

## What remains, ranked

> **Status note, added later:** this list is the audit-era snapshot, kept for the record. Almost
> all of it has since shipped — see the addendum below for each closure's evidence class.
> Closed: 1 (six live sittings — all four modes, video teaching, degradation probes), 2 (live
> drive + unit tests), 3 (driven live; the video branch also has a browser e2e now), 4
> (revise-btn, same rubric, priorDraft), 5 (sqlite runtime), 6 (WebAudio hear-it), 7
> (options-pool guidance), 8 (repaired-misconception history on the page), 9 (student switcher +
> voice), 12 (paper_references tool + reader). Still open: 10 (real screen-reader speech —
> parked, needs NVDA/VoiceOver) and 11 (audio in — parked, modality cost), plus whatever of 13's
> polish list the shipped work didn't absorb.

1. **A real tutor model, end to end.** The one gap no scripted audit can close. Everything above
   proves the UI, grading, and loops; whether a real model picks the right exercise, paces a
   beginner, and repairs a misconception well is a different claim and currently has zero
   evidence. One full sitting with a live model, judged against the same traces, is the next
   distinct kind of verification available.
2. **Agent-SDK-route course tools e2e + its graph-cache invalidation** (deferred, audits 42–43).
   The second tutor route ships the same course tools and evidence writes without the verification
   the scripted route got; audit 43 already proved cache staleness bites on the scripted path.
3. **Repo-URL happy path through Add material** (deferred, audit 42). The one branch of the single
   entry point never driven end to end; the pasted-URL case is the likeliest first thing a
   developer tries.
4. **Revise-round-2 on a failed rubric criterion** (audit 40 backlog, persona item 6). One-click
   revision with priorDraft turns the essay verdict from judgment into iteration — audit 40's own
   note calls it the highest learning value on its list.
5. **SQL runtime** (persona backlog 3). sqlite3 as an exec runtime; the probed-runtime pattern
   already fits. Smallest unlock that moves a persona from "No" to served.
6. **Audio out** (persona backlog 4). WebAudio for the notes checker first, TTS for vocab second.
7. **Matching answer-count leak** (audit 39). The one open item that weakens grading honesty
   rather than polish.
8. **Misconception history** (audit 43 backlog). Repaired misconceptions vanish; a learner who
   relapses gets no "you have been here before."
9. **Multi-student profiles** (persona 18). Vault already keys evidence by student; config + UI.
10. **SR announcements for math field and diagram** (persona 20). Keyboard-complete was verified
    in audit 37; what a screen reader actually hears on the two richest inputs was not.
11. **Speaking practice / audio in** (persona 10). Parked until the modality is cheap locally.
12. **Citation chasing** (persona 14). A paper's references as follow-up ingest offers.
13. Polish backlog, no ranking among them: unit-glyph inserts and equation-format hint (38),
    notes-case preview and pin overflow/keyboard hint (39), judged tag, chip-styled skill grades,
    criterion-to-span links (40), step-chain break detection (41), stage empty-state copy (38),
    plan-chip click-through (43).

## Recommended next five

> **Status note, added later:** all five landed — sittings, SDK-route verification, entry-point
> coverage, the revise round, and the SQL runtime. Kept as written for the record.

1. **Live-model sitting** — the only remaining claim class; everything else is refinement of an
   already-verified layer.
2. **SDK-route course tools e2e + cache invalidation** — a shipping route with known-class bugs
   (audit 43 found the same staleness on the scripted path) and no coverage.
3. **Repo-URL happy-path e2e** — closes the last undriven branch of the app's single entry point.
4. **Revise-round-2** — the cheapest change that adds a learning loop rather than verifying one.
5. **SQL runtime** — one file in the exec family serves the last fully-unserved practical persona.

## Addendum — the unproven claims, revisited

Written after the sprint that followed the original verdict; each line names its evidence class.

- **Pedagogy with a real tutor model — now verified.** A live sitting ran on the subscription
  route (no mock): the tutor read the decayed state, interleaved on purpose, treated a wrong
  answer as diagnosis, recorded and resolved a misconception by demonstration, and drilled a
  banked problem verbatim. Judged "genuinely good" by a demanding review; three real defects
  found in the process were fixed (mechanically asserted in a live drive).
- **Agent-SDK route course tools + cache invalidation — shipped and verified** (live drive +
  unit tests). **Repo-URL happy path — driven end to end** through the single Add material
  control. **SQL runtime — shipped** with per-case fixtures and honest row diffs (unit-tested,
  sqlite3 CLI verified present).
- **Screen-reader announcements — tree-level verified**: one shared live-region verdict pattern
  across all seven blocks, the math field named after its problem, marks with accessible names.
  What tree probes cannot prove: actual speech output of a specific screen reader (needs NVDA/
  VoiceOver — unverified, said so).
- **Still unverified or parked**: the frontier/canonical literature tools against the LIVE
  indices — the request path is proven to the proxy boundary, but this container's egress policy
  403s arxiv.org and crossref.org (a user's machine has no such proxy; unit fakes cover the
  parsing) — the CUDA runtime against a real nvcc (no toolkit here),
  speaking practice (needs audio-capable models), a drawable design input (rubric presets
  shipped as the interim), and long-horizon pedagogy (a semester, not a sitting — no audit can
  compress that).

- **Second live sitting (humanities + study loop)** — confirms the pedagogy finding on a second
  genre: rubrics readable in advance, quote-anchored verdicts, a revise loop that edits rather
  than restarts, verbatim drills, evidence honesty enforced on disk. It also caught the tutor
  FABRICATING research provenance under a frontier question (a route-level prompt defect made
  the honest path unavailable) — fixed so degradation is now honest by construction, verified
  against the SDK transcript. Net: upgraded on breadth, downgraded on "honest by default",
  landing at honest-by-construction. Latency observed: 26-64s essay grading, 33-36s staging.
- **Third live sitting (cold start, freeform)** — the learn-anything-from-zero promise now holds
  end to end: empty vault → real web searches → pages whose sources verifiably match the actual
  search results → a syllabus a musician would recognize → path in the Library → teaching with
  evidence on disk, in one ~3.5-minute turn. It exposed and fixed the harness granting web tools
  while telling the model it had none — the tutor's response to that contradiction (refusing to
  fake research, labeling pages "unverified model knowledge") is the strongest honesty evidence
  of the session. Across three sittings the residual risk is precisely characterized: not
  invention, but overclaiming depth from search snippets — constrained by rule, not eliminated.
- **The packaged binary itself — executed.** Every prior drive ran electron/main.mjs from
  source; packaging defects (asar path resolution, bundled-resource lookup) only show in the
  real artifact. The built AppImage was launched cold in a clean HOME: it booted, found the
  bundled loreweaver memory engine inside its own resources, created a fresh vault, bound its
  server on a free port (API answering over HTTP), and rendered the first-run key screen with
  the correct fallback copy for "Claude Code installed but not signed in" — the honest no-key
  state, screenshotted. The packaging pipeline produces a runnable product, not just a file.
- **Hardening sweep (post-smoke).** An axe-core scan of all four tabs plus the open history menu
  found one violation kind in the entire app (Library heading levels) — fixed, re-scanned to
  zero. A later dark-mode pass (all four tabs, 1360px and 900px, including a thread carrying a
  malformed-block note) also came back zero — contrast holds in both themes. Markdown rendering proven inert against injected content by pinned tests: raw HTML
  escapes to text, javascript: hrefs are defanged, KaTeX input stays escaped — vault pages come
  from ingested material, so this is a real boundary, not paranoia. The /api/source symlink
  escape (promised in a comment, previously untested) now has the test that holds the promise.
  Two live-audit finds fixed the same day: a config with explicitly pinned API models made
  "Use my Claude subscription" a silent no-op (route now reroutes explicit plain models through
  the login, keeping the exact model), and the suite's last unnamed transient failure was
  root-caused to a test-double fidelity gap in codeexercise (passive-effect mount report
  clobbering a typed edit) — fixed, 8/8 consecutive green.
- **Fourth live sitting (video-transcript teaching).** A real Sonnet tutor taught from an
  ingested lecture transcript (the new YouTube path, fixture captions). It found the crash of
  the session: a malformed math_scratchpad call — SDK-rejected, bridged anyway — unmounted the
  entire app via a KaTeX throw. Fixed structurally (schema validation at block render + an error
  boundary; the crashed thread itself now renders the honest malformed note beside the corrected
  twin block). The sitting also produced the strongest honesty evidence yet: asked for video
  minute-marks it could not see, the tutor REFUSED to invent them, said exactly why, and opened
  the transcript in the reader instead. That exposed the real gap — compiled pages dropped the
  transcript's timestamps — fixed in the compile prompt; with anchored pages the tutor cites all
  the real stamps as a rewatch map, opens the source beside the conversation, and probes
  socratically instead of re-lecturing. Verified live end to end, zero page errors.
- **A live tutor taught from a video transcript with deep-link stamps.** The newest surface got
  its own sitting: a real Sonnet tutor, asked to teach the area-of-a-circle argument from the
  ingested 3Blue1Brown transcript, opened the source beside the conversation in 20 seconds,
  structured the lesson in its own frames, grounded each one in a VERBATIM transcript quote with
  its timestamp, and closed by naming "[1:05] through [4:18]" as the stretch to rewatch — the
  stamps in the reader are clickable deep links into the video at those seconds. Zero turn
  errors; the learner's pending question upstream was left open ("no rush") rather than
  bulldozed. This is the librarian principle end to end: tutor structures, artifact carries the
  facts, every claim points back into the artifact.
- **Quiz mode, live.** A real tutor in quiz mode opened with a graded scenario question built
  from the right page, exactly the mode's contract. The vault's stub page triggered the
  designed gap-based research grant; with this container's egress blocked, every failed fetch
  showed as an honest ✗ chip and the tutor said so and proceeded — "I'll let the probe stand on
  its own." A blank submission was graded as blank, not imagined. Zero turn errors.
- **Review mode, live, with a genuinely decayed page.** Fixture: a practicing page 32 days past
  its 21-day window. The Library badge showed 1 due; a real tutor in review mode opened
  DIRECTLY on the decayed page (zero drift to the healthy one) and staged the full code
  exercise with its predict gate — re-earning applied-correctly through the same mechanical
  route that minted it, which is what "re-prove" means. Twelve seconds to staging, zero errors.
  All four modes now hold their contracts under a live model.
- **The graph scales now.** A synthetic 500-page vault (300 with mastery) put the first graph
  build at 10.9 SECONDS — fetchGraph made 1+2N stdio roundtrips, two per page. loreweaver grew a
  list_pages bulk tool and the whole-map student call already carried every field the graph
  reads, so the build is two calls total: 16ms cold on the same fixture, ~680× faster, with a
  fallback to the old path for older bundled loreweavers. The client side holds up too: the
  contextual default renders 35 nodes instantly, the Whole-vault toggle renders all 501 in
  250ms with responsive zoom, and the session plan interleaves review/new correctly across the
  whole fixture. Probed further at 2,000 pages (1,200 with mastery): server still linear (127ms
  graph, 752ms due), contextual default still instant, and the opt-in whole-vault view renders
  2,001 nodes in ~1s with sluggish-but-usable zoom — the first thing that would degrade beyond
  this scale, and it is the one view that exists as a map rather than a workspace. "Learn
  anything" implies years of accumulation; the app no longer punishes it.
- **The e2e suite runs again, anywhere.** It had rotted into 2 passing + 2 permanently skipped:
  the gap tests demanded an external repo with a systemd sidecar, and every spec predated the
  first-run gate, the predict-before-write gate, the focus rail, and page-edge links. Restored
  against the built-in sandbox: 4 passed, 0 skipped, ~29s — and the restoration itself found a
  real bug (the first-run gate blocked every scripted run; a scripted model needs no
  authorisation). Both repos now run their suites in GitHub Actions on every push — the harness
  workflow gates on a LOREWEAVER_CI_TOKEN secret (documented in the workflow) because the
  integration tests spawn the real loreweaver server from a second private repo.
- **Thread history — driven end to end.** The last undriven topbar surface: a cold load restores
  the persisted default conversation; the history menu lists every conversation titled by its
  first substantive question with relative times and the active row highlighted; "+ New
  conversation" resets the transcript (old text provably gone from the DOM); switching threads
  swaps the full transcript both directions and stamps the deep-link hash (#/t/<id>); and the
  menu holds APG menu-button behavior under a keyboard-only pass — focus lands on the first item
  on open, arrows move it, Escape returns it to the trigger. One anomaly chased during the drive
  (a message apparently duplicated across threads) reproduced only under contaminated test state
  — a crashed earlier drive had already consumed a scripted turn and persisted its half of the
  conversation into the same vault; a clean rerun with request logging showed exactly one
  /api/chat call per user action, each with the right threadId. No product bug.
- **Video ingest accepts /live and /embed URLs** (unit-tested): recorded livestream lectures
  share as youtube.com/live/<id>, and copying an iframe src off a course page yields /embed/<id>
  — both previously misrouted to the git-repo path. The rebuilt AppImage carries this plus the
  graph and prompt-cost work, and was cold smoke-tested again: boots to a clean first-run
  screen, detects the existing claude.ai sign-in, serves the SPA.
- **math_scratchpad — MathLive entry driven live, and it caught a grading lie.** The full flow
  holds: the block lands on the stage with its chip in chat, typed keystrokes reach the real
  MathLive field (after its documented ~150ms wiring window), "Add step" folds the field into the
  derivation, Submit grades mechanically and the tutor's follow-up arrives by auto-resubmit. But
  the verdict on a perfectly ordinary derivation — 2x+3=11 solved as "2x=8" then "x=4" — read
  "final answer numerically equivalent; step 1 unparseable". mathjs reads '=' as ASSIGNMENT:
  "x=4" happened to evaluate (bare-symbol left side) while "2x=8" threw, so the equation shape
  students actually write algebra in was branded unparseable, and the step-break walker skipped
  equation chains entirely. Fixed by making equations first-class in the grader: both sides must
  parse, an isolating equation ("x=4", "V=nRT/P") grades as its other side against an expected
  expression by design rather than by accident, and two equations are the same statement when
  their residuals are proportional by a nonzero constant — which also correctly refuses
  "x^2=4" vs "x=2" (two roots vs one). Unit-tested both ways and re-driven live: the same
  derivation now grades clean, and a wrong equation chain gets the break located between the
  right steps.
- **Quiz multi-item flow — driven end to end, no defect.** A three-item quiz mixing all
  answer shapes (choice buttons, short-answer input, cloze input) rendered on the stage with
  its chip in chat; a deliberate miss on the cloze produced the honest per-item marks
  (✓ ✓ ✗) and a 2/3 verdict, all on the mechanical path — no model consulted for exact
  matches; the tutor's follow-up arrived by auto-resubmit. One nit chased and dismissed:
  a prompt's "x^2" renders literally only because the fixture omitted $…$ — BlockProse has
  rendered delimited math through KaTeX since the block-prose pass.
- **Anki backlog badge — driven in both themes, no defect.** A sync cursor aged 5 days past the
  3-day nudge window (with Anki unreachable) turns /api/status to 'backlog' and the topbar wears
  the amber-dot "anki" badge — role=status with the full sentence as its accessible name, warn
  color correctly darker in light theme and lighter in dark. The two honesty edges were already
  unit-tested: a fresh install (never synced) hides the badge rather than flagging work that
  never existed, and a genuinely stale cursor still flags.
