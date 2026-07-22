// Ported (import adaptations only — local ./types.js, and postRun from ./api.js which hits
// /api/gap/run) from ~/Dev/personal/the-gap apps/web/src/InlineCompletion.tsx (READ ONLY there),
// then updated for RungEditor v2 (docs/superpowers/plans/2026-07-21-coding-stage.md, "whole-file
// IDE" — the user design decision behind that rewrite reads directly on THIS screen: "no need to
// force the user write in one line ... we don't need to restrict where the user writes"). The
// artificially small "one editable line in an otherwise read-only frame" shape is gone along with
// RungEditor's old three-pane machinery — this is now the same whole-file editor full_body uses,
// just loaded from a rung whose scaffold's marker task happens to describe a smaller edit (see
// ./scaffold.ts). context_line strip above; submissions run via /api/gap/run in whole-file mode
// (debounced same as full_body); WRONG result -> show rung.prose.hint as a side note under the
// editor; RIGHT -> success_line and a 'continue' affordance.
//
// Detection scope: inline_completion gets ONLY the docs detector (syntax errors) — plan/predict
// are full_body concerns. The gap here is a few lines, already context-lined and hint-carrying by
// design — an idle-on-empty-gap plan offer would compete with the hint that already exists for
// this exact case, and a 3-run predict-then-run panel doesn't fit a single-branch gap. Only the
// syntax-error streak — a signal orthogonal to the gap's size — still applies.
//
// P1 (docs/superpowers/plans/2026-07-20-gap-integration.md IDE focus mode): the detector instance
// and the docs offer's rendering both moved to the caller (CodeExercise.tsx) — the offer now
// docks as a brief-panel tab (FocusLayout.tsx) alongside full_body's plan/predict/docs tabs
// instead of floating as its own aside card here, so the parent needs the live `offers` state to
// build that tab list. The context_line strip also moved to the caller's brief panel (the rung's
// "context/contract line" — see FocusLayout's `contextLine` prop) to avoid rendering it twice.

import { useCallback, useState } from 'react';
import type { Rung } from './types.js';
import { RungEditor } from './RungEditor.js';
import { SyntaxErrorNote } from './SyntaxErrorNote.js';
import { useDebouncedRun } from './hooks/useDebouncedRun.js';
import type { UseDetectorState } from './hooks/useDetectorState.js';
import { postRun } from './api.js';
import { resolveScaffold } from './scaffold.js';

export interface InlineCompletionProps {
  rung: Rung;
  /** Called when the learner dismisses the right-answer success state ("continue" affordance). */
  onContinue: () => void;
  /** Owned by the caller (one instance per active inline_completion rung) so its `offers` can
   *  also drive the brief panel's Docs tab — see this file's top comment. */
  detector: UseDetectorState;
}

export function InlineCompletion({ rung, onContinue, detector }: InlineCompletionProps) {
  // resolveScaffold(rung) is stable for the life of this mount — rung.id changes remount this
  // component fresh via CodeExercise.tsx's `key={currentRung.id}` (same rationale as
  // RungEditor.tsx's own mount-once effect), so recomputing on every render is unnecessary but
  // harmless; not memoized to keep this file's shape simple. `code` seeds directly from it
  // (this screen never passes RungEditor a draftKey, so RungEditor's own resolved starting doc
  // can never differ from `initialScaffold`) rather than through RungEditor's mount-sync
  // onDocChange call, so there is no window where an untouched screen's `code` reads as ''.
  const initialScaffold = resolveScaffold(rung);
  const [code, setCode] = useState(initialScaffold);
  const [hasRun, setHasRun] = useState(false);
  const [pass, setPass] = useState(false);
  const [syntaxError, setSyntaxError] = useState<string | undefined>(undefined);

  const run = useCallback(
    async (currentCode: string) => {
      // Untouched (still exactly the starting scaffold — nothing typed yet, or RungEditor's
      // mount-time sync call, or the debounce firing right after either) isn't a submission worth
      // grading — avoid an immediate spurious "wrong" flash before the learner has changed
      // anything.
      if (currentCode === initialScaffold) return;
      const response = await postRun(rung.id, currentCode, { mode: 'file' });
      setHasRun(true);
      setPass(response.pass);
      setSyntaxError(response.syntaxError);
      detector.dispatch({
        type: 'run-result',
        at: Date.now(),
        failingSet: response.results.filter((r) => !r.pass).map((r) => r.name),
        syntaxError: response.syntaxError !== undefined,
      });
    },
    [rung.id, detector, initialScaffold],
  );

  useDebouncedRun(code, run);

  const showHint = hasRun && !pass && syntaxError === undefined && rung.prose.hint !== undefined;
  const showSuccess = hasRun && pass;

  return (
    <div className="inline-completion">
      <RungEditor scaffold={initialScaffold} onDocChange={setCode} />

      {syntaxError !== undefined && <SyntaxErrorNote message={syntaxError} />}

      {showHint && (
        <p className="inline-completion-hint" role="note">
          {rung.prose.hint}
        </p>
      )}

      {showSuccess && (
        <div className="inline-completion-success">
          <p className="inline-completion-success-line">{rung.prose.success_line}</p>
          <button type="button" onClick={onContinue}>
            continue
          </button>
        </div>
      )}
    </div>
  );
}
