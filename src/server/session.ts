import {
  ToolLoopAgent, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse,
  isStepCount, toUIMessageStream, tool, type LanguageModel, type ModelMessage, type ToolSet, type UIMessage,
} from 'ai';
import { z } from 'zod';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES, type BlockToolName } from '../shared/blocks.js';
import { recentLapses } from './anki/inbound.js';
import type { HarnessConfig } from './config.js';
import { gradeBlockOutput } from './grading.js';
import { buildIngestTools } from './ingestTools.js';
import type { Loreweaver } from './mcp.js';
import { modelFor } from './models.js';
import { readGoal, pathProgress } from './goalStore.js';
import { buildBootstrapContext, buildInstructions, type Mode } from './prompt.js';
import { logGuardrail } from './sessionStore.js';
import { buildWebTools } from './webTools.js';
import { generateExercise, listGenerated } from './gap/generated.js';
import { builtinPatterns } from './gap/service.js';
import { compileGenerate } from './gap/generateSeam.js';

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

/**
 * Which block tools the tutor may use: all of them, including `code_exercise`.
 *
 * That last one was briefly withheld when no the-gap sidecar was configured, because a tool whose
 * backend cannot exist is not a tool — a fresh install's first programming lesson ended in "This
 * exercise can't start right now." The right fix turned out to be one level down: the sandbox now
 * ships INSIDE the harness (gap/service.ts, child-process runner and all), so the backend always
 * exists and the gate came back out. Kept as a named function because claudeSdkTutor builds its
 * allowlist from the same answer, and because the next conditional block (if one ever appears)
 * belongs here, not scattered across two tutors.
 */
export function availableBlocks(): BlockToolName[] {
  return [...BLOCK_TOOL_NAMES];
}

/** Frontend tools: no execute — the loop pauses; the browser supplies output via addToolOutput.
 *  (`inputSchema` cast to z.ZodTypeAny — a plain `.map` over the BlockToolName union defeats
 *  tool()'s generic overload inference, which otherwise falls back to Tool<never, never, ...>.) */
export function blockTools(): ToolSet {
  return Object.fromEntries(availableBlocks().map((name) => [name, tool({
    description: `Present a ${name} block to the student and wait for their work.`,
    inputSchema: BLOCK_TOOLS[name].input as z.ZodTypeAny,
  })]));
}

/** Words that carry no topic, so a page whose body happens to contain them is not evidence that
 *  the vault covers what the student just asked about. Loreweaver's `search` scores +1 per body
 *  token, so without this every page in the vault matches "what is the derivative of x" via
 *  "what"/"is"/"the" and the coverage test below would always say "covered". */
const STOPWORDS = new Set([
  'the', 'and', 'but', 'for', 'are', 'was', 'were', 'can', 'you', 'your', 'his', 'her', 'its',
  'this', 'that', 'these', 'those', 'what', 'why', 'how', 'who', 'when', 'where', 'which',
  'does', 'did', 'has', 'have', 'had', 'not', 'with', 'from', 'about', 'into', 'than', 'then',
  'them', 'they', 'there', 'here', 'some', 'any', 'all', 'more', 'most', 'much', 'many',
  'explain', 'tell', 'teach', 'show', 'help', 'want', 'like', 'know', 'learn', 'understand',
  'please', 'thanks', 'okay', 'yes', 'sure', 'next', 'again', 'let', 'lets', 'get', 'got',
]);

/** A hit at this score means a TITLE or tag matched, or three separate content words did — either
 *  way the vault has something genuinely on-topic. Body-only coincidences score below it. */
const COVERED_SCORE = 3;

/** The topic words in a student message: long enough to mean something, not a stopword. */
export function topicTokens(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/))]
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    return (messages[i].parts as any[])
      .filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
  }
  return '';
}

/** A page this short is a placeholder, whatever its frontmatter claims. Loreweaver's own auto-stub
 *  body is one sentence; a real page that teaches something is not 400 characters long. */
const THIN_BODY_CHARS = 400;

/** Why the tutor is allowed to research this turn. Each kind is a different KIND of gap, and the
 *  tutor is told which — "there is no page" and "the page is guesswork" call for different work. */
export type GapReason =
  | 'empty-vault'      // nothing in the vault at all
  | 'no-page'          // pages exist, none on this topic
  | 'stub'             // the on-topic page is a stub (usually auto-created from a dangling link)
  | 'unsourced'        // the page exists but cites nothing — written from model memory
  | 'thin'             // the page exists and says almost nothing
  | 'freeform';        // not a gap: freeform mode researches by design

export interface VaultGap { reason: GapReason; slug?: string; detail: string }

interface GapDeps {
  search: (query: string) => Promise<{ slug: string; score: number; status?: string }[]>;
  /** Only called for the single best-matching page, so this costs one file read per turn. */
  readPage: (slug: string) => Promise<{ meta: { sources?: string[]; status?: string }; body: string }>;
}

