// The small-model engine (spec 2026-07-31): the harness decides, the model fills one narrow
// slot per call. Pure orchestration — no I/O of its own; consumers hand in the model calls.
import { LlmHttpError } from './llm/index.js';

export type PipelineFailureClass = 'overflow' | 'weak-output' | 'transport';

/** Endpoint-unreachable/erroring — not model-too-weak. LlmHttpError covers every non-2xx the
 * adapters surface (post-retry); undici's "fetch failed" TypeError is the connection-level face.
 * (Moved verbatim from ingest.ts — one definition, two consumers.) */
export function isTransportFailure(e: unknown): boolean {
  if (e instanceof LlmHttpError) return true;
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
 * "consumed the entry with undistilled content" bug the old compile ladder guarded against. */
export async function mapPieces<T>(opts: {
  pieces: string[];
  budget: number;
  concurrency?: number;
  attempt: (piece: string, rejection?: string) => Promise<T>;
  floor: (piece: string, cls: PipelineFailureClass, reason: string) => Promise<T>;
}): Promise<{ results: T[]; receipts: PieceReceipt[] }> {
  const results: T[] = new Array(opts.pieces.length);
  const receipts: PieceReceipt[] = new Array(opts.pieces.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= opts.pieces.length) return;
      const piece = opts.pieces[i];
      try {
        results[i] = await opts.attempt(piece);
        receipts[i] = { piece: i, outcome: 'ok' };
      } catch (first) {
        if (isTransportFailure(first)) throw first;
        const firstMsg = first instanceof Error ? first.message : String(first);
        try {
          results[i] = await opts.attempt(piece, firstMsg);
          receipts[i] = { piece: i, outcome: 'ok' };
        } catch (second) {
          if (isTransportFailure(second)) throw second;
          const reason = (second instanceof Error ? second.message : String(second)).slice(0, 160);
          const cls = classifyFailure(second, piece.length, opts.budget);
          results[i] = await opts.floor(piece, cls, reason);
          receipts[i] = { piece: i, outcome: 'floored', reason, class: cls };
        }
      }
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? 4, opts.pieces.length));
  await Promise.all(Array.from({ length: n }, worker));
  return { results, receipts };
}
