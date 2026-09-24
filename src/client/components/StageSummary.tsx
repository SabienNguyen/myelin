import { isToolUIPart, getToolName, type UIMessage } from '../../shared/uiMessages.js';
import { BlockProse } from './BlockProse.js';
import { Mark, Verdict } from './blocks/Verdict.js';
import { Latex } from './blocks/MathScratchpad.js';

const EXERCISES = new Set([
  'quick_check', 'structured_check', 'quiz', 'math_scratchpad',
  'label_diagram', 'writing_draft', 'code_exercise', 'pronounce',
]);

/** Read-only continuity; pending exercises retain their own interactive Stage portals. */
export function StageSummary({ messages, isRunning = false, onRetry }: {
  messages: UIMessage[]; isRunning?: boolean; onRetry?: (id: string) => void;
}) {
  const exercises = messages.filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts).filter(isToolUIPart)
    .filter((p) => EXERCISES.has(getToolName(p)));
  if (exercises.some((p) => p.state === 'input-available' || p.state === 'input-streaming')) return null;
  const last = exercises.filter((p) => p.state === 'output-available').at(-1);
  if (!last) return null;
  const input = (last.input ?? {}) as Record<string, unknown>;
  const output = (last.output ?? {}) as Record<string, unknown>;
  const grading = output.grading as { verdict: string; detail: string; retryable?: boolean;
    perItem?: { id: string; correct: boolean; source?: string }[] } | undefined;
  const prompt = [input.prompt, input.question, input.title].find((v) => typeof v === 'string') as string | undefined;
  const isQuiz = getToolName(last) === 'quiz';
  // Quiz's output is { answers: [{id, answer}] } — not a string, and JSON.stringify-ing that
  // into the "You:" line is the bug this branch exists to avoid. Render one row per item instead,
  // matching Quiz.tsx's own done card, joined to the input by item id.
  const quizItems: { id: string; type: string; prompt: string }[] =
    isQuiz && Array.isArray(input.items) ? input.items : [];
  const quizAnswers: { id: string; answer: string }[] =
    isQuiz && Array.isArray(output.answers) ? output.answers : [];
  const byId = new Map((grading?.perItem ?? []).map((p) => [p.id, p]));
  const answer = output.values ?? output.answer;
  const answerText = typeof answer === 'string' ? answer
    // Skip, never stringify, an entry that isn't plain text — see the quiz branch above for the
    // one block whose answers are objects.
    : Array.isArray(answer) ? answer.filter((v): v is string => typeof v === 'string').join(', ') : null;
  return (
    <section className="block stage-summary" aria-label="Latest exercise">
      <h3>Latest exercise</h3>
      {/* Same words as the block's own tag (QuickCheck and the other blocks say "graded" /
          "submitted"), so the Stage and the transcript describe one answer the same way. */}
      <span className="graded-tag">{grading?.verdict === 'ungraded' ? 'not graded' : grading ? 'graded' : 'submitted'}</span>
      {prompt && <BlockProse text={prompt} />}
      {getToolName(last) === 'math_scratchpad' && <div className="stage-math-work">
        <div className="stage-problem"><Latex tex={String(input.problemLatex ?? '')} /></div>
        {Array.isArray(output.steps) && output.steps.length > 0 && <>
          <h4>Your work</h4>
          <ol>{output.steps.map((step, i) => <li key={i}>
            <Latex tex={typeof step?.latex === 'string' ? step.latex : ''} />
          </li>)}</ol>
        </>}
        <h4>Final answer</h4>
        <div className="stage-final"><Latex tex={String(output.finalLatex ?? '')} /></div>
      </div>}
      {isQuiz && quizItems.length > 0 && (
        <ul>
          {quizItems.map((item) => {
            const learnerAnswer = quizAnswers.find((a) => a.id === item.id)?.answer;
            const scored = byId.get(item.id);
            // A choice answer is one of the tutor's own choices, maths included, so it renders
            // like one; a typed answer is the learner's text and stays literal — same rule as
            // the Quiz done card.
            const shown = !learnerAnswer ? '(blank)'
              : item.type === 'choice' ? <BlockProse text={learnerAnswer} inline /> : learnerAnswer;
            return (
              <li key={item.id}>
                <BlockProse text={item.prompt} inline /> — {shown} {scored != null && <Mark ok={scored.correct} />}
              </li>
            );
          })}
        </ul>
      )}
      {!isQuiz && answerText && <p>You: {answerText}</p>}
      <Verdict grading={grading} />
      {grading?.verdict === 'ungraded' && grading.retryable && onRetry && (
        <button type="button" disabled={isRunning} onClick={() => onRetry(last.toolCallId)}>Retry grading</button>
      )}
    </section>
  );
}
