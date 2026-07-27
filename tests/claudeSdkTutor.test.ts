import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Loreweaver } from '../src/server/mcp.js';
import { courseMcpTools, createClaudeSdkTutorSession } from '../src/server/claudeSdkTutor.js';
import { getGraphCached, invalidateGraphCache } from '../src/server/graphCache.js';
import { loadSdkSession, saveSdkSession } from '../src/server/sessionStore.js';

const LW_REPO = `${process.env.HOME}/Dev/personal/loreweaver`;
let lw: Loreweaver; let vault: string; let cfg: any;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), 'lwh-sdk-vault-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  writeFileSync(join(vault, 'pages', 'arith.md'), '---\ntitle: Arithmetic\ndifficulty: 1\nstatus: solid\n---\nnumbers');
  const loreweaverCfg = { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' as const };
  cfg = { student: 'kid', vault, models: { tutor: { model: 'claude-sdk:sonnet' } }, loreweaver: loreweaverCfg };
  lw = await Loreweaver.connect({ vault, student: 'kid', loreweaver: loreweaverCfg } as any);
}, 30_000);
afterAll(async () => { await lw.close(); });

// --- Fake SDKMessage fixtures (only the fields our translator reads; cast loosely — the real
// types have many required bookkeeping fields we don't exercise). ---
function initMsg(sessionId: string): any {
  return {
    type: 'system', subtype: 'init',
    apiKeySource: 'none', claude_code_version: 'test', cwd: '/tmp',
    tools: [], mcp_servers: [], model: 'test-model', permissionMode: 'bypassPermissions',
    slash_commands: [], output_style: 'default', skills: [], plugins: [],
    uuid: 'u-init', session_id: sessionId,
  };
}
function assistantMsg(sessionId: string, content: any[]): any {
  return {
    type: 'assistant',
    message: { id: 'msg1', type: 'message', role: 'assistant', content, model: 'test', stop_reason: 'end_turn', stop_sequence: null, usage: {} },
    parent_tool_use_id: null, uuid: `u-asst-${Math.random()}`, session_id: sessionId,
  };
}
function resultMsg(sessionId: string): any {
  return {
    type: 'result', subtype: 'success',
    duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1,
    result: 'ok', total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
    uuid: 'u-res', session_id: sessionId,
  };
}
// `stream_event` envelope wraps a raw Anthropic API stream event under its OWN uuid — deliberately
// distinct from the assistant envelope's uuid below, matching the real-world shape that caused Bug A.
function streamEventMsg(sessionId: string, uuid: string, event: any): any {
  return { type: 'stream_event', event, parent_tool_use_id: null, uuid, session_id: sessionId };
}

async function drain(res: Response): Promise<string> { return res.text(); }

function chunksOf(body: string): any[] {
  return body.split('\n').filter((l) => l.startsWith('data:') && l.slice('data: '.length).trim() !== '[DONE]')
    .map((l) => JSON.parse(l.slice('data: '.length)));
}

describe('turn 1 (fresh session)', () => {
  it('persists the SDK session id and streams text + a bare-named block tool-input part', async () => {
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      yield initMsg('sess-turn1');
      yield assistantMsg('sess-turn1', [
        { type: 'text', text: 'Nice, let’s warm up.' },
        {
          type: 'tool_use', id: 'tc1', name: 'mcp__blocks__quick_check',
          input: { question: '2+2?', mode: 'choice', choices: ['3', '4'], pageSlug: 'arith' },
        },
      ]);
      yield resultMsg('sess-turn1');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    const res = await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] as any,
      'learn', 'thread-turn1',
    );
    const body = await drain(res);
    const chunks = chunksOf(body);

    expect(loadSdkSession(vault, 'thread-turn1')).toBe('sess-turn1');
    expect(chunks.some((c) => c.type === 'text-delta' && c.delta.includes('warm up'))).toBe(true);
    const toolChunk = chunks.find((c) => c.type === 'tool-input-available');
    expect(toolChunk).toBeTruthy();
    expect(toolChunk.toolName).toBe('quick_check'); // bare name, no mcp__blocks__ prefix
    expect(toolChunk.toolCallId).toBe('tc1');

    // turn-1 prompt carries the bootstrap ("SESSION CONTEXT") since there's no prior assistant
    // turn — and the student's own message, which only submission turns omit
    expect(calls[0].prompt).toMatch(/SESSION CONTEXT/);
    expect(calls[0].prompt).toContain('hello');
    expect(calls[0].options.resume).toBeUndefined();

    // The base prompt's research rules name ai-sdk tools this route does not have. The system
    // prompt must correct that and give the no-research-tools case an honest script — a live
    // sitting caught the model claiming to have "read" papers on a turn with zero tool calls.
    expect(calls[0].options.systemPrompt).toMatch(/Your only research tools are WebSearch and WebFetch/);
    expect(calls[0].options.systemPrompt).toMatch(/could not reach the live indices/);
    expect(calls[0].options.systemPrompt).toMatch(/NEVER claim to have read, fetched, or checked a source/);
  }, 30_000);
});

