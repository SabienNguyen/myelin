import type { HarnessConfig } from './config.js';

// Wire shapes for a gap-ladder payload (mirrors the subset src/client/components/blocks/gap/
// types.ts ports — duplicated here rather than imported because server code must not depend on
// client code). `reference_answer` is named so a stray leak into a server-side consumer would be
// visible in a type-level diff — see helpPrompt.ts's top comment for why the help route's prompt
// builder uses a DIFFERENT type that omits it entirely rather than picking fields off this one.
export interface GapRung {
  id: string;
  template: 'worked_example' | 'inline_completion' | 'full_body';
  artifactId: string;
  visible_pre: string;
  visible_post: string;
  reference_answer: string;
  prose?: { context_line?: string; hint?: string; success_line?: string };
}
// B2c: mined artifacts (packages/miner output, i.e. the harness vault's own repo-mining pass)
// served IN ADDITION to `rungs` above. Optional (not every ladder payload predates this field,
// and callers that only care about the built-in ladder never need to touch it) rather than
// required, so existing code/tests constructing a GapLadderPayload literal don't need updating.
export interface GapMinedArtifactMeta {
  title: string;
  family: string; // e.g. "mined:<repo>"
  source: { repo: string; commit: string; path: string };
}
export interface GapMinedEntry {
  rung: GapRung;
  meta: GapMinedArtifactMeta;
}
export interface GapLadderPayload {
  ladder: { pattern: string; targetArtifactId: string; siblingArtifactId: string; rungs: string[] };
  rungs: GapRung[];
  mined?: GapMinedEntry[];
  /** Calling convention of the exercise ('stream' | 'function'). Optional because an earlier
   *  version of this payload predates it — absent means stream, the only family that existed.
   *  The client uses it for COPY (a function returns one value; a stream yields a sequence),
   *  never for grading. */
  family?: string;
}

/** Fetches the built-in sandbox's ladder payload (gap/service.ts), through the same stripped
 * payload builder its own GET /api/gap/ladder route serializes. Lazy import so gapProxy (which
 * gapHelp.ts also pulls in) does not eagerly load exercise content it usually won't need. Shared
 * by that route and gapHelp.ts's /api/gap/help route, so both ever reach rung data through this
 * one path — the mechanical half of the answer-integrity invariant: there is no second,
 * unstripped source of rung data for either caller to reach instead. */
export async function fetchLadderPayload(cfg: HarnessConfig): Promise<GapLadderPayload> {
  const { builtinLadderPayload } = await import('./gap/service.js');
  return builtinLadderPayload(undefined, cfg.vault);
}

/** Powers the `gap` badge on GET /api/status. Code exercises run in-process (gap/service.ts) —
 * there is no separate sidecar that could be down, so this is unconditionally true. Kept as a
 * named function (rather than inlined at the one call site) so the status route reads as
 * checking something, not hardcoding a badge value. */
export async function isGapUp(): Promise<boolean> {
  return true;
}
