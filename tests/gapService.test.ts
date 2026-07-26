// The built-in coding sandbox: the service that made code_exercise work on a fresh install.
//
// This grew out of a scratch-directory stand-in for the external the-gap sidecar. Promoting it
// meant fixing the one thing about the stand-in that was genuinely not production-grade: it ran
// learner code in-process with node:vm, where vm's `timeout` covers only synchronous top-level
// evaluation — so a `while (true) {}` inside the learner's async generator blocked the event loop,
// the Promise.race timer never fired, and the WHOLE server (chat, grading, vault) hung. The tests
// here pin the child-process answer to that, plus the two invariants carried over from the sidecar.

import { describe, it, expect } from 'vitest';
import { buildBuiltinGapRoutes, builtinLadderPayload } from '../src/server/gap/service.js';
import { runInChild } from '../src/server/gap/runner.js';
import {
  STREAM_CONSUMER_CASES, STREAM_CONSUMER_ENTRY, STREAM_CONSUMER_RUNGS,
} from '../src/server/gap/streamConsumer.js';

const REFERENCE = STREAM_CONSUMER_RUNGS.find((r) => r.template === 'full_body')!.reference_answer;

describe('the answer-integrity invariant', () => {
  it('strips reference_answer for every rung the learner will attempt', () => {
    const payload = builtinLadderPayload();
    for (const r of payload.rungs) {
      if (r.template === 'worked_example') {
        // The worked example is read-only teaching material — its "answer" IS the content.
        expect(r.reference_answer.length).toBeGreaterThan(0);
      } else {
        expect(r.reference_answer).toBe('');
      }
    }
  });

  it('does not mutate the source rungs while stripping', () => {
    builtinLadderPayload();
    // A careless strip-in-place would blank the module-level rung and grade nothing thereafter.
    expect(STREAM_CONSUMER_RUNGS.find((r) => r.template === 'full_body')!.reference_answer)
      .toContain('parseSSE');
  });
});

describe('running code in the child', () => {
  it('passes the reference implementation against the full gauntlet', async () => {
    const out = await runInChild({
      kind: 'suite', code: REFERENCE, entryPoint: STREAM_CONSUMER_ENTRY, cases: STREAM_CONSUMER_CASES,
    });
    expect(out.pass).toBe(true);
    expect(out.results).toHaveLength(5);
    expect(out.trace?.fired).toHaveLength(5);
  });

  it('fails a naive one-chunk-per-line implementation on exactly the boundary cases', async () => {
    // The gauntlet's whole reason to exist: an implementation that ignores chunk boundaries must
    // fail, and fail on the cases ABOUT boundaries — a suite this one passed would be decoration.
    const naive = `async function* parseSSE(chunks) {
      const dec = new TextDecoder();
      for await (const chunk of chunks) {
        for (const line of dec.decode(chunk).split('\\n')) {
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (d === '[DONE]') return;
          yield d;
        }
      }
    }`;
    const out = await runInChild({
      kind: 'suite', code: naive, entryPoint: STREAM_CONSUMER_ENTRY, cases: STREAM_CONSUMER_CASES,
    });
    expect(out.pass).toBe(false);
    const failed = out.results.filter((r) => !r.pass).map((r) => r.name);
    expect(failed).toContain('single event split across two chunks');
    expect(failed).toContain('multi-byte UTF-8 character split across chunks');
  });

  it('reports expected/actual ONLY on failing cases', async () => {
    const out = await runInChild({
      kind: 'suite', code: REFERENCE, entryPoint: STREAM_CONSUMER_ENTRY, cases: STREAM_CONSUMER_CASES,
    });
    // Shipping the expected value for a passed case would hand out answers for free; the client's
    // reveal-with-evidence-cap flow only makes sense if the server is stingy here.
    for (const r of out.results) expect(r.expected).toBeUndefined();
  });

  it('reports a syntax error as a message, not a crash', async () => {
    const out = await runInChild({
      kind: 'suite', code: 'function {', entryPoint: STREAM_CONSUMER_ENTRY, cases: STREAM_CONSUMER_CASES,
    });
    expect(out.pass).toBe(false);
    expect(out.syntaxError).toMatch(/SyntaxError/);
  });

  it('KILLS an unbounded synchronous loop from outside the child', async () => {
    // THE test this architecture exists for. In-process vm + Promise.race cannot catch this —
    // the busy loop blocks the event loop the race timer lives on. A child process dies to a
    // SIGKILL no matter what its event loop is doing. Short kill window to keep the suite fast.
    const t0 = Date.now();
    const out = await runInChild({
      kind: 'suite',
      code: 'async function* parseSSE(c) { while (true) {} }',
      entryPoint: STREAM_CONSUMER_ENTRY,
      cases: STREAM_CONSUMER_CASES,
    }, 1_500);
    expect(out.pass).toBe(false);
    expect(out.syntaxError).toMatch(/unbounded loop/);
    expect(Date.now() - t0).toBeLessThan(4_000);
    // And this process — the one the whole tutor runs in — is still alive to assert anything at all.
  }, 10_000);

  it('scratch mode returns the learner output with no expected value anywhere', async () => {
    const out = await runInChild({
      kind: 'scratch', code: REFERENCE, entryPoint: STREAM_CONSUMER_ENTRY, input: 'data: a\ndata: b\n',
    });
    expect(out.scratch).toBe(true);
    expect(out.actual).toBe(JSON.stringify(['a', 'b']));
    expect(out.chunks).toBeGreaterThan(1); // fed in awkward slices, not one friendly read
    expect(JSON.stringify(out)).not.toContain('expect');
  });
});

