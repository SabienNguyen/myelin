// First-party MCP stdio client (own-harness phase C): JSON-RPC 2.0 over newline-delimited
// stdin/stdout — which IS the MCP stdio transport — narrowed to what the harness uses against
// engram: initialize, tools/list, tools/call. Respawn-on-crash stays mcp.ts's business
// (withRespawn); this layer's contract is that a dead child rejects every in-flight and future
// call with a transport-shaped error ("closed") that isTransportError recognizes.
import { spawn } from 'node:child_process';

// What the replaced SDK client sent; engram's @modelcontextprotocol/sdk supports it and echoes it
// back. The negotiated version in the reply is not enforced — tools/list and tools/call are
// identical across every protocol revision this client could meet.
const PROTOCOL_VERSION = '2025-11-25';

export interface McpToolDecl {
  name: string;
  description: string;
  /** Raw JSON Schema, passed through verbatim — both provider wires take it natively, so no
   * conversion step exists anywhere between the MCP server and the model. */
  inputSchema: Record<string, unknown>;
}

/** The full tools/call result object, untranslated: mcp.ts reads .content[0].text and .isError. */
export interface McpToolResult {
  content: { type: string; text?: string; [key: string]: unknown }[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface McpConnection {
  listTools(): Promise<McpToolDecl[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

export interface SpawnMcpServerOptions {
  command: string;
  args?: string[];
  /** The child's FULL environment (not merged with process.env here — the caller already
   * passes {...process.env, ENGRAM_VAULT, ...}). Absent means inherit. */
  env?: Record<string, string>;
  onUncaughtError?: (error: unknown) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export async function spawnMcpServer(opts: SpawnMcpServerOptions): Promise<McpConnection> {
  const child = spawn(opts.command, opts.args ?? [], {
    env: opts.env,
    // stderr inherits: engram logs there today and journalctl must keep seeing it.
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: false,
  });
  const onUncaught = opts.onUncaughtError ?? ((e: unknown) => console.error('[mcp-client]', e));
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;

  const rejectAll = (reason: string) => {
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
  };

  const send = (msg: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  const handleLine = (line: string) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      onUncaught(new Error(`mcp: unparseable stdout line: ${line.slice(0, 200)}`));
      return;
    }
    if (msg.method !== undefined) {
      // Server-initiated traffic. Requests get an answer so the server never hangs on us: ping
      // an empty result, anything else method-not-found. Notifications need none.
      if (msg.id !== undefined) {
        send(msg.method === 'ping'
          ? { jsonrpc: '2.0', id: msg.id, result: {} }
          : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not supported: ${msg.method}` } });
      }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`mcp error ${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  };

  // A JSON message may split ANYWHERE across stdout chunks — buffer bytes and only parse at a
  // newline. Byte-indexed on purpose: a multibyte character could straddle a chunk boundary,
  // and decoding before the split would corrupt it.
  let buf: Buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let nl: number;
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, nl).toString('utf8').trim();
      buf = buf.subarray(nl + 1);
      if (line) handleLine(line);
    }
  });

  // 'close' rather than 'exit': close fires after stdio has drained, so a response the server
  // wrote just before dying still resolves its call instead of being beaten by the rejection.
  child.on('close', (code) => {
    closed = true;
    rejectAll(`mcp transport closed: server exited (code ${code})`);
  });
  child.on('error', (e) => {
    closed = true;
    onUncaught(e);
    rejectAll(`mcp transport closed: ${e.message}`);
  });
  // EPIPE from writing to a dying child; the close handler above owns the rejections.
  child.stdin.on('error', (e) => onUncaught(e));

  const request = (method: string, params?: Record<string, unknown>): Promise<any> => {
    if (closed) return Promise.reject(new Error('mcp transport closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  };

  await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'myelin', version: '0.1.0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    async listTools() {
      const res = await request('tools/list', {});
      return ((res?.tools ?? []) as any[]).map((t) => ({
        name: String(t.name),
        description: String(t.description ?? ''),
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    },
    callTool(name, args) {
      return request('tools/call', { name, arguments: args });
    },
    async close() {
      if (!closed) {
        closed = true;
        rejectAll('mcp transport closed: client closed');
        child.kill();
      }
    },
  };
}
