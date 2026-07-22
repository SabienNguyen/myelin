// Ported (import adaptations — ./handWrittenProse.js, ./api.js's postRun which hits
// /api/gap/run) from ~/Dev/personal/the-gap apps/web/src/PredictRunPanel.tsx (READ ONLY there).
// Logic unchanged.
//
// The 3-consecutive-identical-failing-set offer: "checklist of the rung's callbacks/branches ...
// learner checks predictions, presses 'run with tracing' -> POST /api/run with {trace: true} ...
// Panel shows predicted vs actual table, plain text." The actual column only carries a
// fired/did-not-fire verdict for items the trace harness can directly observe (item.observable);
// the null-body-guard row (an internal branch, not a callback) shows "not directly observed"
// instead.
//
// RungEditor v2 (docs/superpowers/plans/2026-07-21-coding-stage.md): `code` (lifted from
// CodeExercise.tsx's own `code` state) is now the learner's WHOLE current file, not a gap
// fragment — `mode: 'file'` on the trace request below is required so the sidecar grades/traces
// it as such instead of trying to splice it into visible_pre/visible_post.

import { useState } from 'react';
import { PREDICT_ITEMS_BY_ARTIFACT } from './handWrittenProse.js';
import { postRun } from './api.js';

export interface PredictRunPanelProps {
  artifactId: string;
  rungId: string;
  /** The learner's current whole-file doc — see this file's top comment. */
  code: string;
}

type ActualState = 'not-run' | 'running' | { fired: string[] };

export function PredictRunPanel({ artifactId, rungId, code }: PredictRunPanelProps) {
  const items = PREDICT_ITEMS_BY_ARTIFACT[artifactId] ?? [];
  const [predictions, setPredictions] = useState<Record<string, boolean>>({});
  const [actual, setActual] = useState<ActualState>('not-run');

  function togglePrediction(key: string): void {
    setPredictions((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function runWithTracing(): Promise<void> {
    setActual('running');
    const response = await postRun(rungId, code, { mode: 'file', trace: true });
    setActual({ fired: response.trace?.fired ?? [] });
  }

  return (
    <div className="predict-run-panel">
      <p className="predict-run-panel-intro">before running: which of these do you expect to fire?</p>
      <table className="predict-run-table">
        <thead>
          <tr>
            <th scope="col">item</th>
            <th scope="col">predicted</th>
            <th scope="col">actual</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key}>
              <td>{item.label}</td>
              <td>
                <label>
                  <input
                    type="checkbox"
                    checked={predictions[item.key] ?? false}
                    onChange={() => togglePrediction(item.key)}
                    aria-label={`predict: ${item.label}`}
                  />
                  {predictions[item.key] ? ' yes' : ' no'}
                </label>
              </td>
              <td>{describeActual(actual, item.key, item.observable)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => void runWithTracing()} disabled={actual === 'running'}>
        run with tracing
      </button>
    </div>
  );
}

function describeActual(actual: ActualState, key: string, observable: boolean): string {
  if (actual === 'not-run') return 'not run yet';
  if (actual === 'running') return 'running…';
  if (!observable) return 'not directly observed';
  return actual.fired.includes(key) ? 'fired' : 'did not fire';
}
