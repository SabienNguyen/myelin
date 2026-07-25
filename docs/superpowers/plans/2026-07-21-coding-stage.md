# 2026-07-21 — Coding stage: in-IDE tutor help, repo mining, continuous improvement loop

User directives: "set up a loop to continuously improve the coding stage flow", "should have a
tutor that we can query for help", "implement the repo compiling so we can learn from repos".

## A. In-IDE tutor help (harness)

The focus-mode IDE currently exiles the tutor ("back to tutor" rail). Learners need help *in
place* without abandoning the exercise or polluting the lesson thread.

- FocusLayout brief panel gains a **Help** tab: a small composer ("Ask about this exercise…") +
  a scrollable hint transcript (this exercise's help exchanges only, session-local state).
- `POST /api/gap/help` `{pattern, rung, question, draft, failures[]}` → one-shot generation on
  the **tutor model** (works on both `ollama:` and `claude-sdk:` routes via the existing
  one-shot generate seams — NOT the chat thread; help is ephemeral scaffolding, not lesson
  history).
- **Answer-integrity invariant (mechanical, not prompt-level)**: the help prompt is built ONLY
  from learner-visible material — the rung payload as served by the answer-stripping gap proxy,
  the learner's own draft, test names/failure messages, and the pattern's vault page. The
  reference answer must have no path into the prompt. Unit test proves it: build the prompt
  from a fixture whose reference solution contains a sentinel string; assert sentinel absent.
- Prompt rules: proximity hints that escalate (concept → strategy → structure), never complete
  gap code; ≤180 words; no praise/emoji (gap tone rules apply inside the IDE).
- UX: Ctrl+/ focuses the help composer; pending state while generating; hints render markdown.

## B. Repo mining — "learn from repos"

Mirror of book ingestion: point at a repo, get (1) vault pages from its docs and (2) REAL
practice artifacts mined from its tested code, gauntlet-verified like every other artifact.

### B1 (the-gap repo): `packages/miner`
- Input: a local repo path. Discovery: TS/JS source files with adjacent tests
  (`x.test.ts`/`x.spec.ts`/`__tests__`).
- MVP candidate rule (guarantees runnable artifacts): single-file modules whose imports are
  node builtins only, with a test file whose imports resolve to that module + builtins +
  vitest/jest globals. Copy pair into an artifact dir
  `{artifact.ts, artifact.test.ts, meta.json}` with `family: "mined:<repoName>"` and
  `source: {repo, commit, path}`.
- Run the EXISTING 5-gate gauntlet over each candidate; only passers are kept.
- CLI: `pnpm miner <repoPath> --out <dir>` → JSON report
  `{candidates, passed: [...], rejected: [{path, gate, reason}]}`.
- DoD: mining the-gap itself and/or loreweaver-harness yields ≥1 passing artifact end-to-end
  (e.g. pure helpers with focused tests are known to exist in both).

### B2 (harness): Add-repo ingestion (after B1 review)
- Library "Add repo" (git URL or local path) → shallow clone to `vault/.harness/repos/<name>`
  → queue entry `{mode: 'repo'}` with converting/compiling progress like books.
- Docs pass: README/docs/*.md through the existing markdown→chapters→compile pipeline
  (sourceUrl = repo URL) — concept pages.
- Mining pass: run B1 miner; register passed artifacts with the gap sidecar (extra store dir,
  env-configured); seed pattern pages via `write_page` (single-writer preserved) citing
  repo+path; tutor offers `code_exercise` blocks on them (pageSlug wired).
- E2E: add a small fixture repo → pages exist + one mined exercise completes with evidence.

## C. Continuous improvement loop — coding stage flow

Standing loop (runs between/after A+B reviews, until the user says stop): drive a full
exercise as a fresh learner via Playwright (multiple viewports), log every friction point
here, dispatch fixes, re-verify, repeat until a pass yields no new findings.

Queue (live):
- [ ] Fresh-learner Playwright pass at 1280×800 and 1920×1080 (after B2c lands, so the pass
      covers mined exercises too).
- [ ] Mined artifacts' titles: "Artifact" (from filename derivation) is meaningless in the
      ladder — B2c's seeding should derive better titles (exported function name or meta).

Done log:
- (seed) P2 Run/Submit split, line numbers, JetBrains Mono, autosave, run timing (b7a2377).
- A: in-IDE help shipped (87343e6); live-smoked on prod.
- B1: packages/miner in the-gap (fc71594); DoD 5/10 gauntlet-passed mining the-gap itself.
- B2a: GAP_EXTRA_STORES serving + boot re-verify + stripping parity (ec0320c);
  systemd env wired (1a8e8e2); sidecar restarted green.
- C batch 1 (dea27fb): continuous line numbers across panes (Compartment reconfigure on gap
  line-count change, guard verified by real-CM6 jsdom test), help label dedupe, Ctrl+/ hint,
  prompt rule 12 (no block-mechanics narration). Shipped.
