// @vitest-environment jsdom
//
// The bug this pins was observed live: while the backend was restarting the dev proxy answered 502
// with an empty body, `.json()` rejected with "Unexpected end of JSON input", and that reached the
// learner as an uncaught pageerror in one panel and an eternal "Loading…" in another. Every
// assertion below is about the two things that made it bad — that a failure was indistinguishable
// from slowness, and that when it did surface it surfaced as an HTTP method and path.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiError, getGraph, getPage, getPaths, setGoal } from '../../src/client/lib/api.js';

afterEach(() => { vi.unstubAllGlobals(); });

const respond = (init: { ok?: boolean; status?: number; body?: string }) => {
  const body = init.body ?? '';
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => JSON.parse(body),
  }) as unknown as Response));
};

describe('client api error handling', () => {
  it('turns a 502 with an empty body into a readable error, not a JSON parser message', async () => {
    respond({ ok: false, status: 502, body: '' });
    await expect(getGraph()).rejects.toThrow(ApiError);
    await expect(getGraph()).rejects.toThrow(/couldn’t load the concept graph/i);
    // The exact failure that used to escape as an unhandled rejection.
    await expect(getGraph()).rejects.not.toThrow(/JSON/i);
  });

  it('never puts an HTTP method or path in the message a learner reads', async () => {
    respond({ ok: false, status: 502, body: '' });
    const err = await getPage('chain-rule').catch((e) => e as ApiError);
    expect(err.message).not.toMatch(/\/api\//);
    expect(err.message).not.toMatch(/\bGET\b/);
    // Still available for logging — diagnostics belong on the object, not in the copy.
    expect(err.path).toBe('/api/page/chain-rule');
    expect(err.status).toBe(502);
  });

  it('distinguishes unreachable from answered-badly, because only one has a user action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await getGraph().catch((e) => e as ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/can’t reach the harness/i);
  });

  it('rejects a 2xx whose body is not JSON rather than resolving undefined', async () => {
    // The dev server standing in for the backend answers 200 with an HTML shell. Resolving here
    // would hand every caller `undefined` and move the crash somewhere less obvious.
    respond({ ok: true, status: 200, body: '<!doctype html>' });
    await expect(getPaths()).rejects.toThrow(/wasn’t readable/i);
  });

  it('reads a 404 as "not written yet" rather than as a malfunction', async () => {
    respond({ ok: false, status: 404, body: '' });
    const err = await getPage('ghost').catch((e) => e as ApiError);
    expect(err.message).toBe('Nothing written for “ghost” yet.');
    expect(err.message).not.toMatch(/error|failed/i);
  });

  it('resolves normally on a good response', async () => {
    respond({ ok: true, status: 200, body: JSON.stringify({ nodes: [{ slug: 'a' }], goal: null }) });
    await expect(getGraph()).resolves.toMatchObject({ nodes: [{ slug: 'a' }] });
  });

  it('surfaces a failed goal save instead of silently dropping it', async () => {
    respond({ ok: false, status: 400, body: '' });
    // Matches restRoutes.ts's own argument for answering 400 rather than no-opping: a goal that
    // silently failed to save is worse than one that visibly did.
    await expect(setGoal({ kind: 'path', slug: 'calculus' })).rejects.toThrow(/couldn’t save your goal/i);
  });

  it('reports an unreachable harness on save without claiming the goal was stored', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(setGoal(null)).rejects.toThrow(/wasn’t saved/i);
  });
});