describe('the HTTP routes', () => {
  const app = buildBuiltinGapRoutes();
  const post = (body: unknown) => app.request('/api/gap/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('serves the ladder', async () => {
    const res = await app.request('/api/gap/ladder');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ladder.rungs).toHaveLength(3);
    expect(body.rungs.map((r: any) => r.template))
      .toEqual(['worked_example', 'inline_completion', 'full_body']);
  });

  it('grades a run end to end', async () => {
    const res = await post({ rungId: 'stream-consumer:full_body', code: REFERENCE });
    const body = await res.json();
    expect(body.pass).toBe(true);
    expect(body.results).toHaveLength(5);
  });

  it('stress mode re-chunks the same bytes adversarially', async () => {
    const res = await post({ rungId: 'stream-consumer:full_body', code: REFERENCE, stress: true });
    const body = await res.json();
    expect(body.stressed).toBe(true);
    expect(body.pass).toBe(true);
    expect(body.results.length).toBe(15); // 5 cases x 3 hostile chunkings
  });

  it('scratch dispatches off `input`, same as the sidecar contract', async () => {
    const res = await post({ rungId: 'stream-consumer:full_body', code: REFERENCE, input: 'data: x\n' });
    const body = await res.json();
    expect(body.scratch).toBe(true);
    expect(body.actual).toBe('["x"]');
  });

  it('refuses a body with no code', async () => {
    expect((await post({ rungId: 'r' })).status).toBe(400);
  });

  it('names an unknown pattern instead of grading against the wrong suite', async () => {
    expect((await post({ rungId: 'quantum-flux:full_body', code: 'x' })).status).toBe(404);
  });
});

describe('predict-the-output — comprehension before production', () => {
  const app = buildBuiltinGapRoutes();
  const predict = (body: unknown) => app.request('/api/gap/predict', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('a correct prediction passes, graded by actually running the reference server-side', async () => {
    const res = await predict({
      rungId: 'stream-consumer:inline_completion',
      caseName: 'one event per chunk',
      prediction: ['Hello', 'world'],
    });
    const body = await res.json();
    expect(body.pass).toBe(true);
  });

  it('a wrong first attempt reveals NOTHING — the answer stays server-side', async () => {
    const res = await predict({
      rungId: 'stream-consumer:inline_completion',
      caseName: 'one event per chunk',
      prediction: ['data: Hello', 'data: world'], // the classic miss: forgetting the prefix strip
      attempt: 1,
    });
    const body = await res.json();
    expect(body.pass).toBe(false);
    expect(body.actual).toBeUndefined();
  });

  it('a second miss earns the actual output as teaching material', async () => {
    const res = await predict({
      rungId: 'stream-consumer:inline_completion',
      caseName: 'one event per chunk',
      prediction: ['wrong'], attempt: 2,
    });
    const body = await res.json();
    expect(body.pass).toBe(false);
    expect(body.actual).toEqual(['Hello', 'world']);
  });

  it('refuses a case the rung does not offer for prediction', async () => {
    const res = await predict({
      rungId: 'stream-consumer:inline_completion',
      caseName: 'multi-byte UTF-8 character split across chunks', // unreadable preview — not offered
      prediction: ['café'],
    });
    expect(res.status).toBe(404);
  });

  it('the ladder carries the QUESTIONS (input previews) but never the answers', async () => {
    const body = await (await app.request('/api/gap/ladder')).json();
    const inline = body.rungs.find((r: any) => r.template === 'inline_completion');
    expect(inline.predict.length).toBeGreaterThan(0);
    expect(inline.predict[0].inputPreview).toContain('data:');
    expect(JSON.stringify(inline.predict)).not.toContain('Hello","world'); // no expect arrays
  });

  it('the inline rung reference composes pre+answer+post and actually runs — the sibling-entry fix holds', async () => {
    // This is the regression the backlog recorded: with one entry point per ladder, running the
    // worked example's sibling reference produced "parseSSE is not defined". Per-rung entry points
    // and runnableReference are the fix; a passing predict on the inline rung proves both.
    const res = await predict({
      rungId: 'stream-consumer:inline_completion',
      caseName: 'stops at the [DONE] sentinel',
      prediction: ['a'],
    });
    expect((await res.json()).pass).toBe(true);
  });
});
