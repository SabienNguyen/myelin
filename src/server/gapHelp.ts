// Track A (docs/superpowers/plans/2026-07-21-coding-stage.md "A. In-IDE tutor help"):
// POST /api/gap/help — a one-shot, ephemeral hint generation for a learner stuck mid-exercise.
// Deliberately NOT the chat thread (the interactive tutor role is a separate concern) — help
// exchanges live only in the client's session-local Help tab state, never saved to the lesson
// thread.
//
// Answer-integrity invariant, mechanically enforced (not just prompt-worded): this route fetches
// rung data ONLY via gapProxy.ts's fetchLadderPayload — the exact same fetch the GET /api/gap/
// ladder passthrough route uses, which the-gap sidecar already answer-strips server-side. It then
// maps the fetched rung down to helpPrompt.ts's `HelpRungContext`, a type that has no
// `reference_answer` field at all, before ever calling buildHelpPrompt. There is no second,
// unstripped endpoint this route could reach for instead, and no field on the prompt-builder's
// input type to carry a reference answer even if one were mistakenly forwarded.
import { generateText, type LanguageModel } from 'ai';
import { Hono } from 'hono';
import type { HarnessConfig } from './config.js';
import { fetchLadderPayload } from './gapProxy.js';
import { buildHelpPrompt, type HelpRungContext } from './helpPrompt.js';
import type { Engram } from './mcp.js';
import { modelFor } from './models.js';

const DRAFT_CAP = 20_000;
const QUESTION_CAP = 2_000;
// Only the most recent few hints matter for escalation, and the whole transcript would otherwise
// grow the prompt without bound across a long exercise.
const PRIOR_HINT_CAP = 6;

export interface GapHelpDeps {
  /** Injectable model seam for tests (mirrors ingestRoutes.ts's deps.model). */
  model?: LanguageModel;
}

interface HelpRequestBody {
  pattern?: unknown;
  rung?: unknown;
  question?: unknown;
  draft?: unknown;
  failures?: unknown;
  priorHints?: unknown;
}

function validate(body: HelpRequestBody): { pattern: string; rung: string; question: string; draft: string; failures: string[]; priorHints: string[] } | { error: string } {
  if (typeof body.pattern !== 'string' || body.pattern.trim() === '') return { error: '"pattern" must be a non-empty string' };
  if (typeof body.rung !== 'string' || body.rung.trim() === '') return { error: '"rung" must be a non-empty string' };
  if (typeof body.question !== 'string' || body.question.trim() === '') return { error: '"question" must be a non-empty string' };
  if (typeof body.draft !== 'string') return { error: '"draft" must be a string' };
  if (!Array.isArray(body.failures) || body.failures.some((f) => typeof f !== 'string')) {
    return { error: '"failures" must be a string[]' };
  }
  // priorHints is OPTIONAL and absent-tolerant: an older client simply gets the previous
  // single-shot behaviour rather than a 400. Capped in count and length for the same reason
  // question/draft are — this text goes straight into a model prompt.
  if (body.priorHints !== undefined
    && (!Array.isArray(body.priorHints) || body.priorHints.some((h) => typeof h !== 'string'))) {
    return { error: '"priorHints" must be a string[] when present' };
  }
  return {
    pattern: body.pattern,
    rung: body.rung,
    question: body.question.slice(0, QUESTION_CAP),
    draft: body.draft.slice(0, DRAFT_CAP),
    failures: body.failures as string[],
    priorHints: ((body.priorHints as string[] | undefined) ?? [])
      .slice(-PRIOR_HINT_CAP).map((h) => h.slice(0, QUESTION_CAP)),
  };
}

export function buildGapHelpRoute(lw: Engram, cfg: HarnessConfig, deps: GapHelpDeps = {}) {
  const app = new Hono();
  // No gate: with the built-in sandbox there is always a ladder to explain.

  app.post('/api/gap/help', async (c) => {
    const raw = await c.req.json().catch(() => ({})) as HelpRequestBody;
    const parsed = validate(raw);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    const { pattern, rung, question, draft, failures, priorHints } = parsed;

    let ladder: Awaited<ReturnType<typeof fetchLadderPayload>>;
    try {
      ladder = await fetchLadderPayload(cfg);
    } catch (e: any) {
      return c.json({ error: `gap sidecar unavailable: ${e?.message ?? e}` }, 502);
    }

    const matched = ladder.rungs.find((r) => r.template === rung);
    if (!matched) return c.json({ error: `no "${rung}" rung available for pattern "${pattern}"` }, 400);

    // Learner-visible fields only — reference_answer is never read off `matched`, see this file's
    // top comment. `rungContext` is typed with no field that could hold it.
    const rungContext: HelpRungContext = {
      template: matched.template,
      artifactId: matched.artifactId,
      visiblePre: matched.visible_pre,
      visiblePost: matched.visible_post,
      contextLine: matched.prose?.context_line,
    };

    let vaultPage: string | undefined;
    try {
      const { page } = await lw.call('read_page', { slug: pattern });
      vaultPage = page.body;
    } catch {
      vaultPage = undefined; // tolerate page-missing (or any read failure) — help still works
    }

    const { system, prompt } = buildHelpPrompt({ pattern, rung: rungContext, draft, failures, vaultPage, question, priorHints });

    const { text } = await generateText({ model: deps.model ?? modelFor('tutor', cfg), system, prompt });

    return c.json({ hint: text.trim() });
  });

  return app;
}
