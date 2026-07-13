export function QuickCheck({ args, result, addResult }: {
  args: any; result: any; addResult: (r: any) => void;
}) {
  if (result) {
    return (
      <div className="block quick-check done">
        <p>{args.question}</p>
        <p>You: {result.answer}{result.grading && <em className={`verdict ${result.grading.verdict}`}> — {result.grading.verdict}</em>}</p>
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
