// One fake model for tests of model-graded paths (grading, gap help, card gen). Replies with
// canned text — a function reply picks per prompt, which is how a test serves the rubric judge
// and the annotation grader different JSON from a single grader model — and records every prompt
// as plain text so tests can assert what the model was actually shown. A reply that throws makes
// the model call reject, for exercising the failure paths.
import { MockLanguageModelV3 } from 'ai/test';

function promptText(options: { prompt: unknown }): string {
  return ((options.prompt ?? []) as any[])
    .map((m) => (Array.isArray(m.content)
      ? m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n')
      : String(m.content ?? '')))
    .join('\n');
}

export function textModel(reply: string | ((prompt: string) => string)) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = promptText(options);
      prompts.push(prompt);
      return {
        content: [{ type: 'text', text: typeof reply === 'function' ? reply(prompt) : reply }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { model, prompts };
}
