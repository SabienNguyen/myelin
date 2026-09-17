# Audit fixes, 2026-08-30

Source: `docs/audit-2026-08-30.md`. Each task is one executor, TDD, fenced to the files listed.
Tasks are disjoint by file so they run in parallel in the same tree. Nothing touches
`src/server/index.ts` except T1 (bind) and the T7b follow-up (Anki wiring), which runs after T1.

## T1 Loopback bind, config-path expand, thread-id 400, fetchGraph fallback log
Files: `src/server/index.ts` (the `serve()` call only), `src/server/restRoutes.ts`,
`src/server/chatRoute.ts`, tests under `tests/` for those.
- `serve({ fetch: app.fetch, port: cfg.port, hostname: '127.0.0.1' })`. Log the bound address.
- `restRoutes.ts:452,470`: read `HARNESS_CONFIG` through the same `expand()` `config.ts` uses
  (export it from config.ts if it is not exported; that file is in-fence for the export line only).
- `chatRoute.ts:71-79` and the `POST /api/chat` stance write at `:63`: a thread id rejected by
  `assertThreadId` returns 400 with the message, and `setStance` must not run before the id check.
- `restRoutes.ts:33-45` `fetchGraph`: the version-skew fallback logs `console.error` with the
  caught error before walking pages.

## T2 Outbound timeouts
Files: `src/server/frontierResearch.ts`, `src/server/ingestRepo.ts`, `src/server/llm/mcpClient.ts`,
their tests.
- `frontierResearch.ts:44,69`: `AbortSignal.timeout(15_000)` on both fetches, matching `webTools.ts`.
- `ingestRepo.ts:184-199` git clone: `GIT_TERMINAL_PROMPT=0` in env, 5-minute timeout that kills
  the child and rejects with a message naming the URL.
- `mcpClient.ts:122-129` `request()`: per-request timeout (default 120s, overridable via an
  options arg) that rejects with an error whose message contains `transport timeout` so the
  existing `isTransportError` path in `mcp.ts` (which T3 is narrowing to match
  `mcp transport`) treats it as a dead child.

## T3 Respawn false positives
Files: `src/server/mcp.ts`, `tests/mcp.test.ts`.
- `TRANSPORT_ERROR` must not match tool-result text. Match only the client's own transport
  messages: `/^mcp transport|EPIPE|ECONNRESET|transport timeout/i` tested against the error
  message, and never against an error thrown at `mcp.ts:139` (`engram ${name}: ...`). Cleanest:
  throw a `ToolError` subclass at :139 and have `isTransportError` return false for it.
- `withRespawn`: `await this.client.close().catch(() => {})` before assigning the new client.
- Add `author_affinity` to `READ_ONLY_ENGRAM_TOOLS`.
- Fix the comment at `mcp.ts:109`: `ingestRepo.ts` does not call `write_page`; `seedPatternPages.ts` does.
- Test: an error `engram read_page: page not found: closed-loop-control` does not respawn; a
  `mcp transport closed` error does, and the old client's `close` was called.

## T4 Three model routes in webTools
Files: `src/server/webTools.ts`, its tests.
- Replace `isAnthropicRouted` with a route discriminator that mirrors `models.ts` (`anthropic` /
  `ollama` / `openai`). `openai:` gets the SearXNG function tool when configured and no tool
  otherwise; never the Anthropic server tool. Test all three.

## T5 Grading guards
Files: `src/server/grading.ts`, `src/shared/blocks.ts`, `tests/grading.test.ts`,
`tests/blank-submissions.test.ts`.
- `code_exercise` (`grading.ts:827`): `suiteGreen = testsTotal > 0 && testsPassed === testsTotal`.
- `numeric`/vector unit check (`:330,364`): route through the mathjs path `gradeUnitAnswer` uses,
  or compare with a prefix-aware equality; `20 km/s` vs `m/s` must fail, `20 m/s` must pass,
  `20 m s^-1` may pass.
