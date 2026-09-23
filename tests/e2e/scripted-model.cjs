'use strict';

const fs = require('node:fs');

/**
 * E2E hook. CommonJS on purpose: src/server/models.ts is ESM and reaches this file via
 * `createRequire(import.meta.url)` so `require()` works from inside a "type": "module" package.
 *
 * One factory, one script format:
 *   { turns: [ { when？: string, toolCalls？: [{ toolName, input }], text？: string } ] }
 *
 * A turn with `when` is KEYED: it is served, once, to the first request whose current user text
 * (every user-role text after the request's last assistant message — the learner's words on a
 * fresh turn, the harness's tail notes on a grading continuation, the question on an aside call)
 * contains that string, case-blind. Unkeyed turns are served in order to every other request, as
 * before. Keys let two spec files share one backend without depending on which runs first, and
 * make a turn an assertion about its request: a reply keyed on a harness note only arrives if
 * that note reached the model.
 *
 * createChatModel(scriptPath) — the first-party ChatModel (src/server/llm/types.ts) that
 * chatModelFor resolves for EVERY role: the tutor loop and compile agent drive stream(), the
 * one-shot roles (grading, gap help, card gen) drive generate().
 *
 * ALL models for one scriptPath share one turn counter (module-level `states`): the tutor session
 * holds its model while every grading call resolves a fresh chatModelFor, and if each kept its
 * own counter the grader would replay the first tool-call turn forever instead of reaching its
 * scripted verdict.
 *
 * The script file is read LAZILY (only when a turn is popped, never at factory call time) —
 * tests/models.test.ts's ESM-require regression test sets LW_MOCK_MODEL to a path that doesn't
 * exist and only asserts chatModelFor() returns a model; it must not blow up with ENOENT for a
 * bogus script path that is never actually streamed from.
 *
 * Past the end of the script the two methods diverge on purpose:
 *   - stream() returns an EMPTY tool-call-free 'stop' turn so the loop terminates cleanly. This
 *     covers the extra step the loop takes after a turn that both emits text AND calls a
 *     loop-executed tool (e.g. record_evidence): it re-invokes the model once more with the tool
 *     result appended, which a fixed 2-turn E2E script does not itself account for — and that
 *     extra step must not smuggle default text into the rendered conversation.
 *   - generate() defaults to 'CORRECT — scripted.' so a scripted drive's model-graded answers
 *     pass without the script enumerating every grading call.
 */

// scriptPath -> { turns, used, served }, shared by every model built for that path.
const states = new Map();

function stateFor(scriptPath) {
  let st = states.get(scriptPath);
  if (!st) {
    st = { turns: null, used: new Set(), served: 0 };
    states.set(scriptPath, st);
  }
  return st;
}

/** What a keyed turn's `when` is matched against — see the header comment. */
function currentUserText(req) {
  const messages = (req && req.messages) || [];
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { start = i + 1; break; }
  }
  return messages.slice(start).filter((m) => m.role === 'user')
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]))
    .filter((p) => p && p.type === 'text').map((p) => p.text).join('\n').toLowerCase();
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

function popTurn(scriptPath, method, req) {
  const st = stateFor(scriptPath);
  if (st.turns === null) {
    const raw = fs.readFileSync(scriptPath, 'utf8');
    const parsed = JSON.parse(raw);
    st.turns = Array.isArray(parsed.turns) ? parsed.turns : [];
  }
  const said = currentUserText(req);
  let index = st.turns.findIndex((t, i) => !st.used.has(i) && t.when && said.includes(t.when.toLowerCase()));
  if (index === -1) index = st.turns.findIndex((t, i) => !st.used.has(i) && !t.when);
  const turn = index === -1 ? undefined : st.turns[index];
  if (index !== -1) st.used.add(index);
  trace(method, index, turn);
  st.served += 1;
  // 1-based count of turns served, for the ids the pre-refactor single-counter code minted.
  return { turn, n: st.served };
}

const SCRIPTED_USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

function chatTurn(scriptPath, method, req) {
  const { turn, n } = popTurn(scriptPath, method, req);
  const toolCalls = ((turn && turn.toolCalls) || []).map((call, i) => ({
    type: 'tool-call',
    toolCallId: `scripted-${n}-${i}-${call.toolName}`,
    toolName: call.toolName,
    // First-party tool-call input is the parsed value, never a JSON string.
    input: call.input,
  }));
  return { turn, toolCalls, n };
}

function createChatModel(scriptPath) {
  return {
    async generate(req) {
      const { turn, toolCalls } = chatTurn(scriptPath, 'generate', req);
      // The past-end default: a one-shot grade past the script's end passes.
      const text = (turn && turn.text) || (toolCalls.length ? '' : 'CORRECT — scripted.');
      return {
        text,
        toolCalls,
        usage: SCRIPTED_USAGE,
        finishReason: toolCalls.length ? 'tool-calls' : 'stop',
      };
    },

    async *stream(req) {
      const { turn, toolCalls, n } = chatTurn(scriptPath, 'stream', req);
      // Past-end streams are EMPTY (see the header comment) — the loop ends, no default text.
      const text = (turn && turn.text) || '';
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

module.exports = { createChatModel };
