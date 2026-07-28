import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Loreweaver } from '../src/server/mcp.js';
import { courseMcpTools, createClaudeSdkTutorSession } from '../src/server/claudeSdkTutor.js';
import { getGraphCached, invalidateGraphCache } from '../src/server/graphCache.js';
import { loadSdkSession, loadThread, saveSdkSession } from '../src/server/sessionStore.js';
import { LW_REPO } from './lwRepo.js';

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

  it('does NOT nudge when the only grade carries no evidence (unavailable code_exercise)', async () => {
    // Parity with the ai-sdk route: an unavailable code_exercise grades with evidence: [], the tutor
    // is asked to "record_evidence for: []" and correctly records nothing. Gating the guardrail on
    // grade COUNT (not evidence) spent an extra query and flashed a false "evidence not recorded"
    // warning every time the sandbox was down.
    saveSdkSession(vault, 'thread-noevidence', 'sess-n0');
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      const sid = `sess-n${calls.length}`;
      yield initMsg(sid);
      yield assistantMsg(sid, [{ type: 'text', text: 'The coding sandbox is down — try again shortly.' }]);
      yield resultMsg(sid);
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'let me code' }] },
      {
        id: 'a1', role: 'assistant', parts: [{
          type: 'tool-code_exercise', toolCallId: 'tc9', state: 'output-available',
          input: { pageSlug: 'streams', rungId: 'stream-consumer:full_body' },
          output: { unavailable: true },
        }],
      },
    ] as any[];
    await drain(await session.respond(history, 'learn', 'thread-noevidence'));

    expect(calls.length).toBe(1); // no nudge — there was no evidence to record
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

