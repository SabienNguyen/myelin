# Inline asides — implementation plan

Repo: /home/sabien/Dev/personal/myelin. Read `.claude/skills/no-slop-code/SKILL.md` (and
`.claude/skills/no-slop-ui/SKILL.md` for client work) — binding. The user has UNCOMMITTED work in this
tree; build on it, never revert it, never run git stash/checkout/reset/restore/add/commit. Touch only
the files your task names.

## Approved design

While answering the tutor, the learner asks about a concept WITHOUT derailing the lesson:
- Start: (a) select text in a tutor message → an "ask aside" button (same pattern as
  src/client/components/SourceReader.tsx's selection → ask) → a small inline input under that message
  with the selection quoted, optional question text; (b) `/aside <question>` in the composer, attached
  to the latest assistant message.
- Answer: a SEPARATE small model call on the tutor model — not a chat turn. Tools: read-only vault
  (`search`, `read_page`) + web research where the route has it (webTools: read_url + provider
  serverTools). NO blocks, NO record_evidence, NO write_page, NO other writes. Prompt: explain just
  this concept briefly, ground it in vault pages/sources where possible, say plainly when it is from
  model memory, never answer the lesson's pending question.
- Display: a collapsible note under the anchored tutor message — `aside · <topic>` — inset surface,
  accent left border, answer + source links. Persists in the saved thread as a part of that message.
  Never a new turn; the pending block stays answerable.
- Afterwards: the next main tutor turn gets a trailing HARNESS note listing the asides on the message
  the student is answering (question + one-line answer summary): account for them, don't re-explain.
  The aside is queued into lesson notes (lessonNotes.ts, task E) so its concept becomes/extends a
  vault page. No mastery evidence.

## Wire contract (shared by A1 and A2 — pin verbatim)

`src/shared/aside.ts`:
```ts
export interface AsideSource { url: string; title?: string }
export interface AsideData {
  asideId: string;            // crypto.randomUUID()
  quote?: string;             // the selected text, when started from a selection
  question: string;           // what the learner typed; for a bare selection, `Explain "<quote>"`
  answer: string;             // markdown
  sources: AsideSource[];     // web sources actually used (server-tool-result / read_url)
  vaultPages: string[];       // slugs the answer read via read_page
  fromMemory: boolean;        // true when neither sources nor vaultPages grounded it
  createdAt: string;          // ISO
}
/** The UI message part stored on the anchored assistant message. */
export interface AsidePart { type: 'data-aside'; id: string; data: AsideData }
export interface AsideRequest { threadId: string; messageId: string; question: string; quote?: string }
export type AsideResponse = { part: AsidePart } | { error: string };
export const ASIDE_MAX_QUESTION = 2000;
```
Endpoint: `POST /api/aside` with `AsideRequest` JSON → 200 `{ part }` | 400 `{ error }` (validation) |
404 `{ error }` (unknown thread/message) | 502 `{ error }` (model failure, with the provider message).

---

## A1 — server

- `src/shared/aside.ts` exactly as above.
- `src/server/asideRoute.ts`: `export function buildAsideRoute(lw: Engram | null, cfg: HarnessConfig, deps?: AsideDeps): Hono`
  with `AsideDeps = { model?: ChatModel; now?: () => Date }` (injectable for tests, like session.ts's
  deps). Validates body (threadId via sessionStore's assertThreadId, non-empty question ≤
  ASIDE_MAX_QUESTION, quote ≤ ASIDE_MAX_QUESTION), loads the thread, finds `messageId` among
  ASSISTANT messages (404 otherwise), builds context = the anchored message's text (and the quote),
  runs `runLoop` (src/server/llm/loop.ts) with the tutor model (`chatModelFor('tutor', cfg)` unless
  deps.model), maxSteps 6, tools = ONLY `search` and `read_page` from the Engram MCP tool list (read
  how session.ts builds activeMcp) + `buildWebTools(cfg, cfg.models.tutor.model)` tools and
  serverTools. Collect `sources` from server-tool-result outputs (both shapes: the oai
  `{ query, sources: [{url,title}] }` and Anthropic's web_search_tool_result content — see
  src/server/lessonNotes.ts, which already parses both; REUSE its helper, export it from there if it
  is not exported) and read_url calls; `vaultPages` from read_page calls. Persist the part (below),
  enqueue lesson notes (below), return `{ part }`. Model/loop failure → console.error('[aside] ...')
  + 502 with the message. Mount it in src/server/index.ts next to the other routes (before the
  degraded-boot `/api/*` catch-all, like the codex routes).
- System prompt for the aside call (a const in asideRoute.ts): the rules in "Approved design" above,
  plus: 120–250 words, plain markdown, cite web sources inline by title, name vault pages used, and a
  final line "(from memory — not checked against a source)" when fromMemory.
- Persistence: add to src/server/sessionStore.ts `export function addPartToMessage(vault, threadId,
  messageId, part): void` that loads the thread, appends the part to that message's parts (replacing
  a part with the same `id`), and writes it back. THEN read saveThread's union-by-id merge: a later
  client save of the same message WITHOUT the aside part must not drop it — make the merge keep
  `data-aside` parts from the on-disk copy of a message when the incoming copy lacks them (merge by
  part id). Test that exact scenario.
