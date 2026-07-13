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
