// I3 (docs/superpowers/plans/2026-07-20-gap-integration.md): "coding patterns live in the
// vault/graph like any other knowledge." The Gap's ladders are keyed by pattern id (MVP: one
// ladder, 'stream-consumer'); this seeds a matching vault page at boot so the pattern has
// somewhere to live in the graph/library/page tabs and a slug for code_exercise's `pageSlug` and
// record_evidence to target, even before any tutor turn ever teaches it.
//
// Single-writer rationale (docs/superpowers/plans/2026-07-12-loreweaver-harness.md Global
// Constraints: "all vault/student mutations go through Loreweaver MCP tools"): this still goes
// through lw.call('write_page', ...) — Loreweaver remains the only thing that ever touches the
// vault on disk. What makes this safe to run unattended at every boot, unlike a model-authored
// write, is that the content is MECHANICAL: a fixed string baked into this file, not model
// output — there's nothing here for a model to hallucinate or drift, so "write once, never again"
// (the idempotence check below) is sufficient; no review/approval step is needed the way a
// tutor's freeform-mode write would need one.
import type { HarnessConfig } from './config.js';
import type { Loreweaver } from './mcp.js';

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

/** Idempotent boot seed: for each known ladder pattern, writes a 'stub' vault page IF (and only
 * if) that slug doesn't already exist. Never overwrites — a page that has grown past the stub
 * (the tutor filled it in, or it earned a 'draft'/'solid' status some other way) is left alone,
 * so re-running this on every boot is safe and cheap (one `listSlugs()` glob plus zero or more
 * `write_page` calls). No-ops entirely when `cfg.gap` is absent — same "feature off when config
 * absent" pattern as gapProxy.ts's buildGapRoutes, since there's no ladder to seed a page for. */
export async function seedPatternPages(lw: Loreweaver, cfg: HarnessConfig): Promise<void> {
  if (!cfg.gap) return;
  const existing = new Set(await lw.listSlugs());
  for (const page of PATTERN_PAGES) {
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
