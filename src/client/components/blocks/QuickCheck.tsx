import { useState } from 'react';
import { BlockProse } from '../BlockProse.js';
import { GradedTag, Verdict } from './Verdict.js';
import { AnswerText } from './AnswerText.js';
import { ImeInput } from './ImeInput.js';
import { useRovingKeys } from '../../lib/tablist.js';

type Confidence = 'sure' | 'unsure';

export function QuickCheck({ args, result, addResult }: {
  args: any; result: any; addResult: (r: any) => void;
}) {
  // Confidence-before-reveal: an OPTIONAL pre-answer self-rating. It rides the block result only
  // when actually chosen — answering without touching the toggle sends no confidence at all, so
  // the calibration count (/api/progress) is built purely from deliberate ratings, never from a
  // default the learner didn't mean.
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const onRadioKeys = useRovingKeys({ selector: '[role="radio"]' });
  const submit = (answer: string) => addResult(confidence ? { answer, confidence } : { answer });
  if (result) {
    const said: Confidence | null =
      result.confidence === 'sure' || result.confidence === 'unsure' ? result.confidence : null;
    const missed = result.grading?.verdict === 'incorrect' || result.grading?.verdict === 'partial';
    return (
      <div className="block quick-check done">
        {/* Every other answered card carries this tag; here it earns its keep in the multi-block
            turn, where grading waits for the LAST block — without it this card shows nothing
            between answering and grading, and a learner can't tell "not graded yet" from
            "never will be". */}
        <GradedTag grading={result.grading} />
        <BlockProse text={args.question} />
        {/* QuickText submits whatever is in the field, empty string included, so a learner who
            presses Enter on a blank input got a graded card reading "You:" and nothing else. That
            is reachable in real use, not a scripted-model artifact. Blank is left submittable on
            purpose — it is honest evidence of not knowing, and blocking it would strand the learner
            on a block they cannot clear — so the card just says so, using StructuredCheck's
            existing wording rather than inventing a second one. */}
        {/* The confidence echo stays on the graded card: calibration feedback only teaches if the
            learner can see which rating each verdict was paired with. */}
        <p>
          You: {result.answer?.trim() ? <AnswerText text={result.answer} /> : '(blank)'}
          <Verdict grading={result.grading} dash word />
          {said && <span className="confidence-echo"> — you said {said}</span>}
        </p>
        {missed && args.expected && (
          // Only a mechanical grade compared against the key; a model grader is told not to trust
          // it (answerKey.ts), so there it is the tutor's answer, not the answer.
          <p className="quiz-expected">
            {result.grading.source === 'mechanical' ? 'Answer' : 'Tutor\'s answer'}: <AnswerText text={args.expected} />
          </p>
        )}
        {missed && result.grading.detail && <p className="quiz-expected">{result.grading.detail}</p>}
      </div>
    );
  }
  return (
    <div className="block quick-check">
      <BlockProse text={args.question} />
      <div className="confidence" role="radiogroup" aria-label="How confident?" onKeyDown={onRadioKeys}>
        {(['sure', 'unsure'] as const).map((c, i) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={confidence === c}
            className={`confidence-chip${confidence === c ? ' on' : ''}`}
            // Roving tabindex, same contract as the tab strips: one Tab stop, arrows within.
            tabIndex={(confidence != null ? confidence === c : i === 0) ? 0 : -1}
            // Re-clicking the chosen chip clears it — the toggle is optional, and a mis-click must
            // not force a rating into the record.
            onClick={() => setConfidence((prev) => (prev === c ? null : c))}
          >
            {c}
          </button>
        ))}
      </div>
      {/* `lang` (e.g. "vi") turns the text field into that language's input method — Vietnamese
          Telex today, so a learner types diacritics from an ASCII keyboard (ImeInput.tsx). */}
      {args.mode === 'choice'
        ? args.choices?.map((ch: string) => (
            // Choices carry maths as often as the question does ("$\frac{1}{2}$"), and are exact-match
            // targets otherwise, so only their maths is typeset.
            <button key={ch} type="button" onClick={() => submit(ch)}><AnswerText text={ch} /></button>
          ))
        : <ImeInput name="a" lang={args.lang} onSubmit={submit} />}
    </div>
  );
}