describe('follow-up turn with a completed block output', () => {
  it('grades mechanically, resumes with the stored session id, and sends HARNESS graded wording', async () => {
    saveSdkSession(vault, 'thread-followup', 'sess-stored');
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      yield initMsg('sess-stored');
      // Call record_evidence so the guardrail doesn't fire a second query in this test.
      yield assistantMsg('sess-stored', [
        { type: 'text', text: 'Good job.' },
        { type: 'tool_use', id: 'tc-ev', name: 'mcp__loreweaver__record_evidence', input: { student: 'kid', slug: 'arith', kind: 'applied-correctly', note: 'x' } },
      ]);
      yield resultMsg('sess-stored');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
      {
        id: 'a1', role: 'assistant', parts: [{
          type: 'tool-quick_check', toolCallId: 'tc1', state: 'output-available',
          input: { question: '2+2?', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' },
          output: { answer: '4' },
        }],
      },
    ] as any[];
    await drain(await session.respond(history, 'learn', 'thread-followup'));

    expect(calls.length).toBe(1); // record_evidence was called — no guardrail nudge
    expect(calls[0].options.resume).toBe('sess-stored');
    expect(calls[0].prompt).toMatch(/HARNESS: the student answered the block\(s\) you displayed/);
    // The submission itself must ride along: the resumed SDK session only holds the block-display
    // sentinel, so a verdict without the work reads as unverifiable (audit 45: model refused to
    // record_evidence over exactly this).
    expect(calls[0].prompt).toContain('"answer":"4"');
    expect(calls[0].prompt).toMatch(/Graded mechanically\/by the grader as: correct/);
    expect(calls[0].prompt).not.toMatch(/SESSION CONTEXT/); // not turn 1 — no bootstrap re-sent
    // The resumed session already holds the "quiz me" turn. Replaying it here read, live, as the
    // student re-sending the identical request — the model re-taught and staged a diagnostic
    // check over the graded card. A submission turn carries only the harness grade report, and
    // gap detection (keyed off that same stale text) must not re-issue its research directive.
    expect(calls[0].prompt).not.toContain('quiz me');
    expect(calls[0].prompt).not.toMatch(/HARNESS: your memory has a gap/);
  }, 30_000);
});

describe('evidence guardrail', () => {
  it('nudges a second query when record_evidence is never called', async () => {
    saveSdkSession(vault, 'thread-guardrail', 'sess-g0');
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      const sid = `sess-g${calls.length}`;
      yield initMsg(sid);
      yield assistantMsg(sid, [{ type: 'text', text: 'Nice work!' }]); // never calls record_evidence
      yield resultMsg(sid);
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
      {
        id: 'a1', role: 'assistant', parts: [{
          type: 'tool-quick_check', toolCallId: 'tc2', state: 'output-available',
          input: { question: '3+3?', mode: 'choice', choices: ['5', '6'], expected: '6', pageSlug: 'arith' },
          output: { answer: '6' },
        }],
      },
    ] as any[];
    await drain(await session.respond(history, 'learn', 'thread-guardrail'));

    expect(calls.length).toBe(2); // original + one nudged retry
    expect(calls[1].prompt).toMatch(/record_evidence/);
    expect(existsSync(join(vault, '.harness', 'guardrail.log'))).toBe(true);
  }, 30_000);
});

