import { CheckIcon as Check } from '@phosphor-icons/react';
import { BlockProse } from '../BlockProse.js';
import { Verdict } from './Verdict.js';
export function QuickCheck({ args, result, addResult }: {
  args: any; result: any; addResult: (r: any) => void;
}) {
  if (result) {
    return (
      <div className="block quick-check done">
        {/* Every other answered card carries this tag; here it earns its keep in the multi-block
            turn, where grading waits for the LAST block — without it this card shows nothing
            between answering and grading, and a learner can't tell "not graded yet" from
            "never will be". */}
        <span className="graded-tag">{result.grading ? <><Check size={12} weight="bold" aria-hidden /> graded</> : 'submitted'}</span>
        <BlockProse text={args.question} />
        {/* QuickText submits whatever is in the field, empty string included, so a learner who
            presses Enter on a blank input got a graded card reading "You:" and nothing else. That
            is reachable in real use, not a scripted-model artifact. Blank is left submittable on
            purpose — it is honest evidence of not knowing, and blocking it would strand the learner
            on a block they cannot clear — so the card just says so, using StructuredCheck's
            existing wording rather than inventing a second one. */}
        <p>You: {result.answer?.trim() ? result.answer : '(blank)'}<Verdict grading={result.grading} dash word /></p>
      </div>
    );
  }
  return (
    <div className="block quick-check">
      <BlockProse text={args.question} />
      {args.mode === 'choice'
        ? args.choices?.map((ch: string) => (
            <button key={ch} onClick={() => addResult({ answer: ch })}>{ch}</button>
          ))
        : <QuickText onSubmit={(answer) => addResult({ answer })} />}
    </div>
  );
}
function QuickText({ onSubmit }: { onSubmit: (v: string) => void }) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget).get('a') as string); }}>
      <input name="a" autoFocus /><button type="submit">Answer</button>
    </form>
  );
}
