# loreweaver-harness

A learn-anything tutoring app (desktop and localhost web) on top of the Loreweaver MCP
teaching-memory server. A chat tutor teaches through graded blocks, a mastery graph tracks what
you have actually proven, and an evidence guardrail keeps the two honest: nothing counts as
learned without being graded and recorded, and a model's opinion can never mint the evidence a
machine check earns. Loreweaver is the only writer of the vault and student files — the harness
talks to it exclusively over stdio MCP.

What that means in practice:

- **Every subject gets an applied check.** Mechanical checkers for science and structured answers
  (numeric/unit algebra/chem equations/sets/sequences/matching/note arithmetic), a step-aware
  math scratchpad (MathLive + numeric equivalence), diagram labelling for picture subjects,
  rubric'd writing drafts with annotations and a one-click revise round for essay subjects, and a
  code sandbox: exercise ladders, generated exercises behind a review gate, and whole-program
  judging in ten runtimes (node, TypeScript, python3, bash, ruby, sqlite, C, Rust, CUDA where a
  toolkit exists; Go/Java via Docker) plus compose-backed service environments (redis, postgres).
- **Your material is the curriculum.** One "Add material" control ingests books/papers
  (PDF/EPUB/DOCX/MD), git repos (functions mined into exercises with your approval), YouTube
  lectures (the video's own captions become a timestamped transcript — needs `yt-dlp`, no video
  download), and problem sets or past exams — banked and drilled verbatim, never paraphrased. A
  source reader opens any ingested artifact beside the conversation; select a passage to ask
  about it, and the tutor can bring you to a source itself.
- **The tutor is a librarian first.** Live literature search (newest and most-cited), citation
  chasing through an ingested paper's own references, and prompt rules that route learning
  through real human artifacts — with research claims that must match what was actually read.
- **The loop closes visibly.** Spaced review with decay, an interleaved one-click session plan,
  misconception record → surface → repair → resolve (with the repair history kept), per-student
  profiles, a teaching-style preference, and two-way Anki sync.

## Setup

1. **Node >= 22.**
2. `npm i`
3. `npm start`, open the app, and paste an Anthropic API key when it asks.

That is the whole required setup. **There is no config file to write** — every field has a working
default (`src/server/config.ts`):

| | Default | Change it with |
|---|---|---|
| Vault | `~/Documents/Loreweaver`, or `~/loreweaver-vault` if you have no Documents folder. Created at boot. | `vault` |
| Student id | your OS username | `student` |
| Models | Sonnet for tutor/quiz/compile, Haiku for grader/card_gen | `models.*.model` |
| Loreweaver MCP server | found automatically: installed dependency, then a sibling `loreweaver` checkout | `LOREWEAVER_ENTRY`, or `loreweaver.command`/`args` |
| Port | 4820 | `port` |

Anything you do want to change goes in `harness.config.json` — copy
`harness.config.example.json` and delete everything you are not overriding; partial files are fine
and untouched fields keep their defaults. `harness.config.json` is gitignored.

The boot log names what it resolved, so a wrong path shows up immediately rather than as a broken
feature later:

```
config: none found at ./harness.config.json — using defaults
vault:  /home/you/Documents/Loreweaver
memory: /usr/bin/node /home/you/loreweaver/dist/server.js
```

### The API key

