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
}

const defaultDelay = (attempt: number) => 2000 * 2 ** attempt;

function isRetryable(e: unknown): boolean {
  if (e instanceof LlmHttpError) return e.retryable;
  // undici surfaces network-level failures (refused, reset, DNS) as "TypeError: fetch failed".
  return e instanceof TypeError && /fetch failed/i.test(e.message);
}

export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const delayMs = opts.delayMs ?? defaultDelay;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      await new Promise((r) => setTimeout(r, delayMs(attempt)));
    }
  }
}
