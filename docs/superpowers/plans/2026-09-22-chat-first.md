# Chat first, study on demand — implementation plan

Repo: /home/sabien/Dev/personal/myelin. Read `.claude/skills/no-slop-code/SKILL.md` (and
`.claude/skills/no-slop-ui/SKILL.md` for client work) — binding. The user has UNCOMMITTED work in
this tree; build on it, never revert it, never run git stash/checkout/reset/restore/add/commit.
Touch only the files your task names.

## Approved design (user chose: chat first; keep the structured tutor as /study)

Today the harness DERIVES a mode per turn (deriveMode.ts — the 2026-07-31 "one mode" design removed
the selector) and the default is `learn`: the tutor with a 418-line rulebook plus per-turn forcing
(the "end this turn on something the student PRODUCES" note, the named-topic note, research gated by
vaultGap, a bootstrap that pushes suggested lessons). Nearly every harness bug seen on 2026-09-22
came from that forcing: "hi" resumed the last topic and greeted twice; research and write_page stayed
locked on "sure"/"lets go"; blocks were forced into turns that only wanted an answer; the tutor
taught from memory because the rules decided when it could look things up.

New contract:
- New mode `chat` becomes the DEFAULT derived mode. It can do everything `freeform` can (web
  research, read_url, vault reads AND writes, ingest, create_path, generate) plus all practice
  blocks — with NONE of the forcing: no produce-something note, no named-topic note, no vault-gap
  gating/note, no suggested-lesson push in the opening context. It runs on a new lean prompt,
  `src/server/chat-system-prompt.md` (below), instead of tutor-system-prompt.md.
- Explicit asks still route: "quiz me" → quiz, "let's review" → review (unchanged regexes), and the
  new `/study [topic]` command → today's `learn` tutor, sticky for the thread until the learner
  ends it (client) or sends `/chat`. learn/review/quiz keep the full tutor prompt and behaviour.
- Vault growth from chat: lesson notes run on chat turns only when the turn did research (sources)
  or used a block (exchanges) — plain answers from memory never become pages.
- Evidence invariant untouched: mastery changes only through record_evidence after graded blocks.

## The chat prompt — create `src/server/chat-system-prompt.md` with EXACTLY this content

```markdown
# Myelin Chat Prompt

You are Myelin, a research and learning companion working inside the student's own knowledge vault
(Engram). Be a genuinely useful conversational partner: answer, research, explain, discuss, and help
them think. The student decides what each conversation is for. Rules:

1. **Answer what was asked.** A greeting gets a greeting; a question gets an answer. Never steer the
   conversation toward a lesson, a quiz, a review or what is due unless the student asks — the app
   shows those on its own.
2. **Ground before you recall.** Prefer the student's vault (`search`, `read_page`) and their sources,
   then research, over your own memory. Cite what you used inline: page titles for the vault, title
   and URL for the web. When an answer rests on your own memory, say so in a few words; never present
   recall as something you looked up.
3. **Learning tools are offered, never forced.** When the student asks to be checked, quizzed or
   drilled, or to really understand something, use a practice block. Otherwise, after a substantial
   explanation you may end with ONE short offer ("Want a quick check on this?") — at most once per
   topic, never after a greeting, and never as a block they did not ask for.
4. **Blocks are tools — invoke them, never describe them.** Make the real tool call; never write a
   block's name, JSON or fields in prose. After calling one, do not narrate it ("the question is
   above") — add at most one sentence of new help, or nothing.
5. **Graded work, and only graded work, is evidence.** When the harness attaches graded block
   results, call `record_evidence` exactly as it instructs before you reply. Never record evidence
   for something the student only read, asked about or discussed — conversation is not proof.
6. **Feedback describes only what the student actually did.** Quote their words; never credit them
   with reasoning they did not write.
7. **Text you wrote before a tool call has already been shown — never write it again.** After a tool
   result comes back, continue from where you stopped and add only what the result changed.
8. **Structured study is a separate mode.** If the student wants to be taught a subject properly —
   driven, step by step, with exercises — suggest `/study <topic>`. Do not turn this chat into one.
9. **Write maths as maths** (`$…$`, `$$…$$`) and code in fenced blocks, in chat and inside blocks.

<!-- when: tool:web_search|tool:read_url -->
10. **Research like a librarian.** For anything current, contested or outside the vault, search and
    read before answering — for a claim that matters, two independent sources, reconciled. Prefer
    human-written, primary material (documentation, papers, books, the people who built the thing)
    over summaries of it, and say who wrote what you cite.

<!-- end -->
<!-- when: tool:write_page -->
11. **Save what is worth keeping, with its sources.** When research turns up something the student
    will want again, or they ask to save it, write or extend a vault page with `write_page`: `sources`
    lists exactly the URLs you read, status is `draft` unless it is well sourced, and it links to
    related pages. Never overwrite a solid, sourced page from memory. You need not save every
    exchange — researched turns are also filed into the vault automatically.

<!-- end -->
<!-- when: tool:find_canonical_sources|tool:find_recent_papers -->
12. **Name the literature.** For "what should I read" or "what is new", use the paper tools and give
    what they return with authors and dates; offer to ingest a paper so pages compile from it rather
    than from memory. If they return nothing on-topic, say so and try the web instead.

<!-- end -->
<!-- when: fact:sources -->
13. **A quoted passage is an invitation to discuss the source.** When the student sends a passage
    from the reader, ground your answer in that passage and the rest of the source; offer a check
    only if they want one.

<!-- end -->
```

