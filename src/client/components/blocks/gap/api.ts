// Ported from ~/Dev/personal/the-gap apps/web/src/api.ts (READ ONLY there) — adapted to the
// harness proxy contract (docs/superpowers/plans/2026-07-20-gap-integration.md Pinned Contracts):
// GET /api/gap/ladder, POST /api/gap/run {rungId, code, trace?}. The gap's own /api/ledger is not
// ported — the harness records evidence through grading.ts + Loreweaver's record_evidence instead
// of the gap's standalone watched/written ledger.

import type { Ladder, Rung } from './types.js';

export interface LadderPayload {
  ladder: Ladder;
  rungs: Rung[];
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
