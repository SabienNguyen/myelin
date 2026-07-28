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
- **This session's new surfaces re-swept**: 600 seeded equation-biased fuzz inputs through the
  math grader's new equation branches (no throws, invariants held — now a permanent suite
  member), and a 900px dark-mode pass over the quiz done card and history dropdown: single
  column stacks correctly, the menu anchors inside the viewport, and no horizontal scroll with
  or without the menu open.
- **Mode selector mid-session — investigated, no bug.** Runtime is keyed by threadId only while
  `mode` rides in on each render's transport, which smelled like a stale-closure risk: switch the
  selector, keep sending the old mode forever. Sniffed the wire in a live drive — both a
  pre-first-message switch (learn→review) and a mid-conversation switch (review→quiz) reached
  /api/chat with the freshly selected mode. useChatRuntime honors the per-render transport;
  nothing to fix. The history drive is also now a permanent e2e spec (sixth spec, 7/7 tests
  green) with threads seeded straight into the session store so no scripted turn is consumed.
- **Fresh-vault cold start — driven end to end, no defect.** With zero authored pages, every read
  endpoint answers 200 with honest empties, and the app self-seeds exactly one practice pattern
  (the built-in sandbox's stream-consumer stub — by design, so the first coding exercise always
  has a page to record against). The chat shows "What do you want to learn?" with three example
  prompts, the Library says plainly what doesn't exist yet and which control creates it, the
  graph renders its single node with legend and focus hint, and the first chat turn completes.
  loreweaver's side also gained a permanent fuzz suite this cycle: 900 seeded hostile inputs
  through parsePage/serializePage/slugify — the surface compiled pages are written to — with a
  parse→serialize→parse fixed-point invariant, all holding on first run (84/84).
- **Axe re-swept with the new states in the tree — two real fixes.** The earlier zero-violation
  passes never had a quiz done card or an open history menu in the scanned DOM. Scanning those:
  (1) block titles in the chat/stage columns were h3 directly under the topbar h1 — a
  heading-level skip; Quiz and LabelDiagram titles are now h2 with the same look. (2) The active
  history row's relative-time text sat at 4.09:1 on the accent-soft background in dark theme —
  under AA; it now inherits the row's accent foreground (≥5.4:1 in both themes, computed).
  Re-scanned after both fixes: zero violations in light and dark with the quiz card and open
  menu present.
- **Setup-state axe pass — one more real fix.** Generalizing the "new state, new scan" lesson:
  the FirstRun screen (both variants — subscription offer and the expanded API-key form) had its
  card outside any landmark (no main — the screen replaces the whole app, so it needs its own).
  Now a main landmark; zero violations across FirstRun × both variants × both themes, and the
  Add-material popover scanned clean in both themes as-is.
- **Ingest failure paths — driven, one real layout bug fixed.** With yt-dlp deliberately absent
  and a dead repo URL, both Add-material failure paths were driven in the real browser. The repo
  path already reported exemplarily (ERROR chip in the Library with the exact git command and
  exit code, dismissable). The video path's install hint, though, rendered as a single unwrapped
  line loose in the topbar, running off the window edge — the one message that tells a user how
  to fix their setup was unreadable. Failures now report inside the open panel where text wraps
  and the user is looking; the topbar span only carries the short post-success status and is
  ellipsis-capped so no message can displace the topbar again. Verified at 1360px and 900px with
  a no-horizontal-scroll assertion; the panel error also survives the narrow-screen rule that
  hides the topbar copy. One observation judged fine as-is: the repo path's "ingesting in the
  background" topbar note is written at accept time and doesn't update when the background clone
  later fails — the Library card is the live surface and reports the failure in full.
