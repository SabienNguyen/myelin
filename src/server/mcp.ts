import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { glob } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ToolSet } from 'ai';
import type { HarnessConfig } from './config.js';
import { invalidateGraphCache } from './graphCache.js';

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

// Matches transport-shaped failures from a dead/dying MCP child, e.g. "write EPIPE" and the
// ai-sdk client's own "Attempted to send a request from a closed client" (matched by 'closed').
const TRANSPORT_ERROR = /closed|EPIPE|transport|disconnected/i;

export function isTransportError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return TRANSPORT_ERROR.test(msg);
}

export class Loreweaver {
  // A respawn in flight, shared by every caller that hits the dead client at once. null when none.
  private respawning: Promise<MCPClient> | null = null;

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
          // Inside the desktop app, `process.execPath` — which config.ts's runnerFor uses to run a
          // compiled entry — is the Electron binary, and launching it plainly would open a second
          // app window instead of a Node process. This makes it behave as Node. A no-op for a real
          // node binary, so it costs nothing to set unconditionally.
          ELECTRON_RUN_AS_NODE: '1',
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
      return fn(await this.respawn());
    }
  }

  // Respawn the child, deduped: when the child dies mid-compile, all `concurrency` in-flight tool
  // calls hit the transport error at once. Without sharing, each one ran `this.client = await
  // spawn()` — spawning a fresh loreweaver process per failed call and orphaning every one but the
  // last (never closed, a leaked child). A shared in-flight promise means one death → one respawn,
  // and every waiter retries against that same fresh client.
  private respawn(): Promise<MCPClient> {
    if (!this.respawning) {
      this.respawning = (async () => {
        await new Promise((r) => setTimeout(r, 100)); // short backoff
        this.client = await Loreweaver.spawn(this.cfg);
        return this.client;
      })().finally(() => { this.respawning = null; });
    }
    return this.respawning;
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

  // Graph-cache invalidation seam: every write_page call the harness itself makes reaches the
  // vault through exactly one of the two methods below (call() or execTool()) — both live on
  // this wrapper and both already know the tool name, so this is the single, least-invasive
  // place to hook invalidateGraphCache() rather than sprinkling it across every write_page call
  // site (ingestRepo.ts/seedPatternPages.ts call lw.call('write_page', ...) directly; the
  // tutor-session and compile agent loops in session.ts/ingest.ts instead hand out the ToolSet
  // from tools(), whose execute() is execTool() below — the model triggers write_page through
  // THAT path, not call()). Only invalidate on success: a rejected/erroring write never touched
  // the vault. External vault edits (e.g. a user editing Obsidian directly) aren't covered here
  // and fall through to the cache's own TTL — see graphCache.ts.
  private static invalidateIfWrite(name: string): void {
    // record_evidence invalidates too: graph nodes carry mastery (color, decay ring, ⚠
    // misconception marker) baked into the cached payload, so with write_page-only invalidation a
    // freshly recorded or freshly resolved misconception kept the stale marker for up to a TTL
    // plus a client poll (~90s measured in the lifecycle audit) — long enough for a learner to
    // repair a confusion and watch the graph keep accusing them of it.
    if (name === 'write_page' || name === 'record_evidence') invalidateGraphCache();
  }

  private execTool(name: string, args: any, opts: any): Promise<any> {
    return this.withRespawn(async (client) => {
      const tool = (await client.tools())[name];
      if (!tool?.execute) throw new Error(`loreweaver tool "${name}" not found on client`);
      const result = await tool.execute(args, opts);
      Loreweaver.invalidateIfWrite(name);
      return result;
    });
  }

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    return this.withRespawn(async (client) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
      if (res.isError) throw new Error(`loreweaver ${name}: ${text}`);
      const parsed = JSON.parse(text);
      Loreweaver.invalidateIfWrite(name);
      return parsed;
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
