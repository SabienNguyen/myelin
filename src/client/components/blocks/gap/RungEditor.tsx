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
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { loadDraft, saveDraft } from './draftStorage.js';

const LANGUAGE = javascript({ typescript: true });

// P2 (editor polish): the read-only pre/post panes get line numbers + bracket matching too, so
// all three stacked CM6 views read as one continuous editor frame rather than the gap pane
// visibly being "the only real one." Each pane still numbers its own lines from 1 — the file's
// top comment already documents why these are three independently-mounted views rather than one
// continuous document (no real seam-free way to lock ranges of a single CM6 doc), and a
// continuously-numbered virtual line count across the seam would need to track the gap's live
// line count on every keystroke; not worth the complexity for a cosmetic offset.
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
  useReadOnlyPane(postRef, visiblePost);

  useEffect(() => {
    if (!gapRef.current) return;
    const startDoc = draftKey ? (loadDraft(draftKey) ?? initialGap) : initialGap;
    const view = new EditorView({
      state: EditorState.create({
        doc: startDoc,
        extensions: [
          basicSetup,
          oneDark,
          LANGUAGE,
          keymap.of([
            { key: 'Ctrl-Enter', run: () => { onRunRequestRef.current?.(); return true; } },
            { key: 'Cmd-Enter', run: () => { onRunRequestRef.current?.(); return true; } },
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const next = update.state.doc.toString();
            onGapChangeRef.current(next);
            if (draftKey) saveDraft(draftKey, next);
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
