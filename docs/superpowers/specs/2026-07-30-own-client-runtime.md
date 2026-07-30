# Own harness phase E: a first-party client runtime (spec only — not built yet)

Phases A-D replaced the server side of the AI SDK; the client still runs on
`@assistant-ui/react-ai-sdk`, whose bundled `ai@6` copy parses our SSE stream and drives the
chat state machine. This spec is the plan for taking that last piece first-party. It is
deliberately a separate sitting: the client runtime owns block rendering, auto-resubmit, focus
mode, and deep links — swapping it blind risks the whole app, so this lands only with the full
e2e suite green and screenshot-verified browser checks per feature.

## What stays, what goes

- **Goes**: `@assistant-ui/react-ai-sdk` (the `useChatRuntime`/`AssistantChatTransport` glue and
  its nested `ai@6`/`@ai-sdk/react` copies). With it goes the strict ai@6 chunk-vocabulary
  constraint on the wire — after E, both ends are ours.
- **Stays**: `@assistant-ui/react` and `@assistant-ui/react-markdown`. They are UI primitives
  (Thread, composer, message parts, the toolkit contract), not a model harness. assistant-ui
  supports custom runtimes; the replacement targets that seam instead of rebuilding chat UI.

## Design

One new client module, `src/client/chatCore/`:

1. **Stream consumer** — parse our SSE (`data:` JSON lines, `[DONE]`) into part updates against
   a chat store. The server already assembles messages identically (`wire.ts`'s
   MessageAssembler); extract that assembly into `src/shared/` so client and server literally
   share the reducer, and the "does the client build what onEnd persisted?" question becomes a
   tautology instead of a test surface.
2. **Chat store + runtime adapter** — message list, running flag, error state; exposed to
   assistant-ui through its external-store runtime API so `Thread.tsx`, `toolkit.tsx`, and every
   panel keep their current props. `addToolOutput` equivalent: write the output into the tool
   part, then apply the auto-resubmit predicate.
3. **Transport** — POST `/api/chat` with `{messages, mode, threadId, writeUp}` only (the
   `id`/`trigger`/`tools`/`system` fields the old transport sent were always ignored
   server-side); `onFinish` PUT to `/api/thread/:id` unchanged.
4. **Auto-resubmit** — `blockOutputsComplete` moves in unchanged (last-step scoping and all);
   its tests in `tests/client/runtime.test.tsx` keep their meaning.

## Wire simplification (after the swap, not during)

While ai@6 parses the stream, every chunk must fit its strict schema. Once chatCore is the only
consumer, the protocol can become v2: drop the compat headers, add a `usage` chunk (per-turn
token + cache-read reporting for the ledger UI), and collapse `tool-input-start/available` for
non-streamed inputs. Server and client change in lockstep behind one shared type file; the e2e
suite gates the cutover. Do NOT piggyback v2 onto the initial swap — parity first, then evolve.

## Order of work

1. Extract the shared message reducer out of `wire.ts` (server-only refactor, suite green).
2. Build chatCore against the CURRENT wire format; unit-test it with recorded chunk streams
   (the wire tests already produce them).
3. Swap `runtime.tsx` to the external-store runtime behind the same `Runtime` component; delete
   the react-ai-sdk dependency. Full e2e + browser verification of: tutor loop with block
   resubmit, focus mode, deep links, history switching, Ask-Tutor bridge, mode switches.
4. Protocol v2 (usage chunk first — it feeds the token ledger) as its own change.

## Risks to respect

- The auto-resubmit race guards (tabTouchedRef, drop-when-isRunning in the Ask-Tutor bridge)
  encode real bugs found in live sittings — port them, do not rediscover them.
- assistant-ui's external-store API must be pinned at the installed version's semantics
  (`@assistant-ui/react@0.14.x`); upgrading it is out of scope for the swap.
- scrubModelArtifacts stays on the render path regardless of runtime.
- Message-id continuity on block resubmits remains load-bearing (double-render regression
  otherwise — pinned by tests/session.test.ts and the tutor-loop e2e spec).
