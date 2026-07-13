import { useState } from 'react';
import { panelBus } from '../../lib/panelBus.js';
import { StagePortal } from '../StagePortal.js';

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
          <p>{item.prompt}</p>
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
    const perItem: { id: string; correct: boolean }[] = props.result.grading?.perItem ?? [];
    const byId = new Map(perItem.map((p) => [p.id, p.correct]));
    return (
      <div className="block quiz done">
        <h3>{props.args.title}</h3>
        <ul>
          {props.args.items.map((item: any) => {
            const answer = props.result.answers.find((a: any) => a.id === item.id)?.answer;
            const correct = byId.get(item.id);
            return (
              <li key={item.id}>
                {item.prompt} — {answer} {correct != null && (correct ? '✓' : '✗')}
              </li>
            );
          })}
        </ul>
        {props.result.grading && <em className={`verdict ${props.result.grading.verdict}`}> — {props.result.grading.detail}</em>}
      </div>
    );
  }
  return (
    <>
      <div className="block chip" onClick={() => panelBus.setTab('stage')}>📝 Quiz sent to stage ▸</div>
      <StagePortal><QuizInner args={props.args} addResult={props.addResult} /></StagePortal>
    </>
  );
}
