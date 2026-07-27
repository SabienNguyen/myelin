# What happened on 2026-07-27 (autonomous session)

The short version: the video-learning capability went from idea to fully verified product feature,
both repos gained CI and self-provisioning for future sessions, the app was hardened (fuzz,
injection, accessibility, coverage) and scale-tested to 2,000 pages, and all four tutor modes were
verified live with a real model. Everything below is on master in both repos, with every claim's
evidence class in `learning-ui-verdict.md`.

## The video-learning arc (from your claude-video pointer)

- **Ingest**: a YouTube URL pasted into the single Add material field becomes a timestamped
  transcript — captions only, no video download, manual track preferred over auto (6790e86).
  A missing yt-dlp names its install command; caption-less videos get an honest error naming the
  parked Whisper path.
- **Deep links**: every `[1:05]` stamp is a link into the video at that second — in the raw
  transcript (dce7f0f) and, via a mechanical pass at compile time, in the vault pages built from
  it (cc9189b). The tutor's prompt rule knows the stamps are clickable (15f10e4).
- **Verified live**: a real tutor taught the area-of-a-circle argument from the ingested
  3Blue1Brown transcript — opened the source beside the conversation, grounded each frame in a
  verbatim quote with its timestamp, and named "[1:05] through [4:18]" as the stretch to rewatch
  (ebb3bd7). The librarian principle, end to end.
- **Covered forever**: a browser e2e drives the happy path with a fake yt-dlp shim (e677e9e).

## Live-model verification completed

