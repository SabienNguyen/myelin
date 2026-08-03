/**
 * Retry for the tutor's outbound network calls.
 *
 * A tool call that fails once used to fail for the turn: `read_url` returned `{error: …}`, the
 * model saw a dead source, and a lesson got taught from memory instead — over a blip that a second
 * attempt 400ms later would have sailed through. Search is worse, because a failed search reads to
 * the model as "nothing exists on this".
 *
 * What is NOT retried matters as much. A 404 is an answer: the page is gone, and asking twice more
 * just spends the learner's time to print the same thing. Same for 401/403 — credentials do not
 * improve by waiting. Only transport failures, timeouts, 429 and 5xx get another go, because those
 * are the ones where the same request can genuinely succeed unchanged.
 */

/** HTTP statuses where the identical request may succeed later: rate limits and server-side faults.
 *  Everything else in the 4xx range is a verdict about the request itself. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Thrown errors worth another attempt: the connection never completed, or we gave up waiting.
 *  `fetch` surfaces DNS/connection failures as a TypeError, and AbortSignal.timeout as AbortError. */
export function isRetryableError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  const msg = (e as Error)?.message ?? '';
  return e instanceof TypeError
    || /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg);
}

export interface RetryOptions {
  /** Total attempts including the first. 3 is the default: two extra tries covers a blip without
   *  making a genuinely-down host cost the learner nine seconds of silence. */
  attempts?: number;
  /** Base backoff in ms; doubles per attempt (400, 800). */
  baseDelayMs?: number;
  /** Injected in tests so a retry suite does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry — the caller logs, so this module stays free of a logging dependency. */
  onRetry?: (attempt: number, reason: string) => void;
}

const delay = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/**
 * Runs `fn`, retrying while `retryable` says the failure is transient. Rethrows the LAST error once
 * attempts run out, so the caller's existing error message is what the model finally sees.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retryable: (e: unknown) => boolean = isRetryableError,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 400;
  const sleep = opts.sleep ?? delay;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // The final attempt does not sleep — there is nothing after it to wait for.
      if (i === attempts - 1 || !retryable(e)) break;
      opts.onRetry?.(i + 1, (e as Error)?.message ?? String(e));
      await sleep(base * 2 ** i);
    }
  }
  throw last;
}

/** A non-ok HTTP response carried as an error so `withRetry` can decide on it by status. Keeps the
 *  status/url available to the caller's final error message. */
export class HttpStatusError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
  }
}

/** fetch + retry, treating retryable statuses as retryable failures. Returns the successful
 *  Response; throws HttpStatusError for a permanent status, or the transport error. */
export async function fetchWithRetry(
  url: string, init: RequestInit, opts: RetryOptions = {},
): Promise<Response> {
  return withRetry(
    async () => {
      const res = await fetch(url, init);
      if (!res.ok) throw new HttpStatusError(res.status, url);
      return res;
    },
    (e) => (e instanceof HttpStatusError ? isRetryableStatus(e.status) : isRetryableError(e)),
    opts,
  );
}
