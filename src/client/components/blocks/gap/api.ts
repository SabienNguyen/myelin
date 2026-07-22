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
  results: { name: string; pass: boolean }[];
  syntaxError?: string;
  trace?: { fired: string[] };
}

export async function getLadder(): Promise<LadderPayload> {
  const response = await fetch('/api/gap/ladder');
  if (!response.ok) throw new Error(`GET /api/gap/ladder failed: ${response.status}`);
  return response.json();
}

export async function postRun(rungId: string, code: string, trace?: boolean): Promise<RunResponse> {
  const response = await fetch('/api/gap/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(trace ? { rungId, code, trace: true } : { rungId, code }),
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
