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
  zero. Markdown rendering proven inert against injected content by pinned tests: raw HTML
  escapes to text, javascript: hrefs are defanged, KaTeX input stays escaped — vault pages come
  from ingested material, so this is a real boundary, not paranoia. The /api/source symlink
  escape (promised in a comment, previously untested) now has the test that holds the promise.
  Two live-audit finds fixed the same day: a config with explicitly pinned API models made
  "Use my Claude subscription" a silent no-op (route now reroutes explicit plain models through
  the login, keeping the exact model), and the suite's last unnamed transient failure was
  root-caused to a test-double fidelity gap in codeexercise (passive-effect mount report
  clobbering a typed edit) — fixed, 8/8 consecutive green.
- **The e2e suite runs again, anywhere.** It had rotted into 2 passing + 2 permanently skipped:
  the gap tests demanded an external repo with a systemd sidecar, and every spec predated the
  first-run gate, the predict-before-write gate, the focus rail, and page-edge links. Restored
  against the built-in sandbox: 4 passed, 0 skipped, ~29s — and the restoration itself found a
  real bug (the first-run gate blocked every scripted run; a scripted model needs no
  authorisation). Both repos now run their suites in GitHub Actions on every push — the harness
  workflow gates on a LOREWEAVER_CI_TOKEN secret (documented in the workflow) because the
  integration tests spawn the real loreweaver server from a second private repo.
