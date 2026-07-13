import { useEffect, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { CheckIcon as Check, SigmaIcon as Sigma } from '@phosphor-icons/react';
import { panelBus } from '../../lib/panelBus.js';
import { StagePortal } from '../StagePortal.js';

export function Latex({ tex }: { tex: string }) {
  return <span dangerouslySetInnerHTML={{ __html: katex.renderToString(tex, { throwOnError: false }) }} />;
}

function MathLiveInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<any>(null);
  useEffect(() => { import('mathlive'); }, []); // registers <math-field>
  useEffect(() => {
    if (ref.current && ref.current.value !== value)
      ref.current.setValue?.(value, { silenceNotifications: true });
  }, [value]);
  return <math-field ref={ref} onInput={(e: any) => onChange(e.target.value)} />;
}

export function MathScratchpadInner({ args, addResult, MathInput = MathLiveInput }: {
  args: any; addResult: (r: any) => void; MathInput?: typeof MathLiveInput;
}) {
  const [steps, setSteps] = useState<{ latex: string }[]>([]);
  const [current, setCurrent] = useState('');
  return (
    <div className="block math-scratchpad">
      <p>Problem: <Latex tex={args.problemLatex} /></p>
      <ol>{steps.map((s, i) => <li key={i}><Latex tex={s.latex} /></li>)}</ol>
      <MathInput value={current} onChange={setCurrent} />
      {args.stepMode && (
        <button onClick={() => { if (current) { setSteps([...steps, { latex: current }]); setCurrent(''); } }}>
          Add step
        </button>
      )}
      <button onClick={() => {
        const finalLatex = current || steps[steps.length - 1]?.latex || '';
        const allSteps = current ? [...steps, { latex: current }] : steps;
        addResult({ steps: allSteps, finalLatex });
      }}>Submit</button>
    </div>
  );
}

export function MathScratchpad(props: { args: any; result: any; addResult: (r: any) => void }) {
  if (props.result) {
    return <div className="block done"><span className="graded-tag"><Check size={12} weight="bold" /> graded</span>
      Answer: <Latex tex={props.result.finalLatex} />
      {props.result.grading && <em className={`verdict ${props.result.grading.verdict}`}> — {props.result.grading.detail}</em>}</div>;
  }
  return (
    <>
      <div className="block chip" onClick={() => panelBus.setTab('stage')}><Sigma size={15} weight="duotone" /> Math problem waiting on the stage</div>
      <StagePortal><MathScratchpadInner args={props.args} addResult={props.addResult} /></StagePortal>
    </>
  );
}