describe('resume-failure fallback', () => {
  it('falls back to a fresh session and overwrites the stored id when resume throws', async () => {
    saveSdkSession(vault, 'thread-stale', 'sess-stale');
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      if (params.options.resume === 'sess-stale') {
        throw new Error('session not found (pruned)');
      }
      yield initMsg('sess-fresh');
      yield assistantMsg('sess-fresh', [{ type: 'text', text: 'Starting over.' }]);
      yield resultMsg('sess-fresh');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    await drain(await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi again' }] }] as any,
      'learn', 'thread-stale',
    ));

    expect(calls.length).toBe(2); // failed resume attempt + fresh fallback
    expect(calls[0].options.resume).toBe('sess-stale');
    expect(calls[1].options.resume).toBeUndefined();
    expect(loadSdkSession(vault, 'thread-stale')).toBe('sess-fresh'); // overwritten
  }, 30_000);
});

describe('Bug A: text streamed via partials must not also re-emit via the assistant fallback', () => {
  it('streams the same text exactly once when stream_events (own uuid) precede the assistant message (different uuid)', async () => {
    async function* fakeQuery(params: any) {
      yield initMsg('sess-dedupe');
      // Partial-stream path: content_block_start/delta/stop under stream-event uuid "u-stream-1".
      yield streamEventMsg('sess-dedupe', 'u-stream-1', { type: 'message_start' });
      yield streamEventMsg('sess-dedupe', 'u-stream-1', {
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
      });
      yield streamEventMsg('sess-dedupe', 'u-stream-1', {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello there.' },
      });
      yield streamEventMsg('sess-dedupe', 'u-stream-1', { type: 'content_block_stop', index: 0 });
      // Fallback path: the SAME text at the SAME index (0), but under a DIFFERENT uuid — the
      // real-world shape (assistantMsg mints its own `u-asst-*` uuid, unrelated to the stream
      // events' "u-stream-1"). Pre-fix, the uuid-keyed dedupe check never matches across envelopes,
      // so this re-emits the already-streamed text a second time.
      yield assistantMsg('sess-dedupe', [{ type: 'text', text: 'Hello there.' }]);
      yield resultMsg('sess-dedupe');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    const res = await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] as any,
      'learn', 'thread-dedupe',
    );
    const chunks = chunksOf(await drain(res));

    const textStarts = chunks.filter((c) => c.type === 'text-start');
    const deltas = chunks.filter((c) => c.type === 'text-delta' && c.delta === 'Hello there.');
    expect(textStarts.length).toBe(1); // exactly one text block was opened, not two
    expect(deltas.length).toBe(1); // the text streamed exactly once, not twice
  }, 30_000);
});

