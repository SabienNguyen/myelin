// structured_check — the generic applied block (see src/shared/blocks.ts for why it exists).
// One component, five mechanical checkers, no subject knowledge anywhere in it.
//
// Deliberate choice for `set` and `sequence`: a single textarea, one answer per line, NOT N inputs
// sized to the expected list. Rendering N boxes would tell the learner how many answers there are,
// which for a "name all of them" question is most of the question.

import { useState } from 'react';
import { RulerIcon as Ruler } from '@phosphor-icons/react/dist/csr/Ruler';
import { BlockProse } from '../BlockProse.js';
import { prettyAnswer } from '../../lib/answerDisplay.js';
import { parseNotes, playNotes } from '../../lib/audio.js';
import { panelBus } from '../../lib/panelBus.js';
import { StagePortal } from '../StagePortal.js';
import { Verdict } from './Verdict.js';

type Checker =
  | { kind: 'numeric'; expected: number; tolerance?: number; relative?: boolean; unit?: string }
  | { kind: 'set'; expected: string[] }
  | { kind: 'sequence'; expected: string[] }
  | { kind: 'matching'; items: { left: string; right: string }[]; options?: string[] }
  | { kind: 'unit'; expected: number; unit: string }
  | { kind: 'chem_equation'; reactants?: string[]; products?: string[] }
  | { kind: 'notes'; expected: string[]; ordered?: boolean }
  | { kind: 'vector'; expected: number[]; tolerance?: number; relative?: boolean; unit?: string }
  | { kind: 'pattern'; expected: string };

interface Args { prompt: string; pageSlug: string; hint?: string; checker: Checker }

/**
 * The learner's answer, rendered the way the prompt above it is rendered.
 *
 * `$…$` goes through BlockProse (real KaTeX, same as the prompt); anything else gets the
 * mechanical formula prettifier (answerDisplay.ts). Renders NOTHING when the display form would be
 * identical — a preview that just echoes the input is noise under every plain answer.
 */
function AnswerText({ value }: { value: string }) {
  if (value.includes('$')) return <BlockProse text={value} inline />;
  return <>{prettyAnswer(value) ?? value}</>;
}

function AnswerPreview({ value }: { value: string }) {
  const changed = value.includes('$') || prettyAnswer(value) !== null;
  if (!changed) return null;
  return (
    <p className="structured-preview" aria-live="polite">
      reads as: <AnswerText value={value} />
    </p>
  );
}

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
  // A chem_equation prompt is the one place the tutor reliably writes formulas as plain ASCII
  // (`CH4 + O2 -> CO2 + H2O`), and the audit screenshot showed it sitting raw directly above the
  // learner's own SUBSCRIPTED answer preview — the question read less like chemistry than the
  // answer. Scoped to this checker kind because there letter+digit tokens are formulas; running
  // it on every prompt would subscript prose like "step2". Display only, as always.
  const displayPrompt = checker.kind === 'chem_equation'
    ? (prettyAnswer(args.prompt) ?? args.prompt) : args.prompt;

  if (result) {
    const g = result.grading;
    return (
      <div className="block structured-check done">
        {/* 'graded' only when grading has actually arrived. With several blocks in one turn, the
            harness grades on the resubmit that fires after ALL of them are answered — until then
            this card is submitted-not-graded, and the tag saying otherwise was a lie a screenshot
            caught. */}
        <span className="graded-tag">{g ? 'graded' : 'submitted'}</span>
        <div className="structured-prompt"><BlockProse text={displayPrompt} /></div>
        <p className="structured-answer">
          {/* (result.values ?? []): a server-rejected tool call reaches here with a non-contract
              output, and .length on undefined unmounted the app root (see Quiz for the incident). */}
          You: {(result.values ?? []).length === 0 ? '(blank)'
            : (result.values as string[]).map((v: string, i: number) => (
              <span key={i}>{i > 0 && ', '}<AnswerText value={v} /></span>
            ))}
        </p>
        {checker.kind === 'notes' && parseNotes(String(result.values?.[0] ?? '')).length > 0 && (
          <button type="button" className="play-notes" aria-label="play your answer"
            onClick={() => playNotes(String(result.values[0]))}>▶ hear it</button>
        )}
        {/* No leading dash: the verdict wraps onto its own line below the answer, where an
            orphaned "— " read as a typo in the audit screenshot. */}
        <Verdict grading={g} />
      </div>
    );
  }

  // Interactive applied check lives on the STAGE, like every other applied block (quiz, math,
  // diagram, draft, code) and unlike the deliberately-inline quick_check warm-up — the stage's own
  // empty copy already lists "science checks" among what lands there, and the matching/sequence
  // variants need the stage's room rather than the narrower transcript column. The transcript keeps
  // a chip that announces the exercise and jumps to it, exactly as Quiz/Math do.
  return (
    <>
      <button type="button" className="block chip" onClick={() => panelBus.setTab('stage')}>
        <Ruler size={15} weight="duotone" /> Applied check waiting on the stage
      </button>
      <StagePortal><StructuredCheckInner args={args} addResult={addResult} /></StagePortal>
    </>
  );
}

