// Ported from ~/Dev/personal/the-gap apps/web/src/api.ts (READ ONLY there) — adapted to the
// harness proxy contract (docs/superpowers/plans/2026-07-20-gap-integration.md Pinned Contracts):
// GET /api/gap/ladder, POST /api/gap/run {rungId, code, trace?}. The gap's own /api/ledger is not
// ported — the harness records evidence through grading.ts + Loreweaver's record_evidence instead
// of the gap's standalone watched/written ledger.

import type { Ladder, MinedEntry, Rung } from './types.js';

export interface LadderPayload {
  ladder: Ladder;
  rungs: Rung[];
  // Final integration (docs/superpowers/plans/2026-07-21-coding-stage.md B2c): optional — a
  // pre-B2c sidecar response (or a fixture built before this landed) simply omits it, which
  // CodeExercise.tsx's resolution treats identically to an empty array.
  mined?: MinedEntry[];
}

export interface RunResponse {
  pass: boolean;
  // `expected`/`actual` are optional and absent from the real sidecar today — see types.ts's
  // TestResult. TestResultsPanel only offers them behind a deliberate reveal.
  results: { name: string; pass: boolean; expected?: string; actual?: string }[];
  syntaxError?: string;
  trace?: { fired: string[] };
  // Scratch-run fields (request carried `input`): the suite did not run, so `results` is empty and
  // `actual` is the learner's own output. No expected value exists for a scratch run, which is why
  // it carries no evidence consequence — unlike the reveal above.
  scratch?: boolean;
  actual?: string;
  chunks?: number;
  runtimeError?: string;
}

export async function getLadder(): Promise<LadderPayload> {
  const response = await fetch('/api/gap/ladder');
  if (!response.ok) throw new Error(`GET /api/gap/ladder failed: ${response.status}`);
  return response.json();
}

export interface PostRunOptions {
  /** Whole-file IDE (docs/superpowers/plans/2026-07-21-coding-stage.md): `code` is the rung's
   *  COMPLETE file rather than just a spliced-in gap fragment — graded against the artifact's
   *  real suite, same shape response either way (plus an optional `syntaxError` on parse
   *  failure). Every caller that now sources `code` from RungEditor's whole-doc onDocChange
   *  (CodeExercise.tsx, InlineCompletion.tsx, PredictRunPanel.tsx) must set this — omitting it
   *  would have the sidecar try to splice a whole file into visible_pre/visible_post as if it
   *  were a bare gap fragment. */
  mode?: 'file';
  trace?: boolean;
  /** Scratch run against the learner's OWN input instead of the artifact suite. The sidecar returns
   *  `{scratch:true, actual}` and skips grading entirely. Deliberately routed through /api/run
   *  rather than a new endpoint so the harness's existing proxy — which forwards the request body
   *  verbatim — needs no change. A sidecar that doesn't implement it simply grades as usual, which
   *  the panel reports rather than pretending it ran. */
  input?: string;
}

export async function postRun(rungId: string, code: string, options?: PostRunOptions): Promise<RunResponse> {
  const response = await fetch('/api/gap/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rungId,
      code,
      ...(options?.mode ? { mode: options.mode } : {}),
      ...(options?.trace ? { trace: true } : {}),
      ...(options?.input !== undefined ? { input: options.input } : {}),
    }),
  });
  if (!response.ok) throw new Error(`POST /api/gap/run failed: ${response.status}`);
  return response.json();
}

// Track A (docs/superpowers/plans/2026-07-21-coding-stage.md "A. In-IDE tutor help"): a one-shot
// hint generation, deliberately NOT the chat thread — see src/server/gapHelp.ts's top comment.
export interface HelpRequest {
  pattern: string;
  rung: string;
  question: string;
  draft: string;
  failures: string[];
}
export interface HelpResponse {
  hint: string;
}

export async function postHelp(input: HelpRequest): Promise<HelpResponse> {
  const response = await fetch('/api/gap/help', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`POST /api/gap/help failed: ${response.status}`);
  return response.json();
}
