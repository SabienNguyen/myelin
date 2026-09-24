import { isToolUIPart, getToolName, type UIMessage } from '../../shared/uiMessages.js';
import { BlockProse } from './BlockProse.js';
import { GradedTag, Mark, Verdict } from './blocks/Verdict.js';
import { AnswerText } from './blocks/AnswerText.js';
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
  const grading = output.grading as {
    verdict: string; detail: string; retryable?: boolean; perItem?: { id: string; correct: boolean }[];
  } | undefined;
  const prompt = [input.prompt, input.question, input.title].find((v) => typeof v === 'string') as string | undefined;
  // A quiz's answers are {id, answer} per item, which joined as JSON read "You: {"id":"q1",…}". Each
  // item gets its own line with its prompt and mark, as the quiz's own card shows it.
  const quizItems = getToolName(last) === 'quiz' && Array.isArray(input.items) && Array.isArray(output.answers)
    ? (input.items as { id?: unknown; prompt?: unknown }[]).map((item) => ({
        id: String(item.id),
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
        answer: (output.answers as { id?: unknown; answer?: unknown }[]).find((a) => a?.id === item.id)?.answer,
        mark: grading?.perItem?.find((p) => p.id === item.id),
      }))
    : null;
  const answer = output.values ?? output.answer;
  const answerText = typeof answer === 'string' ? answer
    : Array.isArray(answer) ? answer.filter((v) => typeof v === 'string' || typeof v === 'number').join(', ') : null;
  return (
    <section className="block stage-summary" aria-label="Latest exercise">
      <h3>Latest exercise</h3>
      <GradedTag grading={grading} />
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
      {quizItems && (
        <ul className="stage-quiz">
          {quizItems.map((q) => (
            <li key={q.id}>
              <BlockProse text={q.prompt} inline /> — {typeof q.answer === 'string' && q.answer.trim()
                ? <AnswerText text={q.answer} /> : '(blank)'}
              {q.mark && <> <Mark ok={q.mark.correct} /></>}
            </li>
          ))}
        </ul>
      )}
      {answerText && <p>You: <AnswerText text={answerText} /></p>}
      <Verdict grading={grading} />
      {grading?.verdict === 'ungraded' && grading.retryable && onRetry && (
        <button type="button" disabled={isRunning} onClick={() => onRetry(last.toolCallId)}>Retry grading</button>
      )}
    </section>
  );
}
