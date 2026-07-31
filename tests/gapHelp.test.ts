import { describe, it, expect } from 'vitest';
import { buildGapHelpRoute } from '../src/server/gapHelp.js';
import { textModel } from './mockModel.js';

// The reference solution for the built-in stream-consumer exercise's full_body rung — this route
// must never leak it into a built prompt (gapProxy.ts's fetchLadderPayload strips
// reference_answer server-side before this route ever sees the rung; see this file's top comment
// and gapProxy.ts's doc comment). The fake external sidecar this test file used to spin up is
// gone — cfg.gap no longer exists, so gapHelp always reads the real built-in ladder now, and
// these tests exercise that ladder directly instead of a fixture standing in for a remote one.

function cfgFor(tutorModel: string): any {
  return { models: { tutor: { model: tutorModel } } };
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
  it('answers from the built-in ladder', async () => {
    const app = buildGapHelpRoute(fakeLw(), cfgFor('ollama:x'), { model: mockModel('try the buffer') });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).hint).toBe('try the buffer');
  });

  it('validates required fields (400 on missing/malformed body)', async () => {
    const app = buildGapHelpRoute(fakeLw({ body: 'x' }), cfgFor('ollama:x'), { model: mockModel('hint') });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: 'stream-consumer' }), // missing rung/question/draft/failures
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it('validates failures must be a string[]', async () => {
    const app = buildGapHelpRoute(fakeLw({ body: 'x' }), cfgFor('ollama:x'), { model: mockModel('hint') });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, failures: [1, 2] }),
    });
    expect(res.status).toBe(400);
  });

  it('happy path — ollama:/ai-sdk tutor route returns {hint}', async () => {
    const model = mockModel('name what a null response.body should trigger before you touch a reader.');
    const app = buildGapHelpRoute(fakeLw({ body: 'vault page body' }), cfgFor('ollama:qwen2.5-coder'), { model });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hint).toContain('null response.body');
  });

  it('tolerates a missing vault page (read_page throws "page not found") without failing the request', async () => {
    const app = buildGapHelpRoute(fakeLw(undefined), cfgFor('claude-sonnet-5'),
      { model: mockModel('a concept-level hint with no vault page available.') });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).hint).toBeTruthy();
  });

  it('no matching rung for the requested template -> 400', async () => {
    const app = buildGapHelpRoute(fakeLw({ body: 'x' }), cfgFor('claude-sonnet-5'),
      { model: mockModel('unused') });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, rung: 'not-a-real-template' }),
    });
    expect(res.status).toBe(400);
  });

  // Answer-integrity regression test (the point of this feature's safety): capture the exact
  // prompt (system included) handed to the tutor model via the injectable model seam and assert
  // the built-in exercise's real reference solution has no path into it.
  it('answer-integrity: the built prompt never contains the reference solution', async () => {
    const { model, prompts } = textModel('a proximity hint');
    const app = buildGapHelpRoute(fakeLw({ body: 'vault page body' }), cfgFor('claude-sonnet-5'), { model });
    const res = await app.request('/api/gap/help', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('full_body'); // the rung really reached the prompt…
    // …and no reference-implementation detail did: this exact early-return line only exists in
    // full_body's reference_answer (src/server/gap/streamConsumer.ts's REFERENCE), never in the
    // visible pre/post fragments HelpRungContext is built from.
    expect(prompts[0]).not.toMatch(/data === '\[DONE\]'\) return/);
  });
});
