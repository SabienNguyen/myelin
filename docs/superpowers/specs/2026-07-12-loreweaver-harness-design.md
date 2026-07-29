# Engram Harness — Design Spec

**Date:** 2026-07-12
**Status:** Approved design, pre-implementation
**Repo:** `~/Dev/personal/myelin` (standalone app; Engram server at `~/Dev/personal/engram` is a dependency, unchanged)

## 1. Goal

A learner-facing tutoring harness over the Engram MCP server: a localhost web app where a tutor agent teaches any subject from a Engram vault, with the ritual, enforcement, and rendering that generic chat harnesses cannot provide:

1. **Ritualized session start** — the loop, not the prompt, guarantees the tutor knows student state before the first word.
2. **Mechanical evidence guardrail** — teaching exchanges cannot silently skip `record_evidence`.
3. **Rendering** — prereq DAG with mastery/decay, clickable wiki-links, subject-specific interactive blocks.
4. **Push, not pull** — review-due notifications fire natively even with no browser open.

Subject-generic by design: math and writing kits ship in v1; every other subject works day one via the universal quiz/quick-check blocks, and new kits are additive.

## 2. Decisions log (from brainstorm, 2026-07-11/12)

| Decision | Choice |
|---|---|
| Relationship to AGI Path app | Standalone app; vault format is the only contract. Possible roadmap import later (v1.x+) |
| v1 features | Graph+mastery panel, scheduler+notifications, evidence guardrail, quiz mode — all four |
| Model strategy | No hardcoded models. Role → model routing in config, switchable at runtime (Claude Code-style) |
| Layout | **A: Tutor Desk** — chat spine + one tabbed side panel (Stage / Graph / Page). Light blocks inline in chat, heavy blocks in Stage |
| Subject kits in v1 | **Math + writing** (plus universal quiz + quick-check) |
| Anki | **Full two-way in v1** (cards out via AnkiConnect, review outcomes back as evidence) |
| Graph view | **A: layered ladder** (dagre/ELK deterministic DAG). Constellation skin deferred; Obsidian covers ambient graph browsing |
| Stack | **Approach 1**: Node backend on AI SDK v7 + assistant-ui frontend, behind a thin `TutorSession` interface (raw-SDK swap stays a one-module change) |

## 3. Architecture

```
Browser SPA (Vite + React + assistant-ui)
  ├─ Chat pane (assistant-ui thread; quick-check blocks inline)
  └─ Side panel tabs: Stage (blocks) · Graph (mastery DAG) · Page (rendered markdown)
        │  HTTP + SSE (useChat protocol) · REST (graph/state/pages)
Node backend (Hono; systemd user service)
  ├─ TutorSession — AI SDK v7 ToolLoopAgent; bootstrap; guardrail; model router
  ├─ Scheduler   — node-cron → notify-send (libnotify/Hyprland)
  └─ AnkiBridge  — AnkiConnect client (localhost:8765), both directions
        │  stdio (spawned child)      │  HTTPS
Engram MCP server (13 tools)   Anthropic API (per-role models, prompt caching)
        │
Vault files (pages/, students/, raw/, review-log.md)
  └─ vault/.harness/ — harness-only state (see §10)
```

**Boundary rule (load-bearing):** the Engram MCP server is the **only writer** of vault and student files. The AnkiBridge records evidence via `record_evidence`; the graph/page REST endpoints read via MCP tools. The harness never parses or writes vault markdown directly. One writer, no divergence.

**Frontend stack:** Vite, React, TypeScript, `@assistant-ui/react` + `@assistant-ui/react-ai-sdk`, `@assistant-ui/react-markdown` with a remark wiki-link plugin (clicks route to the Page tab), KaTeX for math display, MathLive for math input, dagre (or ELK) for graph layout.

**Backend stack:** Node, TypeScript, Hono, `ai` (v7) + `@ai-sdk/anthropic` + `@ai-sdk/mcp` (stdio transport), node-cron, zod.

## 4. Block system

