// structured_check — the generic applied block (see src/shared/blocks.ts for why it exists).
// One component, five mechanical checkers, no subject knowledge anywhere in it.
//
// Deliberate choice for `set` and `sequence`: a single textarea, one answer per line, NOT N inputs
// sized to the expected list. Rendering N boxes would tell the learner how many answers there are,
// which for a "name all of them" question is most of the question.

import { useState } from 'react';

type Checker =
  | { kind: 'numeric'; expected: number; tolerance?: number; relative?: boolean; unit?: string }
  | { kind: 'set'; expected: string[] }
  | { kind: 'sequence'; expected: string[] }
  | { kind: 'matching'; items: { left: string; right: string }[]; options?: string[] }
  | { kind: 'pattern'; expected: string };

interface Args { prompt: string; pageSlug: string; hint?: string; checker: Checker }

/** Deterministic shuffle so the option order does not hand over the pairing by sitting in answer
 *  order, and does not reshuffle under re-render (which would move an option out from under a
 *  half-made selection). Seeded from the joined strings — same question, same order, every time. */
function stableShuffle(items: string[]): string[] {
  let seed = items.join('|').split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function StructuredCheck({ args, result, addResult }: {
  args: Args; result: any; addResult: (r: any) => void;
}) {
  const { checker } = args;
  const [single, setSingle] = useState('');
  const [lines, setLines] = useState('');
  const [picks, setPicks] = useState<string[]>(
    checker.kind === 'matching' ? checker.items.map(() => '') : [],
  );

  if (result) {
    const g = result.grading;
    return (
      <div className="block structured-check done">
        <span className="graded-tag">graded</span>
        <p className="structured-prompt">{args.prompt}</p>
        <p className="structured-answer">You: {result.values.join(', ') || '(blank)'}</p>
        {g && <em className={`verdict ${g.verdict}`}> — {g.detail}</em>}
      </div>
    );
  }

  function submit() {
    const values = checker.kind === 'matching' ? picks
      : (checker.kind === 'set' || checker.kind === 'sequence')
        ? lines.split('\n').map((l) => l.trim()).filter(Boolean)
        : [single];
    addResult({ values });
  }

  const listLabel = checker.kind === 'sequence'
    ? 'one per line, in order'
    : 'one per line, in any order';

  return (
    <div className="block structured-check">
      <p className="structured-prompt">{args.prompt}</p>
      {args.hint && <p className="structured-hint">{args.hint}</p>}

      {(checker.kind === 'numeric' || checker.kind === 'pattern') && (
        <div className="structured-single">
          <input
            aria-label={checker.kind === 'numeric' ? 'numeric answer' : 'answer'}
            inputMode={checker.kind === 'numeric' ? 'decimal' : 'text'}
            value={single}
            onChange={(e) => setSingle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          {checker.kind === 'numeric' && checker.unit && (
            <span className="structured-unit">{checker.unit}</span>
          )}
        </div>
      )}

      {(checker.kind === 'set' || checker.kind === 'sequence') && (
        <>
          <p className="structured-list-label">{listLabel}</p>
          <textarea
            aria-label={listLabel}
            rows={4}
            value={lines}
            onChange={(e) => setLines(e.target.value)}
          />
        </>
      )}

      {checker.kind === 'matching' && (
        <ul className="structured-matching">
          {checker.items.map((it, i) => {
            const options = stableShuffle(checker.options ?? checker.items.map((x) => x.right));
            return (
              <li key={it.left}>
                <span className="structured-left">{it.left}</span>
                <select
                  aria-label={`match for ${it.left}`}
                  value={picks[i]}
                  onChange={(e) => setPicks((p) => p.map((v, j) => (j === i ? e.target.value : v)))}
                >
                  <option value="">—</option>
                  {options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </li>
            );
          })}
        </ul>
      )}

      <button type="button" onClick={submit}>Submit</button>
    </div>
  );
}