export function StructuredCheckInner({ args, addResult }: {
  args: Args; addResult: (r: any) => void;
}) {
  const { checker } = args;
  const displayPrompt = checker.kind === 'chem_equation'
    ? (prettyAnswer(args.prompt) ?? args.prompt) : args.prompt;
  // Everything the learner answers in ONE input. `unit` includes its unit in the answer (that is
  // the point of the checker), `chem_equation` is one equation, `notes` split server-side.
  const isSingle = ['numeric', 'pattern', 'unit', 'chem_equation', 'notes', 'vector'].includes(checker.kind);
  const [single, setSingle] = useState('');
  const [lines, setLines] = useState('');
  const [picks, setPicks] = useState<string[]>(
    checker.kind === 'matching' ? checker.items.map(() => '') : [],
  );

  function submit() {
    const values = checker.kind === 'matching' ? picks
      : !isSingle
        ? lines.split('\n').map((l) => l.trim()).filter(Boolean)
        : [single];
    addResult({ values });
  }

  const listLabel = checker.kind === 'sequence'
    ? 'one per line, in order'
    : 'one per line, in any order';

  return (
    <div className="block structured-check">
      <div className="structured-prompt"><BlockProse text={displayPrompt} /></div>
      {args.hint && <p className="structured-hint">{args.hint}</p>}

      {isSingle && (
        <div className="structured-single">
          <input
            aria-label={checker.kind === 'numeric' ? 'numeric answer' : 'answer'}
            inputMode={checker.kind === 'numeric' ? 'decimal' : 'text'}
            placeholder={checker.kind === 'unit' ? 'value with unit — e.g. 20 m/s'
              : checker.kind === 'chem_equation' ? 'e.g. CH4 + 2O2 -> CO2 + 2H2O'
                : checker.kind === 'notes' ? 'note names — e.g. C E G'
                  : checker.kind === 'vector' ? 'e.g. (3, 4)' : undefined}
            value={single}
            onChange={(e) => setSingle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          {/* Prettified (m/s^2 shows as m/s²): the suffix says what quantity is being asked for,
              not what to type — grading normalises ^ and superscripts away, so both forms count. */}
          {checker.kind === 'numeric' && checker.unit && (
            <span className="structured-unit">{prettyAnswer(checker.unit) ?? checker.unit}</span>
          )}
          {/* Ear feedback for music answers: plays the learner's OWN notes (never the expected
              ones — that would be the answer). Disabled until something parseable is typed. */}
          {checker.kind === 'notes' && (
            <button
              type="button"
              className="play-notes"
              aria-label="play the notes you typed"
              disabled={parseNotes(single).length === 0}
              onClick={() => playNotes(single)}
            >▶ hear it</button>
          )}
        </div>
      )}
      {/* Unit glyphs, one tap: · ² ³ ⁻ are the whole difference between typing physics and
          fighting a keyboard (audit 38's top friction). Insert-at-end is enough — these come at
          the end of a unit expression in practice. ASCII forms still grade identically. */}
      {(checker.kind === 'unit' || (checker.kind === 'numeric' && checker.unit)) && (
        <p className="unit-glyphs" aria-label="insert a unit symbol">
          {['·', '²', '³', '⁻¹'].map((glyph) => (
            <button key={glyph} type="button" onClick={() => setSingle((s) => s + glyph)}>
              {glyph}
            </button>
          ))}
        </p>
      )}
      {/* Notes get their own preview: standard notation capitalises note letters, and grading
          accepts "c e g" silently — teach the convention without penalising it (audit 39's
          recommendation). Shown only when the canonical spelling differs from what was typed. */}
      {checker.kind === 'notes'
        ? (() => {
          const canon = single.split(/[\s,]+/).filter(Boolean)
            .map((t) => t.length ? t[0].toUpperCase() + t.slice(1) : t).join(' ');
          if (!canon || canon === single.trim().replace(/[\s,]+/g, ' ')) return null;
          return <p className="structured-preview" aria-live="polite">reads as: {canon}</p>;
        })()
        : isSingle && <AnswerPreview value={single} />}

      {(checker.kind === 'set' || checker.kind === 'sequence') && (
        <>
          <p className="structured-list-label">{listLabel}</p>
          <textarea
            aria-label={listLabel}
            rows={4}
            value={lines}
            onChange={(e) => setLines(e.target.value)}
          />
          {/* One combined line rather than per-row previews: showing N rendered rows under an
              N-line textarea would echo the count of answers, which for a set question the
              textarea deliberately withholds. This appears only once SOMETHING renders differently. */}
          {(() => {
            const entries = lines.split('\n').map((l) => l.trim()).filter(Boolean);
            if (!entries.some((l) => l.includes('$') || prettyAnswer(l) !== null)) return null;
            return (
              <p className="structured-preview" aria-live="polite">
                reads as: {entries.map((l, i) => (
                  <span key={i}>{i > 0 && ' · '}<AnswerText value={l} /></span>
                ))}
              </p>
            );
          })()}
        </>
      )}

      {checker.kind === 'matching' && (() => {
        // One shuffle for the whole list — every row offers the SAME option set, so this does not
        // depend on the row index. It was computed inside the .map(), re-shuffling (deterministically,
        // so identically) once per item on every render; hoisting it is a pure O(N²)->O(N) cleanup.
        const options = stableShuffle(checker.options ?? checker.items.map((x) => x.right));
        return (
          <ul className="structured-matching">
            {checker.items.map((it, i) => (
              <li key={it.left}>
                {/* Same notation treatment as the prompt and the learner's own answer: `$…$` is real
                    KaTeX, ASCII maths (`x^2`, `SO4^2-`) gets the mechanical prettifier. Without this
                    the one place inside the block that showed raw `x^2` / leaked a `$…$` label was
                    the matching left column. */}
                <span className="structured-left"><AnswerText value={it.left} /></span>
                <select
                  aria-label={`match for ${it.left}`}
                  value={picks[i]}
                  onChange={(e) => setPicks((p) => p.map((v, j) => (j === i ? e.target.value : v)))}
                >
                  <option value="">—</option>
                  {/* A native <option> can't host KaTeX, so `$…$` options fall back to raw — but the
                      plain-Unicode prettifier still turns `x^2` into x². `value` stays the raw string
                      so the submitted pick and grading are byte-for-byte unchanged. */}
                  {options.map((o) => <option key={o} value={o}>{prettyAnswer(o) ?? o}</option>)}
                </select>
              </li>
            ))}
          </ul>
        );
      })()}

      <button type="button" onClick={submit}>Submit</button>
    </div>
  );
}
