'use strict';

const fs = require('node:fs');

/**
 * E2E hook (Task 12). CommonJS on purpose: src/server/models.ts is ESM and reaches this file
 * via `createRequire(import.meta.url)` so `require()` works from inside a "type": "module"
 * package.
 *
 * Two factories, one script format:
 *   { turns: [ { toolCalls？: [{ toolName, input }], text？: string } ] }
 *
 * - createScriptedModel(scriptPath) — a LanguageModelV3-shaped object (ai@7 / @ai-sdk/provider
 *   v3 stream chunk shapes — usage nested {inputTokens:{...}, outputTokens:{...}}, finishReason
 *   {unified, raw}) for the tutor loop, which stays on the AI SDK until own-harness phase C.
 * - createChatModel(scriptPath) — the first-party ChatModel (src/server/llm/types.ts) that
 *   chatModelFor hands the one-shot roles (grading, gap help, card gen).
 *
 * ALL factories for one scriptPath share one turn counter (module-level `states`): the tutor
 * session holds its V3 model while every grading call resolves a fresh ChatModel, and if each
 * kept its own counter the grader would replay the first tool-call turn forever instead of
 * reaching its scripted verdict.
 *
 * The script file is read LAZILY (only when a turn is popped, never at factory call time) —
 * tests/models.test.ts's ESM-require regression test sets LW_MOCK_MODEL to a path that doesn't
 * exist and only asserts modelFor() returns a defined model (or fails with a MODULE_NOT_FOUND
 * naming 'scripted-model'); it must not blow up with ENOENT for a bogus script path that is
 * never actually streamed from.
 *
 * Calls past the end of the script return an empty, tool-call-free 'stop' finish so the agent
 * loop terminates cleanly instead of erroring — this covers the extra step the SDK takes after
 * a step that both emits text AND calls a server-executed tool (e.g. record_evidence): it
 * re-invokes the model once more with the tool result appended, which our fixed 2-turn E2E
 * script does not itself account for. One-shot generate calls past the end default to
 * 'CORRECT — scripted.' so a scripted drive's model-graded answers pass without the script
 * enumerating every grading call.
 */

// scriptPath -> { turns, index }, shared by every model built for that path.
const states = new Map();

function stateFor(scriptPath) {
  let st = states.get(scriptPath);
  if (!st) {
    st = { turns: null, index: 0 };
    states.set(scriptPath, st);
  }
  return st;
}

// Because every method shares one turn counter, a mis-ordered script surfaces as a baffling
// wrong-verdict or parse failure far from here. LW_MOCK_TRACE=<path> appends one line per pop
// so a drive can SEE which call consumed which turn.
function trace(method, i, turn) {
  const tracePath = process.env.LW_MOCK_TRACE;
  if (!tracePath) return;
  const summary = turn
    ? `toolCalls=[${(turn.toolCalls || []).map((c) => c.toolName).join(',')}] text=${JSON.stringify((turn.text || '').slice(0, 60))}`
    : 'PAST-END';
  try { fs.appendFileSync(tracePath, `${method} turn[${i}] ${summary}\n`); } catch { /* trace is best-effort */ }
}

function popTurn(scriptPath, method) {
  const st = stateFor(scriptPath);
  if (st.turns === null) {
    const raw = fs.readFileSync(scriptPath, 'utf8');
    const parsed = JSON.parse(raw);
    st.turns = Array.isArray(parsed.turns) ? parsed.turns : [];
  }
  const turn = st.turns[st.index];
  trace(method, st.index, turn);
  st.index += 1;
  // 1-based turn number, for the ids the pre-refactor single-counter code minted.
  return { turn, n: st.index };
}

function createScriptedModel(scriptPath) {
  return {
    specificationVersion: 'v3',
    provider: 'scripted-e2e',
    modelId: `scripted-model(${scriptPath})`,
    supportedUrls: {},

    async doGenerate() {
      // The claim this used to throw with — "the harness only ever calls doStream" — stopped being
      // true when quiz short answers went through gradeOpenAnswer's generateText. A doGenerate that
      // pops a turn and returns its text lets scripted drives exercise MODEL-GRADED paths too.
      const { turn } = popTurn(scriptPath, 'doGenerate');
      return {
        content: [{ type: 'text', text: (turn && turn.text) || 'CORRECT — scripted.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },

    async doStream() {
      const { turn, n } = popTurn(scriptPath, 'doStream');

      const toolCalls = (turn && turn.toolCalls) || [];
      const parts = [];

      toolCalls.forEach((call, i) => {
        parts.push({
          type: 'tool-call',
          toolCallId: `scripted-${n}-${i}-${call.toolName}`,
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        });
      });

      if (turn && turn.text) {
        const id = `scripted-text-${n}`;
        parts.push({ type: 'text-start', id });
        parts.push({ type: 'text-delta', id, delta: turn.text });
        parts.push({ type: 'text-end', id });
      }

      parts.push({
        type: 'finish',
        finishReason: {
          unified: toolCalls.length ? 'tool-calls' : 'stop',
          raw: toolCalls.length ? 'tool_use' : 'end_turn',
        },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
      });

      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

const SCRIPTED_USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

function chatTurn(scriptPath, method) {
  const { turn, n } = popTurn(scriptPath, method);
  const toolCalls = ((turn && turn.toolCalls) || []).map((call, i) => ({
    type: 'tool-call',
    toolCallId: `scripted-${n}-${i}-${call.toolName}`,
    toolName: call.toolName,
    // First-party tool-call input is the parsed value; only the V3 stream path stringifies.
    input: call.input,
  }));
  return {
    // The past-end default mirrors doGenerate's: a one-shot grade past the script's end passes.
    text: (turn && turn.text) || (toolCalls.length ? '' : 'CORRECT — scripted.'),
    toolCalls,
    n,
  };
}

function createChatModel(scriptPath) {
  return {
    async generate() {
      const { text, toolCalls } = chatTurn(scriptPath, 'generate');
      return {
        text,
        toolCalls,
        usage: SCRIPTED_USAGE,
        finishReason: toolCalls.length ? 'tool-calls' : 'stop',
      };
    },

    async *stream() {
      const { text, toolCalls, n } = chatTurn(scriptPath, 'stream');
      for (const call of toolCalls) yield call;
      if (text) {
        const id = `scripted-text-${n}`;
        yield { type: 'text-start', id };
        yield { type: 'text-delta', id, text };
        yield { type: 'text-end', id };
      }
      yield {
        type: 'finish',
        reason: toolCalls.length ? 'tool-calls' : 'stop',
        usage: SCRIPTED_USAGE,
      };
    },
  };
}

module.exports = { createScriptedModel, createChatModel };