A **block** is a frontend tool call: the tutor calls `present_block({kind, payload})`; the tool call streams to the browser; assistant-ui generative UI renders the component for `kind`; the user's completed work returns as the tool result; the loop grades it and records evidence.

**Extensibility contract:** a new subject kit = one payload/result schema (zod, shared types package) + one React component + one grading rubric prompt. No loop, server, or protocol changes.

**Placement:** `quick-check` renders inline in the chat transcript; all other kinds render in the Stage tab (chat shows a compact "sent to stage ▸" chip).

### v1 block kinds

| Kind | Payload (essentials) | Result | Grading |
|---|---|---|---|
| `quick-check` | one question, answer mode (text/choice) | answer | mechanical if choice/exact; else `grader` role |
| `quiz` | item list (multiple-choice, short-answer, cloze), page slugs | per-item answers | mechanical where objective; `grader` for short answers |
| `math-scratchpad` | problem (LaTeX), step mode on/off, page slug | steps[] + final (LaTeX from MathLive) | per-step check on submit: numeric equivalence first (evaluate student vs expected expression at sampled points via mathjs), `grader` fallback for non-evaluable steps; step-level errors feed misconception evidence |
| `writing-draft` | prompt, round number, prior-round text | draft text | `grader` returns typed annotations: `{span, category, note}[]` + per-skill grades (claim, concision, specificity); rounds are diffed |

**Evidence flow:** every graded block ends in `record_evidence` with the appropriate kind (`applied-correctly`, `explained-correctly`, `misconception` + note, `exposed`). Objective results are graded mechanically; the LLM `grader` is reserved for open-ended work.

## 5. Tutor loop (`TutorSession`)

- **Bootstrap ritual:** on session open, the **backend** calls `get_student_state`, `next_lessons` (with active goal), and review-due queries, injecting results into the first request. Not model-optional.
- **Modes** (changes injected framing only): `learn` (default), `review` (due items first), `quiz`, `freeform`.
- **Evidence guardrail:** loop tracks a per-turn flag — gradeable event (block result returned, or new concept presented) without a matching `record_evidence`. On attempted turn end with flag up: inject one system nudge and continue. Second failure: end turn, log `⚠ evidence not recorded` to UI + file.
- **Model routing:** roles `tutor`, `grader`, `quiz_gen`, `card_gen`, `compile` — each `{model, effort?}` in config. Header dropdown switches `tutor` live and persists. Non-tutor roles run as one-shot calls outside the conversation context.
- **Prompt caching:** system prompt (pedagogy rules, evolved from engram `docs/tutor-prompt.md`) + tool definitions are stable per session → cache-controlled.
- **Persistence:** threads as JSONL in `vault/.harness/sessions/`. Resume is a convenience; a fresh session bootstrapped from student state must always be sufficient (portability invariant).
- **Swap hedge:** `TutorSession` exposes a thin interface (start, send, events out); AI SDK specifics stay inside the module.

## 6. Graph + mastery panel

- Layered DAG (dagre/ELK), goal at top, prereq arrows solid, `deepens` dashed/dimmed.
- Node color = **effective (decayed) mastery**: unseen gray, exposed amber, practicing blue, mastered green.
- **Decay ring:** countdown arc to next level drop, with "· Nd" label.
- **⚠ misconception badge**; hover reveals the note.
- 🎯 goal marker; unmet-prereq path highlighted — same query `next_lessons` uses, so panel and tutor cannot disagree.
- Interactions: click → Page tab (rendered markdown, clickable wiki-links); context action → "teach me this now" (starts targeted learn exchange).
- Data via backend REST endpoints that call MCP tools (`read_page`, `get_student_state`, `next_lessons`) — no direct vault reads.

## 7. Scheduler + notifications

- node-cron in the backend (systemd user service ⇒ works with no browser open).
- Daily digest at configured hour: decay warnings + reviews due → single `notify-send`.
- **Notification ledger** (`vault/.harness/notify.json`): each decay/due event notifies once. Quiet hours + cadence in config.
- `notify-send` missing → warn in log, feature off.

