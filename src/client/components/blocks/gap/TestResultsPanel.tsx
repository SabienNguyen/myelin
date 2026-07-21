// Ported (with one import adaptation — `TestResult` from ./types.js) from
// ~/Dev/personal/the-gap apps/web/src/TestResultsPanel.tsx (READ ONLY there). Logic unchanged.
//
// "list of test names with pass/fail state — names only, no assertion diffs (diffs can leak
// expected values)."

import type { TestResult } from './types.js';

export function TestResultsPanel({ results }: { results: TestResult[] }) {
  if (results.length === 0) {
    return <p className="test-results-empty">no results yet — start typing in the gap</p>;
  }

  return (
    <ul className="test-results-panel">
      {results.map((result) => (
        <li key={result.name} className={result.pass ? 'test-result test-result--pass' : 'test-result test-result--fail'}>
          <span className="test-result-status" aria-hidden="true">
            {result.pass ? 'PASS' : 'FAIL'}
          </span>
          <span className="test-result-name">{result.name}</span>
        </li>
      ))}
    </ul>
  );
}
