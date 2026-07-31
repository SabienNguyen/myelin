import { describe, it, expect } from 'vitest';
import { isGapUp } from '../src/server/gapProxy.js';
import { buildBuiltinGapRoutes } from '../src/server/gap/service.js';

// The external the-gap sidecar proxy (buildGapRoutes, cfg.gap) has been removed — code exercises
// only ever run through the built-in sandbox now (gap/service.ts), so this file only pins the
// invariant that survives: the built-in route answers and still strips reference_answer for
// non-worked_example rungs. The passthrough/precedence/502/cache tests that used to live here
// tested the removed sidecar proxy and had no in-process equivalent worth keeping.
describe('built-in gap ladder route', () => {
  it('answers GET /api/gap/ladder, not a 404', async () => {
    const app = buildBuiltinGapRoutes();
    const res = await app.request('/api/gap/ladder');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ladder.pattern).toBe('stream-consumer');
    // Answer-integrity invariant: stripped for the learner's own rungs, present only on the
    // read-only worked example.
    for (const r of body.rungs) {
      if (r.template === 'worked_example') expect(r.reference_answer).not.toBe('');
      else expect(r.reference_answer).toBe('');
    }
  });
});

describe('isGapUp status ping', () => {
  it('is always true — code exercises run in-process, so there is no sidecar to be down', async () => {
    expect(await isGapUp()).toBe(true);
  });
});