describe('single-writer rule: the SDK hook confines every vault-mutating loreweaver tool to freeform', () => {
  // unlink_pages rewrites the page to delete an edge — a vault mutation like write_page/link_pages.
  // allowedTools does not gate under bypassPermissions (see the hook's own comment), so if the hook
  // does not name unlink_pages it is auto-allowed in learn/review/quiz — the drift this locks out.
  async function hookFor(mode: any) {
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      yield initMsg('sess-sw');
      yield assistantMsg('sess-sw', [{ type: 'text', text: 'ok' }]);
      yield resultMsg('sess-sw');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    await drain(await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any,
      mode, `thread-sw-${mode}`,
    ));
    return calls[0].options.hooks.PreToolUse[0].hooks[0];
  }
  const call = (hookFn: any, tool: string) => hookFn(
    { hook_event_name: 'PreToolUse', session_id: 'sess-sw', transcript_path: '/tmp/x', cwd: '/tmp',
      tool_name: `mcp__loreweaver__${tool}`, tool_input: { src: 'a', dst: 'b', type: 'prereq' }, tool_use_id: 't' },
    't', { signal: new AbortController().signal },
  );

  it('denies unlink_pages in learn mode (it prunes graph edges — a write)', async () => {
    const res = await call(await hookFor('learn'), 'unlink_pages');
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(res.hookSpecificOutput.permissionDecisionReason).toMatch(/freeform/i);
  }, 30_000);

  it('allows unlink_pages in freeform mode (where the single-writer rule permits edits)', async () => {
    const res = await call(await hookFor('freeform'), 'unlink_pages');
    expect(res.hookSpecificOutput.permissionDecision).toBe('allow');
  }, 30_000);

  it('denies the whole write family (write_page, link_pages, unlink_pages, compile_source, create_path) in review mode', async () => {
    const hookFn = await hookFor('review');
    for (const tool of ['write_page', 'link_pages', 'unlink_pages', 'compile_source', 'create_path']) {
      const res = await call(hookFn, tool);
      expect(res.hookSpecificOutput.permissionDecision, tool).toBe('deny');
    }
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

describe('structural rule 1a — grading turns withhold the block tools', () => {
  it('a grading turn lists only the navigation UI tools; a user turn lists all', async () => {
    const { blockAllowlist } = await import('../src/server/claudeSdkTutor.js');
    const grading = blockAllowlist(true);
    const user = blockAllowlist(false);
    // open_source, speak, offer_write are navigation, not graded work — all survive the withhold.
    expect(grading.sort()).toEqual(
      ['mcp__blocks__offer_write', 'mcp__blocks__open_source', 'mcp__blocks__speak']);
    expect(user).toContain('mcp__blocks__quiz');
    expect(user).toContain('mcp__blocks__writing_draft');
    expect(user).toContain('mcp__blocks__open_source');
    expect(user).toContain('mcp__blocks__speak');
    expect(user).toContain('mcp__blocks__offer_write');
  });
});

describe('step boundary — a grade turn must not re-trigger the client auto-resubmit', () => {
  // ai@7 APPENDS a sendAutomaticallyWhen-triggered response onto the existing assistant message.
  // Without a start-step chunk after the graded output, the block part stays inside the last step
  // and runtime.tsx's blockOutputsComplete resubmits forever (live probe: the resumed session
  // received the stale user text ~40 times). streamText emits this boundary on the ai-sdk route;
  // this route's hand-rolled stream must too.
  it('emits start-step AFTER the graded tool-output-available, so the block leaves the last step', async () => {
    saveSdkSession(vault, 'thread-step', 'sess-step');
    async function* fakeQuery() {
      yield initMsg('sess-step');
      yield assistantMsg('sess-step', [
        { type: 'text', text: 'Graded.' },
        { type: 'tool_use', id: 'tc-ev2', name: 'mcp__loreweaver__record_evidence', input: { student: 'kid', slug: 'arith', kind: 'applied-correctly', note: 'x' } },
      ]);
      yield resultMsg('sess-step');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
      {
        id: 'a1', role: 'assistant', parts: [{
          type: 'tool-quick_check', toolCallId: 'tc-step', state: 'output-available',
          input: { question: '2+2?', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' },
          output: { answer: '4' },
        }],
      },
    ] as any[];
    const chunks = chunksOf(await drain(await session.respond(history, 'learn', 'thread-step')));
    const gradedAt = chunks.findIndex((c) => c.type === 'tool-output-available' && c.toolCallId === 'tc-step');
    const stepAt = chunks.findIndex((c) => c.type === 'start-step');
    expect(gradedAt).toBeGreaterThanOrEqual(0);
    expect(stepAt).toBeGreaterThan(gradedAt);
  }, 30_000);
});

describe('freeform research grant', () => {
  // The cold-start sitting that motivated this: freeform always spreads WebSearch/WebFetch into
  // allowedTools, but the system prompt said they arrive only with a HARNESS gap line — which
  // freeform never sends. The model obeyed and compiled a brand-new subject from memory. The
  // prompt and the grant must agree, and a research call must be visible in the stream.
  it('tells the model its web tools are live, allows create_path, and streams the WebSearch call', async () => {
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      yield initMsg('sess-ff');
      yield assistantMsg('sess-ff', [
        { type: 'tool_use', id: 'tc-ws', name: 'WebSearch', input: { query: 'music harmony basics' } },
      ]);
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc-ws', content: [{ type: 'text', text: 'results' }] }] },
        parent_tool_use_id: null, uuid: 'u-user-ws', session_id: 'sess-ff',
      } as any;
      yield assistantMsg('sess-ff', [
        { type: 'tool_use', id: 'tc-wf', name: 'WebFetch', input: { url: 'https://example.org', prompt: 'read it' } },
      ]);
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc-wf', is_error: true, content: [{ type: 'text', text: 'Socket is closed' }] }] },
        parent_tool_use_id: null, uuid: 'u-user-wf', session_id: 'sess-ff',
      } as any;
      yield assistantMsg('sess-ff', [{ type: 'text', text: 'Here is what I found.' }]);
      yield resultMsg('sess-ff');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    const chunks = chunksOf(await drain(await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'teach me harmony' }] }] as any,
      'freeform', 'thread-ff',
    )));

    expect(calls[0].options.allowedTools).toContain('WebSearch');
    expect(calls[0].options.allowedTools).toContain('WebFetch');
    expect(calls[0].options.allowedTools).toContain('mcp__loreweaver__create_path');
    expect(calls[0].options.systemPrompt).toMatch(/available on every turn in this mode/);
    expect(calls[0].options.systemPrompt).not.toMatch(/HARNESS gap line/);

    const call = chunks.find((c) => c.type === 'tool-input-available' && c.toolCallId === 'tc-ws');
    expect(call?.toolName).toBe('WebSearch');
    expect(chunks.some((c) => c.type === 'tool-output-available' && c.toolCallId === 'tc-ws')).toBe(true);

    // The failed WebFetch must reach the chip AS a failure: the tool_result block's is_error is
    // the only signal, and dropping it showed "read a web page" over a dead socket.
    const failed = chunks.find((c) => c.type === 'tool-output-available' && c.toolCallId === 'tc-wf');
    expect(failed?.output?.isError).toBe(true);
  }, 30_000);

  it('keeps the gap-line wording outside freeform', async () => {
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      yield initMsg('sess-ln');
      yield assistantMsg('sess-ln', [{ type: 'text', text: 'hi' }]);
      yield resultMsg('sess-ln');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    await drain(await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] as any,
      'learn', 'thread-ln',
    ));
    expect(calls[0].options.systemPrompt).toMatch(/HARNESS gap line/);
    expect(calls[0].options.systemPrompt).not.toMatch(/available on every turn in this mode/);
  }, 30_000);
});

