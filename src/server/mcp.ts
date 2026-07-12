import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { glob } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { HarnessConfig } from './config.js';

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

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

  tools() { return this.client.tools(); }

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const exec = async () => {
      const res = await this.client.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
      if (res.isError) throw new Error(`loreweaver ${name}: ${text}`);
      return JSON.parse(text);
    };
    try {
      return await exec();
    } catch (e: any) {
      if (!/closed|EPIPE|transport|disconnected/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 100)); // single respawn with backoff
      this.client = await Loreweaver.spawn(this.cfg);
      return exec();
    }
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
