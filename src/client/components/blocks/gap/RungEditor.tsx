// v2 (docs/superpowers/plans/2026-07-21-coding-stage.md, "whole-file IDE" — user design decision:
// "no need to force the user write in one line, give access to the whole IDE... the ai should just
// leave a comment... we don't need to restrict where the user writes"). Replaces the original
// three-stacked-CM6-view pre/gap/post approach (ported from ~/Dev/personal/the-gap
// apps/web/src/RungEditor.tsx, READ ONLY there, then diverged with P2 editor-polish additions —
// line numbers/bracket matching on the read-only panes, draft autosave, continuous cross-pane line
// numbering via a per-pane offset Compartment) with ONE CodeMirror 6 view over the rung's whole
// file: everything editable, natural single-doc line numbers, no DOM seam between "read-only" and
// "editable" regions. That whole 3-view/offset-Compartment machinery is gone — the sidecar's
// `scaffold` field (or, absent that, synthesizeScaffold's client-side equivalent — see
// ./scaffold.ts) already IS the complete file the learner should see, so there is nothing left for
// this component to assemble from parts.
//
// The AI's "turn marker" (server/synthesized wording: "── YOUR TURN ──" + a one-line task +
// closing border, see scaffold.ts) is no longer a structural boundary CM6 enforces — it is plain
// text in an ordinary editable document, like any comment a colleague left in a file. The only
// thing this component still does about it is a subtle, best-effort line decoration (see
// markerHighlightField below) that highlights it as long as it's recognizably still there, and
// says nothing if the learner edits or deletes it — never blocking, never restoring.
//
// Ctrl/Cmd+Enter's keymap is wrapped in Prec.highest (see the mount effect below): basicSetup's
// own @codemirror/commands defaultKeymap binds "Mod-Enter" to insertBlankLine, which on a non-Mac
// platform normalizes to the SAME "Ctrl-Enter" this component binds to Run — without the
// precedence bump, basicSetup (listed first in `extensions`) wins the tie and Ctrl+Enter silently
// inserts a blank line instead of running (caught by this file's own test suite, not by hand).
import { useEffect, useRef } from 'react';
import { EditorState, Prec, RangeSetBuilder, StateField, type Text } from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { loadDraft, saveDraft } from './draftStorage.js';
import { findMarkerLineRange } from './scaffold.js';

const LANGUAGE = javascript({ typescript: true });

const MARKER_LINE_DECORATION = Decoration.line({ attributes: { class: 'cm-your-turn-marker' } });

function buildMarkerDecorations(doc: Text): DecorationSet {
  const range = findMarkerLineRange(doc.toString());
  const builder = new RangeSetBuilder<Decoration>();
  if (range) {
    const lastLine = Math.min(range.endLine, doc.lines);
    for (let lineNo = range.startLine; lineNo <= lastLine; lineNo += 1) {
      const line = doc.line(lineNo);
      builder.add(line.from, line.from, MARKER_LINE_DECORATION);
    }
  }
  return builder.finish();
}

// Recomputed on every doc change by a plain rescan rather than tracked incrementally: the marker
// is free-form text the learner can edit or delete at any time (see this file's top comment), so
// there is no cheaper "patch" representation worth maintaining, and a couple of regex passes over
// a file capped at 20k chars server-side (HelpPanel's draft, same doc) is cheap per keystroke.
const markerHighlightField = StateField.define<DecorationSet>({
  create: (state) => buildMarkerDecorations(state.doc),
  update: (deco, tr) => (tr.docChanged ? buildMarkerDecorations(tr.state.doc) : deco.map(tr.changes)),
  provide: (field) => EditorView.decorations.from(field),
});

export interface RungEditorProps {
  /** The rung's whole-file starting doc — a resolved scaffold (see ./scaffold.ts's
   *  resolveScaffold), NOT draft-adjusted; draft restoration (below) is this component's own
   *  concern so callers never need to duplicate that resolution. */
  scaffold: string;
  onDocChange: (code: string) => void;
  /** P1 (docs/superpowers/plans/2026-07-20-gap-integration.md IDE focus mode): the editor grows
   *  to fill the available column height instead of sizing to its content — see
   *  `.rung-editor-frame--fill` in styles.css. Off by default so InlineCompletion's inline,
   *  content-sized use is unaffected. */
  fillHeight?: boolean;
  /** P2 (editor polish): when present, the editor restores a saved draft under this key on mount
   *  (falling back to `scaffold` if none is saved) and autosaves on every change — see
   *  draftStorage.ts. Omit to opt a caller out of persistence entirely (its default). */
  draftKey?: string;
  /** P2 (editor polish): fires on Ctrl+Enter AND Cmd+Enter from inside the editor — wired to
   *  "Run" by the caller. Read through a ref (see onRunRequestRef below) so the mount-once effect
   *  always calls the latest callback without needing to remount the view on every render. */
  onRunRequest?: () => void;
}

export function RungEditor({ scaffold, onDocChange, fillHeight = false, draftKey, onRunRequest }: RungEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onDocChangeRef = useRef(onDocChange);
  onDocChangeRef.current = onDocChange;
  const onRunRequestRef = useRef(onRunRequest);
  onRunRequestRef.current = onRunRequest;

  useEffect(() => {
    if (!containerRef.current) return;
    const startDoc = draftKey ? (loadDraft(draftKey) ?? scaffold) : scaffold;
    // Report the RESOLVED starting doc (draft-restored or scaffold) to the caller immediately, not
    // just on the learner's first real edit — callers (CodeExercise.tsx) need an accurate "current
    // doc" from the moment this mounts to compute wroteCode (exact compare against the ORIGINAL
    // scaffold, not the draft) correctly even if the learner never types anything. Not persisted
    // as a draft here — nothing has changed yet, so there is nothing new worth writing.
    onDocChangeRef.current(startDoc);

    const view = new EditorView({
      state: EditorState.create({
        doc: startDoc,
        extensions: [
          basicSetup,
          oneDark,
          LANGUAGE,
          markerHighlightField,
          Prec.highest(keymap.of([
            { key: 'Ctrl-Enter', run: () => { onRunRequestRef.current?.(); return true; } },
            { key: 'Cmd-Enter', run: () => { onRunRequestRef.current?.(); return true; } },
          ])),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const next = update.state.doc.toString();
            onDocChangeRef.current(next);
            if (draftKey) saveDraft(draftKey, next);
          }),
        ],
      }),
      parent: containerRef.current,
    });
    return () => view.destroy();
    // Mounted once: this component owns its own document from here on (rung switches remount it
    // via a `key` change in CodeExercise.tsx, not a live doc swap — same rationale as the
    // pre-rewrite version this replaces). scaffold/draftKey are only ever read at that first
    // mount; a live swap of either mid-session isn't a case that arises.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={fillHeight ? 'rung-editor-frame rung-editor-frame--fill' : 'rung-editor-frame'}>
      {/* data-testid is a tiny test-only affordance (I3, docs/superpowers/plans/2026-07-20-
          gap-integration.md): tests/e2e/gap-exercise.e2e.ts locates this pane to dispatch a real
          synthetic ClipboardEvent('paste') at it (the standard way to feed exact multi-line text
          into a CM6 contentEditable without keystroke-level fragility) — CM6's own paste handler
          applies it as one transaction, so this is still the real editor/real CM6 path, not a
          stand-in like CodeExerciseInner's `Editor` prop swap used in jsdom tests. */}
      <div ref={containerRef} className="rung-pane rung-pane--editable" aria-label="exercise code" data-testid="gap-editor" />
    </div>
  );
}
