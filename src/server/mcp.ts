import { glob } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  spawnMcpServer, type LoopTool, type McpConnection, type McpToolResult,
} from './llm/index.js';
import type { HarnessConfig } from './config.js';
import { invalidateGraphCache } from './graphCache.js';

// Matches transport-shaped failures from a dead/dying MCP child: "write EPIPE" and the stdio
// client's own "mcp transport closed: …" rejections (matched by 'closed').
const TRANSPORT_ERROR = /closed|EPIPE|transport|disconnected/i;

export function isTransportError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return TRANSPORT_ERROR.test(msg);
}

export class Engram {
  // A respawn in flight, shared by every caller that hits the dead client at once. null when none.
  private respawning: Promise<McpConnection> | null = null;

  private constructor(private client: McpConnection, private cfg: HarnessConfig) {}

  static async connect(cfg: HarnessConfig): Promise<Engram> {
    return new Engram(await Engram.spawn(cfg), cfg);
  }

  private static spawn(cfg: HarnessConfig): Promise<McpConnection> {
    return spawnMcpServer({
      command: cfg.engram.command,
      args: cfg.engram.args,
      env: {
        ...process.env as Record<string, string>,
        ENGRAM_VAULT: cfg.vault,
        ENGRAM_EMBEDDINGS: cfg.engram.embeddings,
        // Inside the desktop app, `process.execPath` — which config.ts's runnerFor uses to run a
        // compiled entry — is the Electron binary, and launching it plainly would open a second
        // app window instead of a Node process. This makes it behave as Node. A no-op for a real
        // node binary, so it costs nothing to set unconditionally.
        ELECTRON_RUN_AS_NODE: '1',
      },
      onUncaughtError: (e) => console.error('[engram-mcp]', e),
    });
  }

  // ONE respawn policy shared by every client use (call(), tools(), and each tool's execute() —
  // see tools() below): try against the current client; on a transport-shaped error, respawn once
  // with a short backoff and retry against the fresh client. A second failure propagates — we
  // never loop respawning.
  private async withRespawn<T>(fn: (client: McpConnection) => Promise<T>): Promise<T> {
    try {
      return await fn(this.client);
    } catch (e) {
      if (!isTransportError(e)) throw e;
      return fn(await this.respawn());
    }
  }

  // Respawn the child, deduped: when the child dies mid-compile, all `concurrency` in-flight tool
  // calls hit the transport error at once. Without sharing, each one ran `this.client = await
  // spawn()` — spawning a fresh engram process per failed call and orphaning every one but the
  // last (never closed, a leaked child). A shared in-flight promise means one death → one respawn,
  // and every waiter retries against that same fresh client.
  private respawn(): Promise<McpConnection> {
    if (!this.respawning) {
      this.respawning = (async () => {
        await new Promise((r) => setTimeout(r, 100)); // short backoff
        this.client = await Engram.spawn(this.cfg);
        return this.client;
      })().finally(() => { this.respawning = null; });
    }
    return this.respawning;
  }

  // Each tool's execute() goes through execTool, which resolves `this.client` at INVOCATION time
  // (not at fetch time) via withRespawn — so a toolset fetched once per compile/turn and handed
  // out widely (ingest.ts/session.ts do exactly that) keeps working across a mid-flight respawn
  // instead of calling into the dead child it was fetched from.
  async tools(): Promise<LoopTool[]> {
    const decls = await this.withRespawn((client) => client.listTools());
    return decls.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
      execute: (args: unknown) => this.execTool(name, args),
    }));
  }

  // Graph-cache invalidation seam: every write_page call the harness itself makes reaches the
  // vault through exactly one of the two methods below (call() or execTool()) — both live on
  // this wrapper and both already know the tool name, so this is the single, least-invasive
  // place to hook invalidateGraphCache() rather than sprinkling it across every write_page call
  // site (ingestRepo.ts/seedPatternPages.ts call lw.call('write_page', ...) directly; the
  // tutor-session and compile agent loops in session.ts/ingest.ts instead hand out the tools
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

  // Returns the FULL tools/call result object ({content, isError?}), which the loop serializes
  // whole into the model's tool_result — the same view the model had before the harness owned
  // this bridge, and the shape mcp.test.ts pins (raw.content[0].text).
  private execTool(name: string, args: unknown): Promise<McpToolResult> {
    return this.withRespawn(async (client) => {
      const result = await client.callTool(name, (args ?? {}) as Record<string, unknown>);
      Engram.invalidateIfWrite(name);
      return result;
    });
  }

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    return this.withRespawn(async (client) => {
      const res = await client.callTool(name, args);
      const text = res.content[0]?.text ?? '';
      if (res.isError) throw new Error(`engram ${name}: ${text}`);
      const parsed = JSON.parse(text);
      Engram.invalidateIfWrite(name);
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