/**
 * Where the tutor's memory falls short of what the student just asked — and therefore when it may
 * go and research.
 *
 * Freeform: always, as before. That is where a subject gets researched, sourced and compiled.
 *
 * Teaching modes (`learn`/`review`/`quiz`): whenever there is a real GAP. That word is doing work.
 * The first version of this only unlocked when the vault had no page at all, which missed the more
 * common and more damaging case — a page that EXISTS but is not worth being grounded in:
 *
 *   * a `stub`, which Loreweaver creates automatically for any prereq nobody has written yet, so
 *     "the vault has a page on it" can mean "the vault has a sentence saying it should have one";
 *   * a page with an empty `sources` list, which is the vault's own record that it was written from
 *     model memory and never verified — exactly the thing research exists to fix;
 *   * a page too short to teach from.
 *
 * In all three the tutor previously had to either teach from a placeholder or improvise, with no way
 * to go and find out. Now it researches and says which of the three it hit.
 *
 * Still deliberately narrow. A solid, sourced, substantial page wins over any search result, because
 * a page carries the student's own evidence and edges and a search result carries neither. Writing
 * stays freeform-only, so the single-writer rule is untouched.
 *
 * Failures fail CLOSED: if the vault cannot be read we do not know whether it covers the topic, and
 * staying grounded is the safer of the two wrong answers.
 */
