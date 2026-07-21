import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Loreweaver } from '../src/server/mcp.js';
import { createClaudeSdkTutorSession } from '../src/server/claudeSdkTutor.js';
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

    // turn-1 prompt carries the bootstrap ("SESSION CONTEXT") since there's no prior assistant turn
    expect(calls[0].prompt).toMatch(/SESSION CONTEXT/);
    expect(calls[0].options.resume).toBeUndefined();
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
    expect(calls[0].prompt).toMatch(/HARNESS: graded block results attached above/);
    expect(calls[0].prompt).not.toMatch(/SESSION CONTEXT/); // not turn 1 — no bootstrap re-sent
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
