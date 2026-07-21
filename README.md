# loreweaver-harness

A localhost tutoring web app that sits on top of the [Loreweaver](https://github.com) MCP
teaching-memory server: a chat tutor (Anthropic models, one per role — tutor / grader / quiz
generator / card generator / compiler) that teaches through subject blocks (quick checks, quizzes,
math scratchpads, writing drafts), shows a live mastery DAG of the student's pages, enforces an
evidence guardrail so nothing gets taught without being graded and recorded, and syncs two-way with
Anki. Loreweaver is the only writer of the vault and student files — the harness talks to it
exclusively over stdio MCP.

## Setup

1. **Node >= 22.**
2. `npm i`
3. Copy the example config and point it at your vault:
   ```bash
   cp harness.config.example.json harness.config.json
   ```
   Edit `harness.config.json`: `vault` (path to your Loreweaver vault), `student` (your student
   id), the five `models.*.model` ids, and `loreweaver.args` (path to your Loreweaver checkout's
   `src/server.ts`). `harness.config.json` is gitignored — it's local, developer-specific config.
4. **`ANTHROPIC_API_KEY`** — export it in your shell for `npm run dev:server` / `npm start`, or
   add it to a systemd user-service override (`systemctl --user edit loreweaver-harness`, then
   `Environment=ANTHROPIC_API_KEY=...` under `[Service]`) if running via the unit below.
5. **Anki desktop** — install it, then add the [AnkiConnect](https://ankiweb.net/shared/info/2055492159)
   add-on (code `2055492159`) via Tools → Add-ons → Get Add-ons. Anki must be running (with
   AnkiConnect loaded) for the two-way sync to do anything; the harness treats "Anki closed" as a
   normal, non-error state and just skips sync until it's back.
6. **Optional — real embeddings:** `ollama pull nomic-embed-text` and set
   `loreweaver.embeddings: "ollama"` in your config (the default). Set it to `"fake"` for tests/E2E
   or if you don't want to run Ollama.
7. **Optional — local models (ollama):** any role's `models.*.model` id can be prefixed with
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
   for the one-shot roles only: `grader` (open-answer + writing-draft grading), `card_gen`, and
   `compile`. The compile route additionally spawns its own loreweaver MCP server process (see
   `src/server/ingest.ts`'s `compileOne` for why that's an acceptable second writer) and can only
   enforce the write_page citation as a prompt instruction, not the mechanical guarantee the
   ai-sdk path gets from wrapping `execute()` — a known gap.

**Out of scope: the interactive `tutor` role.** `claude-sdk:` is not wired up for `tutor` — the
tutor's chat loop is a live, streaming, human-in-the-loop conversation (the assistant-ui chat
surface awaiting the student's next message mid-turn), and the Agent SDK's `query()` is a
run-to-completion async generator with no bridge to that HITL/streaming shape yet. Building that
bridge is a separate project; `tutor` must stay on a plain id or `ollama:` until then.

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

**Optional: the Gap sidecar (code-exercise blocks).** [The Gap](~/Dev/personal/the-gap) is a
separate repo providing gauntlet-graded coding ladders on `:4930` (+ its own dev UI on `:4931`,
unused by the harness until the code_exercise block ports it in a later task). If installed,
point `harness.config.json`'s `gap.url` at it (default `http://localhost:4930`) — absent, the
`/api/gap/*` proxy routes and the `gap` status badge simply don't register.
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
model as every other subject. The gap sidecar (`:4930`, plus its dev UI on `:4931`) is
infrastructure: don't open it to learn; it only serves ladders and runs tests for the harness.
With the sidecar configured, the harness also seeds a stub vault page per ladder pattern at boot
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
The E2E test spins up the real Hono backend and a real Loreweaver server (fake embeddings, a
disposable fixture vault) with the tutor model replaced by `tests/e2e/scripted-model.cjs` (via the
`LW_MOCK_MODEL` env hook in `src/server/models.ts`), then drives the built SPA with a real browser:
bootstrap → the tutor opens with a `quick_check` block → the student answers → the harness grades
it and the scripted model calls `record_evidence` → the test asserts the evidence landed in the
student's file.

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
