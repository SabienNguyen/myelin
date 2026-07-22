// Originally ported (with one import adaptation) from ~/Dev/personal/the-gap
// apps/web/src/RungEditor.tsx (READ ONLY there) with logic unchanged from the source. P2 (editor
// polish) has since diverged from that upstream file — line numbers/bracket matching on the
// read-only panes, draft autosave, and the Ctrl/Cmd+Enter run keymap below are harness-local
// additions, not present upstream.
//
// "CodeMirror 6 ... showing visible_pre and visible_post as READ-ONLY dimmed regions and the gap as
// the editable region between them." Editor-pane approach: three stacked CodeMirror 6 views
// sharing one visual frame — a read-only dimmed view for visible_pre, an editable view for the
// gap, a read-only dimmed view for visible_post. CM6 has no built-in "some ranges of this one
// document are locked" primitive that composes cleanly with normal typing/selection — three
// independently-mounted views, with only the middle one's onChange wired up, is the simplest
// robust approximation of "one editor, some of it locked," at the cost of the pre/gap/post
// boundary being a real DOM seam rather than one continuous text buffer. All three share the same
// theme (oneDark) and language support so they read as one continuous frame. The dark-editor
// styling stays scoped inside `.rung-editor-frame` (see ../../../styles.css) — the harness's
// paper/ink chrome wraps the block card outside it.

import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { loadDraft, saveDraft } from './draftStorage.js';

const LANGUAGE = javascript({ typescript: true });

// Continuous line numbering (docs/superpowers/plans/2026-07-21-coding-stage.md section C): the
// three stacked panes read as one file rather than three independently-numbered ones. Pre still
// numbers from 1 (unchanged — it IS the top of the "file"). Gap's offset is `visiblePre`'s line
// count, fixed for the life of this mount (visiblePre never changes without a full remount — see
// the top-of-file comment on rung switches). Post's offset is pre + the GAP's CURRENT line count,
// which does change as the learner types, so only the post pane needs a Compartment it can
// reconfigure live (see the gap-mount effect below).
function countLines(text: string): number {
  return text.split('\n').length;
}

function offsetLineNumbers(offset: number) {
  return lineNumbers({ formatNumber: (lineNo) => String(lineNo + offset) });
}

// P2 (editor polish): the read-only pre/post panes get line numbers + bracket matching too, so
// all three stacked CM6 views read as one continuous editor frame rather than the gap pane
// visibly being "the only real one."
function useReadOnlyPane(container: React.RefObject<HTMLDivElement | null>, doc: string): void {
  useEffect(() => {
    if (!container.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          oneDark, LANGUAGE, lineNumbers(), bracketMatching(),
          EditorView.editable.of(false), EditorView.lineWrapping,
        ],
      }),
      parent: container.current,
    });
    return () => view.destroy();
  }, [container, doc]);
}

export interface RungEditorProps {
  visiblePre: string;
  visiblePost: string;
  initialGap?: string;
  onGapChange: (code: string) => void;
  /** P1 (docs/superpowers/plans/2026-07-20-gap-integration.md IDE focus mode): the gap pane
   *  grows to fill the available column height instead of sizing to its content — see
   *  `.rung-editor-frame--fill` in styles.css. Off by default so InlineCompletion's inline,
   *  content-sized use is unaffected. */
  fillHeight?: boolean;
  /** P2 (editor polish): when present, the gap pane restores a saved draft under this key on
   *  mount (falling back to `initialGap` if none is saved) and autosaves on every change — see
   *  draftStorage.ts. Omit to opt a caller out of persistence entirely (its default). */
  draftKey?: string;
  /** P2 (editor polish): fires on Ctrl+Enter AND Cmd+Enter from inside the gap pane — wired to
   *  "Run" by the caller. Read through a ref (see onGapChangeRef below) so the mount-once effect
   *  always calls the latest callback without needing to remount the view on every render. */
  onRunRequest?: () => void;
}

