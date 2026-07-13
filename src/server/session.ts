import {
  ToolLoopAgent, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse,
  isStepCount, toUIMessageStream, tool, type LanguageModel, type ModelMessage, type ToolSet, type UIMessage,
} from 'ai';
import type { z } from 'zod';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES, type BlockToolName } from '../shared/blocks.js';
import { recentLapses } from './anki/inbound.js';
import type { HarnessConfig } from './config.js';
import { gradeBlockOutput } from './grading.js';
import { buildIngestTools } from './ingestTools.js';
import type { Loreweaver } from './mcp.js';
import { modelFor } from './models.js';
import { buildBootstrapContext, buildInstructions, type Mode } from './prompt.js';
import { logGuardrail } from './sessionStore.js';
import { buildWebTools } from './webTools.js';

// Tools the tutor may use per mode; write/link/compile only in freeform (spec §5).
const TEACH_TOOLS = ['read_page', 'search', 'get_student_state', 'record_evidence',
  'next_lessons', 'find_analogies', 'list_paths', 'read_path'];

// Tools whose `student` argument must always be the configured student — models
// (especially small local ones) invent ids like "student" otherwise.
const STUDENT_TOOLS = ['record_evidence', 'get_student_state', 'next_lessons', 'find_analogies'];

// Tools whose `slug` argument must name a real vault page.
const SLUG_TOOLS = ['record_evidence', 'read_page', 'find_analogies'];

function levenshtein(a: string, b: string): number {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}

/** Map a (possibly hallucinated) slug onto the closest real vault slug. Models invent slugs
 * like "derivatives-introduction" or "derivative" for the real page "derivatives"; repairing
 * conservatively (containment or small edit distance, unique winner) beats letting every
 * downstream record_evidence/find_analogies call fail. Unmatched slugs pass through untouched
 * so genuine errors stay visible. */
export function repairSlug(slug: string, known: string[]): string {
  if (!slug || known.includes(slug)) return slug;
  const norm = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  if (known.includes(norm)) return norm;
  const scored = known
    .map((k) => ({
      k,
      score: norm.startsWith(`${k}-`) || k.startsWith(`${norm}-`) || norm === `${k}s` || k === `${norm}s`
        ? 0 : levenshtein(norm, k),
    }))
    .filter(({ k, score }) => score <= Math.min(3, Math.floor(k.length / 3)))
    .sort((a, b) => a.score - b.score);
  if (scored.length && (scored.length === 1 || scored[0].score < scored[1].score)) return scored[0].k;
  return slug;
}

/** Drop null/undefined args (MCP zod schemas want optional fields ABSENT, not null). */
export function sanitizeToolArgs(args: any, toolName: string, student: string, knownSlugs: string[] = []): any {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (v != null) out[k] = v;
  if (STUDENT_TOOLS.includes(toolName)) out.student = student;
  if (SLUG_TOOLS.includes(toolName) && typeof out.slug === 'string' && knownSlugs.length)
    out.slug = repairSlug(out.slug, knownSlugs);
  return out;
}

/** Wrap MCP tools so every execute() sees sanitized args — the model cannot send a wrong
 * student id, a null optional field, or (where repairable) a hallucinated slug. Failed calls
 * are logged server-side so journalctl shows WHY a tool chip went ⚠. */
function guardMcpTools(tools: ToolSet, student: string, knownSlugs: string[]): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, t]: [string, any]) => [name, {
    ...t,
    execute: t.execute
      ? async (args: any, opts: any) => {
        const clean = sanitizeToolArgs(args, name, student, knownSlugs);
        const result = await t.execute(clean, opts);
        if (result && typeof result === 'object' && (result as any).isError) {
          const text = ((result as any).content ?? []).map((c: any) => c?.text ?? '').join(' ');
          console.error(`[tool-error] ${name} args=${JSON.stringify(clean)} -> ${text.slice(0, 300)}`);
        }
        return result;
      }
      : t.execute,
  }])) as ToolSet;
}

