import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { downloadToTemp, rewriteArxivUrl, MAX_DOWNLOAD_BYTES } from '../src/server/download.js';

let server: Server;
let base: string;
let lastRequestPath = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    lastRequestPath = req.url ?? '';
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/paper.pdf' || url.pathname === '/pdf/2401.12345') {
      res.setHeader('content-type', 'application/pdf');
      res.end('%PDF-1.4 fixture bytes');
      return;
    }
    if (url.pathname === '/paper.epub') {
      res.setHeader('content-type', 'application/epub+zip');
      res.end('fixture epub bytes');
      return;
    }
    if (url.pathname === '/notapaper') {
      res.setHeader('content-type', 'text/html');
      res.end('<html>nope</html>');
      return;
    }
    res.statusCode = 404; res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('rewriteArxivUrl (pure)', () => {
  it('rewrites an arxiv.org /abs/<id> URL to /pdf/<id>', () => {
    expect(rewriteArxivUrl('https://arxiv.org/abs/2401.12345')).toBe('https://arxiv.org/pdf/2401.12345');
  });
  it('leaves non-arxiv URLs untouched', () => {
    expect(rewriteArxivUrl('https://example.com/abs/2401.12345')).toBe('https://example.com/abs/2401.12345');
  });
  it('leaves arxiv.org URLs that are already /pdf/ untouched', () => {
    expect(rewriteArxivUrl('https://arxiv.org/pdf/2401.12345')).toBe('https://arxiv.org/pdf/2401.12345');
  });
});

describe('downloadToTemp', () => {
  it('downloads bytes and infers extension from content-type (pdf)', async () => {
    const file = await downloadToTemp(`${base}/paper.pdf`);
    expect(file.path.endsWith('.pdf')).toBe(true);
    expect(file.contentType).toBe('application/pdf');
    expect(readFileSync(file.path, 'utf8')).toContain('PDF-1.4 fixture bytes');
  });

  it('downloads bytes and infers extension from content-type (epub)', async () => {
    const file = await downloadToTemp(`${base}/paper.epub`);
    expect(file.path.endsWith('.epub')).toBe(true);
  });

  it('rejects an unsupported content-type with a thrown, descriptive error', async () => {
    await expect(downloadToTemp(`${base}/notapaper`)).rejects.toThrow(/content-type/i);
  });

  it('rejects a 404 with a thrown, descriptive error', async () => {
    await expect(downloadToTemp(`${base}/missing`)).rejects.toThrow(/404/);
  });

  it('exposes a 50MB cap', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(50 * 1024 * 1024);
  });

  it('routes an arxiv abs URL through the pdf path before fetching (fixture sees /pdf/)', async () => {
    lastRequestPath = '';
    // fetchImpl injected so we can point the "arxiv.org" rewrite target at our local fixture —
    // the fake fetch records the exact URL downloadToTemp asked for, standing in as the fixture
    // the real network fetch would hit.
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(url);
      const path = new URL(url).pathname;
      return fetch(`${base}${path}`, init as any);
    };
    await downloadToTemp('https://arxiv.org/abs/2401.12345', { fetchImpl });
    expect(seen[0]).toBe('https://arxiv.org/pdf/2401.12345');
    expect(lastRequestPath).toBe('/pdf/2401.12345');
  });
});