// Session context was first-turn-only, so flipping the mode selector mid-thread left the tutor
// acting on the context of the mode the learner left. A live decay sitting caught it: "review"
// selected over a thread whose turn-1 context predated the slippage, and the tutor answered
// "what have I let slip?" with a lecture on forgetting curves instead of re-proving the slipped
// page. A mid-thread mode switch must re-inject fresh context; the same mode must not.
describe('mid-thread mode switch re-injects session context', () => {
  const history = (n: number) => [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hi', state: 'done' }] },
    { id: `u${n}`, role: 'user', parts: [{ type: 'text', text: 'what have I let slip?' }] },
  ] as any;

  it('re-arms bootstrap on switch, stays quiet without one', async () => {
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      yield initMsg('sess-modeswitch');
      yield assistantMsg('sess-modeswitch', [{ type: 'text', text: 'ok' }]);
      yield resultMsg('sess-modeswitch');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });

    // Turn 1 establishes the thread's mode (learn).
    await drain(await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] as any,
      'learn', 'thread-modeswitch'));
    // Turn 2, same mode: no re-injection — the prompt is just the student's text.
    await drain(await session.respond(history(2), 'learn', 'thread-modeswitch'));
    expect(calls[1].prompt).not.toMatch(/SESSION CONTEXT/);
    // Turn 3, switched to review: fresh context, explicitly marked as a mode switch.
    await drain(await session.respond(history(3), 'review', 'thread-modeswitch'));
    expect(calls[2].prompt).toMatch(/switched the tutor mode to REVIEW/);
    expect(calls[2].prompt).toMatch(/SESSION CONTEXT/);
    // Turn 4, still review: quiet again.
    await drain(await session.respond(history(4), 'review', 'thread-modeswitch'));
    expect(calls[3].prompt).not.toMatch(/SESSION CONTEXT/);
  });
});

