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
| 4 | ML engineer moving to GPU work | CUDA kernels graded like any other exercise | Yes where nvcc exists (correctness only — profiling stays honestly out of scope) |
| 5 | Pre-med student, anatomy-heavy semester | Label structures on pictures, spaced review | Yes — label_diagram + decay/review queue |
| 6 | Chemistry undergrad | Equations and unit math checked mechanically, not vibes | Yes — chem_equation/unit checkers (audit 38) |
| 7 | High-school student, algebra | Gentle pacing, no jargon, wins early | Partly — machinery fits; tone/pacing is one prompt for everyone |
| 8 | Law student | Issue-spotting essays against explicit criteria | Yes — writing_draft rubrics; revise loop missing |
| 9 | History undergrad | Argue theses, get marked-up drafts | Yes — annotations + rubric (audit 40) |
| 10 | Language learner (Spanish) | Vocab spacing works; speaking/listening don't exist | Partly — no audio in or out |
| 11 | Music theory student | Interval/chord drills; needs to HEAR them | Yes — hear-it plays the learner's own notes (arpeggio + chord); canonical-spelling preview |
| 12 | Career-switcher, self-taught web dev | A path from zero with real code checks | Yes — paths + ladder rungs + freeform cold start |
| 13 | Data analyst leveling up SQL | Write real queries against real tables, graded | Yes — sqlite exec runtime, per-case schema fixtures, honest row diffs |
| 14 | PhD student, paper-heavy field | Ingest papers, be quizzed on them, chase citations | Partly — paper mode works; no citation-following |
| 15 | Retired lifelong learner, philosophy | Low-friction conversation that still tracks progress | Yes — freeform mode + evidence graph |
| 16 | Senior engineer, system-design interviews | Open-ended design practice against a rubric | Partly — writing_draft rubric fits; no design-specific templates or diagram-drawing input |
| 17 | Med resident who lives in Anki | Their existing deck ecosystem, not a new silo | Yes — Anki two-way sync |
| 18 | Homeschooling parent, two kids | Separate profiles, visible progress per kid | Yes — topbar student switcher, per-learner evidence, persisted |
| 19 | Corporate engineer, internal codebase | Everything local, nothing leaves the machine | Yes — local app, local vault, ollama option |
| 20 | Screen-reader user, any subject | Every flow operable and announced | Mostly — keyboard-complete (audit 37); math-field/diagram SR announcements unverified |

## Shipped since this document was written

Course bank end-to-end (verbatim drills, session-plan slots, seeded evidence pages), the single
Add-material entry point, sqlite runtime, hear-it audio for notes, multi-student profiles, the
essay revise round, unit-glyph inserts, repaired-misconception history, frontier + canonical
literature search (the librarian rules), the source reader with select-to-ask, and the tutor's
open_source hand. The live-model sitting also ran: pedagogy judged genuinely good, three real
defects fixed from it.

From the original ranked backlog, since then: **tone/pacing** (the per-student teaching-style
field, applied as a voice line in the tutor prompt), **citation chasing** (`paper_references`
walks an ingested paper's own reference list into ingest offers), **system-design rubric
presets** (five criteria including numbers-over-vibes; the drawable canvas half stays parked),
**SR announcements** (shared live-region verdicts across all seven blocks, MathLive named from
its problem, and a later axe-core sweep to zero violations), **cancelled-vs-rejected block copy**
(schema-rejected says malformed; talked-past says the conversation moved on), and
**criterion-to-span links + step-chain break detection** (quote-anchored rubric notes that
highlight their evidence in the draft; the math grader names the first broken step).

Beyond the original list: **YouTube lectures through Add material** — a video's own captions
become a timestamped transcript (yt-dlp, no video download), compiled and readable like any
paper, with a tutor rule to send the student to the moment (`[12:34]`) instead of re-lecturing.

## The backlog, ranked (remaining)

1. **Audio in / speaking practice** (10) — STT for pronunciation and conversation drills. Big;
   needs a model with audio; parked until the modality is cheap locally.
2. **Drawable design canvas** (16, the hard half) — system-design practice currently judges a
   written design against rubric presets; sketching the diagram itself has no input surface.
3. **Whisper fallback for caption-less videos** — the video path is captions-only by design;
   caption-less material gets an honest error today. Needs an audio download and an API key.

## What no persona asked for

Per-artifact buttons, more dashboards, gamification, streaks, social features. The personas want
their material, honest grading, and to be told what to review. The backlog above stays inside
that.
