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
// syntax-error streak — a signal orthogonal to the gap's size — still applies, so this screen runs
// its own detector instance and renders just the docs offer when it fires.

import { useCallback, useState } from 'react';
import type { Rung } from './types.js';
import { RungEditor } from './RungEditor.js';
import { SyntaxErrorNote } from './SyntaxErrorNote.js';
import { OfferCard } from './OfferPanel.js';
import { DocsPanel } from './DocsPanel.js';
import { useDebouncedRun } from './hooks/useDebouncedRun.js';
import { useDetectorState } from './hooks/useDetectorState.js';
import { postRun } from './api.js';

export interface InlineCompletionProps {
  rung: Rung;
  /** Called when the learner dismisses the right-answer success state ("continue" affordance). */
  onContinue: () => void;
}

export function InlineCompletion({ rung, onContinue }: InlineCompletionProps) {
  const [code, setCode] = useState('');
  const [hasRun, setHasRun] = useState(false);
  const [pass, setPass] = useState(false);
  const [syntaxError, setSyntaxError] = useState<string | undefined>(undefined);
  const detector = useDetectorState();

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
      {rung.prose.context_line !== undefined && <p className="context-strip">{rung.prose.context_line}</p>}

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

      {detector.offers.docs && (
        <div className="offer-panel">
          <OfferCard onDismiss={() => detector.dismissOffer('docs')}>
            <DocsPanel artifactId={rung.artifactId} />
          </OfferCard>
        </div>
      )}
    </div>
  );
}
