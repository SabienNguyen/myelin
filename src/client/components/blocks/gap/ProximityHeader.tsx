// Ported (with one import adaptation — `TestResult` from ./types.js instead of a local
// re-declaration in ProximityHeader.tsx itself) from ~/Dev/personal/the-gap
// apps/web/src/ProximityHeader.tsx (READ ONLY there). Logic unchanged.
//
// "Header proximity bar: % tests passing + a message naming what's left." Renders a horizontal
// bar, the pass fraction as text, and — when something is failing — the first-matching message
// from failureMessages.ts. No praise on all-passing ("no praise strings").

import { proximityMessage } from './failureMessages.js';
import type { TestResult } from './types.js';

export interface ProximityHeaderProps {
  results: TestResult[];
  hasRun: boolean;
}

export function ProximityHeader({ results, hasRun }: ProximityHeaderProps) {
  const total = results.length;
  const passing = results.filter((r) => r.pass).length;
  const pct = total === 0 ? 0 : Math.round((passing / total) * 100);

  const message = describeState(hasRun, results);

  return (
    <header className="proximity-header">
      <div
        className="proximity-bar-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="tests passing"
      >
        <div className="proximity-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="proximity-text">
        <span className="proximity-fraction">
          {passing}/{total} passing
        </span>
        <span className="proximity-message">{message}</span>
      </div>
    </header>
  );
}

function describeState(hasRun: boolean, results: TestResult[]): string {
  if (!hasRun || results.length === 0) return 'waiting on the first run';
  const failing = new Set(results.filter((r) => !r.pass).map((r) => r.name));
  if (failing.size === 0) return 'all tests passing';
  return proximityMessage(failing);
}
