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
      // text/html is a SUPPORTED source now (it extracts to markdown), so the unsupported-type
      // case needs a type nothing in the pipeline can read.
      res.setHeader('content-type', 'image/png');
      res.end('\x89PNG not a document');
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

/**
 * A plain web page was the one source "Add material" refused: PDFs, ePubs, repos and YouTube links
 * all went through, but the documentation page or article a subject actually lives on came back
 * "unsupported content-type text/html". These cover the extraction path that fixed it.
 */
describe('HTML sources', () => {
  const htmlResponse = (html: string) => ({
    ok: true,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    text: async () => html,
  }) as unknown as Response;

  it('extracts readable text, keeps the title, and drops nav/script chrome', async () => {
    const html = `<html><head><title>  Spinning Up: RL Intro </title></head>
      <body><nav>home about contact</nav><script>var x=1;</script>
      <h1>Part 1: Key Concepts</h1><p>The main characters of RL are the agent and the environment.</p>
      <footer>copyright 2026</footer></body></html>`;
    const out = await downloadToTemp('https://example.com/rl_intro.html', {
      fetchImpl: (async () => htmlResponse(html)) as unknown as typeof fetch,
    });
    expect(out.title).toBe('Spinning Up: RL Intro');
    const text = readFileSync(out.path, 'utf8');
    expect(text).toMatch(/agent and the environment/);
    expect(text).toMatch(/Source: https:\/\/example\.com\/rl_intro\.html/);
    expect(text).not.toMatch(/var x=1/);      // script stripped
    expect(text).not.toMatch(/copyright 2026/); // footer stripped
    expect(out.path).toMatch(/\.md$/);         // rides the ordinary markdown pipeline
  });

  it('refuses a page with no readable text rather than compiling an empty book', async () => {
    const empty = '<html><head><title>x</title></head><body><nav>menu</nav></body></html>';
    await expect(downloadToTemp('https://example.com/empty', {
      fetchImpl: (async () => htmlResponse(empty)) as unknown as typeof fetch,
    })).rejects.toThrow(/no readable text/);
  });
});

/** Doc-site chrome lives in ordinary <div>s, so the structural skips (nav/aside/footer) miss it.
 *  Left in, it reaches the compiler as if it were prose — the Python tutorial's sidebar was banked
 *  as course "problems" ("Errors and Exceptions / NEXT TOPIC"). */
describe('doc-site chrome extraction', () => {
  it('drops sphinx sidebars, toc trees and pilcrow anchors', async () => {
    const html = `<html><head><title>9. Classes</title></head><body>
      <div class="sphinxsidebar"><h4>Previous topic</h4><p>Errors and Exceptions</p>
        <h4>Next topic</h4><p>Brief tour of the standard library</p>
        <ul><li>Report a bug</li><li>Improve this page</li></ul></div>
      <div role="navigation"><p>NAVIGATION index modules</p></div>
      <div class="toctree-wrapper"><ul><li>9.1 A word about names</li></ul></div>
      <div class="body"><h1>9. Classes<a class="headerlink" href="#classes">¶</a></h1>
        <p>Classes provide a means of bundling data and functionality together.</p></div>
      </body></html>`;
    const out = await downloadToTemp('https://docs.python.org/3/tutorial/classes.html', {
      fetchImpl: (async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => html,
      })) as unknown as typeof fetch,
    });
    const text = readFileSync(out.path, 'utf8');
    expect(text).toMatch(/bundling data and functionality/); // the actual article survives
    expect(text).not.toMatch(/Report a bug/);
    expect(text).not.toMatch(/Errors and Exceptions/);
    expect(text).not.toMatch(/Brief tour of the standard library/);
    expect(text).not.toMatch(/NAVIGATION/);
    expect(text).not.toMatch(/¶/);
  });
});
