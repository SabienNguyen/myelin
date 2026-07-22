// The Gap inside the Stage (docs/superpowers/plans/2026-07-20-gap-integration.md, task I2).
// Presents a code_exercise block: a rung='ladder' walks the gap's own sequence — worked_example
// (sibling, read-only) -> inline_completion (target, single-line gap) -> full_body (target, whole
// function gap, real tests) — enforcing that order exactly like the gap's own apps/web/src/App.tsx
// (ported into ./gap/*). A single-rung value ('worked_example' | 'inline_completion' | 'full_body')
// renders just that one screen. addResult() fires the code_exercise contract result
// ({completed, rungReached, testsPassed, testsTotal, wroteCode}) either when the sequence
// completes naturally, or when the learner abandons early via the explicit "stop here" affordance
// (completed:false, rungReached set to whatever step they were on).
//
// P1 (docs/superpowers/plans/2026-07-20-gap-integration.md): IDE focus mode. All three rungs now
// render inside FocusLayout.tsx's shared left-brief/right-content shell instead of each having
// their own ad hoc layout, and the ambient offers (plan/predict/docs) dock as brief-panel tabs
// (see FocusLayout's top comment) instead of a floating aside. Focus mode ITSELF — collapsing the
// chat column to a rail, widening the Stage — is owned by App.tsx via a panelBus event; this file
// only fires that event (mount-with-no-result -> on, unmount -> off, via a cleanup effect so a
// page reload or a "stop here"/pass-driven unmount both correctly clear it — see panelBus.ts's
// `focusMode` event doc). CodeExerciseInner never touches the DOM outside the Stage itself.
//
// P2 (editor polish): full_body's Run and Submit are now explicit, separate actions. Run (button,
// or Ctrl/Cmd+Enter inside the editor — RungEditor.tsx) just executes tests and shows
// results/console; it NEVER calls finish() no matter how green the run is. Submit is the one and
// only path that completes the block for full_body — always clickable, but if the latest run
// isn't all-passing (or there's been no run yet) it opens an inline confirm first rather than
// completing silently. The learner controls when the block actually commits.
//
// RungEditor v2 (docs/superpowers/plans/2026-07-21-coding-stage.md, "whole-file IDE"): full_body
// (and inline_completion — see InlineCompletion.tsx) now load and grade the rung's WHOLE file,
// not a spliced-in gap fragment. `code` here is that whole doc; `initialScaffold` (resolveScaffold
// of the current rung) is the PRISTINE starting doc it's diffed against for wroteCode — an exact
// string compare, not a trim/empty check, since the doc is never actually empty anymore (it always
// starts pre-loaded with the scaffold's visible_pre/marker/visible_post). Run posts
// `{ mode: 'file', code }` to the sidecar accordingly.

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
import { PlanPanel } from './gap/PlanPanel.js';
import { PredictRunPanel } from './gap/PredictRunPanel.js';
import { DocsPanel } from './gap/DocsPanel.js';
import { HelpPanel, type HelpExchange } from './gap/HelpPanel.js';
import { FocusLayout, type BriefTab, type MinedProvenance } from './gap/FocusLayout.js';
import { useDebouncedRun } from './gap/hooks/useDebouncedRun.js';
import { useDetectorState } from './gap/hooks/useDetectorState.js';
import { gapDraftKey, clearDraft } from './gap/draftStorage.js';
import { resolveScaffold } from './gap/scaffold.js';
import type { MinedEntry, Rung, TemplateKind, TestResult } from './gap/types.js';

const STEP_LABELS: Record<TemplateKind, string> = {
  worked_example: 'worked example',
  inline_completion: 'inline completion',
  full_body: 'full body',
};

// Task-tab brief copy, tone-clean (no praise/emoji — spec invariant): what this screen is for,
// not encouragement about it.
const TASK_BRIEF: Record<TemplateKind, string> = {
  worked_example: 'watch the pattern get built move by move — read-only, nothing graded here.',
  // RungEditor v2: no more single fenced-off gap — a comment in the file marks the task, the rest
  // of the file is editable too (docs/superpowers/plans/2026-07-21-coding-stage.md).
  inline_completion: 'a comment below marks what to fill in — the rest of the file is editable '
    + 'too. tests run automatically as you type.',
  // P2 (editor polish): Run and Submit are now separate — see the buttons below the editor.
  full_body: 'write the whole function body. tests run automatically as you type, or press run '
    + '(ctrl/cmd+enter) any time — nothing is graded until you press submit.',
};

