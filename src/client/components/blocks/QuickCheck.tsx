export function QuickCheck({ args, result, addResult }: {
  args: any; result: any; addResult: (r: any) => void;
}) {
  if (result) {
    return (
      <div className="block quick-check done">
        <p>{args.question}</p>
        {/* QuickText submits whatever is in the field, empty string included, so a learner who
            presses Enter on a blank input got a graded card reading "You:" and nothing else. That
            is reachable in real use, not a scripted-model artifact. Blank is left submittable on
            purpose — it is honest evidence of not knowing, and blocking it would strand the learner
            on a block they cannot clear — so the card just says so, using StructuredCheck's
            existing wording rather than inventing a second one. */}
        <p>You: {result.answer?.trim() ? result.answer : '(blank)'}{result.grading && <em className={`verdict ${result.grading.verdict}`}> — {result.grading.verdict}</em>}</p>
      </div>
    );
  }
  return (
    <div className="block quick-check">
      <p>{args.question}</p>
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