## 8. Anki two-way sync (AnkiBridge)

**Prereqs (setup step, documented in README):** install Anki desktop + AnkiConnect add-on; Anki must be open for sync ticks to land.

- **Outbound:** page reaches `practicing` or a quiz item is missed → `card_gen` generates cloze/Q-A cards → push to deck `Engram::<domain>`, tag `engram::<slug>`. Ledger `vault/.harness/anki-map.json` (noteId ↔ slug ↔ content hash) dedupes and updates in place when a page changes.
- **Inbound:** sync on backend start, every 30 min, and before session bootstrap. Pull reviews of tagged cards since last sync; aggregate per slug per day:
  - consistent Good/Easy → one successful practice rep (refreshes decay via `record_evidence`);
  - Again → lapse; repeated lapses surface at next session start for re-teaching/misconception probing.
- **Honesty ceiling:** Anki evidence can *maintain* but never *promote* a page to `mastered`. Promotion requires in-session explained/applied evidence. (Enforced in AnkiBridge's evidence mapping, not by the server.)
- **Failure:** Anki closed → skip silently, retry next tick; nudge notification only if backlog > configured days.

## 9. Configuration (`harness.config.json`, zod-validated at boot)

```jsonc
{
  "vault": "~/Dev/personal/engram-vault",
  "student": "sabien",
  "models": {
    "tutor":   { "model": "claude-sonnet-5" },
    "grader":  { "model": "claude-haiku-4-5" },
    "quiz_gen":{ "model": "claude-sonnet-5" },
    "card_gen":{ "model": "claude-haiku-4-5" },
    "compile": { "model": "claude-sonnet-5" }
  },
  "engram": { "command": "npx", "args": ["tsx", "~/Dev/personal/engram/src/server.ts"], "embeddings": "ollama" },
  "schedule": { "digestHour": 9, "quietHours": [22, 8], "ankiSyncMinutes": 30, "ankiBacklogNudgeDays": 3 },
  "port": 4820
}
```

Model values are examples, not defaults baked into code; every role is user-editable and the tutor role is switchable in the UI.

## 10. Harness state (`vault/.harness/`)

- `anki-map.json` — card ledger (§8)
- `notify.json` — notification ledger (§7)
- `sessions/*.jsonl` — chat threads (§5)
- Travels with the vault; ignored by the Engram server; safe to delete (degrades gracefully: cards re-deduped by tag scan, notifications may re-fire once, threads lost but student model intact).

## 11. Error handling

Theme: **degrade loudly, never corrupt.**

- MCP child crash → respawn with backoff; in-flight turn fails visibly; durable state safe (single-writer rule).
- Anthropic API error → error in thread + retry; roles fail independently.
- Anki/Ollama unavailable → silent degrade + header status badge.
- Config invalid → fail loud at boot with precise zod message.
- Guardrail second-failure → visible UI warning + log file entry.

## 12. Testing

- **Loop (densest):** AI SDK mock models — guardrail nudge fires; bootstrap injects state; routing honors config; mode framing.
- **AnkiBridge:** fake AnkiConnect HTTP fixture — ledger dedup, grade→evidence mapping, maintain-not-promote rule.
- **Scheduler:** injected clock — decay windows, ledger dedup, quiet hours.
- **Blocks:** Testing Library component tests — math step flow, writing annotations, schema round-trips.
- **E2E (one):** Playwright — real backend + real Engram server (fake embeddings) + mock model: bootstrap → quick-check → answer → evidence in student file.

## 13. Deferred (v1.x+)

- Constellation graph skin (component-boundary swap)
- Science / history / social-studies / language kits (timeline, diagram, source-analysis, cloze+audio blocks)
- FSRS/BKT student model (lands in Engram server, not harness)
- AGI Path roadmap import as a Engram path
- Multi-student UI (config field exists; UI assumes one)
- Voice, mobile
