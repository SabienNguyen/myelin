# Own harness: replacing the AI SDK with a first-party model layer

Goal (owner's words): replace the Vercel AI SDK stack with a harness this repo owns, able to sit
behind LiteLLM. Motivation: full control of the loop (rails mode for small models needs it), full
control of token spend (cache placement, compaction, working-set context assembly all become
first-party concerns), and one less framework whose abstractions we fight (the T13 resubmit bugs,
the UIMessage continuity workarounds).

## What "own harness" means here

Three layers, replacing five server packages (`ai`, `@ai-sdk/anthropic`,
`@ai-sdk/openai-compatible`, `@ai-sdk/mcp`, plus the never-imported `@ai-sdk/react`) and
eventually the client runtime (`@assistant-ui/react-ai-sdk`):

1. **Provider layer** (`src/server/llm/`) — our own chat-completion interface over plain `fetch`.
   Two adapters, no SDK dependencies:
   - `anthropic.ts` — the Messages API natively (system + messages, tool use, streaming SSE,
     `cache_control` placed by US, usage fields read by US). Native rather than via LiteLLM so
     prompt-caching control and cache-hit accounting stay first-party — they are the whole Tier-2
     efficiency program.
   - `openaiCompat.ts` — `/v1/chat/completions` for everything else: Ollama, OpenRouter, Nous,
     and a LiteLLM proxy. LiteLLM is how "100+ providers" arrives without us writing adapters:
     run `litellm --port 4000`, set the base URL, done. We speak one wire format; LiteLLM
     translates.
   Both return the same first-party types: `ChatRequest` (messages, tools, system, maxTokens,
   cache hints) and an async-iterable `ChatStream` of first-party events (`text-delta`,
   `tool-call`, `usage`, `done`). No provider types leak past this layer.

2. **Loop layer** (`src/server/llm/loop.ts`) — the tool loop the harness owns. Registers tools
   (block tools + bridged Engram MCP tools), drives call → execute → append → continue, enforces
   the loop policies that today live in patches over the SDK (the block-pause semantics, the
   auto-resubmit predicate, the evidence guardrail hook, max-iteration guards). This is where
   rails mode, deterministic evidence recording, working-set context assembly, and compaction
   later plug in — the reason to own the loop at all.

3. **Wire layer** (`src/server/llm/wire.ts`) — translates loop events into the exact UIMessage
   stream chunks the existing client consumes. THE LOAD-BEARING CONSTRAINT: the client
   (`@assistant-ui/react` + `@assistant-ui/react-ai-sdk` runtime) stays untouched in phases A-D;
   the server must be indistinguishable on the wire from the SDK it replaces. The e2e suite is
   the proof — all 10 specs drive the real client against the real backend and must stay green
   with the SDK gone.

   ### The wire contract, pinned (recon 2026-07-30)

   The client does NOT parse with the top-level `ai@7`. `@assistant-ui/react-ai-sdk@1.3.40`
   bundles its own nested `ai@6.0.224`, and that copy validates every SSE chunk against a
   STRICT zod union (`z.strictObject` — unknown chunk types AND unknown fields are rejected,
   not ignored). The wire layer may emit only:

   - `text-start` / `text-delta` / `text-end` (correlated by `id`)
   - `tool-input-start` / `tool-input-delta` / `tool-input-available` / `tool-input-error`
     (`toolCallId`, `toolName`, `input`)
   - `tool-output-available` (`toolCallId`, `output`) / `tool-output-error` / `tool-output-denied`
   - `tool-approval-request` (WITHOUT `isAutomatic` — that field is ai@7-only and fails ai@6
     validation), `reasoning-start|delta|end`, `source-url`, `source-document`, `file`
   - `data-*` (`{type, id?, data, transient?}`)
   - `start` (`{messageId?, messageMetadata?}`), `start-step`, `finish-step`,
     `finish` (`{finishReason?: 'stop'|'length'|'content-filter'|'tool-calls'|'error'|'other'}`)
   - `error` (`errorText`), `abort`, `message-metadata`

   NEVER: `custom`, `reasoning-file`, `tool-approval-response` (ai@7-only chunk types).

   Encoding: SSE — `data: ${JSON.stringify(chunk)}\n\n` per chunk, terminated by
   `data: [DONE]\n\n`. Headers: `content-type: text/event-stream`, `cache-control: no-cache`,
   `connection: keep-alive`, `x-vercel-ai-ui-message-stream: v1`, `x-accel-buffering: no`.

   Message-id continuity (pinned by tests/session.test.ts): the `start` chunk's `messageId` is
   the LAST incoming message's id iff that message is `role: 'assistant'` (block resubmit —
   continue that message in place), else a freshly generated id (turn 1).

   App-written chunks that must keep working: pre-model `tool-output-available` writes carrying
   `.grading` back to already-rendered block cards (session.ts:786), and the transient
   `data-guardrail` part. A guardrail-retry turn merges TWO loop runs into ONE HTTP stream —
   the wire layer must support multiple sequential runs writing to a single response, with
   step boundaries (`start-step`/`finish-step`) intact.

   Client POST body: the wire layer's route reads only `messages` (full UIMessage[] with
   `parts`), `mode`, `threadId`, `writeUp`; the transport also sends `id`/`trigger`/
   `messageId`/`tools`/`system`, all ignored server-side today — keep ignoring them.