describe('Bug C: real SDK cadence — one assistant envelope PER content block, indices from a different space', () => {
  it('streams thinking -> text -> tool_use with exactly one text-start, one "Hello tools." delta, one tool-input', async () => {
    async function* fakeQuery(params: any) {
      yield initMsg('sess-cadence');
      yield streamEventMsg('sess-cadence', 'u-ms', { type: 'message_start' });
      // content_block_start(0, thinking) — real API index 0.
      yield streamEventMsg('sess-cadence', 'u-cbs0', {
        type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' },
      });
      // Per-block assistant envelope for the thinking block: own uuid, and its ONE block sits at
      // index 0 of THIS envelope's own content array (that happens to coincide with the real API
      // index here, but only by accident — the text block below shows it does not in general).
      yield assistantMsg('sess-cadence', [{ type: 'thinking', thinking: 'let me check the vault', signature: 'sig' }]);
      yield streamEventMsg('sess-cadence', 'u-cbstop0', { type: 'content_block_stop', index: 0 });
      // content_block_start(1, text) — real API index 1.
      yield streamEventMsg('sess-cadence', 'u-cbs1', {
        type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' },
      });
      yield streamEventMsg('sess-cadence', 'u-delta1', {
        type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello tools.' },
      });
      // Per-block assistant envelope for the text block: DIFFERENT uuid, arrives BEFORE
      // content_block_stop(1) — and its ONE block sits at index 0 of ITS OWN content array, not
      // index 1. An index-keyed dedupe check can never match this against the stream_events above.
      yield assistantMsg('sess-cadence', [{ type: 'text', text: 'Hello tools.' }]);
      yield streamEventMsg('sess-cadence', 'u-cbstop1', { type: 'content_block_stop', index: 1 });
      // content_block_start(2, tool_use) — real API index 2.
      yield streamEventMsg('sess-cadence', 'u-cbs2', {
        type: 'content_block_start', index: 2,
        content_block: { type: 'tool_use', id: 'tc-search', name: 'mcp__loreweaver__search', input: {} },
      });
      yield assistantMsg('sess-cadence', [
        { type: 'tool_use', id: 'tc-search', name: 'mcp__loreweaver__search', input: { query: 'arith' } },
      ]);
      yield streamEventMsg('sess-cadence', 'u-cbstop2', { type: 'content_block_stop', index: 2 });
      yield resultMsg('sess-cadence');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    const res = await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'help me with tools' }] }] as any,
      'learn', 'thread-cadence',
    );
    const chunks = chunksOf(await drain(res));

    const textStarts = chunks.filter((c) => c.type === 'text-start');
    const deltas = chunks.filter((c) => c.type === 'text-delta' && c.delta === 'Hello tools.');
    const toolInputs = chunks.filter((c) => c.type === 'tool-input-available' && c.toolCallId === 'tc-search');

    expect(textStarts.length).toBe(1); // exactly one text block was opened, not two
    expect(deltas.length).toBe(1); // the text streamed exactly once, not twice
    expect(toolInputs.length).toBe(1); // tool_use is keyed by stable block.id — always exactly once
  }, 30_000);
});

describe('Bug B: loreweaver arg sanitization is wired through a live seam, not shadowed canUseTool', () => {
  it('exposes a PreToolUse hook (not a bypassPermissions-shadowed canUseTool) that force-corrects the student id', async () => {
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      yield initMsg('sess-hookcheck');
      yield assistantMsg('sess-hookcheck', [{ type: 'text', text: 'ok' }]);
      yield resultMsg('sess-hookcheck');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    await drain(await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any,
      'learn', 'thread-hookcheck',
    ));

    const options = calls[0].options;
    // The dead combination (bypassPermissions relying on canUseTool-only sanitization) is gone:
    // permissionMode is unchanged, but canUseTool is no longer the sanitization seam.
    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.canUseTool).toBeUndefined();

    const matchers = options.hooks?.PreToolUse;
    expect(Array.isArray(matchers) && matchers.length > 0).toBe(true);
    const hookFn = matchers[0].hooks[0];

    const result = await hookFn(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-hookcheck', transcript_path: '/tmp/x', cwd: '/tmp',
        tool_name: 'mcp__loreweaver__record_evidence',
        tool_input: { student: 'WRONG-ID', slug: 'arith', kind: 'applied-correctly', note: 'x' },
        tool_use_id: 'tu1',
      },
      'tu1',
      { signal: new AbortController().signal },
    );
    expect(result.hookSpecificOutput.updatedInput.student).toBe(cfg.student);
  }, 30_000);
});