## Review notes from completed tasks (binding)

- C1 (done): `src/shared/commands.ts` exports `STUDY_COMMAND = 'study'` (in COMMANDS) and
  `commandMode(command: Command): (typeof MODE_COMMANDS)[number] | undefined` (study→'learn',
  chat/learn/review/quiz/freeform→themselves, stance commands and 'write'→undefined). prompt.ts exports
  `PromptVariant = 'tutor' | 'chat'`, `buildInstructions(turn?, variant: PromptVariant = 'tutor')`,
  `promptConditionTerms(variant)`, MODES includes 'chat', and buildBootstrapContext already renders the
  chat opening for mode 'chat'. Known red test owned by C3: tests/client/slashCommands.test.ts expects
  COMMAND_SPECS to cover every wire command — add /study and /chat to the menu.

## Order

C1 → (C2 ∥ C3) → C4 (C4 also waits for the running graph-fix agent to finish with the e2e stack)

---

## C1 — vocabulary, chat prompt, chat bootstrap (prompt.ts + shared/commands.ts)

- Create `src/server/chat-system-prompt.md` with exactly the content above. Make sure the build copies
  it like tutor-system-prompt.md (check scripts/copy-server-assets.mjs and any packaging list).
- `src/server/prompt.ts`:
  - `MODES` gains `'chat'` (keep the others; order: `['chat', 'learn', 'review', 'quiz', 'freeform']`).
  - `FRAMING.chat = 'Mode: CHAT. Follow the student. Learning tools are there if they want them; nothing here is a lesson plan.'`
  - `buildInstructions(turn?: TurnFacts, variant: 'tutor' | 'chat' = 'tutor'): string` — same
    `<!-- when: … -->` section mechanism, reading chat-system-prompt.md for `'chat'` (separate cache
    per variant; the unknown-term throw applies to both files).
  - `promptConditionTerms(variant: 'tutor' | 'chat' = 'tutor'): string[]` — and update
    tests/promptGating.test.ts so it pins BOTH files' terms to real tools/facts.
  - `buildBootstrapContext` for `mode === 'chat'`: keep the header, `voice` and `Student state` lines;
    REPLACE the greeting framing with `Mode: CHAT. The student opened with a greeting — greet them
    back briefly and ask what they would like to explore. Do not bring up lessons, reviews or goals
    unless they ask.`; REPLACE the suggested-lessons / reviews-due / Anki / course-bank / goal lines
    with ONE line: `For reference only — never bring it up unprompted: ${n} reviews due; next
    suggested: ${first two lesson slugs or 'none'}; active goal: ${goal title or 'none'}.` All other
    modes: byte-identical output to today (assert it in a test).
- `src/shared/commands.ts`: `MODE_COMMANDS` gains `'chat'` (it mirrors MODES — keep the chatRoute
  test that pins the overlap passing); add `export const STUDY_COMMAND = 'study' as const;` included
  in `COMMANDS`; add `export function commandMode(command: Command): Mode-like string | undefined`
  (shared code cannot import server code — return the mode name as a string union
  `'chat' | 'learn' | 'review' | 'quiz' | 'freeform'`): `study → 'learn'`, each MODE_COMMAND → itself,
  stance commands and `write` → undefined.
- Tests (first, see them fail): chat variant renders the chat prompt and none of the tutor-only rules
  (assert e.g. no "end on something" / "Teach one concept at a time"); its conditional sections
  appear only when their tool/fact is present; promptConditionTerms('chat') all resolve; chat
  bootstrap (greeting and not) has no "Teach the next suggested lesson"/"Suggested lessons:" and has
  the reference-only line; non-chat bootstrap unchanged; commandMode mapping.
Touch only: src/server/chat-system-prompt.md, src/server/prompt.ts, src/shared/commands.ts, the
asset-copy script if needed, tests/promptGating.test.ts, a new tests/chatPrompt.test.ts, and the
existing commands/greeting tests if an expectation must widen for the new members.

## C2 — server behaviour (deriveMode, chatRoute, session, lessonNotes)

- `src/server/deriveMode.ts`: default return becomes `'chat'`; AUTHORING asks → `'chat'` (chat can
  write/ingest/build paths); `emptyVault` → `'chat'`; QUIZ → `'quiz'`, REVIEW → `'review'` and the
  planKinds branches stay as they are (a plan only exists when the learner started a session).
  Rewrite the module doc comment's last paragraph to say chat is the default and why (forcing bugs).
- `src/server/chatRoute.ts`: use `commandMode()` from shared/commands.ts for the command → mode
  override (`/study` → learn); the writeUp promotion must not demote chat (chat can already write):
  promote to freeform only from learn/review/quiz.
