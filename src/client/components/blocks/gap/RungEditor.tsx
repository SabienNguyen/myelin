// Ported (with one import adaptation) from ~/Dev/personal/the-gap apps/web/src/RungEditor.tsx
// (READ ONLY there). Logic is unchanged from the source.
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
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';

const LANGUAGE = javascript({ typescript: true });

function useReadOnlyPane(container: React.RefObject<HTMLDivElement | null>, doc: string): void {
  useEffect(() => {
    if (!container.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [oneDark, LANGUAGE, EditorView.editable.of(false), EditorView.lineWrapping],
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
}

export function RungEditor({
  visiblePre, visiblePost, initialGap = '', onGapChange, fillHeight = false,
}: RungEditorProps) {
  const preRef = useRef<HTMLDivElement>(null);
  const postRef = useRef<HTMLDivElement>(null);
  const gapRef = useRef<HTMLDivElement>(null);
  const onGapChangeRef = useRef(onGapChange);
  onGapChangeRef.current = onGapChange;

  useReadOnlyPane(preRef, visiblePre);
  useReadOnlyPane(postRef, visiblePost);

  useEffect(() => {
    if (!gapRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialGap,
        extensions: [
          basicSetup,
          oneDark,
          LANGUAGE,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onGapChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
      parent: gapRef.current,
    });
    return () => view.destroy();
    // Mounted once: the gap pane owns its own document from here on (rung switches remount this
    // component via a `key` change in CodeExercise.tsx, not a live doc swap).
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
