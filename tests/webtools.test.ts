import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
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

describe('web research tools', () => {
  it('registers nothing without config', () => {
    expect(Object.keys(buildWebTools(cfg()))).toEqual([]);
  });
  it('web_search returns trimmed results from SearXNG', async () => {
    const tools = buildWebTools(cfg(base)) as any;
    const out = await tools.web_search.execute({ query: 'derivatives' }, {} as any);
    expect(out.results).toEqual([
      { title: 'Alpha', url: 'https://a.example/x', snippet: 'first hit' },
      { title: 'Beta', url: 'https://b.example/y', snippet: 'second hit' },
    ]);
  });
  it('read_url extracts readable text, skipping nav/footer', async () => {
    const tools = buildWebTools(cfg(base)) as any;
    const out = await tools.read_url.execute({ url: `${base}/page` }, {} as any);
    expect(out.text).toContain('Real content here.');
    expect(out.text).not.toContain('MENU');
    expect(out.text).not.toContain('foot');
  });
  it('degrades to structured errors, never throws', async () => {
    const down = buildWebTools(cfg('http://127.0.0.1:1')) as any;
    const s = await down.web_search.execute({ query: 'x' }, {} as any);
    expect(s.error).toMatch(/unavailable/);
    const tools = buildWebTools(cfg(base)) as any;
    const f = await tools.read_url.execute({ url: `${base}/missing` }, {} as any);
    expect(f.error).toMatch(/404/);
  });
});
