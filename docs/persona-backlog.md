# Persona-driven backlog

Twenty people who might sit down in front of this app, what each one actually needs, and the
backlog that falls out. "Served" means the core of their need works today, verified in an audit —
not that nothing could improve.

## The personas

| # | Persona | Core need | Served today? |
|---|---------|-----------|---------------|
| 1 | CS undergrad, algorithms exam next week | Drill real problems, timed, in her course's language | Mostly — exec family + generated exercises; course bank (past exams) landing now |
| 2 | Bootcamp grad, first job, drowning in the team repo | Learn a codebase by doing, not reading | Yes — repo miner (JS/TS/Python), mined exercises with review gate |
| 3 | SRE prepping the CKA | Write YAML against exam-style tasks, mechanically checked | Yes — manifest family |
| 4 | ML engineer moving to GPU work | CUDA kernels graded like any other exercise | Partly — cuda runtime ships where nvcc exists; correctness only, no profiling feedback |
| 5 | Pre-med student, anatomy-heavy semester | Label structures on pictures, spaced review | Yes — label_diagram + decay/review queue |
| 6 | Chemistry undergrad | Equations and unit math checked mechanically, not vibes | Yes — chem_equation/unit checkers (audit 38) |
| 7 | High-school student, algebra | Gentle pacing, no jargon, wins early | Partly — machinery fits; tone/pacing is one prompt for everyone |
| 8 | Law student | Issue-spotting essays against explicit criteria | Yes — writing_draft rubrics; revise loop missing |
| 9 | History undergrad | Argue theses, get marked-up drafts | Yes — annotations + rubric (audit 40) |
| 10 | Language learner (Spanish) | Vocab spacing works; speaking/listening don't exist | Partly — no audio in or out |
| 11 | Music theory student | Interval/chord drills; needs to HEAR them | Partly — notes checker works; no playback |
| 12 | Career-switcher, self-taught web dev | A path from zero with real code checks | Yes — paths + ladder rungs + freeform cold start |
| 13 | Data analyst leveling up SQL | Write real queries against real tables, graded | No — no SQL runtime |
| 14 | PhD student, paper-heavy field | Ingest papers, be quizzed on them, chase citations | Partly — paper mode works; no citation-following |
| 15 | Retired lifelong learner, philosophy | Low-friction conversation that still tracks progress | Yes — freeform mode + evidence graph |
| 16 | Senior engineer, system-design interviews | Open-ended design practice against a rubric | Partly — writing_draft rubric fits; no design-specific templates or diagram-drawing input |
| 17 | Med resident who lives in Anki | Their existing deck ecosystem, not a new silo | Yes — Anki two-way sync |
| 18 | Homeschooling parent, two kids | Separate profiles, visible progress per kid | No — single-student config |
| 19 | Corporate engineer, internal codebase | Everything local, nothing leaves the machine | Yes — local app, local vault, ollama option |
| 20 | Screen-reader user, any subject | Every flow operable and announced | Mostly — keyboard-complete (audit 37); math-field/diagram SR announcements unverified |

## The backlog, ranked

Rank = personas served × depth of the unlock, discounted by effort. Items already in flight are
marked.

1. **Course bank end-to-end** (1, 6, 7, 8, 9) — IN FLIGHT. Past exams/problem sets drilled
   verbatim; ingest wiring + tutor tool + Library surface remain.
2. **Single "Add material" entry point** (everyone) — IN FLIGHT, user directive. One button
   routes file/URL/path to book, paper, repo, or problem set. No per-artifact buttons, ever.
3. **SQL runtime** (13, 12, 19) — sqlite3 as an exec runtime: schema+data fixture in stdin or a
   temp db file, query as the program, result rows as expected stdout. Small, high-value; the
   probed-runtime pattern already fits.
4. **Audio out** (11, 10, 5) — play notes/intervals/chords for music (WebAudio, no dependency);
   TTS for language vocab. Music first: the notes checker exists and is silent, which is absurd
   to a musician.
5. **Multi-student profiles** (18, 7) — student switcher in the topbar; vault already keys
   evidence by student name, so this is mostly config + UI + per-student due badges.
6. **Essay revise loop** (8, 9, 16) — failed rubric criterion offers one-click "revise" opening
   round 2 with priorDraft. Turns judgment into iteration.
7. **Tone/pacing setting** (7, 15) — one profile-level line in the tutor prompt ("high school",
   "no jargon", "brisk expert"). Cheap; changes who can use the app comfortably.
8. **Audio in / speaking practice** (10) — STT for pronunciation and conversation drills. Big;
   needs a model with audio; park until the modality is cheap.
9. **Citation chasing** (14) — a paper page's references become follow-up ingest offers.
10. **System-design templates** (16) — rubric presets + a drawable diagram input (or accept an
    uploaded sketch into label_diagram's grading model). The rubric half is nearly free.
11. **SR announcements for math/diagram** (20) — verify MathLive's aria output in-app; add
    live-region verdicts on label_diagram; an accessibility-focused audit iteration.
12. **Profiling feedback for CUDA** (4) — honest scope question; correctness-only may be the
    right permanent claim for a local app.

## What no persona asked for

Per-artifact buttons, more dashboards, gamification, streaks, social features. The personas want
their material, honest grading, and to be told what to review. The backlog above stays inside
that.
