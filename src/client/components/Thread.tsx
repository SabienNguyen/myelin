import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ThreadPrimitive, MessagePrimitive, ComposerPrimitive, ErrorPrimitive, useComposerRuntime, useMessage, useThread, useThreadRuntime } from '@assistant-ui/react';
import { ArrowUpIcon as ArrowUp, FilePdfIcon as FilePdf, PaperclipIcon as Paperclip, StopIcon as Stop, XIcon as X } from '@phosphor-icons/react';
import { BLOCK_TOOL_NAMES } from '../../shared/blocks.js';
import { getToolName, isToolUIPart, type FileUIPart, type UIMessage } from '../../shared/uiMessages.js';
import { turnFailed } from '../../shared/uiMessageReducer.js';
import { useChatStore } from '../chatCore/index.js';
import { askAside } from '../lib/api.js';
import { AsidePart } from './AsidePart.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { CommandEditor, type CommandEditorHandle } from './CommandEditor.js';
import { MarkdownText } from './MarkdownText.js';
import { NotebookIntro, NotebookPicker, oneLine, useConversationNotebook } from './Notebooks.js';
import { ToolStatusChip } from './ToolStatusChip.js';
import { panelBus } from '../lib/panelBus.js';
import { takePendingAsk } from '../lib/pendingAsk.js';
import { loadDraft, saveDraft } from '../lib/composerDraft.js';
import type { JSONContent } from '@tiptap/core';
import type { Command } from '../../shared/commands.js';
import { titleFor } from '../../shared/threadTitle.js';

// P1 FIX (docs/superpowers/plans/2026-07-20-gap-integration.md — post-review): these two must be
// stable module-scope function references, NOT inline arrow functions inside Thread()'s render
// body. `ThreadPrimitive.Messages` uses `components.UserMessage`/`components.AssistantMessage` as
// React component TYPES for the per-role message subtree — a fresh function identity every time
// Thread() renders reads to React as "a different component type at this position", which
// unmounts and remounts the ENTIRE message subtree (including whatever's portaled into the Stage
// from inside it) on every single Thread re-render. That was already true before P1 but harmless
// (nothing downstream reacted to the churn). P1's CodeExerciseInner mount effect
// (panelBus.setFocusMode(true)/cleanup(false), CodeExercise.tsx) turned it into a feedback loop:
// App re-render -> Thread re-renders -> new inline component identity -> AssistantMessage subtree
// remounts -> CodeExerciseInner's unmount(false)-then-mount(true) cycle flips App's focusMode
// state -> App re-renders again -> repeat, until React's nested-update-count guard throws
// "Maximum update depth exceeded" and tears the tree down (the browser symptom: chip visible,
// #stage-root empty, .focus-mode gone). Fix is this hoist alone — StagePortal's target
// (#stage-root, SidePanel.tsx) is a permanently-mounted DOM node and was never actually churning.
/** A user-attached image in the transcript: a small thumbnail (the data: URL renders directly),
 * never the full-size bitmap — the bubble is a record of what was sent, not a viewer. */
function UserImagePart({ image, filename }: { image: string; filename?: string }) {
  return <img className="msg-attachment-img" src={image} alt={filename ?? 'attached image'} />;
}

/** A user-attached PDF (or other non-image file): a filename chip. The payload is a base64 data:
 * URL with nothing useful to open in-app, so the chip is presentation only. */
function UserFilePart({ filename, mimeType }: { filename?: string; mimeType: string }) {
  return (
    <span className="msg-attachment-file">
      <FilePdf size={14} weight="duotone" />
      {filename ?? mimeType}
    </span>
  );
}

/** The transcript record of a sent slash command (the `data-command` part chatStore puts first
 * on the user message): a muted chip, so replayed history shows the same command state the send
 * carried — the raw "/beginner" text never existed as message text. */
function UserCommandPart({ data }: { data: unknown }) {
  const command = (data as { command?: unknown } | null)?.command;
  if (typeof command !== 'string') return null;
  return <span className="msg-command-chip">{command}</span>;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg user">
      <MessagePrimitive.Parts components={{
        Image: UserImagePart,
        File: UserFilePart,
        data: { by_name: { command: UserCommandPart } },
      }} />
    </MessagePrimitive.Root>
  );
}
/** Thinking output, collapsed by default: available to the curious, never pushed at the learner.
 * Providers that omit thinking content stream the block with empty text — render nothing then,
 * rather than a summary line that expands to a blank. */
function ReasoningPart({ text }: { text: string }) {
  if (!text) return null;
  return (
    <details className="reasoning-part">
      <summary>thinking</summary>
      <p>{text}</p>
    </details>
  );
}

/** Selection cap for an aside quote — same rationale and number as SourceReader's MAX_PASSAGE:
 *  a "passage" is a sentence or two, not the whole message. */
const MAX_ASIDE_QUOTE = 600;

/**
 * "Ask aside" on a tutor message: select text → a floating button → an inline form (quote,
 * optional question, submit/cancel) → askAside → the returned part lands on THIS message via
 * chatStore.addPartToMessage. Mirrors SourceReader.tsx's selection handling (selectionchange,
 * not mouseup — a screen reader's selection commands never fire mouseup) scoped to this one
 * message's own DOM subtree, since a transcript holds many of these at once.
 */
