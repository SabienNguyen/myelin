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
import { PredictGate } from './gap/PredictGate.js';
import { getLadder, postRun } from './gap/api.js';
import { RungEditor } from './gap/RungEditor.js';
import { WorkedExample } from './gap/WorkedExample.js';
import { InlineCompletion } from './gap/InlineCompletion.js';
import { ProximityHeader } from './gap/ProximityHeader.js';
import { ScratchPanel } from './gap/ScratchPanel.js';
import { TestResultsPanel } from './gap/TestResultsPanel.js';
import { SyntaxErrorNote } from './gap/SyntaxErrorNote.js';
import { PlanPanel } from './gap/PlanPanel.js';
import { PredictRunPanel } from './gap/PredictRunPanel.js';
import { DocsPanel } from './gap/DocsPanel.js';
import { PROBLEM_SPEC_BY_ARTIFACT } from './gap/handWrittenProse.js';
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
  const [ladderFamily, setLadderFamily] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  // Bumped by the unavailable-state's Try again, so the ladder fetch below re-runs. A down
  // sandbox is usually transient (it is a separate service), so retrying in place beats
  // making the learner restart the whole exercise.
  const [reloadKey, setReloadKey] = useState(0);
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
  // Sticky for the whole ladder walk, not just the current rung: revealing an expected value on
  // inline_completion still caps the full_body evidence, because the same understanding was
  // shortcut. Never reset — a reveal cannot be taken back.
  const revealedRef = useRef(false);
  // P2 (editor polish): Run and Submit are now distinct actions (see the full_body render branch
  // below) — `run()` only ever populates these two, never `finish()`.
  const [lastRunMs, setLastRunMs] = useState<number | undefined>(undefined);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  // Predict-before-write (backlog item 4): rung ids whose comprehension gate is done or skipped.
  const [predicted, setPredicted] = useState<Record<string, boolean>>({});
  // Expert path: an adversarial re-run of the SAME suite (see gap/api.ts's `stress`). Exploratory
  // like Run and the scratch panel — it never calls finish() and carries no evidence consequence,
  // so passing it is a private satisfaction rather than a grade. `null` = not run this session.
  const [stress, setStress] = useState<{ ok: boolean; passed: number; total: number; failing: string[]; supported: boolean } | null>(null);
  const [stressing, setStressing] = useState(false);

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
  // Gated on `loadError`: focus mode collapses the chat column to a rail across EVERY tab, so an
  // exercise that can never load used to pin the whole app there indefinitely with only "back to
  // tutor" as an exit. An unloadable exercise releases focus instead of holding the UI hostage.
  useEffect(() => {
    if (loadError) { panelBus.setFocusMode(false); return undefined; }
    panelBus.setFocusMode(true);
    return () => panelBus.setFocusMode(false);
  }, [loadError]);

  useEffect(() => {
    let cancelled = false;
    getLadder(args.pattern)
      .then((payload) => {
        if (cancelled) return;
        setRungs(payload.rungs);
        setMined(payload.mined);
        setLadderPattern(payload.ladder?.pattern);
        setLadderFamily((payload as any).family);
      })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, [reloadKey]);

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
  // Keyed by the rung's artifactId (not args.pattern) so a mined artifact without a
  // hand-written spec simply gets none rather than borrowing the built-in ladder's.
  const problemSpec = PROBLEM_SPEC_BY_ARTIFACT[currentRung?.artifactId ?? ''];

  const finish = useCallback((
    completed: boolean, rungReached: TemplateKind, testsPassed: number, testsTotal: number, wroteCode: boolean,
    extra: { unavailable?: boolean; failingTests?: string[] } = {},
  ) => {
    if (completedRef.current) return; // one result per block — guards a stray double-fire (e.g. a
    completedRef.current = true;       // pass event racing a "stop here" click).
    // revealedExpected rides on the result so server/grading.ts can apply the reveal ceiling. A ref,
    // not state: it must not re-render the editor mid-run, and `finish` must read the value at call
    // time rather than close over a stale one.
    addResult({
      completed, rungReached, testsPassed, testsTotal, wroteCode,
      ...(revealedRef.current ? { revealedExpected: true } : {}),
      ...extra,
    });
  }, [addResult]);

  // WHICH cases failed, not just how many. Case names are requirement descriptions ("single event
  // split across two chunks"), so the failing set is a diagnosis — the difference between
  // "3/5 passed" and "passes whole-chunk cases, fails every split-boundary one" is the difference
  // between a score and a misconception the tutor can name and record.
  const failingNames = (rows: { name: string; pass: boolean }[]) =>
    rows.filter((r) => !r.pass).map((r) => r.name);

  function advanceOrFinish(): void {
    if (stepIndex + 1 < sequence.length) {
      setStepIndex((i) => i + 1);
    } else {
      finish(true, template, results.filter((r) => r.pass).length, results.length, false,
        { failingTests: failingNames(results) });
    }
  }

  function stopHere(): void {
    finish(false, template, results.filter((r) => r.pass).length, results.length, false,
      { failingTests: failingNames(results) });
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
    finish(true, 'full_body', testsPassed, results.length, wroteCode,
      { failingTests: failingNames(results) });
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

  // Unloadable exercise. This used to render as one bare line of unstyled body text —
  // `could not load the exercise: GET /api/gap/ladder failed: 502` — outside the block card every
  // other block uses, leaking an HTTP method, path and status at a learner, with no way forward. A
  // block that can never produce a result also PAUSES the whole conversation, so an escape hatch is
  // not optional; `unavailable` makes that escape record no evidence rather than 'struggled'.
  // TWO different failures, deliberately not merged: a fetch that failed means the sandbox is down,
  // whereas a ladder that loaded fine but has no matching rung means this pattern simply has no
  // exercise authored for it. Telling a learner "the sandbox isn't responding" when it answered
  // perfectly well would be a plain lie, and sends anyone debugging in the wrong direction.
  const failure: { detail: string; offline: boolean } | null = loadError
    ? { detail: loadError, offline: true }
    : (rungs && !currentRung
      ? { detail: `ladder loaded, but it has no ${template} step for "${args.pattern}"`, offline: false }
      : null);
  if (failure) {
    return (
      <div className="block code-exercise-unavailable">
        <p className="cxu-headline">
          {failure.offline ? 'This exercise can’t start right now.' : 'This exercise isn’t available yet.'}
        </p>
        <p className="cxu-body">
          {failure.offline
            ? 'The coding sandbox that runs and marks your code isn’t responding, so there’s nothing '
              + 'to practise against yet. Nothing has been recorded against you.'
            : `No coding exercise has been written for “${args.pattern}” yet, so there is nothing to `
              + 'practise here. Nothing has been recorded against you.'}
        </p>
        <div className="cxu-actions">
          {/* Retry is offered only for an offline sandbox. Re-fetching an intact ladder that simply
              has no exercise for this pattern would return the identical answer every time. */}
          {failure.offline && (
            <button type="button" onClick={() => { setLoadError(undefined); setRungs(null); setReloadKey((k) => k + 1); }}>
              Try again
            </button>
          )}
          <button
            type="button"
            className="ghost-btn"
            onClick={() => finish(false, template, 0, 0, false, { unavailable: true })}
          >
            Skip this exercise
          </button>
        </div>
        {/* Kept, but folded away: the endpoint and status are what someone debugging needs and
            exactly what a learner should not be shown first. */}
        <details className="cxu-detail">
          <summary>technical detail</summary>
          <code>{failure.detail}</code>
        </details>
      </div>
    );
  }
  // Both conditions in one guard so `currentRung` narrows to non-null below. The `!currentRung` half
  // is unreachable in practice — `failure` above already returned for a resolved-but-empty ladder —
  // but stating it is cheaper than a non-null assertion at each of the three use sites.
  if (!rungs || !currentRung) {
    return <p className="code-exercise-loading">loading exercise…</p>;
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
        <p>
          {ladderFamily === 'manifest' && template === 'full_body'
            ? 'write the YAML manifest the task describes. checks run automatically as you type, '
              + 'or press run (ctrl/cmd+enter) any time — nothing is graded until you press submit.'
            : ladderFamily === 'exec' && template === 'full_body'
              ? 'write the whole program — it is run once per test case with that case\'s stdin '
                + 'and arguments. tests run automatically as you type, or press run (ctrl/cmd+enter) '
                + 'any time — nothing is graded until you press submit.'
              : TASK_BRIEF[template]}
        </p>
        {/* Fuller problem statement (statement + constraints + a spec example) for the rungs where
            the learner is actually writing code. worked_example is a read-only sibling walk, so a
            spec for the target artifact would only be noise there. Absent artifact -> renders
            nothing, same graceful-degradation shape as the rest of the hand-written prose maps. */}
        {template !== 'worked_example' && problemSpec && (
          <div className="ide-problem-spec">
            <p className="ide-spec-statement">{problemSpec.statement}</p>
            <p className="ide-spec-heading">constraints</p>
            <ul className="ide-spec-constraints">
              {problemSpec.constraints.map((c) => <li key={c}>{c}</li>)}
            </ul>
            {problemSpec.examples.length > 0 && (
              <>
                <p className="ide-spec-heading">example</p>
                {problemSpec.examples.map((ex) => (
                  <dl className="ide-spec-example" key={ex.input}>
                    <dt>input</dt>
                    <dd><code>{ex.input}</code></dd>
                    <dt>yields</dt>
                    <dd><code>{ex.output}</code></dd>
                  </dl>
                ))}
              </>
            )}
          </div>
        )}
        {template === 'full_body' && siblingRung && (
          <details className="ide-sibling-link">
            <summary>see the worked example ({siblingRung.artifactId})</summary>
            <pre>{(siblingRung.prose.moves ?? []).map((m) => m.code).join('')}</pre>
          </details>
        )}
      </div>
    ),
  };

  // Custom-input scratch run. Editable rungs only — worked_example is read-only and has no code of
  // the learner's to run. Carries no evidence consequence (see ScratchPanel's top comment).
  const scratchTab: BriefTab | null = template === 'worked_example' ? null : {
    key: 'scratch',
    label: 'Input',
    active: false,
    content: <ScratchPanel rungId={currentRung.id} code={code} family={ladderFamily} />,
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
        tabs={[taskTab, ...(scratchTab ? [scratchTab] : []), helpTab, ...offerTabs]}
      >
        {template === 'worked_example' && (
          <WorkedExample rung={currentRung} onContinue={advanceOrFinish} />
        )}

        {/* The comprehension gate: production rungs with predictable cases open with "what does
            the finished function yield?" — server-graded, no evidence, skippable. The rung's
            editor renders only once the gate is cleared. */}
        {(template === 'inline_completion' || template === 'full_body')
          && (currentRung as any).predict?.length > 0 && !predicted[currentRung.id] && (
          <PredictGate
            rungId={currentRung.id}
            caseName={(currentRung as any).predict[0].caseName}
            inputPreview={(currentRung as any).predict[0].inputPreview}
            family={ladderFamily}
            onDone={() => setPredicted((p) => ({ ...p, [currentRung.id]: true }))}
          />
        )}

        {template === 'inline_completion'
          && !((currentRung as any).predict?.length > 0 && !predicted[currentRung.id]) && (
          <InlineCompletion rung={currentRung} onContinue={advanceOrFinish} detector={inlineDetector} />
        )}

        {template === 'full_body'
          && !((currentRung as any).predict?.length > 0 && !predicted[currentRung.id]) && (
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
                : <TestResultsPanel results={results} onReveal={() => { revealedRef.current = true; }} />}
            </div>
          </div>
        )}
      </FocusLayout>

      <div className="code-exercise-controls">
        {/* Offered only once the real suite is green: "your code works — does it still work when the
            reads are hostile?" is the question an expert has next, and asking it before they pass
            would just be noise. */}
        {template === 'full_body' && results.length > 0 && results.every((r) => r.pass) && (
          <button
            type="button"
            className="ghost-btn code-exercise-stress"
            disabled={stressing}
            onClick={async () => {
              setStressing(true);
              try {
                const res = await postRun(currentRung.id, code, { mode: 'file', stress: true });
                setStress({
                  ok: res.pass,
                  passed: res.results.filter((r) => r.pass).length,
                  total: res.results.length,
                  failing: res.results.filter((r) => !r.pass).map((r) => r.name).slice(0, 3),
                  supported: res.stressed === true,
                });
              } catch {
                setStress({ ok: false, passed: 0, total: 0, failing: [], supported: false });
              } finally {
                setStressing(false);
              }
            }}
          >
            {stressing ? 'stressing…' : 'stress test'}
          </button>
        )}
        {/* Expert path. The ladder walks worked_example -> inline_completion -> full_body, and until
            now only the TUTOR chose the entry rung: someone who already knows the pattern had to sit
            through a read-only worked example of a SIBLING artifact before being allowed to type.
            No evidence consequence — skipping removes scaffolding, not rigour: full_body is still
            graded by the same real suite, and wroteCode is still an exact diff against the pristine
            scaffold, so applied-correctly is if anything harder to earn this way. */}
        {sequence.length > 1 && stepIndex < sequence.length - 1 && (
          <button
            type="button"
            className="ghost-btn code-exercise-skip"
            onClick={() => setStepIndex(sequence.length - 1)}
          >
            skip ahead — let me just write it
          </button>
        )}
        <button type="button" className="code-exercise-stop" onClick={stopHere}>
          stop here
        </button>
      </div>

      {stress && (
        <p className={`code-exercise-stress-result${stress.ok && stress.supported ? ' ok' : ''}`} role="status">
          {!stress.supported
            // Do not report "survived" for a run that never happened — an older sidecar ignores
            // `stress` and grades normally, which would otherwise read as a pass.
            ? 'this sandbox doesn’t support stress runs, so nothing was stressed.'
            : stress.ok
              ? `survived all ${stress.total} adversarial re-chunkings — 1-byte reads, single-read bodies, empty reads.`
              : `${stress.passed}/${stress.total} under adversarial reads. Still breaking: ${stress.failing.join('; ')}`}
        </p>
      )}
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
        {/* Only when a run actually happened. An exercise abandoned before its first run has no
            counts, and the unguarded version printed a bare "/ tests" — a fraction with no numbers
            in it, which reads as a rendering fault rather than as "you never ran it". */}
        {r.testsTotal ? (
          <p>{r.testsPassed ?? 0}/{r.testsTotal} tests{r.wroteCode ? ', own code' : ''}</p>
        ) : (
          <p>No test run{r.wroteCode ? ', own code written' : ''}.</p>
        )}
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