All four tutor modes now hold their contracts under a real model, each in its own sitting:
learn (earlier), freeform cold-start (earlier), quiz (d518b97 — honest ✗ chips when this
container's egress blocked its research, then a good scenario question anyway), and review
(7850af7 — a genuinely decayed page re-proven through the same code exercise that earned its
evidence, due badge accurate, zero drift).

## Found-and-fixed while auditing

- A config with explicitly pinned API models made "Use my Claude subscription" a silent no-op —
  the route now reroutes explicit plain models through the login, keeping the exact model
  (1e93667). Running as root gets a plain-language hint (4a4d3c9).
- The reader's select-to-ask was pointer-only (mouseup); a screen reader's selection never
  surfaced it. Now selectionchange-driven, with a scroll-offset positioning bug fixed en route
  (28e9ae1).
- The suite's last unnamed transient failure was root-caused (a test-double fidelity gap) and
  killed (1e93667); a second race in the e2e gap spec likewise (e677e9e).
- The graph didn't scale: 10.9s cold at 500 pages (1+2N stdio roundtrips). loreweaver grew
  `list_pages`; the harness builds the graph in two calls; 16ms on the same fixture (539ed4f,
  loreweaver a15fe44). Probed to 2,000 pages: no cliff, first-to-degrade surface named
  (a9a98b3).
- The prompts didn't scale either: both tutor routes inlined EVERY vault slug into EVERY turn,
  and every compile part did the same — thousands of tokens per call at 2,000 pages, billed
  forever. Capped past 150 pages, byte-identical below it, leaning on the server-side mechanisms
  that already cover the gap (repairSlug auto-correction; write_page's link proposals)
  (ed288c8, 826c175).

## Hardening

Zero axe violations in both themes at two widths (3b89658, 44f1560); markdown rendering pinned
inert against injected content (e896a68); the /api/source symlink escape got its test (b722d76);
1,800 seeded-fuzz inputs across six hostile-input parsers, all invariants held (56ec97f);
coverage-guided tests took setupRoutes/signin/scheduler/notify to full honest coverage
(5738cda, 6ab1f89, 3c2a074); a tripwire fails the build if the mirrored mastery contract ever
drifts from loreweaver's (7a8a311).

## Infrastructure

- **CI in both repos** — harness: typecheck + 297 client component tests ungated on every push
  (980ed42), full integration + e2e suites unlock when you add a `LOREWEAVER_CI_TOKEN` secret
  (a fine-grained PAT with read access to the loreweaver repo — see the workflow header or
  README). loreweaver: build + full suite on every push. CI caught one real mistake (a typecheck
  slip) within a minute of it reaching master.
- **SessionStart hooks in both repos** (3063711, loreweaver 186f2ad) — future Claude Code web
  sessions self-provision: dependencies installed, and for the harness the ~/Dev/personal layout
  its integration suites resolve through.
- **The AppImage is tip-current** and the packaged binary itself was executed and smoke-tested
  cold this session (recorded in the verdict addendum).

## Where things stand

Harness: 951 unit tests + 6 runtime-availability skips, 5/5 e2e, everything green.
Loreweaver: 81/81. Parked with reasons (verdict doc): real screen-reader speech, audio-in,
Whisper for caption-less videos, CUDA against real hardware, and a linter (typescript-eslint
does not support TS 7 yet).

## The evening arc (after the prompt caps)

- **The last undriven UI states fell, and two were hiding real bugs.** Thread history proved
  clean end to end (restore, both switch directions, APG keyboard menu — then pinned as an e2e
  spec, taking the suite to 7). The math scratchpad drive caught the grader calling an ordinary
  equation step "unparseable": mathjs reads '=' as assignment, so the exact shape students write
  algebra in failed to parse. Equations are now first-class — split on the top-level '=', an
  isolating equation means its other side, and two equations are the same statement when their
  residuals are proportional (e03a084). Quiz multi-item and the Anki backlog badge drove clean.
- **The axe sweep generalized into "every new state gets scanned" and found three fixes across
  two commits**: a heading-level skip in chat block titles, an active-history-row timestamp that
  failed dark-theme contrast, and the FirstRun card sitting outside any landmark (d3daad9,
  ebcfbbf). Every enumerable UI state has now been scanned in both themes.
- **Error paths got their own drive** (49c448d): with yt-dlp deliberately absent, the install
  hint — the one message telling a user how to fix their setup — rendered as an unwrapped topbar
  line running off the window. Ingest failures now report inside the Add-material panel where
  text wraps; the repo-failure path was already exemplary (exact git command in the Library card).
- **You asked whether to go public, and the repos are now ready**: both READMEs rebuilt (hero
  line, CI badge, real screenshots, the six-kind evidence model verified against source — the
  old summary had silently dropped rubric-passed), the example config's personal student id
  neutralized, package metadata added, no secrets in tracked files (grep-verified). Waiting on
  two decisions only you can make: a license, and flipping both repos public together.

## The night arc (the persona marathon)

You asked for one thing tonight: pretend to be someone learning about LLMs, deeply, and keep
testing that way. That persona ran the app through two continuous multi-hour sittings and it is
the strongest evidence the project has:

- **Three domains taught live** — transformer internals (six pages), RLHF (reward models, KL,
  DPO), and quantization — every topic closed with a graded check (twelve in all, honest
  evidence kinds throughout, four promotions each earned by repetition, zero inflation).
- **Every honesty mechanism observed working unprompted**: the research-grant disclosure, pages
  flagged draft/unverified when taught from knowledge, the evidence bounce → write page → record
  → flag provenance self-heal, the decay → review → re-proof loop on real material, and finally
  unverified → researched → solid with per-claim sources.
- **Seven product bugs found by the probing, all fixed and shipped**: the two-tab silent data
  loss, the Mermaid mid-stream latch, double-escaped newlines reaching learners, the Anki sync
  aborting on one bad page, the missing fence-stripper on the card path, the JSON card protocol
  itself (three failures → FRONT/BACK blocks, twelve cards zero failures), and the bundle script
  dirtying the sibling repo's lockfile.
- **The vault the sittings produced ships in the repo** (docs/demo-vault) with the README's
  graph screenshot taken from it — the cold-start demo problem solved with genuinely earned data.
- **Your questions got answered en route**: both READMEs beautified (screenshots, accurate
  six-kind evidence model), both repos scrubbed and metadata'd for the public flip you decided
  on. Two things wait on you: the license file (MIT recommended — say the word) and the
  visibility toggle in each repo's GitHub settings.

## After you came back

- **MIT license** landed in both repos the moment you named it, lockfiles synced.
- **The graph you called out** ("that looks not good") was a real bug with one mechanism and two
  symptoms: labels kept screen size below zoom 1 while positions shrank, and fit reserved screen
  pixels for labels that had already shrunk. Both fixed; the fitted three-domain graph now
  measures zero overlapping labels at 76% width fill, and the README screenshot is that capture.
- **The label_diagram block's first live sitting found three bugs in one exercise** — an
  entity-escaped SVG rendering as a 26px broken image that crushed every pin, no minimum canvas
  height behind it, and duplicate-label diagrams being impossible to complete. All fixed;
  re-driven to 8/8 correct.
- **CI is flip-ready**: the loreweaver checkout is now attempted on every run (secret if
  present, default token otherwise), so the moment loreweaver goes public the full integration
  and e2e suites run in CI automatically — for forks too. The graceful-skip path is proven live.
