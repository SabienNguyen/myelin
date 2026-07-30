import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { anthropicModel, runLoop } from '../src/server/llm/index.js';
import { buildWebTools, type WebTools } from '../src/server/webTools.js';

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

const names = (wt: WebTools) => wt.tools.map((t) => t.name);
const tool = (wt: WebTools, name: string) => wt.tools.find((t) => t.name === name)!;

describe('web research tools', () => {
  // The reason this whole tool set was reworked: research used to require a self-hosted SearXNG,
  // so with nothing but an API key the tutor had no way to learn a subject it did not already know.
  it('gives an Anthropic-routed tutor search with no local infrastructure at all', () => {
    const wt = buildWebTools(cfg(), 'claude-opus-5');
    expect(names(wt)).toEqual(['read_url']);
    // Provider-executed: Anthropic runs the search, so there is nothing for us to execute — the
    // declaration rides serverTools and reaches the wire verbatim. Pinned deliberately:
    // `web_search_20250305` is the older basic variant; _20260209 is the one with dynamic
    // filtering, and it is what the model actually behaves well with.
    expect(wt.serverTools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }]);
  });

  it('falls back to SearXNG for a local model, which cannot use a provider-executed tool', async () => {
    const wt = buildWebTools(cfg(base), OLLAMA);
    expect(wt.serverTools).toEqual([]);
    const search = tool(wt, 'web_search');
    expect(search.execute).toBeTypeOf('function'); // loop-executed, not provider-executed
    const out: any = await search.execute!({ query: 'derivatives' });
    expect(out.results).toEqual([
      { title: 'Alpha', url: 'https://a.example/x', snippet: 'first hit' },
      { title: 'Beta', url: 'https://b.example/y', snippet: 'second hit' },
    ]);
  });

  it('prefers the provider tool over a configured SearXNG when both are possible', () => {
    const wt = buildWebTools(cfg(base), 'claude-opus-5');
    expect(wt.serverTools.map((t) => t.name)).toEqual(['web_search']);
    expect(names(wt)).not.toContain('web_search');
  });

  it('registers read_url even with no search backend, since it needs no setup', () => {
    const wt = buildWebTools(cfg(), OLLAMA);
    expect(names(wt)).toEqual(['read_url']);
    expect(wt.serverTools).toEqual([]);
  });

  it('read_url extracts readable text, skipping nav/footer', async () => {
    const wt = buildWebTools(cfg(base), OLLAMA);
    const out: any = await tool(wt, 'read_url').execute!({ url: `${base}/page` });
    expect(out.text).toContain('Real content here.');
    expect(out.text).not.toContain('MENU');
    expect(out.text).not.toContain('foot');
  });

  // Everything above is about what buildWebTools RETURNS. This is about what actually leaves the
  // process — the part no amount of reading the tool object can tell you. session.ts merges
  // several tool lists into one loop registry, and a provider-executed tool travels by a different
  // route (runLoop's serverTools) than a custom one, so "both survive the merge and both reach the
  // API" is a real risk and not an obvious one. Recorded against a fake Anthropic endpoint through
  // OUR adapter and loop — the proof the serialized request survived the SDK's removal.
  it('sends the provider tool to the API as web_search_20260209, alongside our own tools', async () => {
    let sent: any = null;
    const fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        sent = JSON.parse(body);
        res.setHeader('content-type', 'text/event-stream');
        res.end([
          'event: message_start',
          `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } })}`,
          '',
          'event: message_stop',
          `data: ${JSON.stringify({ type: 'message_stop' })}`,
          '',
          '',
        ].join('\n'));
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const { port } = fake.address() as { port: number };
    try {
      const model = anthropicModel({ modelId: 'claude-opus-5', apiKey: 'test', baseUrl: `http://127.0.0.1:${port}` });
      const { tools, serverTools } = buildWebTools(cfg(), 'claude-opus-5');
      await runLoop({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools,
        serverTools,
        maxSteps: 1,
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
    const down = buildWebTools(cfg('http://127.0.0.1:1'), OLLAMA);
    const s: any = await tool(down, 'web_search').execute!({ query: 'x' });
    expect(s.error).toMatch(/unavailable/);
    const wt = buildWebTools(cfg(base), OLLAMA);
    const f: any = await tool(wt, 'read_url').execute!({ url: `${base}/missing` });
    expect(f.error).toMatch(/404/);
  });
});