export function CodeExerciseInner({ args, addResult, Editor = RungEditor }: {
  args: any; addResult: (r: any) => void;
  /** Injectable seam for tests (mirrors MathScratchpad's `MathInput` prop) — jsdom mounts real CM6
   *  fine (verified), but simulating actual keystrokes into a contentEditable CM6 view is not
   *  worth the fragility; tests substitute a plain textarea here for the full_body gap. */
  Editor?: typeof RungEditor;
}) {
  const [rungs, setRungs] = useState<Rung[] | null>(null);
  // Final integration (docs/superpowers/plans/2026-07-21-coding-stage.md B2c): the ladder
  // payload's `mined` array and the built-in ladder's own advertised pattern id — both loaded
  // alongside `rungs` (same fetch, same effect below) and used only for rung resolution.
  const [mined, setMined] = useState<MinedEntry[] | undefined>(undefined);
  const [ladderPattern, setLadderPattern] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [stepIndex, setStepIndex] = useState(0);

  // full_body-only run state — worked_example and inline_completion manage their own internally.
  const [code, setCode] = useState('');
  const [hasRun, setHasRun] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<TestResult[]>([]);
  const [syntaxError, setSyntaxError] = useState<string | undefined>(undefined);
  const [planText, setPlanText] = useState('');
  // Track A (docs/superpowers/plans/2026-07-21-coding-stage.md): the Help tab's transcript for
  // THIS exercise (spans the whole ladder walk, not just the current rung — mirrors planText's
  // caller-owned lifting reasoning above) — session-local, never persisted to the lesson thread.
  const [helpExchanges, setHelpExchanges] = useState<HelpExchange[]>([]);
  const completedRef = useRef(false);
  // P2 (editor polish): Run and Submit are now distinct actions (see the full_body render branch
  // below) — `run()` only ever populates these two, never `finish()`.
  const [lastRunMs, setLastRunMs] = useState<number | undefined>(undefined);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  // Two independent detector instances: full_body gets the full plan/predict/docs set (unchanged
  // from I2); inline_completion gets docs only (its own scoping rationale — see
  // InlineCompletion.tsx's top comment). worked_example has no offers at all. Both instances exist
  // for the component's whole lifetime rather than per-step (MVP: one ladder, one pass through) —
  // a stray idle tick while the other screen is active is harmless.
  const detector = useDetectorState();
  const inlineDetector = useDetectorState();

  // P1: focus mode. Fires exactly once on mount (this component only ever mounts when there's no
  // result yet — see CodeExercise() below) and clears via cleanup, which covers BOTH natural exits
  // (a result arrives -> the parent stops rendering this component -> unmount) and abnormal ones
  // (thread switch, reload).
  useEffect(() => {
    panelBus.setFocusMode(true);
    return () => panelBus.setFocusMode(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getLadder()
      .then((payload) => {
        if (cancelled) return;
        setRungs(payload.rungs);
        setMined(payload.mined);
        setLadderPattern(payload.ladder?.pattern);
      })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, []);

  // Final integration (docs/superpowers/plans/2026-07-21-coding-stage.md B2c, "the KNOWN GAP"):
  // pattern resolution. The single MVP built-in ladder always advertises its own pattern id via
  // payload.ladder.pattern — args.pattern matching THAT (not "does some rung happen to have this
  // template", which would silently match any of the 3 valid template values against the wrong
  // artifact) is what makes a request "built-in". Anything else is looked up by rung.artifactId
  // in payload.mined instead: a mined pattern has exactly ONE rung (whatever template the miner
  // selected), so it's forced single-rung here — args.rung's requested step is ignored entirely
  // for a mined match, since there is no ladder to walk. A pattern matching neither falls through
  // to the existing "no rung available" error below, unchanged.
  const isBuiltInPattern = ladderPattern !== undefined && args.pattern === ladderPattern;
  const minedEntry: MinedEntry | null = !isBuiltInPattern
    ? (mined?.find((m) => m.rung.artifactId === args.pattern) ?? null)
    : null;

  const sequence: TemplateKind[] = minedEntry
    ? [minedEntry.rung.template]
    : args.rung === 'ladder'
      ? ['worked_example', 'inline_completion', 'full_body']
      : [args.rung as TemplateKind];

  const template = sequence[stepIndex];
  const currentRung = minedEntry
    ? minedEntry.rung
    : (isBuiltInPattern ? (rungs?.find((r) => r.template === template) ?? null) : null);
  // I2's ladder response carries a sibling worked-example artifact even in single-rung full_body
  // mode (getLadder() always returns the whole rung set) — used for the Task tab's sibling link.
  // Mined artifacts have no sibling (the miner never pairs one) — the Task tab's `siblingRung &&`
  // guard already degrades to omitting that link, no separate branch needed.
  const siblingRung = minedEntry ? null : (rungs?.find((r) => r.template === 'worked_example') ?? null);

  const minedProvenance: MinedProvenance | undefined = minedEntry
    ? {
      family: minedEntry.meta.family,
      source: `${minedEntry.meta.source.repo} — ${minedEntry.meta.source.path}`,
      commit: minedEntry.meta.source.commit,
    }
    : undefined;
  const patternTitle = minedEntry ? minedEntry.meta.title : args.pattern;

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

  // P2 (editor polish): Run executes the tests and shows results/console — it never completes the
  // block or records evidence, no matter how green (that's Submit's job, below). This fires both
  // from useDebouncedRun (auto-run-as-you-type, unchanged from before) and from an explicit
  // trigger (the Run button, Ctrl/Cmd+Enter inside the editor).
  const run = useCallback(async (currentCode: string) => {
    if (!currentRung || currentRung.template !== 'full_body') return;
    setRunning(true);
    setConfirmSubmit(false); // a fresh run supersedes any pending "submit anyway?" confirm.
    const startedAt = performance.now();
    try {
      const response = await postRun(currentRung.id, currentCode, { mode: 'file' });
      setLastRunMs(Math.round(performance.now() - startedAt));
      setHasRun(true);
      setResults(response.results);
      setSyntaxError(response.syntaxError);
      detector.dispatch({
        type: 'run-result',
        at: Date.now(),
        failingSet: response.results.filter((r) => !r.pass).map((r) => r.name),
        syntaxError: response.syntaxError !== undefined,
      });
    } finally {
      setRunning(false);
    }
  }, [currentRung, detector]);

  useDebouncedRun(code, run);

  const fullBodyDraftKey = currentRung ? gapDraftKey(currentRung.artifactId, currentRung.template) : undefined;
  // RungEditor v2: the PRISTINE starting doc (never draft-adjusted) — the one wroteCode diffs
  // against below. '' when currentRung isn't resolved yet is never actually read (doSubmit only
  // ever fires from the full_body render branch, which doesn't render until currentRung exists)
  // but keeps this a plain string rather than a conditional type for every caller downstream.
  const initialScaffold = currentRung ? resolveScaffold(currentRung) : '';

  // Submit is the explicit, learner-controlled completion gesture — Run never fires `finish()`.
  // wroteCode is (re)computed here off the CURRENT whole-doc contents rather than whatever code
  // the last run happened to execute — the moment it's evaluated is "the instant the learner
  // submits", not "the instant a run happened to pass" (P2, unchanged rationale). The definition
  // itself changed with RungEditor v2 though: an exact string compare against `initialScaffold`
  // (the ORIGINAL scaffold, not the draft) rather than a trim/empty check — the doc is never
  // actually empty anymore, it always starts pre-loaded with the scaffold's own text.
  const doSubmit = useCallback(() => {
    setConfirmSubmit(false);
    const testsPassed = results.filter((r) => r.pass).length;
    const wroteCode = code !== initialScaffold;
    finish(true, 'full_body', testsPassed, results.length, wroteCode);
    if (fullBodyDraftKey) clearDraft(fullBodyDraftKey);
  }, [results, code, finish, fullBodyDraftKey, initialScaffold]);

  // Reasonable enabling rule (spec): Submit is always clickable. If the latest run has failing
  // tests — or there's been no run at all yet — clicking it opens an inline confirm instead of
  // completing immediately; a second click ("submit anyway") commits.
  const allPassing = hasRun && results.length > 0 && results.every((r) => r.pass);
  function onSubmitClick(): void {
    if (allPassing) { doSubmit(); return; }
    setConfirmSubmit(true);
  }

  // RungEditor v2: fires once at mount (RungEditor reports its resolved starting doc — draft-
  // restored or scaffold — immediately, not just on the learner's first real edit — see that
  // file's top comment) and on every subsequent edit alike. gapEmpty now means "still exactly the
  // starting scaffold" rather than a literal empty-string check, for the same reason wroteCode's
  // definition changed above.
  const onFullBodyDocChange = useCallback((nextCode: string) => {
    setCode(nextCode);
    const now = Date.now();
    detector.dispatch({ type: 'keystroke', at: now });
    detector.dispatch({ type: 'gap-empty-check', at: now, gapEmpty: nextCode === initialScaffold });
  }, [detector, initialScaffold]);

  if (loadError) {
    return <p className="code-exercise-error">could not load the exercise: {loadError}</p>;
  }
  if (!rungs) {
    return <p className="code-exercise-loading">loading exercise…</p>;
  }
  if (!currentRung) {
    return <p className="code-exercise-error">no {template} rung available for pattern &quot;{args.pattern}&quot;.</p>;
  }

  const ladder = sequence.length > 1
    ? { steps: sequence.map((t, i) => `${i + 1}. ${STEP_LABELS[t]}`), stepIndex }
    : undefined;

  const taskTab: BriefTab = {
    key: 'task',
    label: 'Task',
    active: false,
    content: (
      <div className="ide-task-brief">
        <p>{TASK_BRIEF[template]}</p>
        {template === 'full_body' && siblingRung && (
          <details className="ide-sibling-link">
            <summary>see the worked example ({siblingRung.artifactId})</summary>
            <pre>{(siblingRung.prose.moves ?? []).map((m) => m.code).join('')}</pre>
          </details>
        )}
      </div>
    ),
  };

  // Track A: always present, alongside the offer tabs (not gated by a detector) — draft/failures
  // are threaded straight from this component's own state (spec: "no new global state").
  const helpTab: BriefTab = {
    key: 'help',
    label: 'Help',
    active: false,
    content: (
      <HelpPanel
        pattern={args.pattern}
        rung={template}
        draft={code}
        failures={results.filter((r) => !r.pass).map((r) => r.name)}
        exchanges={helpExchanges}
        onExchangeAdded={(exchange) => setHelpExchanges((prev) => [...prev, exchange])}
      />
    ),
  };

  const offerTabs: BriefTab[] = [];
  if (template === 'full_body') {
    if (detector.offers.plan) {
      offerTabs.push({
        key: 'plan', label: 'Plan', active: true,
        content: <PlanPanel artifactId={currentRung.artifactId} value={planText} onChange={setPlanText} />,
        onDismiss: () => detector.dismissOffer('plan'),
      });
    }
    if (detector.offers.predictRun) {
      offerTabs.push({
        key: 'predict', label: 'Predict', active: true,
        content: <PredictRunPanel artifactId={currentRung.artifactId} rungId={currentRung.id} code={code} />,
        onDismiss: () => detector.dismissOffer('predictRun'),
      });
    }
    if (detector.offers.docs) {
      offerTabs.push({
        key: 'docs', label: 'Docs', active: true,
        content: <DocsPanel artifactId={currentRung.artifactId} />,
        onDismiss: () => detector.dismissOffer('docs'),
      });
    }
  } else if (template === 'inline_completion' && inlineDetector.offers.docs) {
    offerTabs.push({
      key: 'docs', label: 'Docs', active: true,
      content: <DocsPanel artifactId={currentRung.artifactId} />,
      onDismiss: () => inlineDetector.dismissOffer('docs'),
    });
  }

  return (
    <div className="block code-exercise">
      <FocusLayout
        key={currentRung.id}
        patternTitle={patternTitle}
        contextLine={currentRung.prose.context_line}
        ladder={ladder}
        mined={minedProvenance}
        tabs={[taskTab, helpTab, ...offerTabs]}
      >
        {template === 'worked_example' && (
          <WorkedExample rung={currentRung} onContinue={advanceOrFinish} />
        )}

        {template === 'inline_completion' && (
          <InlineCompletion rung={currentRung} onContinue={advanceOrFinish} detector={inlineDetector} />
        )}

        {template === 'full_body' && (
          <div className="ide-editor-column">
            <div className="ide-header-strip">
              <ProximityHeader results={results} hasRun={hasRun} />
              {running && <span className="ide-spinner" role="status" aria-label="running tests" />}
            </div>
            <Editor
              scaffold={initialScaffold}
              onDocChange={onFullBodyDocChange}
              draftKey={fullBodyDraftKey}
              onRunRequest={() => run(code)}
              fillHeight
            />

            <div className="ide-action-row">
              <button
                type="button"
                className="ide-btn ide-btn--run"
                onClick={() => run(code)}
                disabled={running}
              >
                {running ? 'running…' : 'run'}
              </button>
              <button type="button" className="ide-btn ide-btn--submit" onClick={onSubmitClick}>
                submit
              </button>
            </div>
            {confirmSubmit && (
              <div className="ide-submit-confirm" role="alertdialog" aria-label="confirm submit">
                <p>tests aren&apos;t passing — submit anyway?</p>
                <div className="ide-submit-confirm-actions">
                  <button type="button" className="ide-btn ide-btn--submit" onClick={doSubmit}>
                    submit anyway
                  </button>
                  <button type="button" onClick={() => setConfirmSubmit(false)}>
                    keep editing
                  </button>
                </div>
              </div>
            )}

            {/* Whole-file IDE (item 4, docs/superpowers/plans/2026-07-21-coding-stage.md): a
                syntax error means the file doesn't parse — there IS no test-results question to
                answer yet, so it replaces the results list here rather than sitting as a separate
                note elsewhere, distinct from "no results yet" (which means something else: nothing
                run at all). */}
            <div className="ide-test-console">
              <div className="ide-console-header">
                <h4 className="ide-console-title">tests</h4>
                {lastRunMs !== undefined && (
                  <span className="ide-run-timing">ran in {lastRunMs}ms</span>
                )}
              </div>
              {syntaxError !== undefined
                ? <SyntaxErrorNote message={syntaxError} />
                : <TestResultsPanel results={results} />}
            </div>
          </div>
        )}
      </FocusLayout>

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