- **Two tabs on the same conversation — a silent data-loss bug found and fixed.** A live probe
  opened the same thread in two tabs and sent a turn from each: the staler tab's turn-finish
  write replaced the thread file with only its own view, erasing the other tab's entire
  exchange from disk — no crash, no error, just a vanished conversation turn. saveThread now
  merges by message id instead of replacing: a writer keeps its own (fresher) versions of
  messages it knows, and messages it has never seen are preserved in front. Threads only grow —
  there is no message-edit or branch UI — so the union loses nothing, and the normal single-tab
  flow writes byte-identical files. Unit-tested both ways and re-probed live: all four messages
  survive in order, and a fresh tab renders the merged conversation. Full suite 968, e2e 7/7.
- **Live deep-learning sitting (the LLM syllabus) — the strongest pedagogy evidence yet, and two
  real finds.** A learner persona studied transformer internals against the live subscription
  tutor: the QKV asymmetry argument taught with a concrete 2×2 worked example and a scratchpad
  exercise (graded correct — the equation-chain grader fix earning its keep live), then the full
  √d_k variance derivation cross-checked against the paper and a textbook, with sources named
  and an honest disclosure that WebFetch was down so one framing rested on search snippets. The
  evidence guardrail fired honestly when no page existed ("✗ evidence not recorded", explained),
  and after the learner switched to freeform the tutor wrote six prereq-chained pages, created
  the path, set the goal, and retroactively recorded the two bounced evidence items at exposed.
  Find 1, fixed: a Mermaid diagram in the final reply showed source instead of rendering — the
  component saw the fence mid-stream, a half-written chart failed to parse, and the failure
  LATCHED over the later successful render (the reload proved the chart itself fine). The retry
  now clears the failure; pinned by a client test that streams a broken-then-complete chart.
  Find 2, recorded: on this container the Agent-SDK tutor's turn ended with "(No action needed —
  unrelated project task list…)" — the SDK session picked up the host's Claude Code task-list
  reminders. Gracefully ignored, environment-specific (a user's machine has no such reminders),
  but noted as an isolation surface for the claude-sdk route.
- **The LLM sitting continued into multi-head attention — the adversarial-learner test.** Asked
  point-blank whether "heads specialize" is real or folklore, the live tutor produced the two
  actual papers that complicate the story in opposite directions — Voita et al. 2019 (a minority
  of heads take genuinely interpretable roles: positional, syntactic, rare-word) and Michel et
  al. 2019 (most heads are prunable with no loss) — and taught the honest synthesis instead of
  the pop-sci blanket claim. The free-text check on that synthesis graded correct through the
  live SDK grader. The student model now reads exactly as the evidence discipline demands:
  applied-correctly for the two machine-graded computations, explained-correctly (not applied)
  for the model-judged explanation — three pages at exposed, no level inflation anywhere.
- **Positional encoding, same sitting**: taught from the actual problem (permutation invariance),
  through sinusoidal PE's additive scheme, to the RoPE rotation argument — sources named
  (RoFormer, EleutherAI), the vault honestly flagged as still-stub. The tutor's transfer question
  was genuinely diagnostic (rotate only V — does relative position survive?), and the learner's
  "no, the m−n dependence lives in q·k" answer graded correct with evidence recorded. Four
  topics deep, every check graded, every evidence kind honest.
- **The deep-LLM sitting completed the full learn-anything arc.** Six topics taught by the live
  subscription tutor (QKV, scaling, multi-head, positional/RoPE, KV cache, training-vs-inference),
  every one closed with a graded check — two machine-graded computations, four model-judged
  transfer questions, all six recording honest evidence kinds with zero level inflation. The
  KV-cache leg was quantitatively exact (128 KiB/token for the Llama-3-8B shape; its 32K→4 GiB
  check graded mechanically), the exposure-bias leg taught mixed evidence honestly instead of
  folklore, and the sitting closed with freeform compiling all four remaining stubs into solid,
  sourced pages — teach → check → record → durable memory, end to end, under a real model. Two
  papercuts the sitting surfaced were fixed and shipped on the spot (the Mermaid stream latch,
  the double-escaped \n\n in block prose).
- **The decay→review loop closed against genuinely taught content.** qkv-attention (taught,
  applied, and compiled earlier in this same session) was fixture-decayed 30 days at practicing;
  /api/due listed it slipped (raw practicing, effective exposed), and review mode did everything
  right live: named exactly that page with the correct decay narrative, declined to re-research
  a page already solid ("no actual content gap here"), and re-proved it with a question aimed at
  the originally-taught concept — the trophy/suitcase asymmetry. The correct answer graded,
  recorded, restored the level to practicing, and emptied the due queue. Spaced repetition,
  teach-to-re-proof, end to end under a real model on real material.
- **Compiled-page quality — close-read, arithmetic re-verified.** The kv-cache page the sitting
  produced was read line by line: the causal-mask fixity argument is correct, the memory formula
  is right, and its worked example is internally consistent at every step (16 KiB/token/layer →
  512 KiB/token → 2 GiB at 4096 tokens → 4 GiB at batch 2 — a full-MHA 7B shape, correctly
  distinguished from the sitting's GQA example). Sources are listed on the page; their content
  could not be re-fetched from this container (egress), which matches the tutor's own disclosure
  at teaching time. Frontmatter is sound: prereq chain intact, difficulty set, status solid.
- **A second domain opened (RLHF) with the research-honesty contract holding.** Asked for reward
  models, the KL penalty, and the DPO framing, the tutor OPENED by disclosing it had no research
  grant this turn and that the material was trained knowledge, not freshly verified — then wrote
  the rlhf-reward-model page flagged that way and offered the freeform research path for doing
  it properly. The Bradley-Terry teaching was correct (pairwise → sigmoid of reward difference),
  and its shift-invariance transfer question ("+50 per prompt — does the loss change?") graded
  the learner's cancellation answer correct with evidence recorded. The graph now grows a second
  domain from a live sitting.
- **The KL-penalty leg went Socratic, and the level machinery promoted honestly.** With the
  Bradley-Terry prereq freshly proven, the tutor flipped to asking first — the learner's
  extrapolation-plus-trust-region answer graded correct, and rlhf-reward-model promoted exposed
  → practicing on the strength of two explained-correctly records. Repetition earning promotion,
  a single check never doing so — the leveling contract observed working rather than asserted.
- **The RLHF arc closed with the DPO derivation and its honest costs.** The tutor taught the
  closed-form-optimum-to-loss derivation, then answered "what does DPO give up" with the real
  list — off-policy staleness, population identity vs training guarantee, the both-likelihoods-
  can-fall failure mode (flagged as recalled, not verified fresh — the honesty contract again),
  no portable reward artifact, no live hacking detection. Its final check was a three-lesson
  callback: cross-prompt reward comparison, previously asserted as a category error, now derived
  from the un-canceled Z(x) — graded correct, dpo promoted to practicing. The vault now carries
  two live-taught domains; the gauge-freedom thread ran coherently across three separate lessons.
- **Live card generation probed against the taught vault — and it found the sync's blast-radius
  bug.** With a capturing fake AnkiClient and the live claude-sdk card_gen, the first real
  generation attempt over the sitting's pages died mid-run: the model emitted unparseable JSON
  for one math-heavy page (an unescaped character ~1KB in), and the throw aborted the ENTIRE
  outbound sync — no page after it got cards. That's a when-not-if failure for math-heavy vaults.
  syncOutbound now contains a generation failure to its page: logged loudly, counted in a new
  honest `failed` field, and the run carries on. Pinned by a unit test using the suite's real
  loreweaver fixture.
- **Second card-gen find from the same probe: the fence.** The re-run with containment produced
  8 genuinely strong cards (atomic, correct, misconception-first where one was recorded) and one
  contained failure — whose raw text showed the model wrapping its JSON in a ```json fence
  despite the no-fences instruction. grading.ts already had the fence-stripper for exactly this;
  the card path now shares it (parseSdkJson exported) instead of raw JSON.parse. Pinned by a
  fenced-response unit test.
- **Third probe, root fix: the sdk card protocol is no longer JSON.** After the fence fix, the
  same math-heavy page failed AGAIN — a different unescaped character deep in a LaTeX-bearing
  string. Three probes, three distinct JSON defects: the format itself was the bug. Cards are
  plain text pairs, so the sdk path now asks for FRONT/BACK/=== blocks — a shape quotes and
  backslashes cannot break — with the fence tolerance kept and no-parseable-cards still throwing
  readably. The re-probe: 12 cards, zero failures, including four from the page that broke every
  JSON attempt. The failure class is gone rather than patched around.
- **Quantization leg: folklore correction plus a live self-heal.** The tutor dismantled "int4 is
  basically free" with this-session sources (GPTQ, AWQ, LLM.int8()) and real numbers — naive
  int4 breaks on outlier features eating the scale budget, not on bit count — and its check
  probed exactly that mechanism (graded correct). When the evidence record bounced against a
  missing page, the tutor wrote the page itself, retried the record successfully, and flagged
  the page unverified because it came from knowledge rather than read sources. The bounce →
  write → record → honest-provenance sequence, unprompted, under a live model.
- **The provenance loop closed: unverified → researched → solid.** Asked to source its own
  knowledge-only quantization page, the freeform tutor read against the actual papers and
  upgraded the page with per-claim citations — LLM.int8()'s operational outlier definition and
  the 6.7B phase transition, GPTQ's Hessian-based error compensation, AWQ's activation-salience
  rescaling identity — and reported that the outlier-mechanism framing survived contact with all
  three. A page that entered the vault flagged unverified left it solid with four sources: the
  full honesty lifecycle (teach → flag → research → verify → upgrade) observed end to end.
- **Math-heavy transcript at narrow/dark — verified clean, no action.** The sitting's transcripts
  are the heaviest display-math content the app has rendered (RoPE compositions, DPO
  derivations, Bradley-Terry losses). Probed at 900px dark, 1360px dark, and 900px light with
  no-horizontal-scroll assertions at the page, thread, and per-KaTeX-block levels: zero overflow
  anywhere. The earlier responsive and display-math containment work holds against real content.
- **Library path progress with real data — correct, no action.** The sitting's path renders
  1/6 with a proportional bar (exactly one page at practicing), "resume at attention-scaling"
  names the genuinely-next unproven page, and set-as-goal is offered. Progress arithmetic,
  resume logic, and layout all verified against earned — not fixture — state.
- **Page tab with the sourced page — the standing box tells the exact truth.** The
  quantization page renders with its solid chip, tags, sources, and zero overflow; the YOUR
  STANDING box reads "seen once — earned by 1 explanation, judged by the tutor. No exercise has
  confirmed it" and names the structured check as the way to confirm — the applied-route
  honesty surface verified against genuinely earned (not fixture) state. No action.
- **The standing-box loop found one last grading unfairness — fixed.** Following the Page tab's
  own advice, the learner asked for the structured check; the tutor set a numeric check whose
  example said 'e.g. "5" for 5%' — and then its checker demanded a literal % unit, so the
  learner who followed the example exactly was graded partial and recorded struggled. The app
  now defends mechanically: '%' is formatting, not a meaning-bearing unit — a bare number
  satisfies it (fraction-vs-percent confusion still fails the numeric comparison; an explicitly
  different unit still flags). Four tests pin the rule.
- **The percent fix verified live, and the record repaired the honest way.** A fresh check on
  the same fact, answered with a bare "0.1" again, graded "value and unit match" under the fixed
  checker — correct, applied-correctly recorded mechanically, page promoted to practicing. The
  earlier struggled record stays in the history untouched: repair means earning new evidence,
  never editing old.
- **Vault provenance complete.** The last two knowledge-only drafts (rlhf-reward-model, dpo)
  were researched and upgraded to solid with per-claim sources — including pinning the
  previously-flagged-unverified DPO failure mode to the paper that names it (DPO-Positive,
  arXiv:2402.13228). Every page in the sitting's vault is now sourced-solid or an honest stub;
  the shipped demo vault carries the final state.
- **Final demo-vault boot check: 10 nodes, four practicing, every page solid-or-stub** — the
  shipped fixture verified working one last time after the provenance completion. A README
  screenshot refresh was attempted and honestly abandoned: the whole-vault force layout at 10
  nodes sometimes converges tight enough for labels to collide (run-to-run nondeterminism; the
  fit control zooms but doesn't relax overlap), and the existing 9-node capture is cleaner. One
  observation for a future layout pass, not worth risk now: small-N whole-vault could use a
  label-collision nudge.
- **User-reported: the fitted graph "looks not good" — root-caused and fixed.** Labels
  counter-scaled by raw zoom (staying 11 screen px at any zoom) while node geometry clamps at 1,
  so a fit below scale 1 shrank positions but not labels — full-size text crammed into shrunken
  spacing. Two coordinated fixes: the label counter-scale now clamps at 1 too (labels shrink
  with the world below scale 1, preserving the collide-tuned separation), and fit's label
  allowance moves from screen space into the content box below scale 1 (the old math reserved a
  panel-width of pixels for labels that had already shrunk, crushing small vaults into a postage
  stamp). Measured after: 10 labels, zero overlapping pairs, 76% width fill. The README's graph
  screenshot is now this fitted three-domain capture.
- **The label_diagram block's first live sitting found three real bugs — all fixed, then 8/8.**
  Driving the last never-live block: (1) the tutor delivered its SVG HTML-entity-escaped
  (`&lt;svg…`), which rendered as a broken 26px-tall image that crushed every percent-positioned
  pin into one unclickable band — the UI now decodes a plainly-escaped SVG and (2) the canvas
  carries a min-height so no broken image can ever crush the pins again; (3) the diagram needed
  "Residual add" twice but the deduped tray chip died after one placement, making duplicate-label
  diagrams impossible to complete — chips now exhaust only when placed as many times as regions
  need them. Plus a coordinate-collision nudge (separatePins) for model-supplied pin positions.
  Re-driven live after: proper 494×691 canvas, every pin clickable, both residual chips placeable,
  8/8 graded correct with the two rendered Mermaid teaching diagrams above it — the stream-latch
  fix visibly earning its keep.
- **The label_diagram triple-find is pinned as an e2e spec** — its own scripted backend pair
  (:4822/:4175, the gap precedent), with the script deliberately shaped like the live sitting:
  the SVG entity-escaped, two regions at identical coordinates, one label needed twice. The spec
  asserts real canvas height, clicks both coincident pins, re-uses the duplicate chip, and
  completes to 3/3 graded. Suite is now 8 browser specs.
- **Cold-start audit: a brand-new vault's first lesson evaporated — fixed by picking the opening
  mode from the vault.** Driving a genuinely empty vault end to end (fresh student, only the
  boot-seeded pattern stub): the empty-state hero promises "your tutor writes pages as you go,"
  but the session opened in `learn`, whose single-writer rule (deliberate — spec §5) forbids
  write_page. The live tutor did everything right — researched three sources, taught backprop
  well, even warned "nothing here gets saved" — and the newcomer's first lesson left no page, no
  graph node, nowhere for evidence to land. The client now asks the graph before settling on a
  mode: no real (non-stub) page → open in freeform, the one mode that keeps the hero's promise;
  the first real page flips future sessions back to `learn`. Re-driven live: same question, same
  fresh vault, first turn produced a 7-stop syllabus path (forward pass → loss → chain rule →
  gradient descent → backprop → worked example → matrix form), seven sourced solid pages, and a
  quick check — the graph exists after minute one. Established 10-page vault verified still
  opening in `learn`; 8/8 e2e unaffected (all-stub fixture vaults flip to freeform, which the
  scripted model never notices — mode only changes tool mounting it doesn't use).
- **math_scratchpad's first live MathLive sitting: the field's own dialect broke the render.**
  Chain-rule derivation on the newcomer vault (which correctly opened its second sitting in
  `learn` — seven real pages now). Typing du/dx makes MathLive emit its private `\differentialD`
  macro, and KaTeX painted it as red literal error text in the learner's own step list and done
  card — the app defacing the student's correct work. The Latex component now carries KaTeX
  macros for the MathLive dialect (`\differentialD`, `\exponentialE`, `\imaginaryI`,
  `\imaginaryJ`, `\placeholder`, `\mleft/\mright`), spread per render so a model-authored `\def`
  can't leak between expressions. The grader never had the problem — it parses through MathLive's
  own converter. Everything else in the sitting held: step add/edit/save wrote back to the right
  slots, the deliberate sin→cos edit landed, the final `2x\cos(x^2)` graded mechanically
  equivalent, applied-correctly evidence landed on chain-rule, and the honest "step 1
  unparseable" was my own robot typing leaving `=2x` inside the denominator — visually obvious
  to a human, faithfully rendered, correctly not blocking the final-answer grade.
- **Thread-history switching driven live: clean pass.** On the newcomer vault: the history menu
  lists the backprop conversation with ellipsised title and relative time; "+ New conversation"
  lands on the empty hero with a fresh `#/t/<id>` hash; switching back restores the full thread —
  graded scratchpad card included — under `#/t/default`. Zero horizontal overflow at 1360 and
  900 with the menu open. A dark-mode suspicion (the panel looked white in a downscaled
  full-page capture) was chased to ground truth and found FALSE: computed background #24221c and
  raw pixels [43,53,71] = the dark --accent-soft token, exactly right. Lesson kept: judge dark
  theming by computed styles or element crops, not by eyeballing a scaled full-page PNG.
- **Quiz multi-item flow driven live, keyboard-only — and an interrupted-stream divergence found
  with a working self-heal.** A mid-stream browser close (my own drive error, the documented
  onFinish hazard) lost the quiz turn client-side while the server-side SDK session kept it: on
  the next ask the tutor said the quiz was "still open above" — true in its history, false on
  the learner's screen — and refused to stack a duplicate. It also refused, unprompted, to quiz
  on backprop material it hadn't taught yet ("quizzing you on it now would just be me handing
  you answers"). Telling it the honest thing — "my browser reloaded and the quiz vanished" —
  healed the divergence completely: same four questions re-staged, with "that happens sometimes
  with a refresh." The re-staged quiz was then completed KEYBOARD-ONLY: all four inputs reached
  in five tabs (clean tab order), Submit reached and fired by Enter, 4/4 model-judged, two
  evidence records landing on the vault. The divergence hazard is recorded here as known
  behavior with a working conversational recovery; a transport-level replay of unsaved turns is
  the eventual fix if it ever bites harder.
- **Library panel fresh-eyes pass: healthy, one polish fix.** Light/dark/900px all clean (zero
  horizontal overflow), the tutor-built path shows a decay-aware 1/7 meter, the no-books empty
  state points at both entry paths, and Practice carries the seeded ladder with its NEW badge.
  The one find: the resume button read "resume at nn-forward-pass" — a raw slug in
  learner-facing copy. /api/paths now resolves each row's next page to its real title (bounded
  one read_page per path, parallel, null on failure so the client degrades back to the slug),
  and the button reads "resume at The Forward Pass: What a Neural Network Computes" — verified
  live on the newcomer vault.
- **Anki backlog badge driven into its live state: correct in both themes.** Crafted the real
  trigger (a sync cursor five days stale with Anki-Connect down) in the newcomer vault:
  /api/status flips to `anki: "backlog"` and the topbar grows the amber-dot "anki" chip with
  "Anki has a review backlog" as both title and aria-label — light and dark verified. The
  fresh-install guard holds too: with no cursor at all the status reads `down` and the topbar
  stays quiet (no badge about work that never existed). State cleaned up after the drive.
- **Decay → review → re-proof closed on the newcomer vault — after fixing a real mid-thread
  staleness bug.** Crafted honest decay (chain-rule reinforced 38 days ago, loss-functions 20):
  the /api/due queue ordered slipped-first with resolved titles, the Library tab grew its count
  badge, and the path meter stayed decay-aware. Then the find: session context was injected only
  on a thread's FIRST turn, so switching the mode selector to review mid-conversation left the
  tutor acting on the context of the mode the learner left — it answered "what have I let slip?"
  with a well-researched lecture on forgetting curves, because in its history nothing had ever
  slipped. Both tutor routes now track each thread's last mode and a mid-thread switch re-injects
  fresh bootstrap context marked as such (in-memory; post-restart stays quiet, the pre-existing
  behavior). Verified live end to end: switch to review → the tutor named exactly what slipped,
  citing the learner's own June evidence and clearing the healthy pages by name → staged the
  re-proof → correct answer graded, evidence recorded, and chain-rule left the due queue. Also
  re-proved twice over that drive scripts must wait on the thread-save PUT, not the working
  indicator — two turns were lost to early browser closes before the third drive keyed on the PUT.
- **The onFinish data-loss hazard is fixed at the server — a turn now survives the tab closing on
  it.** The client persisted the thread only when ITS stream finished, so a disconnect mid-answer
  lost the whole assistant turn even though the server completed it — the exact divergence behind
  the quiz sitting's "still open above" episode, and it bit three drive scripts in one day. First
  attempt (an onEnd tap on the response stream) failed the same way it was meant to fix: it only
  sees chunks a dying stream still delivers — the drive proved it by persisting a lone step-start.
  The shipped fix accumulates the assistant message's parts server-side beside every chunk
  written and saves in a finally when the query work completes, independent of stream survival;
  an explicit 'start' chunk announces the message id so the client's own later PUT names the same
  message and the union-by-id merge converges. Verified live both ways: a full turn + reload
  renders once (no duplicate), and a turn whose tab was closed four seconds in is complete on
  reconnect. Also caught during this iteration: kill-by-config-path misses node children whose
  config lives in env vars — two "live verifications" earlier today ran against a stale server
  (the fixes were sound and unit-tested, but the live proofs were void until re-run against a
  clean boot; both were re-proven). The ai-sdk route keeps the lighter onEnd-based save (its
  stream emits real start chunks, so ids converge; full disconnect hardening there is future
  work if that route ever carries live traffic).
- **Mode-switch injection re-proven against a clean boot.** The earlier live proof was void (stale
  server); re-run properly: fresh thread, turn 1 in learn, selector flipped to review, then a
  deliberately vague "what should we review right now?" — nothing in the conversation carried the
  answer. The tutor replied with the vault's exact current state: chain-rule holding (re-proven
  an hour earlier), loss-functions with "just 1 day of slack left," and an honest "no reviews are
  actually due right now" that matches /api/due's due-soon-versus-slipped distinction. The
  injected fresh context is doing its job.
