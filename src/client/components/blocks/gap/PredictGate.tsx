import { useState } from 'react';

/**
 * Comprehension before production — backlog item 4. Before the editor opens, the learner is shown
 * a real input from the suite and asked what the FINISHED function yields. The answer is graded
 * server-side (/api/gap/predict): the reference runs in the sandbox's killable child and only the
 * verdict comes back, so the expected output is not sitting in devtools waiting to be read.
 *
 * A gate, not a wall. Prediction records NO evidence — it is formative — so after two misses the
 * server sends the actual output as teaching material and the learner proceeds; and "skip" is
 * always available, because a gate that traps people teaches them to distrust gates.
 */
export function PredictGate({ rungId, caseName, inputPreview, family, onDone }: {
  rungId: string;
  caseName: string;
  inputPreview: string;
  /** 'function' switches the copy from sequence language ("yields, one per line") to single-value
   *  language ("returns") — the audit caught a chemistry function being asked stream questions. */
  family?: string;
  onDone: () => void;
}) {
  const isFn = family === 'function';
  const [lines, setLines] = useState('');
  const [attempt, setAttempt] = useState(1);
  const [verdict, setVerdict] = useState<null | { pass: boolean; actual?: string[] }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/gap/predict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rungId, caseName, attempt,
          prediction: lines.split('\n').map((l) => l.trim()).filter(Boolean),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'prediction check failed'); return; }
      setVerdict(data);
      if (!data.pass) setAttempt((a) => a + 1);
    } catch (e: any) {
      setError(`could not reach the sandbox (${e?.message ?? e})`);
    } finally {
      setBusy(false);
    }
  }

  const revealed = verdict && !verdict.pass && verdict.actual;

  return (
    <div className="predict-gate">
      <h4>Before you write it — read it</h4>
      <p className="predict-lede">
        {isFn
          ? 'The finished function gets called like this. What does it return?'
          : 'The finished function receives this input. What does it yield, in order, one per line?'}
      </p>
      <pre className="predict-input">{inputPreview}</pre>
      <textarea
        aria-label={isFn ? 'predicted return value' : 'predicted output, one per line'}
        rows={isFn ? 1 : 3}
        value={lines}
        onChange={(e) => setLines(e.target.value)}
        placeholder={isFn ? 'the return value' : 'first value\nsecond value'}
      />
      {verdict?.pass && (
        <p className="predict-verdict predict-ok" role="status">
          Right — you can already read this pattern. Now write it.
        </p>
      )}
      {verdict && !verdict.pass && !revealed && (
        <p className="predict-verdict predict-miss" role="status">
          {isFn
            ? 'Not quite. Work it through once more — one more try.'
            : 'Not quite. Look again at where the line breaks fall — one more try.'}
        </p>
      )}
      {revealed && (
        <p className="predict-verdict predict-miss" role="status">
          It {isFn ? 'returns' : 'yields'}: {verdict!.actual!.map((a) => `“${a}”`).join(', ')}. Worth
          a moment before you write — the gap between your prediction and this is the pattern.
        </p>
      )}
      {error && <p className="predict-verdict predict-miss" role="alert">{error}</p>}
      <div className="predict-actions">
        {verdict?.pass || revealed ? (
          <button type="button" className="predict-continue" onClick={onDone}>continue to the editor</button>
        ) : (
          <>
            <button type="button" className="predict-check" onClick={check} disabled={busy || !lines.trim()}>
              {busy ? 'checking…' : 'check my prediction'}
            </button>
            <button type="button" className="predict-skip" onClick={onDone}>skip</button>
          </>
        )}
      </div>
    </div>
  );
}
