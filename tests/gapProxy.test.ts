import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { buildGapRoutes, isGapUp } from '../src/server/gapProxy.js';
import { buildBuiltinGapRoutes } from '../src/server/gap/service.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/ladder') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ladder: {
          pattern: 'stream-consumer', targetArtifactId: 'stream-consumer',
          siblingArtifactId: 'paginated-fetcher', rungs: ['r1'],
        },
        // fixture mirrors the real sidecar: reference_answer already stripped ('') for a
        // non-worked_example rung — the proxy must pass this through untouched, never re-add it.
        rungs: [{ id: 'r1', template: 'inline_completion', reference_answer: '' }],
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          pass: true, results: [{ name: 'test', pass: true }],
          echoRungId: parsed.rungId ?? null, echoTrace: parsed.trace ?? null,
        }));
      });
      return;
    }
    res.statusCode = 404; res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const cfg = (url?: string) => ({ gap: url ? { url } : undefined }) as any;

const routes = (c: any) => buildGapRoutes(c, buildBuiltinGapRoutes);

describe('gap proxy', () => {
  it('config absent -> the BUILT-IN sandbox answers, not a 404', async () => {
    // The semantics this line used to assert — "no config, no code exercises" — is the fresh-install
    // dead end the built-in service exists to remove.
    const app = routes(cfg());
    const res = await app.request('/api/gap/ladder');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ladder.pattern).toBe('stream-consumer');
    // The answer-integrity invariant holds for the builtin exactly as for the sidecar: stripped
    // for the learner's own rungs, present only on the read-only worked example.
    for (const r of body.rungs) {
      if (r.template === 'worked_example') expect(r.reference_answer).not.toBe('');
      else expect(r.reference_answer).toBe('');
    }
  });

  it('a configured external sidecar takes precedence over the builtin', async () => {
    // base's fixture ladder has a DIFFERENT sibling than the builtin — seeing it proves the proxy
    // won, not the builtin.
    const app = routes(cfg(base));
    const body = await (await app.request('/api/gap/ladder')).json();
    expect(body.ladder.siblingArtifactId).toBe('paginated-fetcher');
  });

  it('passes through GET /api/gap/ladder, preserving reference_answer stripping', async () => {
    const app = routes(cfg(base));
    const res = await app.request('/api/gap/ladder');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ladder.pattern).toBe('stream-consumer');
    expect(body.rungs[0].reference_answer).toBe(''); // MUST remain stripped through the proxy
  });

  it('passes through POST /api/gap/run body (incl. trace)', async () => {
    const app = routes(cfg(base));
    const res = await app.request('/api/gap/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rungId: 'r1', code: 'x', trace: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pass).toBe(true);
    expect(body.echoRungId).toBe('r1');
    expect(body.echoTrace).toBe(true);
  });

  it('sidecar down -> structured 502', async () => {
    const app = routes(cfg('http://127.0.0.1:1'));
    const res = await app.request('/api/gap/ladder');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/gap sidecar/i);
  });
});

describe('isGapUp status ping', () => {
  it('true when gap config absent — the built-in sandbox is in-process', async () => {
    expect(await isGapUp(cfg())).toBe(true);
  });

  it('true when sidecar answers /api/ladder', async () => {
    expect(await isGapUp(cfg(base))).toBe(true);
  });

  it('false when sidecar is down', async () => {
    expect(await isGapUp(cfg('http://127.0.0.1:1'))).toBe(false);
  });

  it('caches the result across immediate re-checks (30s window)', async () => {
    const c = cfg(base);
    expect(await isGapUp(c)).toBe(true);
    // A fresh cfg object bypasses the cache; the SAME object must reuse the cached verdict even
    // if we point it somewhere unreachable, proving the cache — not a live re-fetch — answered.
    (c as any).gap.url = 'http://127.0.0.1:1';
    expect(await isGapUp(c)).toBe(true);
  });
});