Anthropic-routed model roles need one. The app asks for it on first run, checks it against Anthropic
before saving (so a wrong key fails at the prompt, not mid-lesson), and stores it in your OS config
directory — `~/.config/loreweaver/credentials.json`, `~/Library/Application Support/Loreweaver/` on
macOS, `%APPDATA%\Loreweaver\` on Windows — **not** in the vault, since vaults get synced and
pushed. `ANTHROPIC_API_KEY` in the environment always wins over the saved key, so a systemd override
(`systemctl --user edit loreweaver-harness`, then `Environment=ANTHROPIC_API_KEY=...` under
`[Service]`) still works. A fully `ollama:` or `claude-sdk:` setup is never asked for a key.

### Optional extras

4. **Anki desktop** — install it, then add the [AnkiConnect](https://ankiweb.net/shared/info/2055492159)
   add-on (code `2055492159`) via Tools → Add-ons → Get Add-ons. Anki must be running (with
   AnkiConnect loaded) for the two-way sync to do anything; the harness treats "Anki closed" as a
   normal, non-error state and just skips sync until it's back.
5. **Better search (embeddings)** — on by default (`loreweaver.embeddings: "ollama"`) and it
   degrades quietly: without Ollama, semantic search and `find_analogies` fall back to lexical
   matching rather than failing. To get the real thing, `ollama pull nomic-embed-text`. Set it to
   `"none"` to stop trying, or `"fake"` for tests/E2E.
6. **Local models (ollama):** any role's `models.*.model` id can be prefixed with
   `ollama:` (e.g. `"grader": { "model": "ollama:qwen2.5-coder:14B" }`) to route that role through
   a local Ollama model instead of Anthropic, via Ollama's OpenAI-compatible endpoint. It defaults
   to `http://localhost:11434/v1`; override with `OLLAMA_BASE_URL` if Ollama runs elsewhere.
   **Context length caveat:** Ollama's runtime default context window is 4096 tokens regardless of
   what the model actually supports, which is too small for this harness's prompts (system prompt +
   MCP tool results + session context). Raise it on the Ollama service, e.g.
   `OLLAMA_CONTEXT_LENGTH=32768` (systemd: `systemctl --user edit ollama`, add
   `Environment=OLLAMA_CONTEXT_LENGTH=32768` under `[Service]`, then restart). Recommended split:
   keep `tutor` and `compile` on Claude (they need the strongest reasoning/tool-use), and route
   `grader`, `quiz_gen`, and `card_gen` to a local model — those are higher-volume, lower-stakes
   calls that a good local coder/instruct model handles fine.
   **Troubleshooting — leaked chat-template tokens:** a degenerate local model can echo its raw
   ChatML control tokens (`<|im_start|>assistant`, `<|endoftext|>`, ...) as literal chat text; the
   harness scrubs these at render (`scrubModelArtifacts` in `src/client/lib/panelBus.ts`) and the
   bundled Ollama models also carry stop params to fix run-on generation at the source.

## Model routes: API key, local (ollama:), subscription (claude-sdk:)

Every `models.*.model` id is routed by matching a prefix — plain id, `ollama:`, or `claude-sdk:` —
so a config can freely mix routes per role, and moving a role off one route later is just editing
that string.

1. **Plain id** (e.g. `"claude-sonnet-5"`) — the Anthropic API, billed to `ANTHROPIC_API_KEY`.
2. **`ollama:<model>`** — a local Ollama model over its OpenAI-compatible endpoint. See setup step
   7 above.
