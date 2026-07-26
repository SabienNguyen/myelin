import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { buildWebTools } from '../src/server/webTools.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/search') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        results: [
          { url: 'https://a.example/x', title: 'Alpha', content: 'first hit' },
          { url: 'https://b.example/y', title: 'Beta', content: 'second hit' },
        ],
      }));
      return;
    }
    if (url.pathname === '/page') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><nav>MENU</nav><body><h1>Title</h1><p>Real content here.</p><footer>foot</footer></body></html>');
      return;
    }
    res.statusCode = 404; res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const cfg = (searxng?: string) => ({ search: searxng ? { searxng } : undefined }) as any;
const OLLAMA = 'ollama:qwen2.5';

describe('web research tools', () => {
  // The reason this whole tool set was reworked: research used to require a self-hosted SearXNG,
  // so with nothing but an API key the tutor had no way to learn a subject it did not already know.
  it('gives an Anthropic-routed tutor search with no local infrastructure at all', () => {
    const tools = buildWebTools(cfg(), 'claude-opus-5') as any;
    expect(Object.keys(tools).sort()).toEqual(['read_url', 'web_search']);
    // Provider-executed: Anthropic runs the search, so there is nothing for us to execute.
    expect(tools.web_search.type).toBe('provider');
    expect(tools.web_search.isProviderExecuted).toBe(true);
    // Pinned deliberately. `web_search_20250305` is the older basic variant; _20260209 is the one
    // with dynamic filtering, and it is what the model actually behaves well with.
    expect(tools.web_search.id).toBe('anthropic.web_search_20260209');
  });

  it('falls back to SearXNG for a local model, which cannot use a provider-executed tool', async () => {
    const tools = buildWebTools(cfg(base), OLLAMA) as any;
    expect(tools.web_search.type).not.toBe('provider');
    const out = await tools.web_search.execute({ query: 'derivatives' }, {} as any);
    expect(out.results).toEqual([
      { title: 'Alpha', url: 'https://a.example/x', snippet: 'first hit' },
      { title: 'Beta', url: 'https://b.example/y', snippet: 'second hit' },
    ]);
  });

  it('prefers the provider tool over a configured SearXNG when both are possible', () => {
    const tools = buildWebTools(cfg(base), 'claude-opus-5') as any;
    expect(tools.web_search.type).toBe('provider');
  });

  it('registers read_url even with no search backend, since it needs no setup', () => {
    const tools = buildWebTools(cfg(), OLLAMA) as any;
    expect(Object.keys(tools)).toEqual(['read_url']);
  });

  it('read_url extracts readable text, skipping nav/footer', async () => {
    const tools = buildWebTools(cfg(base), OLLAMA) as any;
    const out = await tools.read_url.execute({ url: `${base}/page` }, {} as any);
    expect(out.text).toContain('Real content here.');
    expect(out.text).not.toContain('MENU');
    expect(out.text).not.toContain('foot');
  });

  // Everything above is about what buildWebTools RETURNS. This is about what actually leaves the
  // process — the part no amount of reading the tool object can tell you. session.ts merges three
  // separate tool sets into one map (MCP + web + block tools), and a provider-executed tool travels
  // by a different route than a custom one, so "both survive the merge and both reach the API" is a
  // real risk and not an obvious one. Recorded against a fake Anthropic endpoint, so no key needed.
  it('sends the provider tool to the API as web_search_20260209, alongside our own tools', async () => {
    let sent: any = null;
    const fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        sent = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        }));
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const { port } = fake.address() as { port: number };
    try {
      const provider = createAnthropic({ apiKey: 'test', baseURL: `http://127.0.0.1:${port}/v1` });
      await generateText({
        model: provider('claude-opus-5'),
        tools: buildWebTools(cfg(), 'claude-opus-5'),
        prompt: 'hi',
      });
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
    const byName = Object.fromEntries((sent.tools ?? []).map((t: any) => [t.name, t]));
    expect(byName.web_search.type).toBe('web_search_20260209');
    expect(byName.web_search.max_uses).toBe(8);
    expect(byName.read_url.type).toBeUndefined(); // a plain custom tool, and it survived the merge
    expect(byName.read_url.input_schema).toBeTruthy();
  });

  it('degrades to structured errors, never throws', async () => {
    const down = buildWebTools(cfg('http://127.0.0.1:1'), OLLAMA) as any;
    const s = await down.web_search.execute({ query: 'x' }, {} as any);
    expect(s.error).toMatch(/unavailable/);
    const tools = buildWebTools(cfg(base), OLLAMA) as any;
    const f = await tools.read_url.execute({ url: `${base}/missing` }, {} as any);
    expect(f.error).toMatch(/404/);
  });
});
