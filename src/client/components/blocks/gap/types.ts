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
}

export interface Ladder {
  pattern: string;
  targetArtifactId: string;
  siblingArtifactId: string;
  rungs: string[];
}

export interface TestResult {
  name: string;
  pass: boolean;
}
