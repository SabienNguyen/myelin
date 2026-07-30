// Transient-failure retries for the request-initiation path (SDK parity: the AI SDK retried
// twice with exponential backoff by default, and dropping that made a single 529 fail a turn
// that used to recover). Scope is deliberately the POST only — once a stream has started and
// forwarded output, a mid-stream fault must surface, not silently replay half a turn.
import { LlmHttpError } from './types.js';

export interface RetryOptions {
  /** Attempts AFTER the first. Default 2 (the SDK's default). */
  retries?: number;
  /** Delay before retry n (0-based). Default 2s, 4s. Injectable so tests run in milliseconds. */
  delayMs?: (attempt: number) => number;
  /** Caller abort: no further attempts once it fires, and a fire mid-backoff rejects immediately
   * with the signal's reason instead of sleeping out the delay. */
  signal?: AbortSignal;
}

const defaultDelay = (attempt: number) => 2000 * 2 ** attempt;

function isRetryable(e: unknown): boolean {
  if (e instanceof LlmHttpError) return e.retryable;
  // undici surfaces network-level failures (refused, reset, DNS) as "TypeError: fetch failed".
  return e instanceof TypeError && /fetch failed/i.test(e.message);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const delayMs = opts.delayMs ?? defaultDelay;
  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (e) {
      // An aborted attempt is not a transient failure, whatever error shape the abort surfaced as.
      if (attempt >= retries || !isRetryable(e) || opts.signal?.aborted) throw e;
      await abortableSleep(delayMs(attempt), opts.signal);
    }
  }
}