- `src/server/session.ts` — for `mode === 'chat'` (introduce `const openMode = mode === 'freeform' || mode === 'chat'`
  and use it wherever the code tests `mode === 'freeform'` for capability: canWrite, activeMcp filter,
  ingest tools, generate tool, research fact, vaultGap's early return — keep the returned reason
  `'freeform'` so the gap note stays suppressed):
  - system prompt: `buildInstructions(turnFacts(...), mode === 'chat' ? 'chat' : 'tutor')`.
  - trailing notes: do NOT push the "end this turn on something the student PRODUCES" note or the
    named-topic "Teach THAT" note in chat; the reader note (readingSource) in chat says: explain the
    passage and offer a check if useful — no forced block. Grades/evidence, aside, stance and
    mode-switch notes are unchanged.
  - everything else (greetingOnly, evidence guardrail, lesson-notes hook, grading) unchanged.
- `src/server/lessonNotes.ts`: `isTeachingTurn(turn, flags)` gains `flags.chat?: boolean`; when true
  the turn must ALSO have `turn.sources.length > 0 || turn.exchanges.length > 0` (a chat answer from
  memory never becomes pages). session.ts passes `chat: mode === 'chat'`.
- Tests (first): deriveMode default/authoring/emptyVault → chat, quiz/review asks unchanged, plan
  unchanged; chatRoute `/study` → learn and `/chat` → chat, write promotion leaves chat alone; a chat
  turn offers research + write_page + block tools and its system prompt is the chat prompt (assert
  on the ChatRequest the mock model receives, like tests/session.test.ts does); no PRODUCES /
  named-topic notes in chat but still present in learn; lesson notes: chat turn without sources or
  blocks is not queued, with sources is queued.
Touch only: src/server/deriveMode.ts, src/server/chatRoute.ts, src/server/session.ts,
src/server/lessonNotes.ts, and their tests (tests/deriveMode*.test.ts, tests/chatRoute*.test.ts,
tests/session.test.ts, tests/lessonNotes.test.ts, tests/greetingOpening.test.ts if affected).

## C3 — client

- Mode: App's `mode` state `''` means "let the harness decide" = chat. `/chat` → `setMode('')`;
  `/study` → `setMode('learn')` (sticky); `/review` `/quiz` unchanged (sticky). Wire through the
  existing onModeCommand path (App.tsx, runtimeAdapter.ts, chatStore.ts) using `commandMode()`.
- Slash menu (src/client/lib/slashCommands.ts): add `/study` ("a focused tutor session on a topic")
  and `/chat` ("back to open chat"); keep the others.
- Composer: while `mode` is learn/review/quiz/freeform show a chip in the composer's bottom row —
  `studying` / `reviewing` / `quizzing` / `writing` · `end` (a real `<button type="button">`, accessible
  name "end study session", sets mode ''). Nothing in chat mode.
- Empty transcript (Thread.tsx home state): heading "What do you want to explore?" with short
  subcopy (research, read, ask — study tools when you want them); keep the existing session-plan
  card as a secondary card beneath it (its button is how a learner starts studying/reviewing).
- Under the latest assistant message, in chat mode only, when it finished streaming and no block is
  pending: two quiet chips — "check my understanding" (sends the plain user message "Check my
  understanding of this with one quick question.") and "study this" (sends command `study` with
  text "Teach me what we were just discussing, properly." — which also flips the sticky mode). Hide
  them once the learner starts typing.
- Selection toolbar (the aside flow in Thread.tsx): add "quiz me on this" beside "ask aside" — sends
  the chat message `Quiz me on this:\n\n> <selected text>` (the QUIZ regex routes it to quiz mode).
- CSS: tokens only, no animation, match .aside-* and the composer row.
- Tests (Testing Library, role queries): the study chip appears after `/study` and `end` clears it
  (next request's body.mode is ''); chips render only on the latest assistant message in chat mode
  and send the right payloads; "quiz me on this" sends the quoted message; empty-state heading.
Touch only: src/client/App.tsx, src/client/chatCore/runtimeAdapter.ts, src/client/chatCore/chatStore.ts,
src/client/lib/slashCommands.ts, src/client/components/Thread.tsx, src/client/components/CommandEditor.tsx
(only if the menu needs it), src/client/styles.css (new chat-first rules only), tests under
tests/client/ for these.

## C4 — e2e sweep (after C2/C3 and after the graph-fix agent finishes)

Run the whole e2e suite and fix what the chat-first default and today's changes broke, plus the known
items: tutor-loop.e2e.ts opens with "hi" and expects a quiz — send a real request instead (e.g.
"quiz me on derivatives"); gap-exercise.e2e.ts times out — find the root cause by running it on a
clean worktree of HEAD (with node_modules symlinked) vs this tree before changing anything;
graph-contextual.e2e.ts only passes after gap-exercise grades stream-consumer — make it seed its own
state; add tests/e2e/aside.e2e.ts (plan: docs/superpowers/plans/2026-09-22-inline-asides.md, A3)
and tests/e2e/chat-first.e2e.ts (a greeting gets a plain reply; /study shows the studying chip and
end clears it; "check my understanding" stages a block). Ports: fixture pairs only, never 4820/4173.
