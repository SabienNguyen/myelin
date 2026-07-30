// I3 (docs/superpowers/plans/2026-07-20-gap-integration.md): "coding patterns live in the
// vault/graph like any other knowledge." The Gap's ladders are keyed by pattern id (MVP: one
// ladder, 'stream-consumer'); this seeds a matching vault page at boot so the pattern has
// somewhere to live in the graph/library/page tabs and a slug for code_exercise's `pageSlug` and
// record_evidence to target, even before any tutor turn ever teaches it.
//
// Single-writer rationale (docs/superpowers/plans/2026-07-12-myelin.md Global
// Constraints: "all vault/student mutations go through Engram MCP tools"): this still goes
// through lw.call('write_page', ...) — Engram remains the only thing that ever touches the
// vault on disk. What makes this safe to run unattended at every boot, unlike a model-authored
// write, is that the content is MECHANICAL: a fixed string baked into this file, not model
// output — there's nothing here for a model to hallucinate or drift, so "write once, never again"
// (the idempotence check below) is sufficient; no review/approval step is needed the way a
// tutor's freeform-mode write would need one.
import type { HarnessConfig } from './config.js';
import { approvedGenerated } from './gap/generated.js';
import { readBank } from './courseBank.js';
import type { Engram } from './mcp.js';

interface PatternPageSeed {
  slug: string;
  title: string;
  domain: string;
  body: string;
  sources: string[];
}

// MVP: one ladder (the-gap's demo content — see systemd/the-gap.service). Add an entry here per
// additional ladder the-gap grows; each is looked up by GET /api/gap/ladder's `ladder.pattern`,
// which is expected to equal this `slug`.
const PATTERN_PAGES: PatternPageSeed[] = [
  {
    slug: 'stream-consumer',
    title: 'Consuming SSE token streams',
    domain: 'programming',
    body: [
      '# Consuming SSE token streams',
      '',
      "Stub page, seeded at boot from the-gap's `stream-consumer` artifact (I3 vault wiring). " +
        'Practice this pattern with a real code exercise — ask the tutor, or use the Library ' +
        "panel's Practice section — rather than reading this stub as the lesson itself.",
      '',
      'A stream consumer decodes an incrementally-delivered HTTP response body (the shape LLM ' +
        'chat-completion `stream: true` endpoints return) into discrete events, without assuming ' +
        'any chunk boundary lines up with an event boundary — a single event (or even a ' +
        'multi-byte UTF-8 character) can arrive split across two reads, so both the decoder and ' +
        'the line-splitter carry state across reads instead of assuming one chunk equals one line.',
      '',
      'The exercise walks worked example (a sibling pattern, read-only) -> inline completion ' +
        '(one gap) -> full body (the whole function, graded against real tests) — the same ' +
        "sequence the-gap's own ladder enforces.",
    ].join('\n'),
    sources: ['the-gap artifact stream-consumer'],
  },
];

/** The factory-shipped demo patterns, by slug. The graph and the Library's Practice section both
 *  hide one of these while it is untouched (no mastery record, never filled in): a brand-new
 *  learner's workspace opened with a "Consuming SSE token streams" entry they never asked for —
 *  infrastructure presenting itself as their knowledge. The page still exists (code_exercise
 *  targets it, the Page tab can open it, the tutor can assign it); it joins the graph and the
 *  Practice list when the learner actually engages. Deliberately only the hardcoded list:
 *  generated-exercise and course-bank seeds exist because the learner did something. */
export const BUILTIN_PATTERN_SLUGS: ReadonlySet<string> = new Set(PATTERN_PAGES.map((p) => p.slug));

/** Idempotent boot seed: for each known ladder pattern, writes a 'stub' vault page IF (and only
 * if) that slug doesn't already exist. Never overwrites — a page that has grown past the stub
 * (the tutor filled it in, or it earned a 'draft'/'solid' status some other way) is left alone,
 * so re-running this on every boot is safe and cheap (one `listSlugs()` glob plus zero or more
 * `write_page` calls). No gate on cfg.gap any more: the built-in sandbox (gap/service.ts) means
 * there is ALWAYS at least the stream-consumer ladder to seed a page for. */
/** One stub page per course-bank source, so drilled problems have somewhere for evidence to
 *  land. The live-model sitting exposed the gap: a blank answer on a banked problem produced no
 *  `struggled` trace anywhere, because the bank is not a page and record_evidence needs one.
 *  Slug course-<source> — the tutor prompt names it as the pageSlug for bank drills. */
export function courseSeeds(vault: string): PatternPageSeed[] {
  const sources = [...new Set(readBank(vault).map((p) => p.source))];
  return sources.map((source) => ({
    slug: `course-${source}`,
    title: `Course practice: ${source}`,
    domain: 'course',
    body: 'Stub page, seeded at boot for an added problem set or past exam. Evidence from '
      + 'drilling its problems lands here, so struggles and passes on YOUR course material '
      + 'track like any other page.',
    sources: [`course bank source ${source}`],
  }));
}

export async function seedPatternPages(lw: Engram, cfg: HarnessConfig): Promise<void> {
  const existing = new Set(await lw.listSlugs());
  // Approved GENERATED exercises seed pages too — derived from what is on disk, not from widening
  // the hardcoded list below (which the backlog's own self-criticism warns against). Same
  // idempotence, same single-writer route.
  const generated: PatternPageSeed[] = approvedGenerated(cfg.vault).map((ex) => ({
    slug: ex.pattern,
    title: ex.title,
    domain: 'programming',
    // No `# title` heading: the Page panel renders the title itself, and the audit screenshot
    // showed the seeded h1 doubling it immediately below.
    body: [
      'Stub page, seeded at boot for a generated coding exercise (reviewed and approved). '
        + 'Practice it with a real code exercise — ask the tutor.', '',
      ex.statement,
    ].join('\n'),
    sources: [`generated exercise ${ex.pattern} (${ex.generatedBy})`],
  }));
  // Course-bank sources seed a page each, so drilled problems have somewhere for evidence to
  // land. The live-model sitting exposed the gap: a blank answer on a banked problem produced no
  // `struggled` trace anywhere, because the bank is not a page and record_evidence needs one.
  // Slug course-<source> — the tutor prompt names it as the pageSlug for bank drills.
  for (const page of [...PATTERN_PAGES, ...generated, ...courseSeeds(cfg.vault)]) {
    if (existing.has(page.slug)) continue;
    await lw.call('write_page', {
      slug: page.slug,
      title: page.title,
      domain: page.domain,
      body: page.body,
      status: 'stub',
      sources: page.sources,
    });
  }
}
