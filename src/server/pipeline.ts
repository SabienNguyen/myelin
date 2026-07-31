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
