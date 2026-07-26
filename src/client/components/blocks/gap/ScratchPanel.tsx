// Harness-local (NOT ported from the-gap): CodeSignal-style "run against my own input".
//
// Why this one is safe where an always-on expected/actual diff is not: a scratch run has no expected
// value anywhere in it. The learner supplies input, sees what their own code produced, and compares
// the two themselves. Nothing is revealed that they didn't already know, so — unlike
// TestResultsPanel's reveal — this carries NO evidence consequence and never touches
// `revealedExpected`.
//
// It also never calls finish(): like Run, this is a debugging affordance. Submit remains the one
// gesture that grades (see CodeExercise.tsx's top comment).

import { useState } from 'react';
import { postRun } from './api.js';

export interface ScratchPanelProps {
  rungId: string;
  /** The learner's whole current file, same value Run/Submit send. */
  code: string;
  /** 'function' switches the input from stream text to a JSON argument list — the runner parses
   *  the box's contents accordingly, so the label has to say which one it wants. */
  family?: string;
}

export function ScratchPanel({ rungId, code, family }: ScratchPanelProps) {
  const isFn = family === 'function';
  // Manifests have no separate input — the YAML in the editor IS the thing to inspect, and the
  // server's scratch run answers "what does my YAML parse to". The box is hidden; `input` still
  // posts (empty) because the route dispatches scratch-vs-suite on the field's presence.
  const isManifest = family === 'manifest';
  const [input, setInput] = useState(isFn || isManifest ? '' : 'data: alpha\ndata: beta\ndata: [DONE]\n');
  const [out, setOut] = useState<string | null>(null);
  const [chunks, setChunks] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    setOut(null);
    setUnsupported(false);
    try {
      const res = await postRun(rungId, code, { mode: 'file', input });
      // A sidecar that predates scratch support ignores `input` and grades the suite instead. Say so
      // rather than presenting a suite result as though it came from the learner's input.
      if (!res.scratch) setUnsupported(true);
      else if (res.syntaxError) setError(res.syntaxError);
      else if (res.runtimeError) setError(res.runtimeError);
      else { setOut(res.actual ?? '(no output)'); setChunks(res.chunks); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scratch-panel">
      <p className="scratch-note">
        {isManifest
          ? 'see what your YAML parses to — nothing is graded and nothing is revealed here.'
          : 'your own input, your own output — nothing is graded and nothing is revealed here.'}
      </p>
      {!isManifest && (
        <>
          <label className="scratch-label" htmlFor="scratch-input">{isFn ? 'arguments (a JSON array)' : 'input'}</label>
          <textarea
            id="scratch-input"
            className="scratch-input"
            rows={isFn ? 2 : 4}
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isFn ? '[2, 1, 30]' : undefined}
          />
        </>
      )}
      <div className="scratch-actions">
        <button type="button" className="ide-btn ide-btn--run" onClick={run} disabled={busy}>
          {busy ? 'running…' : isManifest ? 'parse my manifest' : 'run on this input'}
        </button>
        {busy && <span className="ide-spinner" role="status" aria-label="running scratch input" />}
      </div>
      {unsupported && (
        <p className="scratch-unsupported" role="status">
          this sidecar doesn&apos;t support custom input — it graded the suite instead, so nothing is
          shown here.
        </p>
      )}
      {error && <p className="scratch-error" role="status">{error}</p>}
      {out !== null && (
        <dl className="scratch-output">
          <dt>{isManifest ? 'parsed' : 'your output'}</dt>
          <dd><code>{out}</code></dd>
          {chunks !== undefined && (
            <>
              {/* Without this, output like ["a",""] reads as a harness bug rather than as the
                  learner's parser breaking on a split read. Naming the chunking makes the result
                  interpretable — and the awkward split is the point, not an accident. */}
              <dt>delivered as</dt>
              <dd className="scratch-chunks">{chunks} separate reads — deliberately split mid-line</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