## MCP: currently on `@ai-sdk/mcp`, replaced with a first-party stdio client

Recon correction: the MCP bridge (`src/server/mcp.ts`) runs on `@ai-sdk/mcp@2.0.10`, NOT the
official `@modelcontextprotocol/sdk` (which is not installed at any level). Since `@ai-sdk/mcp`
returns AI-SDK `ToolSet` values, it goes too. Our usage is narrow — one server (engram), stdio
transport only, `tools()`, `callTool`, `close()`, respawn-on-crash — so phase C ships a minimal
first-party MCP client (`src/server/llm/mcpClient.ts`): JSON-RPC 2.0 over stdio, `initialize`
handshake, `tools/list`, `tools/call`. Tool JSON Schemas pass through to the provider layer
verbatim (both the Anthropic and OpenAI wire formats take raw JSON Schema, so no zod
conversion is needed for MCP tools — the AI SDK's conversion step simply disappears).

## Recon findings that shape the build (2026-07-30)

- **Structured output**: no `generateObject` anywhere; every structured call is `generateText`
  + `Output.object` (grading rubric/annotate, anki card_gen). The provider layer implements
  this as a forced tool call carrying the JSON Schema (`tool_choice` pinned to a single
  synthetic tool) — same mechanism the SDK uses under the hood for Anthropic.
- **Provider-executed web search**: `webTools.ts:87` uses
  `anthropic.tools.webSearch_20260209({maxUses: 8})`. The anthropic adapter must support
  server tools: emit `{type: 'web_search_20260209', name: 'web_search', max_uses}` in the
  request `tools` array and handle `server_tool_use` / `web_search_tool_result` content
  blocks in the stream (they execute provider-side; the loop never runs them).
  `tests/webtools.test.ts` pins the serialized Anthropic request body — it becomes a test of
  OUR adapter's request shaping in phase C.
- **`cachedSystem` is dead code**: `providerOptions`/`cacheControl` appear on no live path —
  the tutor system prompt goes through `ToolLoopAgent`'s `instructions` uncached. So "caching
  parity" is a floor of zero: the new adapter's `cache_control` placement is the first live
  caching this app will have.
- **Block tools pause the loop by having no `execute`** — the loop layer needs first-class
  "external tools": emit the tool call on the wire, halt the run, let the client supply the
  output on resubmit.
- **Test seams to preserve**: `GradingDeps.model` / `GapHelpDeps.model` / ingest's
  `opts.model` inject fakes; `tests/mockModel.ts` is the single shared fake feeding every
  model-graded assertion; `tests/e2e/scripted-model.cjs` is a hand-written LanguageModelV3
  loaded via `LW_MOCK_MODEL`. All three get first-party equivalents — the seam type changes
  from `LanguageModel` to our provider interface.
- **`@ai-sdk/react@^4.0.23` is imported nowhere** — dead dependency, removable immediately.

## Phases

- **A. Provider + loop core, new files only.** `src/server/llm/` with unit tests against a local
  fake HTTP server (both adapters: request shaping, SSE parsing, tool-call assembly from deltas,
  usage extraction incl. cache read/write tokens, error taxonomy; loop: execute vs external
  tools, max steps, structured-output helper). Nothing wired; suite green throughout.
- **B. One-shot roles.** grader/quiz_gen/card_gen/compile-seam/help call sites move from
  `generateText`/`Output.object` to the provider layer. `tests/mockModel.ts` gains a
  first-party fake. `@ai-sdk/openai-compatible` usage ends here.
- **C. The tutor loop + MCP + wire.** session.ts's agent loop replaced by the loop layer;
  chatRoute streams via the wire layer (contract above); `mcp.ts` moves to the first-party
  stdio MCP client; scripted-model e2e hook reimplemented against the first-party provider
  contract; webTools' server-tool factory moves to the adapter's native form. `ai`,
  `@ai-sdk/anthropic`, and `@ai-sdk/mcp` usage ends here. Full e2e green is the gate.
- **D. LiteLLM route + config.** `litellm:` needs no new route — it IS the openai-compat route;
  what ships is config surface (base-url preset, docs, models-dialog datalist entries) and a
  compose/systemd example for running the proxy. README's model-routes table gains the row.
- **E. Client runtime (separate sitting, spec-first).** Replace `@ai-sdk/react` +
  `@assistant-ui/*` with a first-party chat runtime. Deliberately NOT overnight work: the client
  owns block rendering, auto-resubmit, focus mode, deep links; swapping it blind risks the whole
  app. Phase E's spec gets written once A-D are landed and the wire layer is the only protocol
  in play (at that point the client can move to a simpler first-party protocol in lockstep with
  the server, with the e2e suite as the safety net).

## Invariants (every phase)

- Suite + e2e green before each merge; no phase lands half-wired.
- The evidence model is untouchable: machine grades, capApplied, guardrail semantics survive
  byte-for-byte. The loop layer HOOKS the guardrail; it does not reinterpret it.
- Prompt caching parity or better: the anthropic adapter must place `cache_control` at least as
  well as `cachedSystem` does today, and starts reporting cache-read tokens for the ledger.
- No new runtime dependencies. `fetch`, `zod`, and `node:child_process` (for the stdio MCP
  client) suffice — all already present. LiteLLM is an external process the user may run,
  never a bundled dependency.
- Model output remains untrusted: scrubModelArtifacts stays on the render path regardless of
  which layer produced the text.
