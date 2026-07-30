import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnMcpServer, type McpConnection } from '../../src/server/llm/mcpClient.js';
import { isTransportError } from '../../src/server/mcp.js';
import { LW_REPO } from '../lwRepo.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.cjs');

const spawnFake = () => spawnMcpServer({
  command: process.execPath,
  args: [FIXTURE],
  onUncaughtError: () => {}, // the die/EPIPE tests make noise by design
});

describe('spawnMcpServer against the fake server', () => {
  let mcp: McpConnection;
  beforeAll(async () => { mcp = await spawnFake(); });
  afterAll(async () => { await mcp.close(); });

  it('completes the initialize handshake and lists tools with raw JSON Schema', async () => {
    const tools = await mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'fail', 'slow', 'split', 'die']);
    const echo = tools[0];
    expect(echo.description).toBe('echoes its arguments back as JSON text');
    // Passthrough, not conversion: the schema arrives exactly as the server declared it.
    expect(echo.inputSchema).toEqual({
      type: 'object', properties: { text: { type: 'string' } }, required: ['text'],
    });
  });

  it('round-trips a tools/call and returns the full result object', async () => {
    const res = await mcp.callTool('echo', { text: 'hê thô' });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text!)).toEqual({ text: 'hê thô' });
  });

  it('returns isError results as VALUES, not rejections — mcp.ts interprets them', async () => {
    const res = await mcp.callTool('fail', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('boom');
  });

  it('reassembles a message split mid-JSON across stdout chunks', async () => {
    const res = await mcp.callTool('split', {});
    expect(res.content[0].text).toBe('reassembled');
  });

  it('serves interleaved concurrent calls by request-id correlation', async () => {
    const [a, b] = await Promise.all([
      mcp.callTool('slow', {}), // answers 50ms later — after echo, out of send order
      mcp.callTool('echo', { text: 'fast' }),
    ]);
    expect(a.content[0].text).toBe('slow');
    expect(JSON.parse(b.content[0].text!)).toEqual({ text: 'fast' });
  });
});

describe('spawnMcpServer transport death', () => {
  it('rejects the pending call when the server exits mid-call, with a transport-shaped error', async () => {
    const mcp = await spawnFake();
    const err = await mcp.callTool('die', {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/closed/);
    // mcp.ts's withRespawn keys off exactly this predicate — the wrapper stays the respawn owner.
    expect(isTransportError(err)).toBe(true);
    // The connection stays dead: later calls reject immediately rather than hanging.
    await expect(mcp.callTool('echo', { text: 'x' })).rejects.toThrow(/closed/);
  });

  it('rejects the initialize handshake when the command cannot spawn', async () => {
    await expect(spawnMcpServer({
      command: '/nonexistent/mcp-server-binary',
      onUncaughtError: () => {},
    })).rejects.toThrow(/closed/);
  });
});

// The real thing: engram runs on @modelcontextprotocol/sdk's StdioServerTransport — the same
// newline-JSON framing — so this proves the handshake and tool calls against the server the
// harness actually spawns. Skipped when the sibling engram checkout is absent (same guard the
// rest of the suite's LW_REPO tests rely on implicitly via CI's checkout layout).
describe.skipIf(!existsSync(LW_REPO))('spawnMcpServer against real engram', () => {
  let mcp: McpConnection;
  let vault: string;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), 'lwh-mcpclient-'));
    mkdirSync(join(vault, 'pages'), { recursive: true });
    writeFileSync(join(vault, 'pages', 'derivatives.md'),
      '---\ntitle: Derivatives\ndifficulty: 1\nstatus: solid\n---\nrates of change');
    mcp = await spawnMcpServer({
      command: 'npx',
      args: ['tsx', join(LW_REPO, 'src/server.ts')],
      env: {
        ...process.env as Record<string, string>,
        ENGRAM_VAULT: vault,
        ENGRAM_EMBEDDINGS: 'fake',
      },
    });
  }, 30_000);
  afterAll(async () => { await mcp?.close(); });

  it('lists engram tools with their JSON Schemas', async () => {
    const tools = await mcp.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('read_page');
    expect(names).toContain('record_evidence');
    const readPage = tools.find((t) => t.name === 'read_page')!;
    expect(readPage.inputSchema).toMatchObject({ type: 'object' });
  }, 30_000);

  it('calls read_page and gets the page back as JSON text content', async () => {
    const res = await mcp.callTool('read_page', { slug: 'derivatives' });
    expect(res.isError).toBeFalsy();
    const page = JSON.parse(res.content[0].text!);
    expect(page.page.meta.title).toBe('Derivatives');
  }, 30_000);
});