- Next-turn note in src/server/session.ts (trailing notes section, same style as the other HARNESS
  notes): if the last ASSISTANT message has data-aside parts → push
  `HARNESS: while answering, the student asked aside questions about your last message: <for each:
  "<question>" → <first sentence of answer>>. They have that explanation already — build on it, do
  not repeat it, and still expect their answer to your pending question.`
- Lesson notes: call lessonNotes.ts's enqueueLessonNotes (task E's API — read its signature) with a
  LessonTurn built from the aside (tutorText = answer, exchanges = [{ prompt: question, answer: '' }],
  sources, topicSlug = threadTopic(messages)), fire-and-forget with
  console.error('[aside] could not queue lesson notes:', e). If E's isTeachingTurn MIN_LESSON_CHARS
  gate would drop a short aside, bypass the gate for asides (asides are always worth queuing) — do it
  by calling enqueueLessonNotes directly, not by weakening isTeachingTurn.
- Tests `tests/asideRoute.test.ts` (TDD, injected ChatModel via deps — see tests/mockModel.js and
  tests/session.test.ts for the pattern; real Engram via tests/lwRepo.js like session.test.ts):
  validation 400s; unknown message 404; offered tools are exactly search/read_page/read_url(+provider
  search) — assert on the ChatRequest the mock model receives; no block/record_evidence/write_page
  offered; sources/vaultPages/fromMemory computed from a scripted tool sequence; part persisted on the
  right message on disk; a later saveThread of that message without the part keeps it; model failure
  → 502 + '[aside]' console.error; lesson notes queued (ledger entry on disk). Session test: the next
  turn's model request contains the HARNESS aside note when the last assistant message carries one.
Touch only: src/shared/aside.ts, src/server/asideRoute.ts, src/server/sessionStore.ts,
src/server/session.ts (the note only), src/server/index.ts (mount only), src/server/lessonNotes.ts
(export an existing helper only), tests/asideRoute.test.ts, tests/session.test.ts (one case),
tests for sessionStore if they exist.

## A2 — client

- `src/client/lib/api.ts`: `export async function askAside(req: AsideRequest): Promise<AsidePart>` —
  throws an Error carrying the server's `error` text on non-200 (match the file's existing error style).
- `src/client/components/AsidePart.tsx`: renders a `data-aside` part: `<details>` with summary
  `aside · <short topic>` (topic = quote or first ~6 words of question), body = answer via the
  existing MarkdownText/RichMarkdown renderer + a "sources" list of links (target _blank rel noopener)
  + vault page links that call `panelBus.openPage(slug)` + a muted "from memory — not checked"
  line when fromMemory. Register it in Thread.tsx's AssistantMessage parts (`data: { by_name: {
  aside: AsidePart } }` — check how UserMessage registers `command` and mirror it).
- Selection → ask: in Thread.tsx's assistant message, mirror SourceReader.tsx's selection handling:
  when the learner selects text inside an assistant message, show a small `<button type="button">ask
  aside</button>` near the selection; clicking opens an inline form under that message (textarea
  labelled "aside question", the quote shown above it, submit + cancel buttons; Enter submits,
  Escape cancels). Submitting calls askAside with that message's id; while waiting show
  `role="status"` "answering aside…"; on success insert the returned part into the message in the
  client store (read src/client/chatCore/chatStore.ts for how messages are held/updated — add a
  minimal `addPartToMessage(messageId, part)` there if none exists); on error show the error text
  with role="alert" and keep the typed question.
- `/aside`: add `aside` to the composer's slash menu (src/client/lib/slashCommands.ts) WITHOUT adding
  it to src/shared/commands.ts's COMMANDS (the chat wire must never see it — chatRoute 400s unknown
  commands, which is correct). In the composer submit path, a payload whose command is `aside`
  calls askAside({ threadId, messageId: <latest assistant message id>, question: text }) instead of
  sending a chat turn; with no assistant message yet, show the error "no tutor message to ask about
  yet" and send nothing.
- CSS in src/client/styles.css: `.aside-part`, `.aside-ask`, `.aside-form` — tokens only: inset surface
  (--bg-inset), 2px accent left border, --radius-sm, muted summary like .reasoning-part. No animation.
- Tests (Testing Library, role-based queries): AsidePart renders summary/answer/sources/from-memory;
  selecting text in an assistant message shows "ask aside" and submitting calls the API (stub fetch —
  assert the POST body) and renders the returned part under that message; error path shows the alert
  and keeps the text; `/aside hello` calls askAside and does NOT POST /api/chat; with no assistant
  message it shows the error.
Touch only: src/client/lib/api.ts, src/client/components/AsidePart.tsx,
src/client/components/Thread.tsx, src/client/chatCore/chatStore.ts, src/client/lib/slashCommands.ts,
the composer submit file (find it: CommandEditor.tsx / Thread.tsx), src/client/styles.css (aside
rules only), tests under tests/client/ for these.

## A3 — end to end

`tests/e2e/aside.e2e.ts` on the scripted-model e2e stack (read .claude/skills/browser-verify/SKILL.md
and an existing e2e test first): a scripted tutor turn stages a quick_check; the learner selects a
phrase in the tutor message, asks an aside; the scripted aside answer appears collapsed under that
message; reload → still there; the quick_check is still answerable and answering it produces a normal
graded turn whose model request (scripted-model log, if the stack records it) carries the HARNESS
aside note. Touch only that file (and the scripted-model fixture file it needs, if new turns must be
scripted).

Order: A1 (after task E lands) ∥ A2 (after graph T4 lands — it shares styles.css) → A3.