function blockTools(): ToolSet {
  // Frontend tools: no execute — the loop pauses; the browser supplies output via addToolOutput.
  // (`inputSchema` cast to z.ZodTypeAny — a plain `.map` over the BlockToolName union defeats
  // tool()'s generic overload inference, which otherwise falls back to Tool<never, never, ...>.)
  return Object.fromEntries(BLOCK_TOOL_NAMES.map((name) => [name, tool({
    description: `Present a ${name} block to the student and wait for their work.`,
    inputSchema: BLOCK_TOOLS[name].input as z.ZodTypeAny,
  })]));
}

/** Find block-tool outputs in the tail of the incoming history (since the last user text turn). */
function pendingBlockOutputs(messages: UIMessage[]) {
  const out: { tool: BlockToolName; toolCallId: string; input: any; output: any }[] = [];
  const last = messages[messages.length - 1];
  for (const msg of [last]) {
    if (msg?.role !== 'assistant') continue;
    for (const part of msg.parts as any[]) {
      const name = String(part.type).replace(/^tool-/, '') as BlockToolName;
      if (part.type?.startsWith('tool-') && BLOCK_TOOL_NAMES.includes(name)
        && part.state === 'output-available' && !part.output?.grading) {
        out.push({ tool: name, toolCallId: part.toolCallId, input: part.input, output: part.output });
      }
    }
  }
  return out;
}

