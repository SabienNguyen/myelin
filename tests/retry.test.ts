import { describe, it, expect, vi } from 'vitest';
import {
  fetchWithRetry, HttpStatusError, isRetryableError, isRetryableStatus, withRetry,
} from '../src/server/retry.js';

const noSleep = async () => {};

describe('what counts as worth retrying', () => {
  it('retries rate limits and server faults, not verdicts about the request', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    // A 404 IS the answer — asking twice more spends the learner's time to print the same thing.
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
  });

  it('treats transport failures and timeouts as transient', () => {
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableError(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isRetryableError(new Error('unexpected token in JSON'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, isRetryableError, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('recovers on a later attempt — the blip that used to cost a whole turn', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new TypeError('fetch failed');
      return 'recovered';
    });
    await expect(withRetry(fn, isRetryableError, { sleep: noSleep })).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up immediately on a permanent failure', async () => {
    const fn = vi.fn(async () => { throw new Error('unexpected token in JSON'); });
    await expect(withRetry(fn, isRetryableError, { sleep: noSleep })).rejects.toThrow(/unexpected token/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows the LAST error so the caller reports what actually happened', async () => {
    let n = 0;
    const fn = async () => { n += 1; throw new TypeError(`fetch failed #${n}`); };
    await expect(withRetry(fn, isRetryableError, { sleep: noSleep, attempts: 3 }))
      .rejects.toThrow(/#3/);
  });

  it('backs off exponentially and never sleeps after the final attempt', async () => {
    const waits: number[] = [];
    const fn = async () => { throw new TypeError('fetch failed'); };
    await expect(withRetry(fn, isRetryableError, {
      attempts: 3, baseDelayMs: 400, sleep: async (ms) => { waits.push(ms); },
    })).rejects.toThrow();
    expect(waits).toEqual([400, 800]); // two sleeps for three attempts
  });
});

describe('fetchWithRetry', () => {
  const res = (status: number) => ({ ok: status >= 200 && status < 300, status }) as Response;

  it('retries a 503 and succeeds', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { n += 1; return res(n < 2 ? 503 : 200); }));
    await expect(fetchWithRetry('https://x.test', {}, { sleep: noSleep })).resolves.toMatchObject({ status: 200 });
    expect(n).toBe(2);
    vi.unstubAllGlobals();
  });

  it('does not retry a 404, and surfaces the status', async () => {
    const f = vi.fn(async () => res(404));
    vi.stubGlobal('fetch', f);
    await expect(fetchWithRetry('https://x.test', {}, { sleep: noSleep }))
      .rejects.toBeInstanceOf(HttpStatusError);
    expect(f).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
