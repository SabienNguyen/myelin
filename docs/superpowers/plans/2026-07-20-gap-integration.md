# Gap→Harness integration plan (tasks I1–I3)

Goal: the Engram harness (localhost:4173) is the ONE place to interact with the whole
learning system. The Gap (~/Dev/personal/the-gap) becomes a subject kit: the tutor presents
code exercises as blocks; the Stage renders them; passing real tests records real evidence;
coding patterns live in the vault/graph like any other knowledge.

The Gap's spec principles still bind inside the harness: never the answer to the learner's
instance; tests are the grading; ambient dismissible offers, never modal; tone rules.

## Global constraints
All of docs/superpowers/plans/2026-07-12-myelin.md Global Constraints apply
(ESM .js imports, TDD, vitest exit-code checks, no hardcoded models, explicit-path staging,
commit trailer). The Gap repo is a DEPENDENCY — never modified except where a task explicitly
fences a file there. pnpm in the gap repo runs via `npm exec --yes pnpm@latest -- <args>`.

## Pinned contracts

Gap sidecar API (existing, served by the-gap's apps/web/server.ts on :4930):
GET /api/ladder → { ladder: {pattern, targetArtifactId, siblingArtifactId, rungs: string[]}, rungs: Rung[] }
POST /api/run { rungId, code, trace? } → { pass, results: [{name, pass}], syntaxError?, trace? }
(reference_answer stripped for non-worked_example rungs — MUST remain true through any proxy)

Harness additions:
- config schema: optional `gap: { url: string }` (e.g. "http://localhost:4930"). Absent → feature off.
- Harness proxy: /api/gap/* → `${cfg.gap.url}/api/*` (GET/POST passthrough, JSON, 30s timeout).
- New block tool (src/shared/blocks.ts):
  code_exercise = {
    input: z.object({
      pattern: z.string(),          // e.g. 'stream-consumer' (the ladder id, MVP: one ladder)
      rung: z.enum(['worked_example', 'inline_completion', 'full_body', 'ladder']),
      pageSlug: z.string(),         // vault page that receives evidence
    }),
    result: z.object({
      completed: z.boolean(),
      rungReached: z.string(),      // last rung completed
      testsPassed: z.number(),
      testsTotal: z.number(),
      wroteCode: z.boolean(),       // true only if learner-authored code passed full_body
    }),
  }
- Grading (src/server/grading.ts): code_exercise is MECHANICAL — completed && wroteCode →
  'applied-correctly' ("passed real tests with own code"); completed && !wroteCode →
  'exposed' (watched/completed guided rungs only); !completed → 'struggled'.
  detail: `${testsPassed}/${testsTotal} tests`. Never calls a model.
- Tutor prompt rule (tutor-system-prompt.md): for programming-pattern pages, prefer
  code_exercise over quiz — real code beats recall. Rung choice mirrors the Gap ladder:
  first contact → rung 'ladder' (full sequence); refresh/review → 'full_body' directly.

## I1 — sidecar service + proxy (server side)
Fence: src/server/{config.ts, gapProxy.ts(new), index.ts, restRoutes.ts if needed}, systemd/,
tests, README.
1. systemd/the-gap.service (user unit): WorkingDirectory %h/Dev/personal/the-gap,
   ExecStart=/usr/bin/npm exec --yes pnpm@latest -- demo (or a server-only script if trivially
   available — inspect the gap's package scripts; demo also builds+gauntlets rungs at boot,
   which is CORRECT: content re-earns its place each boot; document boot time). Install +
   enable + start it; verify :4930 answers.
2. config: `gap: { url }` optional (add to harness.config.json with http://localhost:4930 and
   to the example file).
3. src/server/gapProxy.ts: buildGapRoutes(cfg) → Hono app: /api/gap/ladder, /api/gap/run
   (POST body passthrough incl. trace). Structured 502 {error} when the sidecar is down
   (degrade loudly). Mount in index.ts when cfg.gap present. /api/status gains gap: 'up'|'down'
   (2s ping of GET /api/ladder, cached 30s).
4. Tests: proxy with a local fixture server (pattern: tests/webtools.test.ts) — passthrough,
   stripping preserved (fixture returns a rung with reference_answer:'' → proxy must not add),
   sidecar-down → 502 structured; config absent → routes absent (404).

## I2 — code_exercise block kit (client + session)
Fence: src/shared/blocks.ts, src/server/{session.ts, grading.ts, tutor-system-prompt.md},
src/client/{toolkit.tsx, components/blocks/CodeExercise*.tsx(new), styles.css append-only},
package.json (CM6 deps), tests. Contract above is verbatim.
1. Port from the-gap/apps/web/src (READ ONLY there; copy+adapt into harness client under
   components/blocks/gap/): RungEditor three-pane CM6 pattern, WorkedExample player,
   InlineCompletion, proximity bar + failureMessages for stream-consumer, detectors.ts pure
   reducer + OfferPanel trio (plan/predict/docs). Adapt fetches to /api/gap/*. Keep the Gap's
   dark-editor styling inside the block card; harness paper/ink chrome outside. npm deps:
   codemirror @codemirror/lang-javascript @codemirror/theme-one-dark @codemirror/state
   @codemirror/view (match versions the gap uses).
2. CodeExercise block component (Stage, chip like quiz): rung='ladder' walks
   worked_example → inline_completion → full_body with the gap's own sequence enforcement;
   single-rung values render just that screen. addResult(result per contract) when the
   sequence completes (or the learner abandons via an explicit "stop here" affordance —
   completed:false, rungReached set).
3. session.ts: code_exercise joins blockTools() automatically via BLOCK_TOOLS; verify the
   auto-resubmit predicate (blockOutputsComplete) needs no change (it iterates BLOCK_TOOL_NAMES).
4. grading.ts: mechanical branch per contract + tests (no model call — enforce with bare cfg).
5. tutor-system-prompt.md rule addition (verbatim from contract section).
6. Tests: component tests for the ladder walk inside the block (mock /api/gap fetches;
   jsdom pragma + cleanup + jest-dom import per repo conventions), grading branch tests,
   assertToneClean equivalent: no praise strings in ported failureMessages (port the gap's
   tone test minimally or assert the exact strings).

## I3 — vault wiring + practice entry + E2E
Fence: src/server/{index.ts or a new seed module}, src/client/components/{SidePanel.tsx,
PagePanel.tsx or PracticePanel.tsx(new)}, tutor-system-prompt.md, tests, .uitour additions.
1. Pattern page seeding: src/server/seedPatternPages.ts — on boot (after Engram.connect),
   for each gap ladder pattern (MVP: stream-consumer → slug 'stream-consumer' titled
   "Consuming SSE token streams", domain 'programming'), if slug missing from listSlugs,
   lw.call('write_page', {...stub body describing the pattern, status:'stub',
   sources:['the-gap artifact stream-consumer']}). Mechanical fixed content — document why
   this respects single-writer (goes through the server; content is static seed, not model
   output). Idempotent.
2. Practice entry point: Library panel gains a "Practice" section (or a small PracticePanel
   listing ladders from /api/gap/ladder): each row shows pattern + rented/owned derived from
   the student model via /api/student (exposed=rented, practicing+=owned-ish — document
   mapping); clicking sends the composer message "Practice <pattern> with a code exercise"
   via threadRuntime.append (tutor stays the orchestrator — one place).
3. E2E (tests/e2e or .uitour extension): scripted-model turn calling code_exercise
   {rung:'full_body'} → block renders in Stage via real gap sidecar (boot it in the test or
   mock the proxy — prefer REAL sidecar, fixture vault) → submit the reference answer
   server-fetched from the gap repo's masker (test-side, never through the UI payload) →
   auto-resubmit → grading mechanical → record_evidence lands 'applied-correctly' on
   'stream-consumer' in the TEMP vault student file. This is the integration's definition of
   done.
4. Playwright screenshots for review: block chip in chat, ladder in Stage, evidence chip after.

## Review gates
fable-plan-sonnet-execute 4-step per task. I2/I3 additionally: Playwright screenshots; grep
served payloads for the reference answer (must be absent); no modals; tone strings clean.
