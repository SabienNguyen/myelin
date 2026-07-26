'use strict';

const fs = require('node:fs');

/**
 * E2E hook (Task 12). CommonJS on purpose: src/server/models.ts is ESM and reaches this file
 * via `createRequire(import.meta.url)` so `require()` works from inside a "type": "module"
 * package.
 *
 * createScriptedModel(scriptPath) returns a LanguageModelV3-shaped object (ai@7 / @ai-sdk/provider
 * v3 stream chunk shapes — usage nested {inputTokens:{...}, outputTokens:{...}}, finishReason
 * {unified, raw}). Each doStream() call pops the next turn from a JSON script:
 *   { turns: [ { toolCalls？: [{ toolName, input }], text？: string } ] }
 * emitting one 'tool-call' chunk per scripted tool call, then text chunks, then 'finish'.
 *
 * The script file is read LAZILY (only inside doStream, never at createScriptedModel() call
 * time) — tests/models.test.ts's ESM-require regression test sets LW_MOCK_MODEL to a path that
 * doesn't exist and only asserts modelFor() returns a defined model (or fails with a
 * MODULE_NOT_FOUND naming 'scripted-model'); it must not blow up with ENOENT for a bogus script
 * path that is never actually streamed from.
 *
 * Calls past the end of the script return an empty, tool-call-free 'stop' finish so the agent
 * loop (ToolLoopAgent, via ai's streamText step loop) terminates cleanly instead of erroring —
 * this covers the extra step the SDK takes after a step that both emits text AND calls a
 * server-executed tool (e.g. record_evidence): it re-invokes the model once more with the tool
 * result appended, which our fixed 2-turn E2E script does not itself account for.
 */
function createScriptedModel(scriptPath) {
  let turns = null;
  let index = 0;

  function loadTurns() {
    if (turns === null) {
      const raw = fs.readFileSync(scriptPath, 'utf8');
      const parsed = JSON.parse(raw);
      turns = Array.isArray(parsed.turns) ? parsed.turns : [];
    }
    return turns;
  }

  return {
    specificationVersion: 'v3',
    provider: 'scripted-e2e',
    modelId: `scripted-model(${scriptPath})`,
    supportedUrls: {},

    async doGenerate() {
      // The claim this used to throw with — "the harness only ever calls doStream" — stopped being
      // true when quiz short answers went through gradeOpenAnswer's generateText. A doGenerate that
      // pops a turn and returns its text lets scripted drives exercise MODEL-GRADED paths too.
      const turn = loadTurns()[index];
      index += 1;
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
      const allTurns = loadTurns();
      const turn = allTurns[index];
      index += 1;

      const toolCalls = (turn && turn.toolCalls) || [];
      const parts = [];

      toolCalls.forEach((call, i) => {
        parts.push({
          type: 'tool-call',
          toolCallId: `scripted-${index}-${i}-${call.toolName}`,
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        });
      });

      if (turn && turn.text) {
        const id = `scripted-text-${index}`;
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

module.exports = { createScriptedModel };
