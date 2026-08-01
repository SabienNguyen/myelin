import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ThreadPrimitive, MessagePrimitive, ComposerPrimitive, ErrorPrimitive, useComposerRuntime, useThread, useThreadRuntime } from '@assistant-ui/react';
import { FilePdfIcon as FilePdf, PaperclipIcon as Paperclip, XIcon as X } from '@phosphor-icons/react';
import type { FileUIPart } from '../../shared/uiMessages.js';
import { useChatStore } from '../chatCore/index.js';
import { CommandEditor, type CommandEditorHandle } from './CommandEditor.js';
import { MarkdownText } from './MarkdownText.js';
import { ToolStatusChip } from './ToolStatusChip.js';
import { panelBus } from '../lib/panelBus.js';

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

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="msg assistant">
      <MessagePrimitive.Parts components={{
        Text: MarkdownText,
        Reasoning: ReasoningPart,
        tools: { Fallback: ToolStatusChip }, // MCP tools → quiet status chip, not JSON
      }} />
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

interface PlanItem {
  kind: string; slug: string; title: string; why: string; transfer?: string;
  /** For a `quiz` item: every page the one block should cover. */
  covers?: string[];
}

/**
 * "Start today's session" — the interleaved plan (/api/session-plan) as the empty thread's primary
 * action once there is anything to plan. Spacing and interleaving are the system's job; the CTA is
 * where the system does the deciding and the learner just sits down. The whole plan travels in the
 * message so the tutor works through it in order — the same delegation shape as every other row
 * that hands the composer a request.
 */
function SessionPlanCta({ plan }: { plan: PlanItem[] }) {
  const composer = useComposerRuntime();
  if (plan.length === 0) return null;

  const KIND_LABEL: Record<string, string> = {
    review: 'review', new: 'new', misconception: 'fix', course: 'course', quiz: 'quiz',
  };
  const start = () => {
    // The transfer directive rides on the item's own line (review/fix items carry it), so the
    // constraint is in front of the tutor exactly where it works that row — not left to a rule
    // several screens up in the system prompt.
    const lines = plan.map((p, i) => {
      // A quiz item covers SEVERAL pages in one block, so the row has to name all of them —
      // otherwise the tutor quizzes the first slug and the batching is lost.
      const what = p.covers?.length ? p.covers.map((c) => `"${c}"`).join(', ') : `"${p.slug}"`;
      return `${i + 1}. [${p.kind}] ${what} — ${p.why}${p.transfer ? ` — ${p.transfer}` : ''}`;
    }).join('\n');
    composer.setText(
      `Run today's session, in this order, one item at a time:\n${lines}\n`
      + 'For reviews and misconceptions, probe or set an exercise before any reteaching; for new items, teach then check. '
      + 'A [quiz] row is ONE quiz block with an item per page it names, not one block per page.',
    );
    composer.send();
  };
  return (
    <div className="session-plan">
      <button type="button" className="primary session-plan-start" onClick={start}>
        Start today’s session ({plan.length} {plan.length === 1 ? 'item' : 'items'})
      </button>
      <ol className="session-plan-preview">
        {plan.map((p) => (
          <li key={p.slug}>
            <span className={`session-plan-kind session-plan-kind--${p.kind}`}>{KIND_LABEL[p.kind] ?? p.kind}</span>
            {p.title}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The empty thread's hero, which knows who it is talking to. A brand-new learner gets the pitch
 * and the cross-subject example asks; a RETURNING learner with a session plan gets "pick up where
 * you left off" and the plan — not a headline asking what they want to learn above a card that
 * already knows. One fetch decides both (plan lives here, SessionPlanCta just renders it), and the
 * hero renders nothing until it resolves, so the copy never flashes from one audience to the other.
 */
function EmptyHero() {
  const [plan, setPlan] = useState<PlanItem[] | null>(null); // null = still deciding
  useEffect(() => {
    let cancelled = false;
    fetch('/api/session-plan')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setPlan(d?.plan ?? []); })
      .catch(() => { if (!cancelled) setPlan([]); }); // no plan is the newcomer state, not an error
    return () => { cancelled = true; };
  }, []);
  if (plan === null) return null;

  const returning = plan.length > 0;
  return (
    <div className="thread-empty">
      <h2>{returning ? 'Pick up where you left off' : 'What do you want to learn?'}</h2>
      {!returning && (
        <p>
          Ask for anything — a topic, a paper, a book you are stuck in. Your tutor writes pages
          as you go, links them into a graph, and tracks what you have actually shown you know.
        </p>
      )}
      <SessionPlanCta plan={plan} />
      {/* The example asks taught their lesson (any subject works) on day one; for a returner they
          are noise beside the plan, and the composer is right below for anything new. */}
      {!returning && <ExampleAsks />}
    </div>
  );
}

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
function Composer() {
  const store = useChatStore();
  const [files, setFiles] = useState<FileUIPart[]>([]);
  const [note, setNote] = useState<string | null>(null);
  // The send gate: tracks the EDITOR's emptiness (a lone command chip counts as content — a bare
  // "/beginner" is a valid send), and must also open for a files-only message.
  const [editorEmpty, setEditorEmpty] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<CommandEditorHandle | null>(null);

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

  // One send path for the Send button, the form, and the editor's Enter keymap. serialize()
  // already trims: whitespace-only text beside files sends as files-only — no junk text part.
  const doSubmit = () => {
    const payload = editorRef.current?.serialize() ?? { text: '' };
    if (payload.text === '' && payload.command === undefined && files.length === 0) return;
    store.sendMessage(payload.text, files, { command: payload.command });
    editorRef.current?.clear();
    setFiles([]);
    setNote(null);
  };

  const submit = (e: FormEvent) => {
    // preventDefault BEFORE assistant-ui's handler: ComposerPrimitive.Root composes this handler
    // first and skips its own send once the event is defaultPrevented.
    e.preventDefault();
    doSubmit();
  };

  return (
    <ComposerPrimitive.Root className="composer" onSubmit={submit}>
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
        <CommandEditor handleRef={editorRef} onEnter={doSubmit} onEmptyChange={setEditorEmpty} />
        {/* Not ComposerPrimitive.Send: its disabled state reads assistant-ui's canSend, which
            knows nothing of the local editor or files and would stay disabled on both. */}
        <button type="submit" disabled={editorEmpty && files.length === 0}>Send</button>
      </div>
    </ComposerPrimitive.Root>
  );
}

export function Thread() {
  // The viewport's autoScroll pins to the bottom on mount — correct for a conversation, wrong for
  // the empty state: in a short window the pitch overflows and a brand-new thread opened with
  // "What do you want to learn?" scrolled out of view (caught in an audit's 900×800 screenshot).
  const empty = useThread((s) => s.messages.length === 0);
  return (
    <ThreadPrimitive.Root className="thread">
      <AskTutorBridge />
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
          <EmptyHero />
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        <ThreadPrimitive.If running>
          <div className="working" role="status">
            <span className="dot" /><span className="dot" /><span className="dot" />
            <em>tutor is working…</em>
          </div>
        </ThreadPrimitive.If>
      </ThreadPrimitive.Viewport>
      <Composer />
    </ThreadPrimitive.Root>
  );
}