export function RungEditor({
  visiblePre, visiblePost, initialGap = '', onGapChange, fillHeight = false, draftKey, onRunRequest,
}: RungEditorProps) {
  const preRef = useRef<HTMLDivElement>(null);
  const postRef = useRef<HTMLDivElement>(null);
  const gapRef = useRef<HTMLDivElement>(null);
  const onGapChangeRef = useRef(onGapChange);
  onGapChangeRef.current = onGapChange;
  const onRunRequestRef = useRef(onRunRequest);
  onRunRequestRef.current = onRunRequest;

  useReadOnlyPane(preRef, visiblePre);

  // Continuous numbering (see helpers above): preLineCount is stable for this mount's whole life
  // (visiblePre never changes without a full remount). startGapDoc mirrors the doc the gap pane's
  // own mount effect below actually starts from (draft-restored or initialGap) — computed once,
  // via a lazy ref init, so the post pane's INITIAL offset can't drift from the gap's real
  // starting content even though the two are set up in separate effects.
  const preLineCount = countLines(visiblePre);
  const startGapDocRef = useRef<string | null>(null);
  if (startGapDocRef.current === null) {
    startGapDocRef.current = draftKey ? (loadDraft(draftKey) ?? initialGap) : initialGap;
  }
  const postLineNumberCompartment = useRef(new Compartment()).current;
  const postViewRef = useRef<EditorView | null>(null);
  const lastGapLineCountRef = useRef(countLines(startGapDocRef.current));

  useEffect(() => {
    if (!postRef.current) return;
    const initialOffset = preLineCount + lastGapLineCountRef.current;
    const view = new EditorView({
      state: EditorState.create({
        doc: visiblePost,
        extensions: [
          oneDark, LANGUAGE,
          postLineNumberCompartment.of(offsetLineNumbers(initialOffset)),
          bracketMatching(),
          EditorView.editable.of(false), EditorView.lineWrapping,
        ],
      }),
      parent: postRef.current,
    });
    postViewRef.current = view;
    return () => { view.destroy(); postViewRef.current = null; };
    // Mounted once, same rationale as the gap effect below. The post pane's LIVE offset updates
    // (as the learner adds/removes lines in the gap) come through
    // postLineNumberCompartment.reconfigure(...) fired from the gap effect's updateListener, not
    // by remounting this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!gapRef.current) return;
    const startDoc = startGapDocRef.current ?? initialGap;
    const view = new EditorView({
      state: EditorState.create({
        doc: startDoc,
        extensions: [
          basicSetup,
          oneDark,
          LANGUAGE,
          // basicSetup already includes a plain lineNumbers() — CM6 dedups the shared gutter/plugin
          // extensions it returns by reference and merges the two lineNumberConfig values (the
          // default config carries no formatNumber key, so there's no conflict), leaving exactly
          // one gutter using OUR formatNumber. See node_modules/@codemirror/view's lineNumbers()
          // (facet-of the shared `gutters()`/`lineNumberGutter` singletons) and
          // @codemirror/state's combineConfig if this ever needs re-verifying.
          offsetLineNumbers(preLineCount),
          keymap.of([
            { key: 'Ctrl-Enter', run: () => { onRunRequestRef.current?.(); return true; } },
            { key: 'Cmd-Enter', run: () => { onRunRequestRef.current?.(); return true; } },
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const next = update.state.doc.toString();
            onGapChangeRef.current(next);
            if (draftKey) saveDraft(draftKey, next);

            // Continuous numbering: the post pane's offset only needs to move when the gap's LINE
            // COUNT changes, not on every keystroke — guard on that before touching the post view
            // at all (line-count changes are rare relative to keystrokes).
            const gapLineCount = update.state.doc.lines;
            if (gapLineCount !== lastGapLineCountRef.current) {
              lastGapLineCountRef.current = gapLineCount;
              postViewRef.current?.dispatch({
                effects: postLineNumberCompartment.reconfigure(
                  offsetLineNumbers(preLineCount + gapLineCount),
                ),
              });
            }
          }),
        ],
      }),
      parent: gapRef.current,
    });
    return () => view.destroy();
    // Mounted once: the gap pane owns its own document from here on (rung switches remount this
    // component via a `key` change in CodeExercise.tsx, not a live doc swap). draftKey/initialGap
    // are only ever read at that first mount (a live swap of either mid-session isn't a case that
    // arises — see above), matching the existing eslint-disable rationale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={fillHeight ? 'rung-editor-frame rung-editor-frame--fill' : 'rung-editor-frame'}>
      <div ref={preRef} className="rung-pane rung-pane--readonly rung-pane--pre" aria-label="code before the gap" />
      {/* data-testid is a tiny test-only affordance (I3, docs/superpowers/plans/2026-07-20-
          gap-integration.md): tests/e2e/gap-exercise.e2e.ts locates this pane to dispatch a real
          synthetic ClipboardEvent('paste') at it (the standard way to feed exact multi-line text
          into a CM6 contentEditable without keystroke-level fragility, e.g. its closeBrackets
          extension double-inserting a `}` typed right after an auto-inserted one) — CM6's own
          paste handler applies it as one transaction, so this is still the real editor/real CM6
          path, not a stand-in like CodeExerciseInner's `Editor` prop swap used in jsdom tests. */}
      <div ref={gapRef} className="rung-pane rung-pane--gap" aria-label="your code" data-testid="gap-editor" />
      <div ref={postRef} className="rung-pane rung-pane--readonly rung-pane--post" aria-label="code after the gap" />
    </div>
  );
}
