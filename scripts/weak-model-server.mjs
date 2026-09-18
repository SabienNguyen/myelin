// A deliberately weak "7B-class" model behind the OpenAI-compat wire. Use it to drive the app
// against small-model failure modes with no GPU, no weights, no network — chiefly to check that
// a degenerate model still leaves the learner with a turn that says something (the closing
// guarantee in src/server/llm/wire.ts):
//
//   npm run weak:model                    # pathology mode on :4901
//   WEAK_MODE=reject-rf npm run weak:model
//
// Then point the app at it: OPENAI_COMPAT_BASE_URL=http://127.0.0.1:4901/v1 and a model id of
// openai:weak-7b in the models dialog.
//
// pathology  — accepts response_format but emits the classic small-model failure cycle:
//              fenced JSON with chatter, invalid JSON, expected∉choices, prose refusals
// reject-rf  — 400s any request carrying response_format (naming it), so the constrained-decoding
//              fallback + endpoint memory engage; answers forced-tool calls, mangling the second
// Deterministic by request count so runs are reproducible.
import { createServer } from 'node:http';

const MODE = process.env.WEAK_MODE ?? 'pathology';
const PORT = Number(process.env.WEAK_PORT ?? 4901);
let calls = 0;
let contentCalls = 0;
let toolCalls = 0;

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

const CHECK_CYCLE = [
  validCheck,                                                   // clean → first try
  '```json\n' + validCheck + '\n```\nHope that helps!',         // fenced + chatter → parse fail
  validCheck,                                                   // retry succeeds
  '{ "question": "Which is the prior?", "mode": "choice", }',   // trailing comma
  '{ "question": "Which is the prior?" ',                       // truncated → template fallback
  violationCheck,                                               // expected∉choices
  validCheck,                                                   // retry succeeds
  'As an AI language model, I cannot produce JSON right now.',  // prose refusal
  'Sure! Let me think about that question instead.',            // refusal again → fallback
  validCheck,                                                   // clean → first try
];

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.statusCode = 404;
    return res.end('not found');
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    calls++;
    res.setHeader('content-type', 'application/json');

    if (MODE === 'reject-rf' && body.response_format) {
      console.error(`[weak] call ${calls}: REJECTED response_format`);
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: 'response_format is not supported by this model' } }));
    }

    if (body.tool_choice && body.tools?.length) {
      const name = body.tools[0].function.name;
      const good = validCheck;
      toolCalls++;
      const bad = toolCalls === 2;
      console.error(`[weak] call ${calls}: tool_call ${name} (${bad ? 'MALFORMED args' : 'valid'})`);
      return res.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: `call_${calls}`, type: 'function', function: { name, arguments: bad ? good.slice(0, 40) : good } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 90, completion_tokens: 40 },
      }));
    }

    const content = CHECK_CYCLE[contentCalls++ % CHECK_CYCLE.length];
    console.error(`[weak] call ${calls}: content reply (${content.startsWith('{') ? 'json-ish' : 'pathological'})`);
    return res.end(JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 90, completion_tokens: 60 },
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.error(`[weak] ${MODE} model on http://127.0.0.1:${PORT}/v1`));