describe('graph-cache invalidation on the SDK route', () => {
  it('exposes a PostToolUse hook that drops the cached graph after record_evidence, and only then', async () => {
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      yield initMsg('sess-cache');
      yield assistantMsg('sess-cache', [{ type: 'text', text: 'ok' }]);
      yield resultMsg('sess-cache');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    await drain(await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any,
      'learn', 'thread-cache',
    ));

    const matchers = calls[0].options.hooks?.PostToolUse;
    expect(Array.isArray(matchers) && matchers.length > 0).toBe(true);
    const hookFn = matchers[0].hooks[0];
    const hookInput = (toolName: string) => ({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-cache', transcript_path: '/tmp/x', cwd: '/tmp',
      tool_name: toolName, tool_input: {}, tool_response: {}, tool_use_id: 'tu-cache',
    });
    const hookExtra = { signal: new AbortController().signal };

    // Asserted through the cache's public API, not a spy: a fetch only happens when the cache is
    // actually empty, so the fetch count IS the invalidation behavior.
    invalidateGraphCache();
    let fetches = 0;
    const fetchGraph = async () => { fetches += 1; return { nodes: [], goal: null, summary: {} }; };
    await getGraphCached(fetchGraph);
    await getGraphCached(fetchGraph);
    expect(fetches).toBe(1); // warm cache serves without refetching

    await hookFn(hookInput('mcp__loreweaver__read_page'), 'tu-cache', hookExtra);
    await getGraphCached(fetchGraph);
    expect(fetches).toBe(1); // reads must NOT invalidate

    await hookFn(hookInput('mcp__loreweaver__record_evidence'), 'tu-cache', hookExtra);
    await getGraphCached(fetchGraph);
    expect(fetches).toBe(2); // evidence write dropped the cache

    await hookFn(hookInput('mcp__loreweaver__write_page'), 'tu-cache', hookExtra);
    await getGraphCached(fetchGraph);
    expect(fetches).toBe(3); // page write dropped it too
  }, 30_000);
});

describe('course tools on the SDK route', () => {
  function seededVault(): string {
    const v = mkdtempSync(join(tmpdir(), 'lwh-sdk-course-'));
    mkdirSync(join(v, '.harness'), { recursive: true });
    writeFileSync(join(v, '.harness', 'course-bank.jsonl'), [
      JSON.stringify({ id: 'exam#1', source: 'exam', n: 1, text: 'Compute the tax owed on $58,000.', answer: '$10,268', added: '2026-07-20', lastCorrect: '2026-07-21' }),
      JSON.stringify({ id: 'exam#2', source: 'exam', n: 2, text: 'Define a deduction versus a credit.', added: '2026-07-20' }),
    ].join('\n') + '\n');
    return v;
  }

  // Loosely typed on purpose: .find() over the heterogeneous tool array intersects the two
  // handlers' arg shapes, which no real call ever satisfies.
  async function callCourseTool(v: string, name: string, args: Record<string, unknown>): Promise<any> {
    const t = courseMcpTools(v).find((tool) => tool.name === name)! as any;
    const res = await t.handler(args, {});
    return JSON.parse(res.content[0].text);
  }

  it('course_problems serves never-answered first, verbatim, with answer and lastCorrect intact', async () => {
    const v = seededVault();
    const payload = await callCourseTool(v, 'course_problems', { k: 5 });
    expect(payload.problems.map((p: any) => p.id)).toEqual(['exam#2', 'exam#1']);
    expect(payload.problems[0].text).toBe('Define a deduction versus a credit.'); // verbatim contract
    expect(payload.problems[1].answer).toBe('$10,268');
    expect(payload.problems[1].lastCorrect).toBe('2026-07-21');
  });

  it('mark_course_problem persists lastCorrect to the bank on disk; an unknown id is an error', async () => {
    const v = seededVault();
    const ok = await callCourseTool(v, 'mark_course_problem', { id: 'exam#2' });
    expect(ok).toEqual({ marked: 'exam#2' });
    const bank = readFileSync(join(v, '.harness', 'course-bank.jsonl'), 'utf8');
    const entry = bank.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
      .find((e) => e.id === 'exam#2');
    expect(entry.lastCorrect).toBe(new Date().toISOString().slice(0, 10));

    const miss = await callCourseTool(v, 'mark_course_problem', { id: 'nope#9' });
    expect(miss.error).toContain('nope#9');
  });

  it('an empty bank answers with the empty-bank note, not a bare empty list', async () => {
    const v = mkdtempSync(join(tmpdir(), 'lwh-sdk-course-empty-'));
    const payload = await callCourseTool(v, 'course_problems', {});
    expect(payload.problems).toEqual([]);
    expect(payload.note).toContain('course bank is empty');
  });
});