export function createTutorSession(
  lw: Loreweaver, cfg: HarnessConfig,
  opts: { model?: LanguageModel; now?: () => Date } = {},
) {
  const model = opts.model ?? modelFor('tutor', cfg);

  async function bootstrap(mode: Mode, slugs: string[]): Promise<string> {
    const [state, lessonsRes] = await Promise.all([
      lw.call('get_student_state', { student: cfg.student }),
      lw.call('next_lessons', { student: cfg.student }),
    ]);
    const lessons = lessonsRes.lessons ?? [];
    const ctx = buildBootstrapContext({
      mode, state,
      lessons,
      reviewsDue: lessons.filter((l: any) => l.reason === 'review-due').map((l: any) => l.slug),
      ankiLapses: recentLapses(cfg.vault),
    });
    // Ground the model in the REAL page ids — small models otherwise invent slugs like
    // "derivatives-introduction" and every downstream slug-taking call fails.
    return `${ctx}\nVault pages (the ONLY valid slugs — use them verbatim): ${slugs.join(', ')}`;
  }

  function turnError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[turn-error]', msg);
    return `The tutor hit an error and this turn was lost: ${msg.slice(0, 200)}`;
  }

  async function respond(messages: UIMessage[], mode: Mode): Promise<Response> {
    const pending = pendingBlockOutputs(messages);

    // Everything slow (grading, bootstrap, model turns) runs INSIDE the stream's execute so the
    // HTTP response starts immediately — the client flips to "running" and can show a working
    // indicator during grading instead of a dead pause.
    const stream = createUIMessageStream({
      // Continuation, not a new sibling message: when this response is a resubmit whose incoming
      // history already ends in an assistant message (the block output that triggered the
      // resubmit), `createUIMessageStream` inspects `originalMessages` and injects THAT message's
      // id into the outgoing 'start' chunk. The client (ai@7's AbstractChat.makeRequest) seeds its
      // streaming state from a snapshot of that same last message and only REPLACES it in place
      // when the ids match — without this, the ids mismatch (a fresh one vs the snapshot's), the
      // client falls back to pushing the snapshot-plus-new-content as an extra sibling message, and
      // the turn-1 content (e.g. "Let's warm up.") ends up rendered twice.
      originalMessages: messages,
      // Surface failures to the learner ("degrade loudly") — and to journalctl. NOTE: model
      // errors surface through the MERGED agent stream, so the same handler must also be passed
      // to toUIMessageStream below — this outer one only catches execute()-level throws.
      onError: turnError,
      execute: async ({ writer }) => {
        // 1. Grade fresh block outputs BEFORE the model sees them.
        const grades: Awaited<ReturnType<typeof gradeBlockOutput>>[] = [];
        for (const p of pending) {
          const grading = await gradeBlockOutput(p.tool, p.input, p.output, cfg);
          p.output.grading = grading; // model sees student work + machine grade together
          grades.push(grading);
        }

        const slugs = await lw.listSlugs();
        const mcpTools = guardMcpTools(await lw.tools(), cfg.student, slugs);
        const activeMcp = Object.fromEntries(Object.entries(mcpTools)
          .filter(([n]) => mode === 'freeform' || TEACH_TOOLS.includes(n)));

        // Research tools ride with the vault-writing tools: freeform only. A subject gets
        // researched and compiled in freeform; teaching modes stay grounded in the vault.
        const webTools = mode === 'freeform' ? buildWebTools(cfg) : {};
        // ingest_paper needs cfg (to queue) AND lw (to kick a background compile) — same
        // freeform-only gate as webTools: a subject gets researched, sourced, and compiled in
        // freeform; teaching modes stay grounded in the vault.
        const ingestTools = mode === 'freeform' ? buildIngestTools(lw, cfg) : {};

        const agent = new ToolLoopAgent({
          model,
          instructions: `${buildInstructions()}\nThe student's id is "${cfg.student}" — always pass exactly this as the \`student\` argument.`,
          tools: { ...activeMcp, ...webTools, ...ingestTools, ...blockTools() },
          stopWhen: isStepCount(24),
        });

        const isFirstTurn = messages.filter((m) => m.role === 'assistant').length === 0;
        const context: ModelMessage[] = [];
        if (isFirstTurn) context.push({ role: 'user', content: await bootstrap(mode, slugs) });
        if (grades.length) context.push({
          role: 'user',
          content: `HARNESS: graded block results attached above: ${grades.map((g) => `${g.verdict} (${g.detail})`).join('; ')}. ` +
            `You MUST now call record_evidence for: ${JSON.stringify(grades.flatMap((g) => g.evidence))} — then respond to the student.`,
        });

        const model_messages = [...context, ...(await convertToModelMessages(messages))];

        // Bug 2 fix: the grading above only mutated the REQUEST's copy of the tool output
        // (p.output.grading, kept so the model sees student work + machine grade together in the
        // prompt below) — the browser never sees that mutation on its own. This is where the
        // `originalMessages` continuation wiring above pays off twice over: because this response
        // continues (replaces in place) the incoming history's last assistant message, ai@7's
        // client-side stream processor seeds its working message state from THAT message — meaning
        // it already contains a part with this toolCallId. So a normal `tool-output-available`
        // chunk finds and patches it directly, same as any other tool result; no custom data part
        // or client-side merge code needed. (A `data-grading` data-part sibling was tried first,
        // merged client-side via onData/setMessages — but it raced the continuation's own
        // replace-in-place write and got clobbered; this doesn't have that problem because it's
        // processed as part of the SAME stream/write sequence.)
        for (const p of pending) {
          writer.write({ type: 'tool-output-available', toolCallId: p.toolCallId, output: p.output });
        }
        const run = async (msgs: ModelMessage[]) => {
          const result = await agent.stream({ messages: msgs });
          writer.merge(toUIMessageStream({ stream: result.stream, onError: turnError }));
          const steps = await result.steps;
          const called = steps.flatMap((s: any) => s.toolCalls ?? [])
            .some((tc: any) => tc.toolName === 'record_evidence');
          return called;
        };
        const recorded = await run(model_messages);
        if (grades.length && !recorded) {
          // Guardrail: one nudged retry
          const nudged = await run([...model_messages, {
            role: 'user',
            content: 'HARNESS GUARDRAIL: you did not call record_evidence for the graded block result. Do it now, then continue.',
          }]);
          if (!nudged) {
            logGuardrail(cfg.vault, `unrecorded evidence for ${pending.map((p) => p.tool).join(',')}`);
            writer.write({ type: 'data-guardrail', data: { warning: 'evidence not recorded' }, transient: true } as any);
          }
        }
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  return { respond };
}
export type TutorSession = ReturnType<typeof createTutorSession>;
