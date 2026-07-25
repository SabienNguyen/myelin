// Ported from ~/Dev/personal/the-gap (READ ONLY there), apps/web (via @the-gap/core's
// packages/core/src/types.ts) — the harness has no dependency on @the-gap/core, so the small
// subset of shapes the sidecar's /api/ladder and /api/run responses actually carry is copied
// here verbatim rather than pulled in as a package dependency.

export type TemplateKind = 'worked_example' | 'inline_completion' | 'full_body';

export interface RungProse {
  context_line?: string;
  hint?: string;
  success_line?: string;
  moves?: {
    code: string;
    explanation: string;
    check?: { question: string; options: [string, string, string]; answerIndex: 0 | 1 | 2 };
  }[];
}

export interface Rung {
  id: string;
  template: TemplateKind;
  artifactId: string;
  visible_pre: string;
  visible_post: string;
  // reference_answer is stripped server-side (the-gap's server.ts) before it ever reaches the
  // browser for the learner's own rung — this type still names the field so a stray leak would
  // be visible in a type-level diff, but the harness client never reads it.
  reference_answer: string;
  prose: RungProse;
  // RungEditor v2 (docs/superpowers/plans/2026-07-21-coding-stage.md, whole-file IDE): the
  // complete answer-stripped file — visible_pre + an indented "YOUR TURN" task-marker comment +
  // visible_post — server-computed for every served rung, built-in and mined alike. Optional so a
  // stale sidecar response predating this field still type-checks; see ./scaffold.ts's
  // resolveScaffold for the client-side fallback every caller uses instead of reading this
  // directly.
  scaffold?: string;
}

export interface Ladder {
  pattern: string;
  targetArtifactId: string;
  siblingArtifactId: string;
  rungs: string[];
}

// Final integration (docs/superpowers/plans/2026-07-21-coding-stage.md B2c): repo-mined
// artifacts served alongside the built-in ladder's `rungs` — mirrors gapProxy.ts's
// GapMinedEntry/GapMinedArtifactMeta (duplicated rather than imported for the same
// server/client boundary reason as the rest of this file). Each entry is exactly ONE rung
// (whatever template packages/miner selected, typically full_body, answer-stripped the same
// way every non-worked_example built-in rung already is) plus provenance for the brief panel.
export interface MinedArtifactMeta {
  title: string;
  family: string; // e.g. "mined:<repo>"
  source: { repo: string; commit: string; path: string };
}

export interface MinedEntry {
  rung: Rung;
  meta: MinedArtifactMeta;
}

export interface TestResult {
  name: string;
  pass: boolean;
  // CodeSignal-style case detail. BOTH optional and absent from the real the-gap sidecar's
  // /api/run today — the contract there is {name, pass} only. A sidecar that omits them renders
  // exactly as before (no reveal affordance at all), which is the same graceful-degradation shape
  // `mined?` and `scaffold?` already use. Only ever shown behind a deliberate per-test reveal, and
  // revealing caps the evidence — see TestResultsPanel and server/grading.ts's reveal ceiling.
  expected?: string;
  actual?: string;
}