3. **`claude-sdk:<model>`** (e.g. `"claude-sdk:sonnet"`) — the [Claude Agent
   SDK](https://code.claude.com/docs/en/agent-sdk/typescript), drawing from your Claude Pro/Max
   subscription's credit pool via your machine's local `claude` (Claude Code) login — **no API
   key involved**. Requires being logged into Claude Code on this machine (`claude` CLI installed
   and authenticated); the SDK reuses that login rather than reading `ANTHROPIC_API_KEY`. Routed
   for the one-shot roles — `grader` (open-answer + writing-draft grading), `card_gen`, and
   `compile` (which additionally spawns its own loreweaver MCP server process — see
   `src/server/ingest.ts`'s `compileOne` for why that's an acceptable second writer — and can only
   enforce the write_page citation as a prompt instruction, not the mechanical guarantee the
   ai-sdk path gets from wrapping `execute()`, a known gap) — **and now also `tutor`** (T43, below).

### `tutor` on the Agent SDK

Setting `models.tutor.model` to a `claude-sdk:` id routes the interactive chat tutor through
`src/server/claudeSdkTutor.ts` (`createClaudeSdkTutorSession`) instead of the AI-SDK
`ToolLoopAgent` path in `src/server/session.ts` — picked at server construction time in
`chatRoute.ts` by inspecting `cfg.models.tutor.model`. It streams the same UIMessage chunk shapes
the existing chat client understands (block tools pause the turn, grading round-trips, the
evidence guardrail nudge, thread continuation), so no client changes are needed to use it.

How it bridges the Agent SDK's run-to-completion `query()` async generator to a HITL chat turn:
- **Blocks pause the turn via an MCP sentinel, not a real pause primitive.** `quick_check` /
  `quiz` / `math_scratchpad` / `writing_draft` / `code_exercise` are registered as an in-process
  MCP server (`createSdkMcpServer`, one `tool()` per `BLOCK_TOOLS` entry) whose handler returns a
  sentinel telling the model to end its turn immediately; the system prompt reinforces this. The
  student's answer arrives as the next chat message, exactly like the ai-sdk path's frontend
  tools.
- **Session continuity uses SDK session resume**, not full-transcript replay: `vault/.harness/sdk-sessions.json`
  maps `threadId -> sdkSessionId`. Turn 1 starts a fresh `query()` and captures the session id off
  the `system`/`init` message; later turns pass only the new turn's content via `options.resume`.
  If resume fails (a stale/pruned session id), the harness falls back to a fresh session seeded
  with a rebuilt bootstrap context, overwrites the stored id, and logs the failure loudly to
  stderr (`console.error`) — it does not fail the turn silently.
- **Streaming** uses `options.includePartialMessages: true` for live text (`stream_event` /
  `content_block_delta` text deltas), and the complete `assistant` message for tool-call input
  (block tools and loreweaver tools alike) since partial JSON-delta tool input isn't useful to the
  UI, which needs the whole object anyway.
- **Argument sanitization** (forcing the configured student id, repairing hallucinated slugs —
  `sanitizeToolArgs`, shared with `session.ts`) runs through a `PreToolUse` hook's `updatedInput`.
  **Verified against a live subscription login:** `canUseTool` was tried first, but the SDK's own
  runtime warning (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`, seen in the journal on a live run) confirmed
  it is dead on this path for two independent reasons — `permissionMode: 'bypassPermissions'`
  auto-approves every tool call before `canUseTool` is consulted, and separately, bare
  `allowedTools` entries (which is what this route's `allowedTools` list is — plain tool names, no
  `Tool(scope)` syntax) shadow `canUseTool` too, so switching `permissionMode` to `'default'` alone
  would not have fixed it. The SDK's own warning names the actual fix: a `PreToolUse` hook is not
  shadowed by either cause, and `PreToolUseHookSpecificOutput.updatedInput` rewrites tool input the
  same way `canUseTool`'s `updatedInput` would have. Each sanitized call logs `[sdk-sanitize]
  <tool>` to stderr so a live run can confirm the seam fires.
- **Known limitations of this path** (only `web_search`/`read_url` and `ingest_paper` — the
  research tools on the ai-sdk path — are not wired up here yet; everything else
  `session.ts`'s freeform mode offers, including `write_page`/`link_pages`/`compile_source`, is
  available). Requires the same local `claude` (Claude Code) login as the other `claude-sdk:`
  routes above.

## Desktop app

`npm run dist` produces a single downloadable file — an AppImage on Linux, a dmg on macOS, an NSIS
installer on Windows — that a person can run with nothing installed and no config to write. It bundles
both repos: the harness serves its own built client on one port (`src/server/staticRoutes.ts`), and
Loreweaver rides along as an unpacked resource that the app spawns over stdio exactly as it does in
development.

```bash
npm run dist            # build:all + bundle:loreweaver + electron-builder
npm run desktop         # same shell against the dev tree, no packaging
```

Three things in this path are not obvious, and each was a bug before it was a comment:

- **`ELECTRON_RUN_AS_NODE=1` on the Loreweaver child** (`src/server/mcp.ts`). Inside the packaged
  app, `process.execPath` — which is what runs a compiled entry — is the Electron binary, so
  spawning it plainly opens a second app window instead of a Node process.
- **Loreweaver is copied in an `afterPack` hook**, not declared as an `extraResources` entry
  (`electron/afterPack.mjs`). electron-builder strips `node_modules` out of extra resources, and the
  shipped server imports `@modelcontextprotocol/sdk` at runtime — so the extraResources version
  packaged cleanly, launched, and died with `ERR_MODULE_NOT_FOUND`. It also has to live outside the
  asar archive, because Node cannot spawn a script from inside one.
- **`scripts/bundle-loreweaver.mjs` installs runtime deps from the lockfile** rather than copying the
  dev checkout's `node_modules`. Copy-then-prune was tried first and left typescript, vitest and
  rollup in the download.

The renderer is a plain web client — no preload, no node integration, `sandbox: true` — because it
talks to the local server over HTTP like any other browser would, so there is no reason to give it
privileges. External links open in the real browser.

`tests/packaging.test.ts` pins these as static checks, so a config edit that would reintroduce one
fails in seconds instead of at the end of a 230MB build.

**Not yet done:** no application icon (the default Electron icon ships), no code signing or
notarization, and no auto-update channel. Only the Linux AppImage has been built and launched here;
the mac and win targets are configured but unverified.

## Running

**Dev** (two processes, hot reload, Vite proxies `/api/*` to the Hono server):
```bash
npm run dev:server   # Hono + AI SDK agent loop + Loreweaver MCP client, :4820
npm run dev:client   # Vite dev server, :5173
```
Open `http://localhost:5173`.

**Production-ish (single machine, no reload):**
```bash
npm run build                       # vite build -> dist/
npm start                           # the backend, :4820 (or install as the systemd unit below)
npx vite preview --port 4173        # serves dist/; inherits vite.config.ts's /api proxy to :4820
```
The systemd unit below manages the backend process only (matches this task's scope — it does not
add static-file serving to the Hono server). `vite preview` is a perfectly serviceable static host
for a single-user localhost app; swap in any other static server pointed at `dist/` if you'd
rather not depend on Vite at runtime, just make sure it proxies `/api/*` to the backend's port.

**As a systemd user service:**
```bash
mkdir -p ~/.config/systemd/user
cp systemd/loreweaver-harness.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now loreweaver-harness
```

**Code exercises work out of the box.** The harness ships a built-in coding sandbox
(`src/server/gap/`): the stream-consumer ladder plus a grader that runs submissions in a spawned
child process with a hard wall-clock kill — so an unbounded loop in learner code dies at 6s instead
of hanging the tutor. Nothing to install, nothing to configure; `/api/gap/*` serves from the app's
own process and the `stream-consumer` pattern page is seeded at boot.

**Optional: the external Gap sidecar (more patterns).** [The Gap](~/Dev/personal/the-gap) is a
separate repo providing the fuller ladder stack on `:4930` (mined artifacts, additional patterns,
its own dev UI on `:4931`). If installed, point `harness.config.json`'s `gap.url` at it (default
`http://localhost:4930`) — a configured url takes precedence over the built-in sandbox.
```bash
cp systemd/the-gap.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now the-gap
```
`pnpm demo` (this unit's `ExecStart`) runs a synchronous gauntlet pre-flight — building and
grading every rung of the demo ladder — before the API server starts serving; that's by design
(content re-earns its place every boot), and pushes boot time to several seconds. Watch
`journalctl --user -u the-gap -f` on first start; `curl localhost:4930/api/ladder` should answer
once it's up.

**One place to learn:** the tutor UI on `:4173` is the product surface — code exercises render as
blocks in its Stage, pattern pages live in its vault/graph, and evidence lands in the same student
model as every other subject. The sandbox — built-in or the `:4930` sidecar — is
infrastructure: don't open it to learn; it only serves ladders and runs tests for the harness.
The harness also seeds a stub vault page per ladder pattern at boot
(`src/server/seedPatternPages.ts`) and the Library tab grows a "Practice" section listing each
pattern with an owned/rented/new badge derived from the student model (effective practicing or
better → owned; exposed → rented; no record → new); clicking a row simply asks the tutor to run a
code exercise — the tutor stays the orchestrator.

## Tests

```bash
./node_modules/.bin/vitest run     # unit + integration suite
./node_modules/.bin/tsc --noEmit   # typecheck
npm run e2e                        # Playwright: full tutor loop against a scripted model
```
The e2e suite spins up the real Hono backend and a real Loreweaver server (fake embeddings,
disposable fixture vaults) with the tutor model replaced by `tests/e2e/scripted-model.cjs` (via the
`LW_MOCK_MODEL` env hook in `src/server/models.ts`), then drives the built SPA with a real browser.
Four specs: the full tutor loop (quick_check → grade → evidence on disk), the whole coding flow
against the built-in sandbox (predict gate → CM6 editor → real tests → evidence), the exercise Help
tab, and the contextual graph. On a machine that ships a pinned Chromium the config can't download
(e.g. a sandboxed CI image), point it at the one that exists:
`PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run e2e`.

### CI

Every push runs `.github/workflows/ci.yml`: typecheck unconditionally, then the vitest and
Playwright suites. The test suites spawn the real loreweaver server from the sibling private repo,
so they only run once the `LOREWEAVER_CI_TOKEN` repository secret exists — a fine-grained personal
access token with read (contents) access to `SabienNguyen/loreweaver`. Until then CI stays green on
the typecheck alone and prints a warning naming the missing secret.

## The evidence model, in five lines

- Mastery levels: `unseen → exposed → practicing → mastered`; they only change through
  `record_evidence` — never by presenting material, and never promoted from mere recall.
- Mastery **decays**: `mastered` needs reinforcement within 45 days, `practicing` within 21, or the
  *effective* level drops back a rung (raw level is kept for history).
- Evidence kinds: `exposed`, `explained-correctly`, `applied-correctly`, `struggled`,
  `misconception` (with a note).
- Anki review sync has a ceiling: a card review maps to `exposed` (refreshes the decay clock,
  never promotes), a lapse (Again) maps to `struggled` — Anki reviews alone can never produce
  `applied-correctly`/`explained-correctly`.
- The harness's evidence guardrail nudges the tutor once, then logs to
  `vault/.harness/guardrail.log`, if a graded block result isn't followed by a `record_evidence`
  call.
