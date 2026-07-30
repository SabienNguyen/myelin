// One fake ChatModel for tests of model-graded paths (grading, gap help, card gen). Replies with
// canned text — a function reply picks per prompt, which is how a test serves the rubric judge
// and the annotation grader different JSON from a single grader model — and records every prompt
// (system included) as plain text so tests can assert what the model was actually shown. A reply
// that throws makes the model call reject, for exercising the failure paths.
//
// Structured output: generateStructured forces its schema tool via toolChoice and reads the
// verdict off the matching tool call. When the request forces a tool, a reply that parses as
// JSON becomes that tool call's input — so one scripted JSON string serves the structured path.
// A reply that does NOT parse stays plain text with no tool call, which generateStructured
// rejects: exactly the "unparseable grade throws" behavior the grading tests pin.
import {
  zeroUsage, type ChatModel, type ChatRequest, type GenerateResult, type Usage,
} from '../src/server/llm/index.js';

/** One scripted loop step: tool calls first, then text — the order the real adapters and the e2e
 * scripted model both emit. `usage` rides the finish event (zeros when unscripted), for tests
 * that assert the figures reach the usage ledger. */
export interface FakeTurn {
  text?: string;
  toolCalls?: { toolName: string; input: unknown }[];
  usage?: Usage;
}

/** A ChatModel whose stream() plays whatever `turn` returns per call — the first-party stand-in
 * for the SDK's MockLanguageModelV3 in loop-driving tests (compile agent, tutor session). The
 * request and a 0-based call index go in, so a fake can script by position or react to the
 * transcript (e.g. "a tool-result is present, so this is step two"). A `turn` that throws makes
 * the model call reject, for exercising failure paths. */
export function streamModel(
  turn: (req: ChatRequest, call: number) => FakeTurn | Promise<FakeTurn>,
): ChatModel {
  let calls = 0;
  return {
    async generate() { throw new Error('streamModel drives stream(); use textModel for one-shot callers'); },
    async *stream(req) {
      const n = calls++;
      const t = await turn(req, n);
      const toolCalls = (t.toolCalls ?? []).map((c, i) => ({
        type: 'tool-call' as const,
        toolCallId: `fake-${n}-${i}-${c.toolName}`,
        toolName: c.toolName,
        input: c.input,
      }));
      for (const call of toolCalls) yield call;
      if (t.text) {
        yield { type: 'text-start', id: '0' };
        yield { type: 'text-delta', id: '0', text: t.text };
        yield { type: 'text-end', id: '0' };
      }
      yield { type: 'finish', reason: toolCalls.length ? 'tool-calls' : 'stop', usage: t.usage ?? zeroUsage() };
    },
  };
}

/** streamModel scripted by position; throws past the end so an unexpected extra step fails the
 * test instead of silently replaying the last turn. */
export function turnsModel(turns: FakeTurn[]): ChatModel {
  return streamModel((_req, call) => {
    const t = turns[call];
    if (!t) throw new Error(`scripted model exhausted after ${turns.length} turns`);
    return t;
  });
}

/** True once the transcript carries any tool-result — the request-shape probe order-independent
 * fakes use to tell "first step" (call the tool) from "later step" (stop). */
export function sawToolResult(req: ChatRequest): boolean {
  return req.messages.some((m) => m.content.some((p) => p.type === 'tool-result'));
}

function promptText(req: ChatRequest): string {
  const parts = req.messages.map((m) =>
    m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n'));
  if (req.system !== undefined) parts.unshift(req.system);
  return parts.join('\n');
}

export function textModel(reply: string | ((prompt: string) => string)) {
  const prompts: string[] = [];
  const respond = (req: ChatRequest): GenerateResult => {
    const prompt = promptText(req);
    prompts.push(prompt);
    const text = typeof reply === 'function' ? reply(prompt) : reply;
    if (req.toolChoice !== undefined && req.toolChoice !== 'auto') {
      try {
        const input = JSON.parse(text);
        return {
          text: '',
          toolCalls: [{ type: 'tool-call', toolCallId: 'mock-call', toolName: req.toolChoice.name, input }],
          usage: zeroUsage(), finishReason: 'tool-calls',
        };
      } catch { /* non-JSON reply to a forced tool: fall through as text, no tool call */ }
    }
    return { text, toolCalls: [], usage: zeroUsage(), finishReason: 'stop' };
  };
  const model: ChatModel = {
    async generate(req) {
      return respond(req);
    },
    // No one-shot caller streams today; the events mirror generate() so the fake stays a full
    // ChatModel rather than throwing on half its interface.
    async *stream(req) {
      const r = respond(req);
      for (const call of r.toolCalls) yield call;
      if (r.text) {
        yield { type: 'text-start', id: '0' };
        yield { type: 'text-delta', id: '0', text: r.text };
        yield { type: 'text-end', id: '0' };
      }
      yield { type: 'finish', reason: r.finishReason, usage: r.usage };
    },
  };
  return { model, prompts };
}
