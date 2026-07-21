import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { glob } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ToolSet } from 'ai';
import type { HarnessConfig } from './config.js';

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

// Matches transport-shaped failures from a dead/dying MCP child, e.g. "write EPIPE" and the
// ai-sdk client's own "Attempted to send a request from a closed client" (matched by 'closed').
const TRANSPORT_ERROR = /closed|EPIPE|transport|disconnected/i;

export function isTransportError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return TRANSPORT_ERROR.test(msg);
}

export class Loreweaver {
  private constructor(private client: MCPClient, private cfg: HarnessConfig) {}

  static async connect(cfg: HarnessConfig): Promise<Loreweaver> {
    return new Loreweaver(await Loreweaver.spawn(cfg), cfg);
  }

  private static spawn(cfg: HarnessConfig): Promise<MCPClient> {
    return createMCPClient({
      transport: new StdioMCPTransport({
        command: cfg.loreweaver.command,
        args: cfg.loreweaver.args,
        env: {
          ...process.env as Record<string, string>,
          LOREWEAVER_VAULT: cfg.vault,
          LOREWEAVER_EMBEDDINGS: cfg.loreweaver.embeddings,
        },
      }),
      onUncaughtError: (e) => console.error('[loreweaver-mcp]', e),
    });
  }

  // ONE respawn policy shared by every client use (call(), tools(), and each tool's execute() —
  // see tools() below): try against the current client; on a transport-shaped error, respawn once
  // with a short backoff and retry against the fresh client. A second failure propagates — we
  // never loop respawning.
  private async withRespawn<T>(fn: (client: MCPClient) => Promise<T>): Promise<T> {
    try {
      return await fn(this.client);
    } catch (e) {
      if (!isTransportError(e)) throw e;
      await new Promise((r) => setTimeout(r, 100)); // single respawn with backoff
      this.client = await Loreweaver.spawn(this.cfg);
      return fn(this.client);
    }
  }

  // Stale-closure hazard: tool objects returned by client.tools() have execute() bound to
  // WHICHEVER client produced them. If that client dies and gets respawned (by this call, by
  // call(), or by another in-flight tool's execute), a previously-fetched tool must not keep
  // calling into the dead one — ingest.ts/session.ts fetch tools() once per compile/turn and
  // hand out those closures widely. So each wrapped execute() re-resolves the tool from
  // `this.client` (whatever is current AT INVOCATION TIME, not at fetch time) via withRespawn,
  // which transparently respawns-and-retries on a transport-shaped failure.
  async tools(): Promise<ToolSet> {
    const raw = await this.withRespawn((client) => client.tools());
    return Object.fromEntries(Object.entries(raw).map(([name, tool]) => [
      name,
      { ...tool, execute: (args: any, opts: any) => this.execTool(name, args, opts) },
    ])) as ToolSet;
  }

  private execTool(name: string, args: any, opts: any): Promise<any> {
    return this.withRespawn(async (client) => {
      const tool = (await client.tools())[name];
      if (!tool?.execute) throw new Error(`loreweaver tool "${name}" not found on client`);
      return tool.execute(args, opts);
    });
  }

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    return this.withRespawn(async (client) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
      if (res.isError) throw new Error(`loreweaver ${name}: ${text}`);
      return JSON.parse(text);
    });
  }

  async listSlugs(): Promise<string[]> {
    const slugs: string[] = [];
    for await (const f of glob(join(this.cfg.vault, 'pages', '**/*.md'))) {
      slugs.push(basename(f, '.md')); // filenames only — never parse vault markdown here
    }
    return slugs.sort();
  }

  async close() { await this.client.close(); }
}