- `pronounce` (`:757`): `applied = result.applied === true && passes >= required` (required
  defaults to the block's own value; if absent, treat as 1).
- Open-answer grader (`:1061`): accept only `^\s*\**\s*(CORRECT|INCORRECT)\b` after stripping
  leading markdown emphasis; when neither token is found, return `struggled` with detail
  `grader reply unparseable` and `console.error` the raw text.
- Pass `contextTokens: cfg.models.grader.contextTokens` on every grader-role call (`:901,1006,1060`).
- `shared/blocks.ts:172-176` `pattern` checker: `expected: z.string().min(1)`.
- `tests/blank-submissions.test.ts`: add `code_exercise`, `pronounce`, `label_diagram`,
  `watch_video` cases and an assertion that `CASES` covers every name in `BLOCK_TOOL_NAMES`.

## T6 Evidence survives a failed turn; rails guards
Files: `src/server/session.ts`, `src/server/rails.ts`, `src/server/historyDiet.ts`, their tests.
- `session.ts:1174-1215`: wrap the model call so that, whether it throws or aborts, (a) usage
  accumulated so far is written to the ledger, (b) the unrecorded-evidence guardrail at :1205
  still runs and logs. Do this with `try/finally`; the guardrail needs the graded outputs, which
  exist before the call.
- `rails.ts:516`: wrap `gradeBlockOutput` exactly as `session.ts:885-896` does.
- `rails.ts:529-531`: inspect the `record_evidence` result; on `isError` log via the same
  guardrail logger session.ts uses.
- `rails.ts:398`: `search` returns no `level`; fetch it from `get_student_state` for the best hit,
  or drop the field. Remove the dead `r.results` branch at :390.
- `historyDiet.ts`: also compact tool results for `read_page`, `video_transcript`, `web_search`,
  `find_recent_papers`, `course_problems` older than the last two turns to a one-line stub naming
  the tool and slug/url. Extend the header comment to say what is and is not compacted.

## T7 Atomic store writes and Anki ledger
Files: new `src/server/atomicWrite.ts`, `src/server/queueStore.ts`, `goalStore.ts`, `stanceStore.ts`,
`sessionStore.ts`, `courseBank.ts`, `provenance.ts`, `scheduler.ts`, `linkList.ts`,
`gap/generated.ts`, `src/server/anki/inbound.ts`, `src/server/anki/outbound.ts`, their tests.
NOT `index.ts`.
- `atomicWrite(path, text)`: write `path + '.tmp-' + pid`, `renameSync`. Use at every
  `writeFileSync` in the listed stores. Test: a throw mid-write leaves the old file intact.
- `courseBank.markCorrect`/`saveProblems`: serialize through one in-module promise chain the way
  `queueStore.updateQueue` does.
- Anki `readLedger` (both): parse failure logs `console.error` and returns `{}`.
- Anki ledger: one shared `withAnkiLedger(fn)` mutex so inbound and outbound cannot interleave
  their read-modify-write.
- Export `ankiOutboundTick(...)` from `outbound.ts` with the same shape as inbound's tick so T7b
  can schedule it.

## T7b (after T1 and T7) Wire Anki outbound
Files: `src/server/index.ts`.
- Call `ankiOutboundTick` from `ankiTick` after `syncInbound`, inside the same try.

## T8 Client fixes
Files: `src/client/components/FirstRun.tsx`, `src/client/components/blocks/Pronounce.tsx`,
`src/client/runtime.tsx`, `src/client/components/RichMarkdown.tsx`,
`src/client/components/TopbarStatus.tsx`, `tests/client/**`.
Build on the uncommitted FirstRun diff; do not revert it wholesale.
- `FirstRun.tsx:119`: reveal compat fields only for `openai:`-prefixed ids; improve the
  placeholder/helper copy so an OpenAI-compatible user learns to type `openai:`.
- `FirstRun.tsx:92-97`: after a 200 save, if the re-read is still `blocked`, show
  `state.apiKey.rolesNeeding` in the error slot.
- `tests/client/firstRun.test.tsx`: `stubFetch` computes `blocked` from the last PUT body (all
  roles `ollama:`/`openai:` or key present → false). Replace the test that pins bare-id reveal
  with one that asserts the still-blocked message.
- Remove the unused `id="compat-*"` attributes.
- `Pronounce.tsx:106-139`: stop tracks in a `finally` when recorder construction fails; `useEffect`
  cleanup stops any live recorder and stream on unmount.
- `runtime.tsx:14`: use `lib/api.ts` `getJson`; on failure render the error, do not mount an
  empty thread.
- `RichMarkdown.tsx:41`: run `scrubModelArtifacts` before `escapeLooseDollars`.
- `TopbarStatus.tsx:300-306,394-397`: a failed refresh sets a visible `note` and disables Save
  until a refresh succeeds; `configureLocal` does not print "ready" after a failed refresh.

## T9 Prompt fence, SSE guards, abort listener
Files: `src/server/ingest.ts`, `src/server/llm/openaiCompat.ts`, `src/server/llm/anthropic.ts`,
their tests.
- `ingest.ts:526-577`: fence chapter text with a per-call random tag
  (`<<<source-${nonce}>>>` ... `<<<end-source-${nonce}>>>`), tell the model text inside is data,
  and strip any occurrence of the tag from the chapter text first.
- `openaiCompat.ts:655`, `anthropic.ts:270`: a frame that fails `JSON.parse` is logged
  (`console.error` with the first 200 chars) and skipped, not thrown.
- `anthropic.ts:162-196`: remove the abort listener on the success path too (`finally`).

## T10 engram student model
Repo: `/home/sabien/Dev/personal/engram`. Files: `src/student/model.ts`,
`src/server/teachTools.ts`, `tests/student.test.ts`, `tests/teachTools.test.ts`.
- Dedupe (`model.ts:154-169`): "same" means equal after trim + lowercase + whitespace collapse.
  Substring containment is not sameness. Heal only exact duplicates. Tests:
  `['off by one', 'off by one in the loop bound']` survives; recording
  `'sign error when integrating by parts'` over `['sign error']` appends.
- `resolves`: empty/whitespace resolves nothing and returns a structured `err`. Schema
  `note`, `misconception`, `resolves`: `.trim().min(1)` where present. Whitespace-only
  misconception is rejected, not stored.
- Every `readStudent` call in tool handlers returns the file's `err(...)` shape on throw instead
  of rejecting at the protocol level.

## T11 engram vault integrity
Repo: `/home/sabien/Dev/personal/engram`. Files: `src/vault/vaultStore.ts`, `src/vault/parsePage.ts`,
`src/server/graphTools.ts`, `src/server/context.ts`, `src/embeddings/index.ts`, their tests.
- A single in-process write queue (`serialize(fn)`) that `write_page`, `link_pages`, `unlink_pages`
  and every vaultStore write go through, so two handlers cannot interleave across `await`.
- `writePage`, `appendReviewLog`, `saveRationale`, `writePathDoc` use `atomicWrite`.
- `parsePage`: keep unknown frontmatter keys in `meta.extra` (or equivalent) and `serializePage`
  writes them back. Fuzz test asserts an `aliases` key survives write → read → write.
- `strArray`: keep valid strings, warn about the rest, never return `[]` for a partially valid list.
- `write_page`'s second `snapshot()` must await the in-flight sync (or force a sync of the new
  page) so `proposeLinks` sees the page. Test through `write_page`, not `startSync` alone.
- `search`: emit `note` when embeddings are unavailable, using `embeddingsError` and the
  provider failure from `startSync`'s catch (surface it on the snapshot).

## T12 Hygiene
Files: `.gitignore`, `.github/workflows/ci.yml`.
- `.gitignore:9`: prefix the wrapped comment with `#`. Replace `*.mts` with the specific file it
  was meant to hide, or remove it if none.
- CI runs `npm run typecheck` before the build.
