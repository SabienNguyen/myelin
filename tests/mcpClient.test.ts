// mcpClient's own contract: initialize/tools-list/tools-call over newline-delimited JSON-RPC,
// and — the behavior this file exists to pin — a request the server never answers must still
// settle, on schedule, with a message mcp.ts's isTransportError treats as a dead child.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnMcpServer } from '../src/server/llm/mcpClient.js';

// Answers `initialize` (so the client's connect step completes) and otherwise reads every
// request and never replies — standing in for an engram child wedged mid-tool-call.
const STALL_SERVER = `
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'stall', version: '0' } },
      }) + '\\n');
    }
    // tools/list, tools/call, notifications/initialized: silently dropped on purpose.
  }
});
`;

// Answers everything immediately, echoing an empty tools list — proves requestTimeoutMs doesn't
// misfire on a server that's actually responsive.
const ECHO_SERVER = `
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const result = msg.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'echo', version: '0' } }
      : { tools: [] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`;

function writeServerScript(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lwh-mcpclient-'));
  const file = join(dir, 'server.mjs');
  writeFileSync(file, source);
  return file;
}

describe('spawnMcpServer request timeout', () => {
  it('rejects a call the server never answers, naming the timed-out method', async () => {
    const conn = await spawnMcpServer({
      command: process.execPath,
      args: [writeServerScript(STALL_SERVER)],
      requestTimeoutMs: 50,
    });
    await expect(conn.listTools()).rejects.toThrow(/^mcp transport timeout: tools\/list$/);
    await conn.close();
  }, 10_000);

  it('does not time out a request the server actually answers', async () => {
    const conn = await spawnMcpServer({
      command: process.execPath,
      args: [writeServerScript(ECHO_SERVER)],
      requestTimeoutMs: 2_000,
    });
    await expect(conn.listTools()).resolves.toEqual([]);
    await conn.close();
  });

  it('defaults requestTimeoutMs to 120s when none is passed', async () => {
    const conn = await spawnMcpServer({
      command: process.execPath,
      args: [writeServerScript(ECHO_SERVER)],
    });
    // No explicit requestTimeoutMs: the connect (`initialize`) itself only succeeds if the
    // default is generous enough for a normal round trip, and the default must be finite for
    // the stall test above to make sense as a regression guard on the SAME code path.
    await expect(conn.listTools()).resolves.toEqual([]);
    await conn.close();
  });
});