// The client persists the thread only when ITS stream finishes — so a tab closed mid-answer lost
// the assistant turn the server had completed (this session's quiz sitting hit it three times:
// tutor and learner ended up with different histories). The server now saves the turn itself on
// stream end; the client's own PUT converges via saveThread's union-by-id because
// generateId makes both sides name the response message identically.
describe('server-side thread persistence', () => {
  it('the assistant turn is on disk after the stream ends, with no client PUT', async () => {
    async function* fakeQuery() {
      yield initMsg('sess-serversave');
      yield assistantMsg('sess-serversave', [{ type: 'text', text: 'saved server-side' }]);
      yield resultMsg('sess-serversave');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    await drain(await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] as any,
      'learn', 'thread-serversave'));
    const saved = loadThread(vault, 'thread-serversave') as any[];
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(saved[1].id).toBeTruthy(); // named — the client's copy will carry the same id
    expect(JSON.stringify(saved[1].parts)).toContain('saved server-side');
  });
});

// Spec §5's single-writer rule was held back by PROMPT alone on this route — allowedTools gates
// nothing under bypassPermissions — and a live sitting watched "update the page NOW" override
// the prompt and write_page succeed in learn mode. The PreToolUse hook is the seam
// bypassPermissions honors; it must deny the write family outside freeform.
describe('PreToolUse hook enforces freeform-only writes', () => {
  async function hookFor(mode: string) {
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      yield initMsg('sess-hook');
      yield assistantMsg('sess-hook', [{ type: 'text', text: 'ok' }]);
      yield resultMsg('sess-hook');
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    await drain(await session.respond(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any,
      mode as any, `thread-hook-${mode}`));
    return calls[0].options.hooks.PreToolUse[0].hooks[0];
  }
  const call = (hook: any, tool: string) => hook({
    hook_event_name: 'PreToolUse', tool_name: `mcp__loreweaver__${tool}`, tool_input: { student: 'kid' },
  });

  it('denies write_page in learn, allows it in freeform, always allows teach tools', async () => {
    const learnHook = await hookFor('learn');
    const denied = await call(learnHook, 'write_page');
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toMatch(/freeform/);
    const teach = await call(learnHook, 'record_evidence');
    expect(teach.hookSpecificOutput.permissionDecision).toBe('allow');

    const freeHook = await hookFor('freeform');
    const allowed = await call(freeHook, 'write_page');
    expect(allowed.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('grade-turn block-tool withholding is hook-enforced, not just allowedTools', () => {
  // allowedTools does not gate under bypassPermissions (the write-family hook exists for the same
  // reason), so a grade turn's blockAllowlist([]) was prompt-only until the hook denied block tools
  // too — matching turnBlockTools' structural drop on the ai-sdk route.
  const blockToolCall = { hook_event_name: 'PreToolUse', tool_name: 'mcp__blocks__quick_check', tool_input: {} };

  async function preToolUseHookFor(history: any[], threadId: string): Promise<any> {
    const calls: any[] = [];
    async function* fakeQuery(params: any) {
      calls.push(params);
      const sid = `sess-bh${calls.length}`;
      yield initMsg(sid);
      yield assistantMsg(sid, [{ type: 'text', text: 'ok' }]);
      yield resultMsg(sid);
    }
    const session = createClaudeSdkTutorSession(lw, cfg, { queryImpl: fakeQuery });
    await drain(await session.respond(history, 'learn', threadId));
    return calls[0].options.hooks.PreToolUse[0].hooks[0];
  }

  it('denies a block tool on a grade turn but lets it through on a normal turn', async () => {
    const gradeTurn = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
      { id: 'a1', role: 'assistant', parts: [{
        type: 'tool-quick_check', toolCallId: 'tc', state: 'output-available',
        input: { question: '2+2?', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' },
        output: { answer: '4' },
      }] },
    ] as any[];
    const gradeHook = await preToolUseHookFor(gradeTurn, 'thread-blockhook-grade');
    const denied = await gradeHook(blockToolCall);
    expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');

    const plainTurn = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'teach me fractions' }] }] as any[];
    const plainHook = await preToolUseHookFor(plainTurn, 'thread-blockhook-plain');
    expect(await plainHook(blockToolCall)).toEqual({}); // not a grade turn — passes through
  }, 30_000);
});