export async function vaultGap(
  mode: Mode,
  messages: UIMessage[],
  slugs: string[],
  deps: GapDeps,
): Promise<VaultGap | null> {
  if (mode === 'freeform') return { reason: 'freeform', detail: 'freeform mode researches by design' };
  if (slugs.length === 0) {
    return { reason: 'empty-vault', detail: 'the vault has no pages at all' };
  }

  const tokens = topicTokens(lastUserText(messages));
  // "ok", "next", "go on" — the student is continuing, not naming a subject. Continuing a lesson the
  // vault already holds is precisely the case that should stay grounded.
  if (tokens.length === 0) return null;

  try {
    const hits = await deps.search(tokens.join(' '));
    const best = hits.find((h) => h.score >= COVERED_SCORE);
    if (!best) {
      return { reason: 'no-page', detail: 'no page covers what the student just asked about' };
    }

    // There IS an on-topic page. Whether it is worth teaching from is a different question.
    const page = await deps.readPage(best.slug);
    const status = page.meta?.status ?? best.status;
    const sources = page.meta?.sources ?? [];
    const body = (page.body ?? '').trim();

    if (status === 'stub') {
      return { reason: 'stub', slug: best.slug, detail: `“${best.slug}” is only a stub` };
    }
    if (sources.length === 0) {
      return {
        reason: 'unsourced',
        slug: best.slug,
        detail: `“${best.slug}” cites no sources — it was written from memory, not checked`,
      };
    }
    if (body.length < THIN_BODY_CHARS) {
      return {
        reason: 'thin',
        slug: best.slug,
        detail: `“${best.slug}” is too thin to teach from (${body.length} characters)`,
      };
    }
    return null; // a real page on the topic. Teach from it.
  } catch {
    return null;
  }
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
  // Which model id the WEB TOOLS should assume — deliberately not the same question as `model`
  // above. A provider-executed search tool is a request-shape feature of Anthropic's API, so it
  // only means anything on a real Anthropic route; an injected model (tests) or the scripted e2e
  // model would carry the declaration to a provider that has never heard of it. `undefined` here
  // makes buildWebTools fall back to SearXNG-or-nothing, which is the honest answer for those.
  const searchModelId = opts.model || process.env.LW_MOCK_MODEL
    ? undefined : cfg.models?.tutor?.model;

  async function bootstrap(mode: Mode, slugs: string[]): Promise<string> {
    const activeGoal = readGoal(cfg.vault);
    const [state, lessonsRes] = await Promise.all([
      lw.call('get_student_state', { student: cfg.student }),
      // A page-kind goal narrows next_lessons to the prerequisite walk toward it (queries.ts's
      // unmetPrereqs) instead of the whole-vault frontier. Guarded: next_lessons errors on a goal
      // that is not a real page, and a stale goal must not break the session — fall back to the
      // unscoped call and let the goal line still report itself.
      (async () => {
        if (activeGoal?.kind === 'page') {
          try { return await lw.call('next_lessons', { student: cfg.student, goal: activeGoal.slug }); }
          catch (e) { console.error('[goal] next_lessons rejected goal', activeGoal.slug, e); }
        }
        return lw.call('next_lessons', { student: cfg.student });
      })(),
    ]);
    const lessons = lessonsRes.lessons ?? [];
    // Path-kind goals get their progress folded in so the tutor can resume at the right step.
    let goalCtx = activeGoal as any;
    if (activeGoal?.kind === 'path') {
      try {
        const doc = await lw.call('read_path', { slug: activeGoal.slug });
        // pathProgress already carries the path's title, so it must not be set separately here.
        goalCtx = { ...activeGoal, ...pathProgress(doc, state) };
      } catch (e) {
        console.error('[goal] read_path failed for goal', activeGoal.slug, e);
      }
    }
    const ctx = buildBootstrapContext({
      mode, state,
      lessons,
      reviewsDue: lessons.filter((l: any) => l.reason === 'review-due').map((l: any) => l.slug),
      ankiLapses: recentLapses(cfg.vault),
      goal: goalCtx,
      emptyVault: slugs.length === 0,
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

        // Research rides with the vault-writing tools in freeform, and unlocks in teaching modes
        // wherever the vault has a GAP — no page, a stub, an unsourced page, a page too thin to
        // teach from. See vaultGap above for why each of those counts.
        const gap = await vaultGap(mode, messages, slugs, {
          search: (query) => lw.call('search', { query }) as Promise<any>,
          readPage: async (slug) => (await lw.call('read_page', { slug })).page,
        });
        const webTools = gap ? buildWebTools(cfg, searchModelId) : {};
        // ingest_paper needs cfg (to queue) AND lw (to kick a background compile) — same
        // freeform-only gate as webTools: a subject gets researched, sourced, and compiled in
        // freeform; teaching modes stay grounded in the vault.
        const ingestTools = mode === 'freeform' ? buildIngestTools(lw, cfg) : {};
        // Freeform-only, like every other content-creating tool: the tutor can commission a NEW
        // coding exercise when a learner wants practice no ladder covers. The result is pending
        // review — the tutor must say so, not promise the exercise for this session.
        const generateTool: ToolSet = mode !== 'freeform' ? {} : {
          generate_exercise: tool({
            description: 'Author a new coding exercise for ANY subject the student is studying. '
              + 'Family "function" (the default): one plain function, JSON args in, JSON value out, '
              + 'graded by deep comparison — use it to turn any domain computation (statistics, '
              + 'stoichiometry, interval arithmetic, text processing) into runnable practice. '
              + 'Family "stream": async-generator-over-byte-chunks (SSE, NDJSON, line protocols, '
              + 'framing). The result is verified mechanically and stored PENDING REVIEW — tell the '
              + 'student it is waiting in the Library\'s Practice section for their approval, and do '
              + 'not promise it mid-conversation.',
            inputSchema: z.object({
              pattern: z.string().describe('kebab-case pattern id, e.g. dilution-calculator'),
              description: z.string().describe('what the exercise should teach, 1-3 sentences'),
              family: z.enum(['function', 'stream']).optional()
                .describe('function (default) for any-domain computations; stream only for byte-stream parsing'),
            }),
            execute: async ({ pattern, description, family }: { pattern: string; description: string; family?: 'function' | 'stream' }) => {
              const slug = pattern.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
              if (builtinPatterns(cfg.vault).includes(slug) || listGenerated(cfg.vault).some((e) => e.pattern === slug)) {
                return { error: `an exercise for "${slug}" already exists` };
              }
              try {
                const ex = await generateExercise(cfg.vault, slug, description, {
                  generate: compileGenerate(cfg), modelName: cfg.models.compile.model,
                }, family ?? 'function');
                return {
                  pattern: ex.pattern, status: ex.status,
                  gates: ex.verification.gates.map((g) => `${g.ok ? 'PASS' : 'FAIL'} ${g.gate}`),
                  note: ex.status === 'pending'
                    ? 'verified mechanically; waiting in the Library tab\'s Practice section for the student to approve it'
                    : 'rejected by the verification gates — do not retry with the same content',
                };
              } catch (e: any) {
                return { error: e?.message ?? String(e) };
              }
            },
          }),
        };

        const agent = new ToolLoopAgent({
          model,
          instructions: `${buildInstructions()}\nThe student's id is "${cfg.student}" — always pass exactly this as the \`student\` argument.`,
          tools: { ...activeMcp, ...webTools, ...ingestTools, ...generateTool, ...blockTools() },
          stopWhen: isStepCount(24),
        });

        const isFirstTurn = messages.filter((m) => m.role === 'assistant').length === 0;
        const context: ModelMessage[] = [];
        if (isFirstTurn) context.push({ role: 'user', content: await bootstrap(mode, slugs) });
        // The unlock is decided per turn, so it can happen mid-conversation — after the bootstrap
        // has already been sent. Say it here or the tutor holds a tool it was told it does not have.
        // The REASON goes in too: "there is no page" and "the page is unsourced guesswork" call for
        // visibly different work, and the second one should not be taught from as if it were fine.
        if (gap && gap.reason !== 'freeform' && webTools.web_search) context.push({
          role: 'user',
          content: `HARNESS: your memory has a gap here — ${gap.detail}. `
            + 'web_search and read_url are unlocked for this turn. Research it, cite what you read '
            + 'in your answer, and teach from that rather than from '
            + `${gap.slug ? 'the existing page' : 'memory'}. You still have NO page-writing tools `
            + 'here, so nothing you find is being saved: once the student has their answer, offer to '
            + `switch to freeform so ${gap.slug ? `“${gap.slug}” can be rewritten properly` : 'the subject can be researched and compiled'} `
            + 'into pages that track their progress.',
        });
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
        // Gate on evidence, not on grade COUNT: a grade can legitimately carry none (an unavailable
        // code_exercise — see grading.ts), and nagging the tutor to record evidence that does not
        // exist would train it to invent some.
        if (grades.some((g) => g.evidence.length > 0) && !recorded) {
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