function AsideAsk({ messageId, children }: { messageId: string; children: ReactNode }) {
  const store = useChatStore();
  const running = useThread((s) => s.isRunning);
  // The message still streaming is not saved yet, so the aside route cannot find it (a raw 404).
  const beingWritten = useMessage((m) => m.isLast) && running;
  // The error placeholder and a tool-only turn have no words to ask about.
  const hasText = useMessage((m) => m.content.some((p) => p.type === 'text' && p.text.trim() !== ''));
  const bodyRef = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<{ text: string; x: number; y: number } | null>(null);
  // `editable`: the keyboard path quotes the whole message, which the learner trims to the part
  // they mean; a mouse selection already is that part.
  const [form, setForm] = useState<{ quote: string; editable?: boolean } | null>(null);
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState<'idle' | 'pending'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onSelectionChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const body = bodyRef.current;
        const sel = window.getSelection();
        const text = sel?.toString().trim() ?? '';
        if (!body || !sel || sel.isCollapsed || !text || !body.contains(sel.anchorNode)) {
          setPick(null);
          return;
        }
        const rangeRect = sel.getRangeAt(0).getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        setPick({
          text: text.length > MAX_ASIDE_QUOTE ? `${text.slice(0, MAX_ASIDE_QUOTE)}…` : text,
          x: Math.max(0, rangeRect.left - bodyRect.left + body.scrollLeft),
          y: rangeRect.bottom - bodyRect.top + body.scrollTop,
        });
      }, 180);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => { clearTimeout(timer); document.removeEventListener('selectionchange', onSelectionChange); };
  }, []);

  const openForm = () => {
    if (!pick) return;
    setForm({ quote: pick.text });
    setPick(null);
    window.getSelection()?.removeAllRanges();
  };
  const cancel = () => { setForm(null); setQuestion(''); setError(null); };

  // Selecting a passage needs a pointer, or caret browsing, or a screen reader's selection
  // commands. This is the way in from the keyboard alone.
  const openFormOnMessage = () => {
    const message = store.getState().messages.find((m) => m.id === messageId);
    const text = (message?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n').trim();
    setForm({ quote: text.length > MAX_ASIDE_QUOTE ? `${text.slice(0, MAX_ASIDE_QUOTE)}…` : text, editable: true });
  };

  // A turn, not an aside: the learner asked to be tested on exactly this passage. The message's
  // own words ("Quiz me") are what route it (deriveMode's QUIZ patterns), so no command rides it.
  const quizOnPick = () => {
    if (!pick) return;
    const quoted = pick.text.split('\n').map((line) => `> ${line}`).join('\n');
    setPick(null);
    window.getSelection()?.removeAllRanges();
    store.sendMessage(`Quiz me on this:\n\n${quoted}`);
  };

  const submit = async () => {
    // A second Enter or click while the first is out would run a second model loop and save a
    // second answer under the message.
    if (!form || status === 'pending') return;
    const quote = form.quote.trim();
    setStatus('pending');
    setError(null);
    try {
      const part = await askAside({
        threadId: store.threadId,
        messageId,
        question: question.trim() || (quote ? `Explain "${quote}"` : 'Explain this another way'),
        ...(quote ? { quote } : {}),
      });
      store.addPartToMessage(messageId, part);
      setForm(null);
      setQuestion('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatus('idle');
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The Enter that accepts an IME conversion is not a submit.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };

  return (
    <div ref={bodyRef} className="aside-ask-region">
      {children}
      {pick && !form && (
        <div className="aside-ask" style={{ left: pick.x, top: pick.y + 8 }}>
          <button type="button" onClick={openForm} disabled={beingWritten}>ask aside</button>
          <button type="button" onClick={quizOnPick} disabled={running}>quiz me on this</button>
        </div>
      )}
      {form && (
        <form
          className="aside-form"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          {form.editable ? (
            <>
              <label htmlFor={`aside-quote-${messageId}`}>quoted passage</label>
              <textarea
                id={`aside-quote-${messageId}`}
                className="aside-form-quote"
                value={form.quote}
                onChange={(e) => setForm({ quote: e.target.value, editable: true })}
              />
            </>
          ) : <blockquote>{form.quote}</blockquote>}
          <label htmlFor={`aside-question-${messageId}`}>aside question</label>
          <textarea
            id={`aside-question-${messageId}`}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
          />
          <div className="aside-form-actions">
            <button type="submit" disabled={status === 'pending'}>submit</button>
            <button type="button" onClick={cancel}>cancel</button>
          </div>
        </form>
      )}
      {!form && hasText && (
        <div className="msg-actions">
          <button type="button" onClick={openFormOnMessage} disabled={beingWritten} aria-label="ask aside about this answer">
            ask aside
          </button>
        </div>
      )}
      {status === 'pending' && <p className="aside-composer-status" role="status">answering aside…</p>}
      {error && <p className="aside-composer-error" role="alert">{error}</p>}
    </div>
  );
}

function AssistantMessage() {
  const messageId = useMessage((m) => m.id);
  return (
    <MessagePrimitive.Root className="msg assistant">
      <AsideAsk messageId={messageId}>
        {/* One malformed part (a hand-edited thread file, a tool output of the wrong shape) costs
            this message, not the whole app: an uncaught render error unmounts the root, and the
            hash reopens the same thread on reload. */}
        <ErrorBoundary label={`message ${messageId}`} fallback={<p className="part-error">this part could not be shown</p>}>
          <MessagePrimitive.Parts components={{
            Text: MarkdownText,
            Reasoning: ReasoningPart,
            tools: { Fallback: ToolStatusChip }, // MCP tools → quiet status chip, not JSON
            data: { by_name: { aside: AsidePart } },
          }} />
        </ErrorBoundary>
      </AsideAsk>
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="error-bubble">
          ⚠ <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
    </MessagePrimitive.Root>
  );
}

/**
 * The three example asks on the empty thread.
 *
 * They were `<li>` elements, styled as bordered boxes — so on the very first screen of the app they
 * looked exactly like buttons and did nothing when clicked. Now they are buttons that fill the
 * composer and send, which is what they always looked like they would do.
 *
 * They stay across three unrelated SUBJECTS on purpose: the most valuable thing to convey in the
 * first three seconds is that this is not a programming tutor, it is a tutor.
 */
const EXAMPLES = [
  'Teach me how derivatives work',
  'I want to understand counterpoint',
  'Walk me through consideration in contract law',
];

function ExampleAsks() {
  const composer = useComposerRuntime();
  return (
    <ul className="thread-empty-examples">
      {EXAMPLES.map((text) => (
        <li key={text}>
          <button
            type="button"
            onClick={() => { composer.setText(text); composer.send(); }}
          >
            “{text}”
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * panelBus.askTutor → a real user chat message, through the SAME path the composer and the
 * example asks use (setText + send), so the message renders in the transcript and starts a turn
 * exactly as if typed. Renders nothing; it exists to hold the composer/thread runtime hooks,
 * which need the runtime context Thread sits inside. While a send is streaming the event is
 * dropped, mirroring the composer's own rule (its Send control is disabled mid-run) — queueing a
 * second send behind a running turn is not something any send path here does.
 */
/** Sends the first message another screen left for this conversation (lib/pendingAsk.ts), once. */
function PendingAsk({ threadId }: { threadId?: string }) {
  const store = useChatStore();
  useEffect(() => {
    if (!threadId) return;
    const ask = takePendingAsk(threadId);
    // The store's own send, not the composer's: it carries a slash command as structured data
    // (a Studio quiz rides /quiz), the same path SessionPlanCta uses.
    if (ask) store.sendMessage(ask.text, [], ask.command !== undefined ? { command: ask.command } : {});
  }, [threadId, store]);
  return null;
}

function AskTutorBridge() {
  const composer = useComposerRuntime();
  const thread = useThreadRuntime();
  useEffect(() => panelBus.subscribe((e) => {
    if (e.type !== 'askTutor') return;
    if (thread.getState().isRunning) return;
    composer.setText(e.text);
    composer.send();
  }), [composer, thread]);
  return null;
}

export interface PlanItem {
  kind: string; slug: string; title: string; why: string; transfer?: string;
  /** For a `quiz` item: every page the one block should cover. */
  covers?: string[];
}

/**
 * "Start today's session" — the interleaved plan (/api/session-plan) on the empty thread, once there
 * is anything to plan. Spacing and interleaving are the system's job; the button is where the system
 * does the deciding and the learner just sits down. A secondary action since chat became the
 * default: the heading asks what to explore, and this is one answer. The whole plan travels in the
 * message so the tutor works through it in order.
 */
function SessionPlanCta({ plan, label = 'Start today’s session', rows = true }: {
  plan: PlanItem[]; label?: string;
  /** Each item as its own way in. Off where something else already lists them (a notebook's
   *  starters name the same topics). */
  rows?: boolean;
}) {
  const store = useChatStore();
  if (plan.length === 0) return null;

  const KIND_LABEL: Record<string, string> = {
    review: 'review', new: 'new', misconception: 'fix', course: 'course', quiz: 'quiz',
  };
  const VERB: Record<string, string> = {
    review: 'Review', new: 'Learn', misconception: 'Fix a slip in', course: 'Practise', quiz: 'Quiz me on',
  };
  const start = (items: PlanItem[]) => {
    // The transfer directive rides on the item's own line (review/fix items carry it), so the
    // constraint is in front of the tutor exactly where it works that row — not left to a rule
    // several screens up in the system prompt.
    const lines = items.map((p, i) => {
      // A quiz item covers SEVERAL pages in one block, so the row has to name all of them —
      // otherwise the tutor quizzes the first slug and the batching is lost.
      // The instruction rides the ROW. As a trailing note after six numbered items it lost to the
      // header's "one item at a time" — the tutor read a 4-page quiz row and staged a single-page
      // structured_check. The row now says what it is before it says what it covers.
      const what = p.covers?.length
        ? `ONE quiz block with ${p.covers.length} items, one per page: ${p.covers.map((c) => `"${c}"`).join(', ')}`
        : `"${p.slug}"`;
      return `${i + 1}. [${p.kind}] ${what} — ${p.why}${p.transfer ? ` — ${p.transfer}` : ''}`;
    }).join('\n');
    // A session is study, not chat: /study puts this turn and the ones after it on the structured
    // tutor (chatStore flips the sticky mode), which is what works a plan row by row.
    store.sendMessage(
      `Run today's session, in this order, one item at a time:\n${lines}\n`
      + 'For reviews and misconceptions, probe or set an exercise before any reteaching; for new items, teach then check. '
      + 'A [quiz] row is a single quiz covering every page it names — the row itself says so.',
      [], { command: 'study' },
    );
  };
  return (
    <div className="session-plan">
      <button type="button" className="session-plan-start" onClick={() => start(plan)}>
        {label} ({plan.length} {plan.length === 1 ? 'item' : 'items'})
      </button>
      {/* The same rows a notebook opens on, so the two empty chats read as one design; any one
          of them is a session of one. */}
      {rows && (
        <ul className="nb-starters session-plan-rows" aria-label="Or one at a time">
          {plan.map((p) => (
            <li key={p.slug}>
              <button type="button" onClick={() => start([p])}>
                <span className={`session-plan-kind session-plan-kind--${p.kind}`}>{KIND_LABEL[p.kind] ?? p.kind}</span>
                {VERB[p.kind] ?? 'Study'} {p.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The session plan narrowed to one notebook's pages: in a Calculus notebook, a plan row for
 * organic chemistry is someone else's session. A quiz row keeps only the pages it covers inside
 * the notebook and is dropped when none are left. Pure.
 *
 * A narrowed quiz row is rebuilt, not just filtered: the server names the row after its FIRST
 * page and lists every page in `why`, so keeping those showed "QUIZ Chain Rule" in a Linear
 * algebra notebook and sent the tutor a why naming other subjects' pages. One page left is a
 * review, not a one-item quiz.
 */
export function planWithin(plan: PlanItem[], topics: readonly { slug: string; title: string }[]): PlanItem[] {
  const titles = new Map(topics.map((t) => [t.slug, t.title]));
  return plan.flatMap((p): PlanItem[] => {
    if (!p.covers?.length) return titles.has(p.slug) ? [p] : [];
    const covers = p.covers.filter((c) => titles.has(c));
    if (covers.length === p.covers.length) return [p];
    if (covers.length === 0) return [];
    const [first] = covers;
    const title = titles.get(first) ?? first;
    if (covers.length === 1) {
      return [{ kind: 'review', slug: first, title, why: 'due for review', ...(p.transfer ? { transfer: p.transfer } : {}) }];
    }
    return [{
      ...p, slug: first, title, covers,
      why: `${covers.length} of your due pages, quizzed together: ${covers.join(', ')}`,
    }];
  });
}

/**
 * The empty thread's hero. Chat is the default (deriveMode.ts), so the question is what to explore,
 * for everyone; a returning learner's session plan sits beneath it as the way into study, rather
 * than as the headline. A brand-new learner gets the cross-subject example asks instead. One fetch
 * decides both, and the hero renders nothing until it resolves, so the copy never flashes from one
 * audience to the other.
 */
function EmptyHero({ threadId }: { threadId?: string }) {
  const composer = useComposerRuntime();
  const notebook = useConversationNotebook(threadId);
  const [plan, setPlan] = useState<PlanItem[] | null>(null); // null = still deciding
  // A failed plan fetch is not the newcomer state: treating it as one showed a returning learner
  // with reviews due the day-one example asks and no sign their session was missing.
  const [planFailed, setPlanFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/session-plan')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ plan?: PlanItem[] }>;
      })
      .then((d) => { if (!cancelled) setPlan(Array.isArray(d?.plan) ? d.plan : []); })
      .catch((e: unknown) => {
        console.error('[session-plan] could not load today’s session:', e);
        if (cancelled) return;
        setPlanFailed(true);
        setPlan([]);
      });
    return () => { cancelled = true; };
  }, []);
  // Both lookups decide the copy, so nothing renders until both resolve — no flash from the
  // general welcome to the notebook's own.
  if (plan === null || notebook === undefined) return null;

  // A conversation filed under a notebook opens on that notebook: its material, its progress, and
  // ways in drawn from its own topics. The session plan still sits below — it spans every notebook.
  if (notebook) {
    return (
      <div className="thread-empty">
        <NotebookIntro detail={notebook} onAsk={(text) => { composer.setText(text); composer.send(); }} />
        <SessionPlanCta
          plan={planWithin(plan, notebook.topics)}
          label={`Study ${notebook.notebook.title}`}
          rows={false}
        />
        {planFailed && <p className="session-plan-failed">could not load today’s session</p>}
      </div>
    );
  }

  const returning = plan.length > 0 || planFailed;
  return (
    <div className="thread-empty">
      <h2>What do you want to explore?</h2>
      {/* One line: what the box below does and the one command worth knowing. The longer pitch
          (research becomes pages, papers and books) is what the example asks show a newcomer. */}
      <p>Ask anything, or type /study for a tutor session.</p>
      <SessionPlanCta plan={plan} />
      {planFailed && <p className="session-plan-failed">could not load today’s session</p>}
      {threadId && <NotebookPicker threadId={threadId} />}
      {/* The example asks taught their lesson (any subject works) on day one; for a returner they
          are noise beside the plan, and the composer is right below for anything new. */}
      {!returning && <ExampleAsks />}
    </div>
  );
}

/** A reply shorter than this is conversation (a greeting back, a one-line answer), not an
 *  explanation worth checking yourself on. */
const MIN_FOLLOW_UP_CHARS = 200;

/** A block on this message still waiting for the learner's answer. */
function awaitsAnswer(message: UIMessage): boolean {
  return message.parts.some((p) => isToolUIPart(p)
    && (BLOCK_TOOL_NAMES as readonly string[]).includes(getToolName(p))
    && p.state !== 'output-available' && p.state !== 'output-error');
}

/**
 * "try again" under a turn that failed — what its closing note or the error bubble tells the
 * learner to do, as one click. Offered for every failure the learner can see: a turn the server
 * ended as failed (marked on the message, so the offer survives a reload), a refused or
 * unreachable request, and a dropped stream that recovery could not bring back. Never while a
 * turn runs or the learner is typing.
 *
 * It resends text, slash command and attachments. A question that never got an answer is
 * re-POSTed as it stands; after an answer that failed, the question is asked again as a new
 * message, so the failed turn and its note stay in the transcript as they do on disk.
 */
function RetryFailed({ drafting }: { drafting: boolean }) {
  const store = useChatStore();
  const { messages, isRunning, error } = useSyncExternalStore(store.subscribe, store.getState);
  const last = messages.at(-1);
  if (drafting || isRunning || last === undefined) return null;
  if (error === undefined && !(last.role === 'assistant' && turnFailed(last))) return null;
  const retry = (onClick: () => void) => (
    <div className="follow-ups">
      <button type="button" onClick={onClick}>try again</button>
    </div>
  );
  if (last.role === 'user') return retry(() => store.resendLast());
  // The turn that failed was a GRADING continuation when an answered block on the message still has
  // no grade: retrying it means resubmitting the answer, not asking the question that staged the
  // block again — that would stage a fresh block and leave the learner's answer ungraded.
  if (answerAwaitingGrade(last)) return retry(() => store.resubmit());
  const asked = [...messages].reverse().find((m) => m.role === 'user');
  if (!asked) return null;
  const text = asked.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const command = (asked.parts.find((p) => p.type === 'data-command') as { data?: { command?: Command } } | undefined)?.data?.command;
  // Attachments ride along: "what is this?" retried without its photo is a different question.
  const files = asked.parts.filter((p): p is FileUIPart => p.type === 'file');
  if (!text.trim() && command === undefined && files.length === 0) return null;
  return retry(() => store.sendMessage(text, files, command !== undefined ? { command } : {}));
}

/** An answered block on this message whose grade never arrived. */
function answerAwaitingGrade(message: UIMessage): boolean {
  return message.parts.some((p) => isToolUIPart(p)
    && (BLOCK_TOOL_NAMES as readonly string[]).includes(getToolName(p))
    && p.state === 'output-available'
    && !(p.output as { grading?: unknown } | undefined)?.grading);
}

/**
 * Chat's two ways into study, under the newest answer: one quick check on it, or the structured
 * tutor on what was just discussed. Chat never forces a block (chat-system-prompt.md rule 3), so
 * these are the learner's one-click version of asking for one. They step aside while a block is
 * waiting, while a turn runs, after a turn that failed (its note is no answer to check), and once
 * the learner starts typing their own next message.
 */
// What a running tool call is doing, in the learner's words. Page tools name their page.
const STEP: Record<string, string> = {
  search: 'searching your pages', web_search: 'searching the web', WebSearch: 'searching the web',
  read_url: 'reading a web page', WebFetch: 'reading a web page', record_evidence: 'saving what you showed',
  get_student_state: 'checking your progress', next_lessons: 'picking what comes next',
  find_analogies: 'looking for an analogy', link_pages: 'linking pages', compile_source: 'reading your source',
  find_recent_papers: 'looking for papers', find_canonical_sources: 'looking for sources',
  ingest_paper: 'reading a paper', generate_exercise: 'writing an exercise', course_problems: 'picking a problem',
};

/** The step a running turn is on, from its newest part: a tool still in flight names what it is
 *  doing, streaming text is "writing", anything before either is "thinking". Pure. */
export function currentStep(message: UIMessage | undefined): string {
  if (message?.role !== 'assistant') return 'thinking';
  const lastPart = message.parts.at(-1);
  const running = [...message.parts].reverse().find((p) => isToolUIPart(p)
    && p.state !== 'output-available' && p.state !== 'output-error');
  if (running && isToolUIPart(running)) {
    const name = getToolName(running);
    const input = (running as { input?: { slug?: unknown; title?: unknown } }).input;
    const page = typeof input?.title === 'string' ? input.title
      : typeof input?.slug === 'string' ? input.slug.replace(/-/g, ' ') : null;
    if (name === 'read_page') return page ? `reading ${page}` : 'reading a page';
    if (name === 'write_page') return page ? `writing ${page}` : 'writing a page';
    if ((BLOCK_TOOL_NAMES as readonly string[]).includes(name)) return 'setting an exercise';
    return STEP[name] ?? 'working';
  }
  return lastPart?.type === 'text' && lastPart.text.trim() ? 'writing' : 'thinking';
}

/** The running turn's status line: what the tutor is doing now, not only that it is busy. */
function WorkingLine() {
  const store = useChatStore();
  const { messages, isRunning } = useSyncExternalStore(store.subscribe, store.getState);
  if (!isRunning) return null;
  return (
    <div className="working" role="status">
      <span className="dot" /><span className="dot" /><span className="dot" />
      <em>tutor is {currentStep(messages.at(-1))}…</em>
    </div>
  );
}

/**
 * What the newest graded block on `message` got wrong, as the prompts the learner missed; null
 * when that block's grade was not a miss (or there is no graded block). An empty list means a miss
 * with no per-item prompt to name (a scratchpad, a draft). Pure.
 */
export function missedOn(message: UIMessage): string[] | null {
  const graded = message.parts.filter((p) => isToolUIPart(p)
    && (BLOCK_TOOL_NAMES as readonly string[]).includes(getToolName(p))
    && p.state === 'output-available'
    && (p.output as { grading?: unknown } | undefined)?.grading);
  const part = graded.at(-1) as { input?: any; output?: any } | undefined;
  if (!part) return null;
  const verdict = part.output?.grading?.verdict;
  if (verdict !== 'incorrect' && verdict !== 'partial') return null;
  const input = part.input ?? {};
  const perItem: { id: string; correct: boolean }[] = Array.isArray(part.output.grading.perItem) ? part.output.grading.perItem : [];
  if (Array.isArray(input.items) && perItem.length > 0) {
    const wrong = new Set(perItem.filter((i) => !i.correct).map((i) => i.id));
    return input.items.filter((i: any) => wrong.has(i?.id) && typeof i?.prompt === 'string').map((i: any) => i.prompt);
  }
  const single = input.question ?? input.prompt;
  return typeof single === 'string' ? [single] : [];
}

/**
 * The one next step after a miss: a fresh question on exactly what was missed, rather than a
 * "2 of 3 correct" with nowhere to go. In every mode, since a study session's miss is the same
 * moment. Steps aside while a turn runs or the learner types, like FollowUps, which it replaces.
 */
function MissedFollowUp({ drafting }: { drafting: boolean }) {
  const store = useChatStore();
  const { messages, isRunning, error } = useSyncExternalStore(store.subscribe, store.getState);
  const last = messages[messages.length - 1];
  if (drafting || isRunning || error !== undefined || last?.role !== 'assistant' || turnFailed(last)) return null;
  const missed = missedOn(last);
  if (missed === null) return null;
  const named = missed.slice(0, 4).map((m) => oneLine(m, 120)).join('; ');
  const ask = missed.length > 0
    ? `I missed ${named}. Give me a fresh question on ${missed.length === 1 ? 'it' : 'them'}, not the same one, and check me before explaining.`
    : 'Give me a fresh question on what I just missed, not the same one, and check me before explaining.';
  return (
    <div className="follow-ups">
      <button type="button" onClick={() => store.sendMessage(ask)}>
        {missed.length > 1 ? 'practise the ones I missed' : 'practise the one I missed'}
      </button>
    </div>
  );
}

function FollowUps({ drafting }: { drafting: boolean }) {
  const store = useChatStore();
  const { messages, isRunning, error } = useSyncExternalStore(store.subscribe, store.getState);
  const last = messages[messages.length - 1];
  if (drafting || isRunning || error !== undefined
    || last?.role !== 'assistant' || turnFailed(last) || awaitsAnswer(last)) return null;
  // After a miss the one useful next step is MissedFollowUp's; these would compete with it.
  if (missedOn(last) !== null) return null;
  const said = last.parts.map((p) => (p.type === 'text' ? p.text : '')).join('').trim();
  if (said.length < MIN_FOLLOW_UP_CHARS) return null;
  return (
    <div className="follow-ups">
      <button type="button" onClick={() => store.sendMessage('Check my understanding of this with one quick question.')}>
        check my understanding
      </button>
      <button type="button" onClick={() => store.sendMessage('Teach me what we were just discussing, properly.', [], { command: 'study' })}>
        study this
      </button>
    </div>
  );
}

/** What the composer says a sticky mode is doing. Chat ('') has no chip: it is the default. */
const MODE_CHIP: Record<string, string> = {
  learn: 'studying', review: 'reviewing', quiz: 'quizzing', freeform: 'writing',
};

// What the attach button admits: the image types both provider wires accept, plus PDF (Anthropic
// document blocks; dropped with a stub on the compat wire). Everything else stays unpickable.
const ATTACH_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,application/pdf';
// Per-file cap. Past ~5MB a single attachment dominates the request body and the provider's
// per-image limits start rejecting anyway; oversize picks get an inline note, not a send failure.
const ATTACH_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The composer: a Tiptap CommandEditor (slash commands as atomic chips) inside the same
 * attachment-aware form. The FORM submit is taken over as before: the handler preventDefaults
 * before assistant-ui's own submit runs and sends through the store directly, because
 * assistant-ui's send() can carry neither attachments (no AttachmentAdapter configured) nor the
 * structured command. Pending files are plain local state; they become FileUIParts on the user
 * message between the data-command part and the text part (chatStore.sendMessage).
 *
 * The programmatic senders (example asks, Ask-Tutor bridge, session-plan CTA, OfferWrite) are
 * deliberately NOT mirrored into the editor: they still call composer.setText + send, which
 * flows through assistant-ui's onNew → store.sendMessage — a path that never touched the visible
 * input even when it was a textarea (setText+send is synchronous; nothing renders in between).
 * Two send paths, one store method, no editor/composer state syncing to get wrong.
 */
export function Composer({ mode = '', onEndMode, onDraftingChange, testEditorHandleRef }: {
  /** The sticky mode ('' is chat); anything else shows as a chip the learner can end. */
  mode?: string;
  onEndMode?: () => void;
  /** Whether the learner has started typing — FollowUps steps aside while they do. */
  onDraftingChange?: (drafting: boolean) => void;
  testEditorHandleRef?: RefObject<CommandEditorHandle | null>;
} = {}) {
  const store = useChatStore();
  const composer = useComposerRuntime();
  const running = useThread((s) => s.isRunning);
  const [files, setFiles] = useState<FileUIPart[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [initialDraft] = useState(() => loadDraft(store.threadId));
  // Debounced: a keystroke's JSON is small, but writing storage on every one is not free. The
  // unmount flush keeps the last 300ms when the learner clicks away mid-sentence.
  const pendingDraft = useRef<{ doc: JSONContent; empty: boolean } | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushDraft = useRef(() => {});
  flushDraft.current = () => {
    clearTimeout(draftTimer.current);
    const draft = pendingDraft.current;
    pendingDraft.current = null;
    if (draft) saveDraft(store.threadId, draft.empty ? null : draft.doc);
  };
  useEffect(() => () => flushDraft.current(), []);
  const onDraftChange = (doc: JSONContent, empty: boolean) => {
    pendingDraft.current = { doc, empty };
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => flushDraft.current(), 300);
  };
  const discardDraft = () => {
    clearTimeout(draftTimer.current);
    pendingDraft.current = null;
    saveDraft(store.threadId, null);
  };
  // The send gate: tracks the EDITOR's emptiness (a lone command chip counts as content — a bare
  // "/beginner" is a valid send), and must also open for a files-only message.
  const [editorEmpty, setEditorEmpty] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const ownEditorRef = useRef<CommandEditorHandle | null>(null);
  // `testEditorHandleRef` is a test-only seam: jsdom cannot type into Tiptap's contenteditable
  // (commandEditor.test.tsx drives it through this same handle), so a Composer-level test needs a
  // way to reach it too. Production never passes it; the default is the ref this component owns.
  const editorRef = testEditorHandleRef ?? ownEditorRef;
  // `/aside` never becomes a chat turn — see doSubmit below — so it needs its own tiny bit of
  // status the composer form itself carries (no assistant message to anchor a part on yet).
  const [asidePending, setAsidePending] = useState(false);
  const [asideError, setAsideError] = useState<string | null>(null);

  const addFiles = (picked: FileList | null) => {
    for (const file of Array.from(picked ?? [])) {
      if (file.size > ATTACH_MAX_BYTES) {
        setNote(`${file.name} is too large — attachments are capped at 5 MB`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        // readAsDataURL yields exactly FileUIPart.url's shape (data:<type>;base64,<payload>).
        setFiles((prev) => [...prev, {
          type: 'file', mediaType: file.type, url: reader.result as string, filename: file.name,
        }]);
      };
      reader.readAsDataURL(file);
    }
  };

  // `/aside <question>` never rides a chat turn (chatRoute 400s an unknown command on purpose —
  // see slashCommands.ts's ComposerCommand note): it calls askAside directly against the latest
  // ASSISTANT message, and the returned part lands on that message via addPartToMessage, exactly
  // as the selection-driven AsideAsk flow does.
  // The editor keeps the question until the aside lands, so a failed one can be sent again
  // without retyping; asidePending stops a second submit meanwhile.
  const submitAside = (question: string) => {
    if (asidePending) return;
    const last = [...store.getState().messages].reverse().find((m) => m.role === 'assistant');
    if (!last) {
      setAsideError('no tutor message to ask about yet');
      return;
    }
    if (files.length > 0) {
      setAsideError('an aside can’t carry attachments — remove them, or send this as a message');
      return;
    }
    setAsideError(null);
    setAsidePending(true);
    askAside({ threadId: store.threadId, messageId: last.id, question })
      .then((part) => {
        store.addPartToMessage(last.id, part);
        editorRef.current?.clear();
        discardDraft();
      })
      .catch((e: unknown) => { setAsideError(e instanceof Error ? e.message : String(e)); })
      .finally(() => setAsidePending(false));
  };

  // One send path for the Send button, the form, and the editor's Enter keymap. serialize()
  // already trims: whitespace-only text beside files sends as files-only — no junk text part.
  const doSubmit = () => {
    const payload = editorRef.current?.serialize() ?? { text: '' };
    if (payload.text === '' && payload.command === undefined && files.length === 0) return;
    if (payload.command === 'aside') { submitAside(payload.text); return; }
    store.sendMessage(payload.text, files, { command: payload.command });
    editorRef.current?.clear();
    discardDraft();
    setFiles([]);
    setNote(null);
  };

  // Escape stops a running turn, same as the Stop button; otherwise it is the editor's.
  const stopOnEscape = () => {
    if (!running) return false;
    composer.cancel();
    return true;
  };

  const submit = (e: FormEvent) => {
    // preventDefault BEFORE assistant-ui's handler: ComposerPrimitive.Root composes this handler
    // first and skips its own send once the event is defaultPrevented.
    e.preventDefault();
    doSubmit();
  };

  return (
    <ComposerPrimitive.Root className="composer" onSubmit={submit}>
      {asidePending && <p className="aside-composer-status" role="status">answering aside…</p>}
      {asideError !== null && <p className="aside-composer-error" role="alert">{asideError}</p>}
      {(files.length > 0 || note !== null) && (
        <div className="composer-attachments">
          {files.map((f, i) => (
            <span key={`${i}-${f.filename}`} className="attachment-chip">
              {f.mediaType.startsWith('image/')
                ? <img className="attachment-thumb" src={f.url} alt="" />
                : <FilePdf size={15} weight="duotone" />}
              <span className="attachment-chip-name">{f.filename}</span>
              <button
                type="button"
                aria-label={`Remove ${f.filename}`}
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          {note !== null && <span className="attachment-note" role="status">{note}</span>}
        </div>
      )}
      <div className="composer-row">
        <button
          type="button"
          className="composer-attach"
          aria-label="Attach image or PDF"
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip size={18} weight="duotone" />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={ATTACH_ACCEPT}
          multiple
          hidden
          onChange={(e) => { addFiles(e.currentTarget.files); e.currentTarget.value = ''; }}
        />
        <CommandEditor handleRef={editorRef} onEnter={doSubmit} onEscape={stopOnEscape}
          initialContent={initialDraft} onChange={onDraftChange}
          onEmptyChange={(empty) => { setEditorEmpty(empty); onDraftingChange?.(!empty); }} />
        {running ? (
          // Cancel reaches the runtime's onCancel → store.abort(), which stops the server's turn
          // too; a reload alone never did (recover() reattaches to the still-running turn).
          <ComposerPrimitive.Cancel className="composer-send composer-stop" aria-label="Stop">
            <Stop size={14} weight="fill" aria-hidden="true" />
          </ComposerPrimitive.Cancel>
        ) : (
          // Not ComposerPrimitive.Send: its disabled state reads assistant-ui's canSend, which
          // knows nothing of the local editor or files and would stay disabled on both.
          <button type="submit" className="composer-send" aria-label="Send" disabled={editorEmpty && files.length === 0}>
            <ArrowUp size={16} weight="bold" aria-hidden="true" />
          </button>
        )}
      </div>
      {MODE_CHIP[mode] !== undefined && (
        <div className="composer-mode">
          <span>{MODE_CHIP[mode]}</span>
          <span aria-hidden="true">·</span>
          <button type="button" aria-label="end study session" onClick={onEndMode}>end</button>
        </div>
      )}
    </ComposerPrimitive.Root>
  );
}

/**
 * The conversation's name above its transcript, as the history list names it (shared/threadTitle).
 * Without it a conversation opened from a link or the palette said nowhere which one it was. Nothing
 * until the learner has said something: an empty chat's own heading does that job.
 */
function ConversationTitle() {
  const store = useChatStore();
  const { messages } = useSyncExternalStore(store.subscribe, store.getState);
  const title = titleFor(messages, '');
  if (!title) return null;
  return (
    <header className="thread-title">
      <h2 title={title}>{title}</h2>
    </header>
  );
}

export function Thread({ mode = '', onModeChange, threadId }: {
  /** The sticky mode App holds: '' is chat (the harness derives each turn), anything else a study
   *  session a /study-family command started. */
  mode?: string;
  onModeChange?: (mode: string) => void;
  /** The open conversation, so its empty state can open on the notebook it is filed under. */
  threadId?: string;
} = {}) {
  // The viewport's autoScroll pins to the bottom on mount — correct for a conversation, wrong for
  // the empty state: in a short window the pitch overflows and a brand-new thread opened with
  // "What do you want to explore?" scrolled out of view (caught in an audit's 900×800 screenshot).
  const empty = useThread((s) => s.messages.length === 0);
  const [drafting, setDrafting] = useState(false);
  return (
    <ThreadPrimitive.Root className="thread">
      <ConversationTitle />
      <AskTutorBridge />
      <PendingAsk threadId={threadId} />
      {/* tabIndex + a name so the transcript can be SCROLLED by keyboard. It is its own scroll
          region (the side panel scrolls independently), and most turns are plain prose with no
          focusable element inside — so without a tab stop of its own, a keyboard-only user has no
          way to scroll back through the conversation (axe flags this as scrollable-region-focusable,
          WCAG 2.1.1). The name makes the stop meaningful rather than an anonymous focusable div. */}
      <ThreadPrimitive.Viewport
        className="thread-viewport"
        autoScroll={!empty}
        tabIndex={0}
        aria-label="Conversation transcript"
      >
        {/* First run showed a blank half-screen and a placeholder — the single most important
            moment in the app said nothing about what it is or what to type. The suggestions are
            deliberately across different SUBJECTS: the thing most worth conveying in the first
            three seconds is that this is not a programming tutor, it is a tutor. */}
        <ThreadPrimitive.Empty>
          <EmptyHero threadId={threadId} />
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        <MissedFollowUp drafting={drafting} />
        {mode === '' && <FollowUps drafting={drafting} />}
        <RetryFailed drafting={drafting} />
        <WorkingLine />
      </ThreadPrimitive.Viewport>
      <Composer mode={mode} onEndMode={() => onModeChange?.('')} onDraftingChange={setDrafting} />
    </ThreadPrimitive.Root>
  );
}
