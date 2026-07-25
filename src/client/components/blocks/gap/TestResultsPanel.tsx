// Ported (with one import adaptation — `TestResult` from ./types.js) from
// ~/Dev/personal/the-gap apps/web/src/TestResultsPanel.tsx (READ ONLY there). Logic unchanged
// EXCEPT for the expected-vs-actual reveal below, which is harness-local.
//
// The upstream rule was: "list of test names with pass/fail state — names only, no assertion diffs
// (diffs can leak expected values)." That rule protected the same invariant as the sidecar's
// reference_answer stripping: if a learner can read expected output per case, they can converge on a
// green suite without understanding the pattern, and `applied-correctly` evidence stops meaning
// anything.
//
// Requested CodeSignal-style case detail is therefore built as an OPT-IN REVEAL rather than an
// always-on diff, on three conditions that together keep the evidence model intact:
//   1. It only appears when the sidecar actually sends `expected`/`actual` (the real the-gap does
//      not today — see types.ts), and only for FAILING tests. A passing test has nothing to debug.
//   2. Revealing is a deliberate click per test, never ambient.
//   3. The first reveal calls onReveal(), which CodeExercise records as `revealedExpected` on the
//      block result, and server/grading.ts caps that run's evidence at 'exposed'. The affordance is
//      available; it just cannot mint mastery.

import { useState } from 'react';
import type { TestResult } from './types.js';

export interface TestResultsPanelProps {
  results: TestResult[];
  /** Called on the learner's FIRST expected-value reveal. Wired to the reveal ceiling in
   *  server/grading.ts via CodeExercise's `revealedExpected`. Optional so existing callers and
   *  tests that don't care about the ceiling keep working unchanged. */
  onReveal?: () => void;
}

export function TestResultsPanel({ results, onReveal }: TestResultsPanelProps) {
  // RungEditor v2 (docs/superpowers/plans/2026-07-21-coding-stage.md): "the gap" no longer names
  // a distinct region of the editor — the whole file is editable.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  function reveal(name: string) {
    if (revealed.size === 0) onReveal?.(); // fires once, on the first reveal of the run
    setRevealed((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));
  }

  if (results.length === 0) {
    return <p className="test-results-empty">no results yet — start typing</p>;
  }

  return (
    <ul className="test-results-panel">
      {results.map((result) => {
        // Detail is offered only for a FAILING test that the sidecar actually described.
        const hasDetail = !result.pass && (result.expected !== undefined || result.actual !== undefined);
        const isOpen = revealed.has(result.name);
        return (
          <li key={result.name} className={result.pass ? 'test-result test-result--pass' : 'test-result test-result--fail'}>
            <span className="test-result-status" aria-hidden="true">
              {result.pass ? 'PASS' : 'FAIL'}
            </span>
            <span className="test-result-name">{result.name}</span>
            {hasDetail && !isOpen && (
              <button
                type="button"
                className="ghost-btn test-result-reveal"
                onClick={() => reveal(result.name)}
              >
                reveal expected — caps this run at exposed
              </button>
            )}
            {hasDetail && isOpen && (
              <dl className="test-result-detail">
                <dt>expected</dt>
                <dd><code>{result.expected ?? '—'}</code></dd>
                <dt>actual</dt>
                <dd><code>{result.actual ?? '—'}</code></dd>
              </dl>
            )}
          </li>
        );
      })}
    </ul>
  );
}
