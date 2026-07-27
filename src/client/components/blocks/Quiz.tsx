import { useState } from 'react';
import { CheckIcon as Check, ListChecksIcon as ListChecks } from '@phosphor-icons/react';
import { panelBus } from '../../lib/panelBus.js';
import { StagePortal } from '../StagePortal.js';
import { BlockProse } from '../BlockProse.js';

export function QuizInner({ args, addResult }: {
  args: any; addResult: (r: any) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const setAnswer = (id: string, answer: string) => setAnswers((a) => ({ ...a, [id]: answer }));
  return (
    <div className="block quiz">
      <h3>{args.title}</h3>
      {args.items.map((item: any) => (
        <div className="quiz-item" key={item.id}>
          <BlockProse text={item.prompt} />
          {item.type === 'choice'
            ? item.choices?.map((ch: string) => (
                <button
                  key={ch}
                  className={answers[item.id] === ch ? 'on' : ''}
                  onClick={() => setAnswer(item.id, ch)}
                >{ch}</button>
              ))
            : (
              <input
                value={answers[item.id] ?? ''}
                onChange={(e) => setAnswer(item.id, e.target.value)}
              />
            )}
        </div>
      ))}
      <button onClick={() => addResult({
        answers: args.items.map((item: any) => ({ id: item.id, answer: answers[item.id] ?? '' })),
      })}>Submit</button>
    </div>
  );
}

export function Quiz(props: { args: any; result: any; addResult: (r: any) => void }) {
  if (props.result) {
    const perItem: { id: string; correct: boolean; source?: string }[] = props.result.grading?.perItem ?? [];
    const byId = new Map(perItem.map((p) => [p.id, p]));
    // A tool call the server REJECTED (bad input from the model) still reaches this branch, with
    // an output that is not the result contract. Reading .answers off it unmounted the entire
    // React root — one malformed quiz blanked the whole app in the audit. Guard, render what
    // exists, and the rest of the session survives the model's mistake.
    const answers: { id: string; answer: string }[] = Array.isArray(props.result.answers) ? props.result.answers : [];
    return (
      <div className="block quiz done">
        <span className="graded-tag">{props.result.grading ? <><Check size={12} weight="bold" /> graded</> : 'submitted'}</span>
        <h3>{props.args.title}</h3>
        <ul>
          {props.args.items.map((item: any) => {
            const answer = answers.find((a) => a.id === item.id)?.answer;
            const scored = byId.get(item.id);
            return (
              <li key={item.id}>
                <BlockProse text={item.prompt} inline /> — {answer} {scored != null && (
                  <span className={scored.correct ? 'mark-ok' : 'mark-bad'}>{scored.correct ? '✓' : '✗'}</span>
                )}
                {/* Which verdicts are a machine's and which are a model's opinion — the evidence
                    note already said "(model-graded)", but the learner could not see WHICH items.
                    Checked is the default and gets no badge; judged is the exception worth naming. */}
                {scored?.source === 'model' && <span className="quiz-judged">judged</span>}
              </li>
            );
          })}
        </ul>
        {/* No leading dash — the verdict wraps onto its own line, where "— 2/3" read as a typo
            in the audit screenshot (same fix as StructuredCheck). */}
        {props.result.grading && <em className={`verdict ${props.result.grading.verdict}`}>{props.result.grading.detail}</em>}
      </div>
    );
  }
  return (
    <>
      <button type="button" className="block chip" onClick={() => panelBus.setTab('stage')}><ListChecks size={15} weight="duotone" /> Quiz waiting on the stage</button>
      <StagePortal><QuizInner args={props.args} addResult={props.addResult} /></StagePortal>
    </>
  );
}