- **Session-plan CTA driven live on the mid-journey vault — the sitting worked, and its first
  probe exposed a grader bug.** The hero's "Start today's session (3 items)" rendered the right
  plan (review loss-functions "1d before it slips", then two frontier items), one click sent the
  ordered contract, and the tutor obeyed it: probed the review item first (an MSE computation)
  before any reteaching. The bug: answering that probe with the full derivation — "C = 1/2
  (1 - 0.8)^2 = ... = 0.02" — was graded "no number found in the answer", because
  parseLeadingNumber anchors at the string's start. Showing your work must never read as not
  answering. The tutor's save was itself exemplary (told the learner their algebra was right and
  the auto-grader wanted a bare number — honest about its own machinery), but the grader now
  meets learners where they are: extractAnswerNumber tries the leading number, then the number
  after the last '=' (every derivation's final-answer convention, and "x = 4"), then a lone
  number token in prose ("about 0.02"); genuine ambiguity ("between 3 and 5") still refuses to
  guess. Suite crossed 1000 tests with the five new cases.
- **Loreweaver decay-semantics fix: confusion no longer extends trust.** Chasing the grader-bug
  fallout showed applyEvidence stamped last_reinforced=today for EVERY evidence kind — including
  'misconception', which changes no level and demonstrates the opposite of standing, so recording
  a learner's confusion about a practicing page handed it a whole fresh decay window.
  last_reinforced now means "the date the current standing was established": level-changing kinds
  still restart it ('struggled' correctly starts the demoted level's clock at the demotion);
  'misconception' keeps the previous date while its evidence entry still records the day. Two new
  tests; loreweaver suite 86 green. ('struggled' demoting the page out of the due queue and into
  next_lessons as a re-teach target was examined and left alone — fail → reset → relearn is the
  right spaced-repetition shape.)
- **AppImage rebuilt current (340 MB, gitignored artifact).** The distributed build now carries
  everything this window shipped: the cold-start freeform default, the MathLive-dialect KaTeX
  macros, the mode-switch context re-injection, server-side turn persistence, extractAnswerNumber,
  the resume-title resolution, and — verified inside the bundled loreweaver's dist — the
  misconception-decay fix. All confirmed by string inspection of the asar and bundle rather than
  trust in the build script; binary smoke-passed with --appimage-extract-and-run. Both repos'
  worktrees stayed clean through the build (the npm-ci bundling rule earning its keep).
- **"Set as goal" driven live for the first time — pass, plus a degrade-loudly path proven in the
  wild.** The Library's set-as-goal writes the goal (kind/slug/setOn persisted, GOAL tag + clear
  goal rendered), and a brand-new sitting opened oriented to it unprompted: "I'm back — where
  were we?" got the goal path's resume point probed first, no re-teaching. Mid-turn the tutor
  hallucinated a block under the wrong MCP prefix (mcp__loreweaver__quick_check) with the
  required `mode` field also missing: the SDK refused the nonexistent tool, the client's schema
  re-validation rendered the honest "✗ quick check could not be shown — the tutor sent it
  malformed", and the model retried correctly in the same turn. Examined and deliberately left
  alone: the ✗ path is what PREVENTS a duplicate-probe mess (a defaulted-mode rescue would have
  rendered the broken call as a live block right before the retry staged its twin).
- **Persona deep-dive: RoPE on the marathon vault — a clean full-loop pass, including page
  AUGMENTATION.** Freeform ask ("my transformer pages don't cover how position gets into
  attention") produced researched teaching with clean KaTeX rotation math — today's MathLive
  macro work holding on fresh live content — a real conceptual probe (why q'_m·k'_n depends only
  on n−m), a correct grade on the orthogonality-plus-additive-composition answer, and evidence
  recorded. The notable behavior: asked to "write up everything we covered," the tutor did NOT
  mint a new rope page — it had already folded the RoPE sections into the existing
  positional-encoding page (now solid, 6.5k chars, 8 RoPE mentions) and said so plainly ("sitting
  there already, properly linked, not something I need to author fresh"). Sources on the page are
  exactly canonical: the Transformer paper, the RoFormer paper (arXiv 2104.09864), and
  EleutherAI's rotary-embeddings post. Augment-don't-fragment is the vault behavior a knowledge
  graph needs, observed unprompted.
- **writing_draft on live content: the annotation flow at its best.** Asked to explain RoPE to a
  junior engineer with one deliberately vague sentence planted: the grader annotated exact spans
  (the filler sentence caught as VAGUE — "hedges with 'basically,' 'sort of,' and 'somehow'
  without conveying any information"), scored the rubric an honest 2/4 with per-criterion
  verdicts, and — the impressive part — judged AUDIENCE FIT correctly, flagging "2D subspaces"
  and "compose additively" as unexplained jargon for the stated junior reader even though both
  statements are technically accurate. Skill grades (claim good / concision weak / specificity
  good), the Revise-this-draft round button, recorded evidence, and feedback prose that teaches
  (the clock-hands analogy for angle difference) all rendered. Every block has now been driven
  live within this session.
