import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { buildGapHelpRoute } from '../src/server/gapHelp.js';
import { textModel } from './mockModel.js';

// The true reference solution for the fixture's full_body rung — this string is NEVER placed
// anywhere in the fake sidecar's GET /api/ladder response below (mirroring the real the-gap
// sidecar, which strips reference_answer server-side before that response is ever serialized —
// see gapProxy.ts's fetchLadderPayload doc comment). If it ever showed up in a built prompt, that
// would mean the reference answer found a path from "the full artifact" into what the model sees.
const REFERENCE_SOLUTION_SENTINEL = 'REFERENCE_SOLUTION_SENTINEL_9f3a1c';

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
        // Mirrors the real sidecar: reference_answer is already stripped ('') for this
        // non-worked_example rung. The full/true reference solution (REFERENCE_SOLUTION_SENTINEL)
        // is never transmitted by this endpoint at all — there is no field on this response that
        // carries it.
        rungs: [{
          id: 'r1', template: 'full_body', artifactId: 'stream-consumer',
          visible_pre: 'function consumeStream(response) {', visible_post: '}',
          reference_answer: '',
          prose: { context_line: 'decode an SSE stream into discrete token events' },
        }],
      }));
      return;
    }
    res.statusCode = 404; res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function cfgFor(url: string | undefined, tutorModel: string): any {
  return { gap: url ? { url } : undefined, models: { tutor: { model: tutorModel } } };
}

function fakeLw(page?: { body: string }): any {
  return {
    call: async (name: string, args: any) => {
      if (name === 'read_page') {
        if (!page) throw new Error(`engram read_page: page not found: ${args.slug}`);
        return { page };
      }
      throw new Error(`unexpected lw.call("${name}")`);
    },
  };
}

const mockModel = (text: string) => textModel(text).model;

const validBody = {
  pattern: 'stream-consumer',
  rung: 'full_body',
  question: 'why does the null-body test still fail?',
  draft: 'const reader = response.body.getReader();',
  failures: ['handles a null body'],
};

describe('POST /api/gap/help', () => {
  it('config absent -> answers from the BUILT-IN ladder, not a 404', async () => {
    // This asserted a 404 when the sandbox was an optional external service. It ships built-in
    // now, so a learner with no config at all still gets help grounded in real rung data.
    const app = buildGapHelpRoute(fakeLw(), cfgFor(undefined, 'ollama:x'), { model: mockModel('try the buffer') });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).hint).toBe('try the buffer');
  });

  it('validates required fields (400 on missing/malformed body)', async () => {
    const app = buildGapHelpRoute(fakeLw({ body: 'x' }), cfgFor(base, 'ollama:x'), { model: mockModel('hint') });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: 'stream-consumer' }), // missing rung/question/draft/failures
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it('validates failures must be a string[]', async () => {
    const app = buildGapHelpRoute(fakeLw({ body: 'x' }), cfgFor(base, 'ollama:x'), { model: mockModel('hint') });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, failures: [1, 2] }),
    });
    expect(res.status).toBe(400);
  });

  it('sidecar down -> structured 502 matching gapProxy\'s error shape', async () => {
    const app = buildGapHelpRoute(fakeLw({ body: 'x' }), cfgFor('http://127.0.0.1:1', 'ollama:x'));
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/gap sidecar/i);
  });

  it('happy path — ollama:/ai-sdk tutor route returns {hint}', async () => {
    const model = mockModel('name what a null response.body should trigger before you touch a reader.');
    const app = buildGapHelpRoute(fakeLw({ body: 'vault page body' }), cfgFor(base, 'ollama:qwen2.5-coder'), { model });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hint).toContain('null response.body');
  });

  it('tolerates a missing vault page (read_page throws "page not found") without failing the request', async () => {
    const app = buildGapHelpRoute(fakeLw(undefined), cfgFor(base, 'claude-sonnet-5'),
      { model: mockModel('a concept-level hint with no vault page available.') });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).hint).toBeTruthy();
  });

  it('no matching rung for the requested template -> 400', async () => {
    const app = buildGapHelpRoute(fakeLw({ body: 'x' }), cfgFor(base, 'claude-sonnet-5'),
      { model: mockModel('unused') });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, rung: 'inline_completion' }), // fixture only has full_body
    });
    expect(res.status).toBe(400);
  });

  // Answer-integrity regression test (the point of this feature's safety): the fake gap upstream's
  // "full artifact" reference solution is REFERENCE_SOLUTION_SENTINEL, but its GET /api/ladder
  // response — the only endpoint this route (or anything else in the harness) ever calls — never
  // carries it. Capture the exact prompt (system included) handed to the tutor model via the
  // injectable model seam and assert the sentinel has no path into it.
  it('answer-integrity: the built prompt never contains the reference solution', async () => {
    const { model, prompts } = textModel('a proximity hint');
    const app = buildGapHelpRoute(fakeLw({ body: 'vault page body' }), cfgFor(base, 'claude-sonnet-5'), { model });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('full_body'); // the rung really reached the prompt…
    expect(prompts[0]).not.toContain(REFERENCE_SOLUTION_SENTINEL); // …and the answer never did
  });
});
