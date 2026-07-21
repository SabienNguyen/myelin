// The Gap inside the Stage (docs/superpowers/plans/2026-07-20-gap-integration.md, task I2).
// Presents a code_exercise block: a rung='ladder' walks the gap's own sequence — worked_example
// (sibling, read-only) -> inline_completion (target, single-line gap) -> full_body (target, whole
// function gap, real tests) — enforcing that order exactly like the gap's own apps/web/src/App.tsx
// (ported into ./gap/*). A single-rung value ('worked_example' | 'inline_completion' | 'full_body')
// renders just that one screen. addResult() fires the code_exercise contract result
// ({completed, rungReached, testsPassed, testsTotal, wroteCode}) either when the sequence
// completes naturally, or when the learner abandons early via the explicit "stop here" affordance
// (completed:false, rungReached set to whatever step they were on).

import { useCallback, useEffect, useRef, useState } from 'react';
import { CodeIcon as Code, CheckIcon as Check } from '@phosphor-icons/react';
import { panelBus } from '../../lib/panelBus.js';
import { StagePortal } from '../StagePortal.js';
import { getLadder, postRun } from './gap/api.js';
import { RungEditor } from './gap/RungEditor.js';
import { WorkedExample } from './gap/WorkedExample.js';
import { InlineCompletion } from './gap/InlineCompletion.js';
import { ProximityHeader } from './gap/ProximityHeader.js';
import { TestResultsPanel } from './gap/TestResultsPanel.js';
import { SyntaxErrorNote } from './gap/SyntaxErrorNote.js';
import { OfferPanel } from './gap/OfferPanel.js';
import { useDebouncedRun } from './gap/hooks/useDebouncedRun.js';
import { useDetectorState } from './gap/hooks/useDetectorState.js';
import type { Rung, TemplateKind, TestResult } from './gap/types.js';

const STEP_LABELS: Record<TemplateKind, string> = {
  worked_example: 'worked example',
  inline_completion: 'inline completion',
  full_body: 'full body',
};

