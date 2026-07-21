// Ported (import adaptations only — local ./types.js, and postRun from ./api.js which hits
// /api/gap/run) from ~/Dev/personal/the-gap apps/web/src/InlineCompletion.tsx (READ ONLY there).
// Logic unchanged.
//
// The inline_completion screen: full artifact rendered read-only EXCEPT the single gap slot
// editable inline (reuses RungEditor's three-pane pattern with a one-line gap); context_line strip
// above; submissions run via /api/gap/run (debounced same as full_body); WRONG result -> show
// rung.prose.hint as a side note under the editor; RIGHT -> success_line and a 'continue'
// affordance.
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

export interface InlineCompletionProps {
  rung: Rung;
  /** Called when the learner dismisses the right-answer success state ("continue" affordance). */
  onContinue: () => void;
  /** Owned by the caller (one instance per active inline_completion rung) so its `offers` can
   *  also drive the brief panel's Docs tab — see this file's top comment. */
  detector: UseDetectorState;
}

export function InlineCompletion({ rung, onContinue, detector }: InlineCompletionProps) {
  const [code, setCode] = useState('');
  const [hasRun, setHasRun] = useState(false);
  const [pass, setPass] = useState(false);
  const [syntaxError, setSyntaxError] = useState<string | undefined>(undefined);

  const run = useCallback(
    async (currentCode: string) => {
      // An empty gap (nothing typed yet, or the debounce firing on initial mount) isn't a
      // submission worth grading — avoid an immediate spurious "wrong" flash before the learner
      // has typed anything.
      if (currentCode.trim() === '') return;
      const response = await postRun(rung.id, currentCode);
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
    [rung.id, detector],
  );

  useDebouncedRun(code, run);

  const showHint = hasRun && !pass && syntaxError === undefined && rung.prose.hint !== undefined;
  const showSuccess = hasRun && pass;

  return (
    <div className="inline-completion">
      <RungEditor visiblePre={rung.visible_pre} visiblePost={rung.visible_post} onGapChange={setCode} />

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
