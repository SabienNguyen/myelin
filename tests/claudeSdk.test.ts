import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Agent SDK's query() before importing the module under test — claudeSdkGenerate must
// never actually spawn the Claude Code CLI / touch a subscription in CI.
const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

async function* messages(msgs: unknown[]) {
  for (const m of msgs) yield m;
}

const { isClaudeSdkModel, stripClaudeSdkPrefix, claudeSdkGenerate } = await import('../src/server/claudeSdk.js');

describe('isClaudeSdkModel', () => {
  it('matches only the claude-sdk: prefix', () => {
    expect(isClaudeSdkModel('claude-sdk:sonnet')).toBe(true);
    expect(isClaudeSdkModel('claude-sdk:claude-opus-4-8')).toBe(true);
    expect(isClaudeSdkModel('claude-sonnet-5')).toBe(false);
    expect(isClaudeSdkModel('ollama:qwen')).toBe(false);
    expect(isClaudeSdkModel('')).toBe(false);
  });
});

describe('stripClaudeSdkPrefix', () => {
  it('removes the prefix, leaving the bare model id', () => {
    expect(stripClaudeSdkPrefix('claude-sdk:sonnet')).toBe('sonnet');
  });
});

describe('claudeSdkGenerate', () => {
  beforeEach(() => queryMock.mockReset());

  it('drains the generator, returning the final assistant text and bare tool names', async () => {
    queryMock.mockReturnValue(messages([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__loreweaver__write_page', input: {} }] },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'working...' }] } },
      { type: 'result', subtype: 'success', result: 'Done — wrote 1 page.', is_error: false },
    ]));

    const res = await claudeSdkGenerate({ model: 'sonnet', prompt: 'Say OK' });
    expect(res.text).toBe('Done — wrote 1 page.');
    expect(res.toolCallNames).toEqual(['write_page']);
  });

  it('passes model, prompt, and permissionMode/allowDangerouslySkipPermissions through to query()', async () => {
    queryMock.mockReturnValue(messages([
      { type: 'result', subtype: 'success', result: 'OK', is_error: false },
    ]));

    await claudeSdkGenerate({ model: 'sonnet', prompt: 'hello', system: 'be terse', maxTurns: 3 });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0][0] as any;
    expect(call.prompt).toBe('hello');
    expect(call.options.model).toBe('sonnet');
    expect(call.options.systemPrompt).toBe('be terse');
    expect(call.options.maxTurns).toBe(3);
    expect(call.options.permissionMode).toBe('bypassPermissions');
    expect(call.options.allowDangerouslySkipPermissions).toBe(true);
    // maxTurns 3 leaves room to consume a tool result, so built-ins stay available.
    expect(call.options.tools).toBeUndefined();
  });

  it('strips built-in tools on a one-turn query, where any tool call is a guaranteed error_max_turns', async () => {
    queryMock.mockReturnValue(messages([
      { type: 'result', subtype: 'success', result: 'OK', is_error: false },
    ]));

    await claudeSdkGenerate({ model: 'sonnet', prompt: 'judge this rubric', maxTurns: 1 });

    const call = queryMock.mock.calls[0][0] as any;
    expect(call.options.tools).toEqual([]);
  });

  it('wires mcp.loreweaver into options.mcpServers as a stdio server, and allowedTools through', async () => {
    queryMock.mockReturnValue(messages([
      { type: 'result', subtype: 'success', result: 'OK', is_error: false },
    ]));

    await claudeSdkGenerate({
      model: 'sonnet',
      prompt: 'compile',
      mcp: { loreweaver: { command: 'npx', args: ['tsx', 'server.ts'], env: { LOREWEAVER_VAULT: '/vault' } } },
      allowedTools: ['mcp__loreweaver__write_page'],
      maxTurns: 24,
    });

    const call = queryMock.mock.calls[0][0] as any;
    expect(call.options.mcpServers).toEqual({
      loreweaver: { type: 'stdio', command: 'npx', args: ['tsx', 'server.ts'], env: { LOREWEAVER_VAULT: '/vault' } },
    });
    expect(call.options.allowedTools).toEqual(['mcp__loreweaver__write_page']);
  });

  it('throws a readable error when the query ends in a non-success result', async () => {
    queryMock.mockReturnValue(messages([
      { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['ran out of turns'] },
    ]));

    await expect(claudeSdkGenerate({ model: 'sonnet', prompt: 'x' }))
      .rejects.toThrow(/error_max_turns.*ran out of turns/);
  });

  it('normalizes multi-underscore tool names by splitting only the mcp__server__ prefix', async () => {
    queryMock.mockReturnValue(messages([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__loreweaver__link_pages', input: {} }] },
      },
      { type: 'result', subtype: 'success', result: 'ok', is_error: false },
    ]));
    const res = await claudeSdkGenerate({ model: 'sonnet', prompt: 'x' });
    expect(res.toolCallNames).toEqual(['link_pages']);
  });
});
