// The small-model engine (spec 2026-07-31): the harness decides, the model fills one narrow
// slot per call. Pure orchestration — no I/O of its own; consumers hand in the model calls.
import { LlmHttpError } from './llm/index.js';

export type PipelineFailureClass = 'overflow' | 'weak-output' | 'transport';

/** Endpoint unreachable or having a moment — worth waiting and retrying, NOT worth falling back
 * over. Only RETRYABLE http failures qualify (LlmHttpError.retryable: 408/409/429/5xx); undici's
 * "fetch failed" TypeError is the connection-level face of the same thing.
 *
 * A permanent 4xx is the endpoint telling us this request is wrong, and it will be just as wrong
 * next time. Treating those as transport cost a live user every chapter of an ingest: gpt-5.6-luna
 * answers "function tools ... are not supported in /v1/chat/completions" with a 400, so compile
 * failed the entry, requeued it, and failed identically forever — when the harness-driven
 * distillation fallback (response_format, no function tools) would have compiled it fine. */
export function isTransportFailure(e: unknown): boolean {
  if (e instanceof LlmHttpError) return e.retryable;
  return e instanceof TypeError && /fetch failed/i.test(e.message);
}

/** Chars a single call may spend on PAYLOAD. tokens*4 is the standard floor estimate; 8k chars
 * are reserved for system + schema + instructions so the payload never truncates them out.
 * No contextTokens configured → the 24k default CHAPTER_CHUNK_CHARS proved for two years. */
export function budgetChars(contextTokens: number | undefined): number {
  if (!contextTokens) return 24_000;
  return Math.max(4_000, contextTokens * 4 - 8_000);
}

/** Why a piece failed, decided BEFORE any fallback runs — the remedies differ (split vs retry vs
 * wait-and-requeue) and "it fell back" without a why is a bug per the spec. */
export function classifyFailure(e: unknown, promptChars: number, budget: number): PipelineFailureClass {
  if (isTransportFailure(e)) return 'transport';
  if (promptChars > budget) return 'overflow';
  return 'weak-output';
}

export interface PieceReceipt {
  piece: number;
  outcome: 'ok' | 'floored';
  reason?: string;
  class?: PipelineFailureClass;
}

/** The ladder, per piece: one attempt, one rejection-retry (the rails recipe), then the
 * consumer's floor with a DIAGNOSED class. Transport rejects the whole map — a dead endpoint
 * would floor every piece into fallback content during an outage, which is exactly the
 * "consumed the entry with undistilled content" bug the old compile ladder guarded against.
 *
 * `attempt`/`floor` get the piece's own index in `pieces` as their last argument — the one place
 * that index is authoritative. Callers that need a stable per-piece label (a "part N of M" in a
 * prompt, say) should use that index, not re-derive it by matching on piece content: two pieces
 * can legitimately have identical text, and a content match would silently mislabel one of them. */
export async function mapPieces<T>(opts: {
  pieces: string[];
  budget: number;
  concurrency?: number;
  attempt: (piece: string, rejection: string | undefined, index: number) => Promise<T>;
  floor: (piece: string, cls: PipelineFailureClass, reason: string, index: number) => Promise<T>;
}): Promise<{ results: T[]; receipts: PieceReceipt[] }> {
  const results: T[] = new Array(opts.pieces.length);
  const receipts: PieceReceipt[] = new Array(opts.pieces.length);
  let next = 0;
  // Set the instant any worker sees a transport failure, and checked before every new piece is
  // claimed. Promise.all can't cancel the OTHER workers' in-flight `attempt`/`floor` calls (no
  // AbortController plumbing here — out of scope), but without this flag they keep claiming and
  // processing FRESH pieces after the entry is already doomed to be marked 'error' and requeued,
  // so the requeue's retry redistills and re-writes those same pieces again under `-2` slug
  // suffixes. This closes that window down to "at most the pieces already in flight when the
  // transport failure landed", which is the best available without real cancellation.
  let aborted = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (aborted) return;
      const i = next++;
      if (i >= opts.pieces.length) return;
      const piece = opts.pieces[i];
      try {
        results[i] = await opts.attempt(piece, undefined, i);
        receipts[i] = { piece: i, outcome: 'ok' };
      } catch (first) {
        if (isTransportFailure(first)) { aborted = true; throw first; }
        const firstMsg = first instanceof Error ? first.message : String(first);
        try {
          results[i] = await opts.attempt(piece, firstMsg, i);
          receipts[i] = { piece: i, outcome: 'ok' };
        } catch (second) {
          if (isTransportFailure(second)) { aborted = true; throw second; }
          const reason = (second instanceof Error ? second.message : String(second)).slice(0, 160);
          const cls = classifyFailure(second, piece.length, opts.budget);
          results[i] = await opts.floor(piece, cls, reason, i);
          receipts[i] = { piece: i, outcome: 'floored', reason, class: cls };
        }
      }
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? 4, opts.pieces.length));
  await Promise.all(Array.from({ length: n }, worker));
  return { results, receipts };
}
