// Ported (with one import adaptation — `Rung` from ../types.js instead of @the-gap/core) from
// ~/Dev/personal/the-gap apps/web/src/WorkedExample.tsx (READ ONLY there). Logic unchanged.
//
// The worked_example player: move-by-move reveal — previously revealed moves stay visible, the
// current move's explanation shows beneath; Space/j advances, k goes back; at a move with a check
// question: options as buttons, wrong pick stays with a one-line neutral note (WRONG_PICK_NOTE,
// tone-checked — see tests/client/gap/failureMessages.test.ts), right pick advances with NO
// praise, just the next move. Read-only throughout — always the ladder's SIBLING artifact's worked
// example, never the learner's own gap, so there is nothing here to grade or submit.

import { useCallback, useEffect, useState } from 'react';
import type { Rung } from './types.js';

// Hand-written, tone-clean, no praise — the neutral note shown on a wrong check pick.
export const WRONG_PICK_NOTE = 'not this one — look at where the guard sits in the sequence.';

export interface WorkedExampleProps {
  rung: Rung;
  /** Called when the learner advances past the final move. */
  onContinue: () => void;
}

export function WorkedExample({ rung, onContinue }: WorkedExampleProps) {
  const moves = rung.prose.moves ?? [];
  const [index, setIndex] = useState(0);
  const [answeredCorrectly, setAnsweredCorrectly] = useState<Record<number, boolean>>({});
  const [wrongNote, setWrongNote] = useState(false);

  const move = moves[index];
  const isLast = index === moves.length - 1;
  // A move with an unanswered (or not-yet-correctly-answered) check gates forward progress —
  // "wrong pick -> stays" applies to keyboard advance too, not just the continue/next button.
  const gated = move?.check !== undefined && answeredCorrectly[index] !== true;

  const goBack = useCallback(() => {
    setWrongNote(false);
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  // NOT built as a setIndex functional updater: calling onContinue() (parent setState) from inside
  // a setIndex updater runs it during React's render/reconciliation of THIS component, which React
  // rejects. Reading `gated`/`isLast` from render-time state instead and calling
  // onContinue()/setIndex() directly in the event-handler body keeps every setState call in its
  // own top-level event-handler tick.
  const advance = useCallback(() => {
    if (gated) return;
    if (isLast) {
      onContinue();
      return;
    }
    setWrongNote(false);
    setIndex((i) => i + 1);
  }, [gated, isLast, onContinue]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === ' ' || event.key === 'j') {
        event.preventDefault();
        advance();
      } else if (event.key === 'k') {
        event.preventDefault();
        goBack();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [advance, goBack]);

  if (!move) {
    return <p className="worked-example-empty">no moves available for this worked example.</p>;
  }

  const priorCode = moves.slice(0, index).map((m) => m.code).join('');

  function pickOption(optionIndex: number): void {
    if (!move.check) return;
    if (optionIndex === move.check.answerIndex) {
      setAnsweredCorrectly((prev) => ({ ...prev, [index]: true }));
      setWrongNote(false);
    } else {
      setWrongNote(true);
    }
  }

  return (
    <div className="worked-example">
      <p className="worked-example-progress">
        move {index + 1} of {moves.length}
      </p>

      <pre className="worked-example-code" aria-label="artifact code, revealed so far">
        <span className="worked-example-code--prior">{priorCode}</span>
        <span className="worked-example-code--current">{move.code}</span>
      </pre>

      <p className="worked-example-explanation">{move.explanation}</p>

      {move.check && (
        <div className="worked-example-check">
          <p className="worked-example-check-question">{move.check.question}</p>
          <div className="worked-example-check-options">
            {move.check.options.map((option, optionIndex) => (
              <button
                key={option}
                type="button"
                className={
                  answeredCorrectly[index] && optionIndex === move.check!.answerIndex
                    ? 'worked-example-check-option worked-example-check-option--correct'
                    : 'worked-example-check-option'
                }
                onClick={() => pickOption(optionIndex)}
              >
                {option}
              </button>
            ))}
          </div>
          {wrongNote && (
            <p className="worked-example-check-note" role="status">
              {WRONG_PICK_NOTE}
            </p>
          )}
        </div>
      )}

      <div className="worked-example-controls">
        <button type="button" onClick={goBack} disabled={index === 0}>
          back
        </button>
        <button type="button" onClick={advance} disabled={gated}>
          {isLast ? 'continue' : 'next'}
        </button>
      </div>
    </div>
  );
}
