import { useEffect, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { CheckIcon as Check, PencilSimpleIcon as Pencil, SigmaIcon as Sigma, XIcon as X } from '@phosphor-icons/react';
import { panelBus } from '../../lib/panelBus.js';
import { StagePortal } from '../StagePortal.js';
import { Verdict } from './Verdict.js';

export function Latex({ tex }: { tex: string }) {
  // String coercion, not trust: throwOnError:false only suppresses PARSE errors — a non-string
  // (a malformed call's missing field) throws before parsing starts, and this throw once
  // unmounted the whole app. The toolkit's schema gate should make that unreachable; this keeps
  // the blast radius at one bad span if it ever isn't.
  const s = typeof tex === 'string' ? tex : String(tex ?? '');
  // problemLatex is DOCUMENTED as LaTeX, but live tutors also send prose with embedded $…$
  // ("A triangle has base $2\pi R$ …") — feeding that whole sentence to KaTeX renders the words
  // as italic variable-soup and the $ signs as red errors (seen on the video-transcript sitting).
  // A $ split renders each segment in its honest mode: prose as text, delimited math as math.
  if (s.includes('$')) {
    const parts = s.split('$');
    return (
      <span>
        {parts.map((part, i) => (i % 2 === 1
          ? <span key={i} dangerouslySetInnerHTML={{ __html: katex.renderToString(part, { throwOnError: false }) }} />
          : <span key={i}>{part}</span>))}
      </span>
    );
  }
  return <span dangerouslySetInnerHTML={{ __html: katex.renderToString(s, { throwOnError: false }) }} />;
}

/** LaTeX flattened to words for the field's accessible name. Not a speech engine — MathLive's own
 *  live region already speaks the CONTENT as it is typed (verified in audit 53); what it never had
 *  is a NAME, so a screen reader landed on an anonymous textbox with no idea which problem it
 *  answers. Common structures get a readable shape, unknown commands just lose the backslash. */
function texToWords(tex: string): string {
  return tex
    .replace(/\\text\{([^{}]*)\}/g, '$1')
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
    .replace(/\\sqrt\{([^{}]*)\}/g, 'sqrt($1)')
    .replace(/\\left|\\right/g, '')
    .replace(/\\[a-zA-Z]+/g, (m) => ` ${m.slice(1)} `)
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Measured (audit 28): for ~100ms after a focus-gaining click, MathLive is still wiring its
// hidden keyboard sink and drops keystrokes. Below human click-to-type latency, so not worked
// around here — but automation driving this field must wait ≥150ms after click before typing.
function MathLiveInput({ value, onChange, label }: {
  value: string; onChange: (v: string) => void; label?: string;
}) {
  const ref = useRef<any>(null);
  useEffect(() => { // registers <math-field>
    import('mathlive').then(() => {
      // MathLive names its focusable keyboard sink (shadow [role=textbox]) only after the first
      // edit, when it stores the spoken form of the content there. Until then a screen reader
      // tabs onto an anonymous textbox — the host's aria-label sits on a node focus never visits.
      // Seed the sink with the field's name; guarded, so once MathLive writes its own it wins.
      const sink = ref.current?.shadowRoot?.querySelector('[role="textbox"]');
      if (label && sink && !sink.hasAttribute('aria-label')) sink.setAttribute('aria-label', label);
    }, (e) => console.error('mathlive failed to load:', e));
  }, [label]);
  useEffect(() => {
    if (ref.current && ref.current.value !== value)
      ref.current.setValue?.(value, { silenceNotifications: true });
  }, [value]);
  return <math-field ref={ref} aria-label={label} onInput={(e: any) => onChange(e.target.value)} />;
}

export function MathScratchpadInner({ args, addResult, MathInput = MathLiveInput }: {
  args: any; addResult: (r: any) => void; MathInput?: typeof MathLiveInput;
}) {
  const [steps, setSteps] = useState<{ latex: string }[]>([]);
  const [current, setCurrent] = useState('');
  // Which step the field is re-working, or null when it holds a fresh line. A derivation's step
  // ORDER is part of the work, so editing writes back to the step's own slot — a recall-and-
  // re-append design would shuffle the argument every time a middle step got fixed.
  const [editing, setEditing] = useState<number | null>(null);

  /** The step list with the field's content folded in — edited step back to its slot, fresh line
   *  appended. Every path that leaves the field (add, edit another step, submit) goes through
   *  this, so typed work is never dropped. Saving an emptied field deletes the step. */
  const folded = () => (editing !== null
    ? steps.map((s, i) => (i === editing ? { latex: current } : s))
    : current ? [...steps, { latex: current }] : steps
  ).filter((s) => s.latex !== '');

  const saveStep = () => {
    if (!current && editing === null) return;
    setSteps(folded()); setCurrent(''); setEditing(null);
  };
  const editStep = (i: number) => {
    const next = folded();
    setSteps(next); setEditing(i); setCurrent(next[i]?.latex ?? '');
  };
  const removeStep = (i: number) => {
    setSteps(steps.filter((_, j) => j !== i));
    if (editing === i) { setEditing(null); setCurrent(''); }
    else if (editing !== null && i < editing) setEditing(editing - 1);
  };
  return (
    <div className="block math-scratchpad">
      <p>Problem: <Latex tex={args.problemLatex} /></p>
      <ol className="scratch-steps">{steps.map((s, i) => (
        <li key={i} className={editing === i ? 'editing' : undefined}>
          <Latex tex={s.latex} />
          <span className="step-tools">
            <button type="button" aria-label={`edit step ${i + 1}`} onClick={() => editStep(i)}><Pencil size={13} /></button>
            <button type="button" aria-label={`remove step ${i + 1}`} onClick={() => removeStep(i)}><X size={13} /></button>
          </span>
        </li>))}
      </ol>
      <MathInput value={current} onChange={setCurrent} label={`your answer — ${texToWords(args.problemLatex ?? '')}`} />
      {args.stepMode && (
        <button type="button" onClick={saveStep}>{editing !== null ? `Save step ${editing + 1}` : 'Add step'}</button>
      )}
      <button type="button" onClick={() => {
        const allSteps = folded();
        addResult({ steps: allSteps, finalLatex: allSteps[allSteps.length - 1]?.latex ?? '' });
      }}>Submit</button>
    </div>
  );
}

export function MathScratchpad(props: { args: any; result: any; addResult: (r: any) => void }) {
  if (props.result) {
    // Same done-card grammar as StructuredCheck: problem, then "You: <answer>", then the verdict
    // on its own line. The old one-liner spliced them with a colon ("… Find v.: 14 — …"), which
    // read as a typo whenever the problem ended in punctuation, and its leading "— " wrapped onto
    // a line of its own — the exact orphan StructuredCheck already removed.
    return <div className="block done"><span className="graded-tag">{props.result.grading ? <><Check size={12} weight="bold" aria-hidden /> graded</> : 'submitted'}</span>
      {/* The problem travels into the done card — without it the thread reads as answers to
          invisible questions when scanned later. */}
      <div className="structured-prompt"><Latex tex={props.args.problemLatex ?? ''} /></div>
      {/* The derivation IS the work: a step-mode card that kept only the final answer read like a
          bare guess when the thread was scanned later. The last step is the final — shown on the
          "You:" line — so only the intermediate steps are listed here. */}
      {Array.isArray(props.result.steps) && props.result.steps.length > 1 && (
        <ol className="scratch-steps">{props.result.steps.slice(0, -1).map((s: any, i: number) => (
          <li key={i}><Latex tex={s?.latex ?? ''} /></li>))}
        </ol>
      )}
      {/* (?? ''): a server-rejected tool call reaches here with a non-contract output, and
          undefined into katex.renderToString threw (see Quiz for the incident). */}
      <p className="structured-answer">You: <Latex tex={props.result.finalLatex ?? ''} /></p>
      <Verdict grading={props.result.grading} /></div>;
  }
  return (
    <>
      <button type="button" className="block chip" onClick={() => panelBus.setTab('stage')}><Sigma size={15} weight="duotone" /> Math problem waiting on the stage</button>
      <StagePortal><MathScratchpadInner args={props.args} addResult={props.addResult} /></StagePortal>
    </>
  );
}