export function CodeExerciseInner({ args, addResult, Editor = RungEditor }: {
  args: any; addResult: (r: any) => void;
  /** Injectable seam for tests (mirrors MathScratchpad's `MathInput` prop) — jsdom mounts real CM6
   *  fine (verified), but simulating actual keystrokes into a contentEditable CM6 view is not
   *  worth the fragility; tests substitute a plain textarea here for the full_body gap. */
  Editor?: typeof RungEditor;
}) {
  const [rungs, setRungs] = useState<Rung[] | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [stepIndex, setStepIndex] = useState(0);

  // full_body-only run state — worked_example and inline_completion manage their own internally.
  const [code, setCode] = useState('');
  const [hasRun, setHasRun] = useState(false);
  const [results, setResults] = useState<TestResult[]>([]);
  const [syntaxError, setSyntaxError] = useState<string | undefined>(undefined);
  const [planText, setPlanText] = useState('');
  const completedRef = useRef(false);

  const detector = useDetectorState();

  useEffect(() => {
    let cancelled = false;
    getLadder()
      .then((payload) => { if (!cancelled) setRungs(payload.rungs); })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, []);

  const sequence: TemplateKind[] = args.rung === 'ladder'
    ? ['worked_example', 'inline_completion', 'full_body']
    : [args.rung as TemplateKind];

  const template = sequence[stepIndex];
  const currentRung = rungs?.find((r) => r.template === template) ?? null;

  const finish = useCallback((
    completed: boolean, rungReached: TemplateKind, testsPassed: number, testsTotal: number, wroteCode: boolean,
  ) => {
    if (completedRef.current) return; // one result per block — guards a stray double-fire (e.g. a
    completedRef.current = true;       // pass event racing a "stop here" click).
    addResult({ completed, rungReached, testsPassed, testsTotal, wroteCode });
  }, [addResult]);

  function advanceOrFinish(): void {
    if (stepIndex + 1 < sequence.length) {
      setStepIndex((i) => i + 1);
    } else {
      finish(true, template, results.filter((r) => r.pass).length, results.length, false);
    }
  }

  function stopHere(): void {
    finish(false, template, results.filter((r) => r.pass).length, results.length, false);
  }

  const run = useCallback(async (currentCode: string) => {
    if (!currentRung || currentRung.template !== 'full_body') return;
    const response = await postRun(currentRung.id, currentCode);
    setHasRun(true);
    setResults(response.results);
    setSyntaxError(response.syntaxError);
    detector.dispatch({
      type: 'run-result',
      at: Date.now(),
      failingSet: response.results.filter((r) => !r.pass).map((r) => r.name),
      syntaxError: response.syntaxError !== undefined,
    });
    if (response.pass) {
      const wroteCode = currentCode.trim() !== '';
      const testsPassed = response.results.filter((r) => r.pass).length;
      finish(true, 'full_body', testsPassed, response.results.length, wroteCode);
    }
  }, [currentRung, detector, finish]);

  useDebouncedRun(code, run);

  const onFullBodyGapChange = useCallback((nextCode: string) => {
    setCode(nextCode);
    const now = Date.now();
    detector.dispatch({ type: 'keystroke', at: now });
    detector.dispatch({ type: 'gap-empty-check', at: now, gapEmpty: nextCode.trim() === '' });
  }, [detector]);

  if (loadError) {
    return <p className="code-exercise-error">could not load the exercise: {loadError}</p>;
  }
  if (!rungs) {
    return <p className="code-exercise-loading">loading exercise…</p>;
  }
  if (!currentRung) {
    return <p className="code-exercise-error">no {template} rung available for pattern &quot;{args.pattern}&quot;.</p>;
  }

  return (
    <div className="block code-exercise">
      {sequence.length > 1 && (
        <nav className="ladder-steps" aria-label="ladder progress">
          {sequence.map((t, i) => (
            <span
              key={t}
              className={i === stepIndex ? 'ladder-step ladder-step--current' : 'ladder-step'}
              aria-current={i === stepIndex ? 'step' : undefined}
            >
              {i + 1}. {STEP_LABELS[t]}
            </span>
          ))}
        </nav>
      )}

      {template === 'worked_example' && (
        <WorkedExample key={currentRung.id} rung={currentRung} onContinue={advanceOrFinish} />
      )}

      {template === 'inline_completion' && (
        <InlineCompletion key={currentRung.id} rung={currentRung} onContinue={advanceOrFinish} />
      )}

      {template === 'full_body' && (
        <div className="code-exercise-columns">
          <div className="code-exercise-main">
            <ProximityHeader results={results} hasRun={hasRun} />
            <Editor
              visiblePre={currentRung.visible_pre}
              visiblePost={currentRung.visible_post}
              onGapChange={onFullBodyGapChange}
            />
            {syntaxError !== undefined && <SyntaxErrorNote message={syntaxError} />}
            <TestResultsPanel results={results} />
          </div>
          <OfferPanel
            offers={detector.offers}
            artifactId={currentRung.artifactId}
            rungId={currentRung.id}
            code={code}
            planText={planText}
            onPlanTextChange={setPlanText}
            onDismissPlan={() => detector.dismissOffer('plan')}
            onDismissPredictRun={() => detector.dismissOffer('predictRun')}
            onDismissDocs={() => detector.dismissOffer('docs')}
          />
        </div>
      )}

      <div className="code-exercise-controls">
        <button type="button" className="code-exercise-stop" onClick={stopHere}>
          stop here
        </button>
      </div>
    </div>
  );
}

export function CodeExercise(props: { args: any; result: any; addResult: (r: any) => void }) {
  if (props.result) {
    const r = props.result;
    return (
      <div className="block code-exercise done">
        <span className="graded-tag"><Check size={12} weight="bold" /> graded</span>
        <p>{props.args.pattern} — {r.rungReached}{r.completed ? '' : ' (stopped early)'}</p>
        <p>{r.testsPassed}/{r.testsTotal} tests{r.wroteCode ? ', own code' : ''}</p>
        {r.grading && <em className={`verdict ${r.grading.verdict}`}> — {r.grading.detail}</em>}
      </div>
    );
  }
  return (
    <>
      <button type="button" className="block chip" onClick={() => panelBus.setTab('stage')}>
        <Code size={15} weight="duotone" /> Code exercise waiting on the stage
      </button>
      <StagePortal><CodeExerciseInner args={props.args} addResult={props.addResult} /></StagePortal>
    </>
  );
}
