// A deliberately weak "7B-class" model behind the OpenAI-compat wire, hosted in-process for the
// weak-model regression suite (tests/llm/weakModel.integration.test.ts) — the standing check that
// the harness's small-model machinery (rails retry, template fallback, constrained-decoding
// fallback + endpoint memory) absorbs the failure modes real small models produce, instead of
// throwing them at the learner. scripts/weak-model-server.mjs is the standalone twin for manual
// `npm run eval:model` runs; the cycles here and there are kept in step by the comments naming
// each pathology.
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

export type WeakMode =
  /** Accepts response_format but emits the classic small-model failure cycle. */
  | 'pathology'
  /** 400s any request carrying response_format (naming it), so the adapter's forced-tool
   * fallback + endpoint memory engage; answers tool calls valid/malformed by its own cycle. */
  | 'reject-rf'
  /** Serves every quick_check as valid JSON prefixed by a <think>…</think> block — the
   * qwen3-class habit of inlining reasoning in content. The adapter's tag extraction must
   * recover it FIRST TRY: one model call, no retry, no template fallback. */
  | 'think-tags';

const validCheck = JSON.stringify({
  question: 'Which quantity is the prior in Bayes’ theorem?',
  mode: 'choice',
  choices: ['P(A)', 'P(B|A)', 'P(A|B)'],
  expected: 'P(A)',
  framing: 'First contact with this idea — a wrong guess is useful here.',
});
const violationCheck = JSON.stringify({
  question: 'Which quantity is the prior?',
  mode: 'choice',
  choices: ['P(A)', 'P(B|A)', 'P(A|B)'],
  expected: 'the prior probability', // schema-valid but not one of choices — the classic 7B slip
  framing: 'Let’s check the basics.',
});
const validFeedback = JSON.stringify({ feedback: 'You picked "P(A)" — that is the prior.', next: 'continue' });

/** One content reply per quick_check call. Sized so SIX generateRailsQuickCheck trials consume it
 * exactly (10 calls): first / retry / fallback / violation-then-retry / fallback / first. */
export const CHECK_CYCLE = [
  validCheck,                                                   // t1: clean → first try
  '```json\n' + validCheck + '\n```\nHope that helps!',         // t2a: fenced + chatter → parse fail
  validCheck,                                                   // t2b: retry succeeds
  '{ "question": "Which is the prior?", "mode": "choice", }',   // t3a: trailing comma
  '{ "question": "Which is the prior?" ',                       // t3b: truncated → template fallback
  violationCheck,                                               // t4a: expected∉choices
  validCheck,                                                   // t4b: retry succeeds
  'As an AI language model, I cannot produce JSON right now.',  // t5a: prose refusal
  'Sure! Let me think about that question instead.',            // t5b: refusal again → fallback
  validCheck,                                                   // t6: clean → first try
];

/** Feedback replies: valid, then chatty prose (schema failure → machine-grade fallback). */
export const FEEDBACK_CYCLE = [validFeedback, 'Great job!! Keep going :)'];

/** think-tags mode's one shape: reasoning inlined ahead of an otherwise-clean JSON body, tags
 * padded with newlines exactly the way qwen3 emits them. */
const thinkPrefixedCheck = '<think>\nThe student is new to this page; probe the prior.\n</think>\n\n' + validCheck;

export interface WeakModelServer {
  baseUrl: string;
  /** Total /chat/completions requests served. */
  calls(): number;
  /** How many of them carried response_format — the endpoint-memory assertion reads this. */
  rfRequests(): number;
  close(): Promise<void>;
}

export async function startWeakModel(mode: WeakMode): Promise<WeakModelServer> {
  let calls = 0;
  let rfRequests = 0;
  let contentCalls = 0;
  let feedbackCalls = 0;
  let toolCalls = 0;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw) as {
        response_format?: { json_schema?: { name?: string } };
        tools?: { function: { name: string } }[];
        tool_choice?: unknown;
      };
      calls++;
      if (body.response_format) rfRequests++;
      res.setHeader('content-type', 'application/json');

      if (mode === 'reject-rf' && body.response_format) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'response_format is not supported by this model' } }));
        return;
      }

      if (body.tool_choice && body.tools?.length) {
        // Forced-tool path: the SECOND tool call mangles its arguments (truncated JSON), the rest
        // are valid — one recoverable slip in a run, deterministic wherever it lands.
        const name = body.tools[0].function.name;
        const good = name === 'rails_feedback' ? validFeedback : validCheck;
        toolCalls++;
        const args = toolCalls === 2 ? good.slice(0, 40) : good;
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id: `call_${calls}`, type: 'function', function: { name, arguments: args } }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 90, completion_tokens: 40 },
        }));
        return;
      }

      const name = body.response_format?.json_schema?.name ?? '';
      const content = name === 'rails_feedback'
        ? FEEDBACK_CYCLE[feedbackCalls++ % FEEDBACK_CYCLE.length]
        : mode === 'think-tags'
          ? thinkPrefixedCheck
          : CHECK_CYCLE[contentCalls++ % CHECK_CYCLE.length];
      res.end(JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 90, completion_tokens: 60 },
      }));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls: () => calls,
    rfRequests: () => rfRequests,
    close: () => new Promise((resolve) => { server.close(() => resolve()); }),
  };
}
