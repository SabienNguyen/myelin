import {
  createSdkMcpServer, query, tool,
  type Options, type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { z } from 'zod';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES, type BlockToolName } from '../shared/blocks.js';
import { UI_TOOLS } from '../shared/uiTools.js';
import { recentLapses } from './anki/inbound.js';
import { markCorrect, nextProblems, readBank } from './courseBank.js';
import { stripClaudeSdkPrefix } from './claudeSdk.js';
import type { HarnessConfig } from './config.js';
import { gradeBlockOutput } from './grading.js';
import { invalidateGraphCache } from './graphCache.js';
import type { Loreweaver } from './mcp.js';
import { buildBootstrapContext, buildInstructions, type Mode } from './prompt.js';
import { availableBlocks, sanitizeToolArgs, slugListLine, vaultGap, type VaultGap } from './session.js';
import { loadSdkSession, logGuardrail, saveSdkSession } from './sessionStore.js';

/**
 * T43: tutor role on the Agent SDK. Same external contract as session.ts's createTutorSession
 * (respond() streams UIMessage chunks the client already understands), but the model turn runs
 * through @anthropic-ai/claude-agent-sdk's query() against the user's Claude Pro/Max subscription
 * login instead of the AI SDK's ToolLoopAgent. See claudeSdk.ts's header comment for why this is
 * a separate route: the SDK's async-generator streaming has a different shape than `ai`'s
 * LanguageModelV3 stream, so it can't share session.ts's ToolLoopAgent plumbing.
 */

// Tools the tutor may use per mode; write/link/compile only in freeform (spec §5). Duplicated
// from session.ts's TEACH_TOOLS (not exported there, and this file must not modify session.ts) —
// keep in sync by hand; a divergence here means the two tutor routes disagree on tool access.
const TEACH_TOOLS = ['read_page', 'search', 'get_student_state', 'record_evidence',
  'next_lessons', 'find_analogies', 'list_paths', 'read_path'];
// create_path is here because the bootstrap prompt orders it in freeform (goal line + cold start);
// before it was listed, the call only ever succeeded by accident of bypassPermissions ignoring
// allowedTools for auto-approval.
const FREEFORM_EXTRA_TOOLS = ['write_page', 'link_pages', 'compile_source', 'create_path'];

const LOREWEAVER_PREFIX = 'mcp__loreweaver__';
const BLOCKS_PREFIX = 'mcp__blocks__';

/** STRUCTURAL rule 1a (mirrors session.ts): a pure grading turn withholds the block tools — two
 *  live probes showed wording alone does not stop the model staging a block over its own offer.
 *  open_source stays in both cases: navigation is not staging work. Exported for tests. */
export function blockAllowlist(gradingOnly: boolean): string[] {
  return [
    ...(gradingOnly ? [] : availableBlocks().map((n) => `${BLOCKS_PREFIX}${n}`)),
    `${BLOCKS_PREFIX}open_source`,
  ];
}
const COURSE_PREFIX = 'mcp__course__';
const RECORD_EVIDENCE_TOOL = `${LOREWEAVER_PREFIX}record_evidence`;

/** Injectable seam for tests: a fake must accept the same {prompt, options} shape query() does
 * and return an async-iterable of SDKMessage. The real Query interface also exposes control
 * methods (interrupt, setPermissionMode, ...) we never call, so fakes only need to satisfy
 * AsyncIterable. */
export interface ClaudeSdkTutorDeps {
  queryImpl?: (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;
}

/** Find block-tool outputs in the tail of the incoming history (since the last user text turn).
 * Duplicated from session.ts's pendingBlockOutputs — not exported there, and this file must not
 * modify session.ts. Keep in sync by hand. */
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

function lastUserText(messages: UIMessage[]): string {
  const msg = [...messages].reverse().find((m) => m.role === 'user');
  if (!msg) return '';
  return (msg.parts as any[]).filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
}

/** MCP tools the model calls to present an interactive block; execute() just hands back a
 * sentinel telling the model to stop talking — the student's answer arrives as the NEXT message
 * (there is no HITL pause primitive in the Agent SDK's query() loop, so the sentinel + system
 * prompt instruction together stand in for one). */
function blockMcpTools() {
  // Heterogeneous schemas (blocks union vs open_source) — collected as an array literal so the
  // element type unions instead of pinning to the first map's generic.
  const blocks: ReturnType<typeof tool<any>>[] = availableBlocks().map((name) => tool(
    name,
    `Present a ${name} block to the student and wait for their work.`,
    BLOCK_TOOLS[name].input.shape,
    async () => ({
      content: [{ type: 'text' as const, text: 'Displayed to the student. End your turn now; their answer arrives next message.' }],
    }),
  ));
  // open_source rides the same bridge but is NAVIGATION, not graded work: the client opens the
  // reader and the tutor keeps teaching — its sentinel says so instead of ending the turn.
  blocks.push(tool(
    'open_source',
    'Open an ingested source (book chapter, paper, notes) in the reading surface beside the '
      + 'conversation — bring the student to the artifact. Pass the source title as the Library '
      + 'shows it.',
    UI_TOOLS.open_source.input.shape,
    async () => ({
      content: [{ type: 'text' as const, text: 'Opening beside the conversation. Continue teaching — direct their reading.' }],
    }),
  ));
  return blocks;
}

/** The course bank's tools on the SDK route — same behavior as session.ts's buildCourseTools,
 * re-expressed in the Agent SDK's tool() shape (its handlers return MCP content blocks, so the
 * ai-sdk ToolSet can't be reused directly). Keep the two in sync by hand, like TEACH_TOOLS.
 * Exported for tests: the SDK executes these handlers inside its own loop, so the fake-queryImpl
 * tests can't reach them — tests/claudeSdkTutor.test.ts calls the handlers directly instead. */
export function courseMcpTools(vault: string) {
  return [
    tool(
      'course_problems',
      'The next banked course problems (past exams, problem sets) worth drilling — never-answered '
        + 'first. Each has a stable id and its VERBATIM text: present that text word for word as a '
        + 'quick_check or structured_check prompt; never paraphrase it.',
      { k: z.number().int().min(1).max(5).optional().describe('how many problems (default 5)') },
      async ({ k }) => {
        const problems = nextProblems(vault, k ?? 5);
        const payload = problems.length
          ? {
            problems: problems.map((p) => ({
              id: p.id, source: p.source, n: p.n, text: p.text,
              ...(p.answer ? { answer: p.answer } : {}),
              ...(p.lastCorrect ? { lastCorrect: p.lastCorrect } : {}),
            })),
          }
          : { problems: [], note: 'the course bank is empty — no problem set or past exam has been added' };
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
      },
    ),
    tool(
      'mark_course_problem',
      'Record that the learner just answered a banked course problem correctly in a graded block — '
        + 'spacing uses it to stop re-asking. Call it alongside record_evidence, never for an '
        + 'answer that was not graded correct.',
      { id: z.string().describe('the problem id from course_problems, e.g. "midterm-2#3"') },
      async ({ id }) => ({
        content: [{
          type: 'text' as const,
          text: JSON.stringify(markCorrect(vault, id)
            ? { marked: id } : { error: `no banked problem with id "${id}"` }),
        }],
      }),
    ),
  ];
}

export function createClaudeSdkTutorSession(
  lw: Loreweaver, cfg: HarnessConfig, deps: ClaudeSdkTutorDeps = {},
) {
  const queryImpl = deps.queryImpl ?? query;

  async function bootstrap(mode: Mode, slugs: string[]): Promise<string> {
    const [state, lessonsRes] = await Promise.all([
      lw.call('get_student_state', { student: cfg.student }),
      lw.call('next_lessons', { student: cfg.student }),
    ]);
    const lessons = lessonsRes.lessons ?? [];
    const ctx = buildBootstrapContext({
      voice: cfg.voice,
      mode, state,
      lessons,
      reviewsDue: lessons.filter((l: any) => l.reason === 'review-due').map((l: any) => l.slug),
      ankiLapses: recentLapses(cfg.vault),
      courseBank: readBank(cfg.vault),
    });
    const relevant = [
      ...lessons.map((l: any) => l.slug),
      ...readBank(cfg.vault).map((p) => `course-${p.source}`),
    ];
    return `${ctx}\n${slugListLine(slugs, relevant)}`;
  }

  function turnError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[claude-sdk-turn-error]', msg);
    // Raw stderr is honest but not always actionable. The one failure a learner can actually fix
    // themselves gets a plain-language line: Linux users DO launch AppImages with sudo, the SDK
    // refuses to run that way, and "--dangerously-skip-permissions cannot be used with root/sudo
    // privileges" reads as our bug rather than their shell.
    const hint = msg.includes('root/sudo privileges')
      ? ' — the subscription route cannot run as root. Start the app as your normal user (no sudo) and try again.'
      : '';
    return `The tutor hit an error and this turn was lost: ${msg.slice(0, 200)}${hint}`;
  }

  function buildSystemPrompt(mode: Mode): string {
    return [
      buildInstructions(),
      `The student's id is "${cfg.student}" — always pass exactly this as the \`student\` argument.`,
      `Mode: ${mode.toUpperCase()}.`,
      'Interactive learning blocks (quick_check, quiz, math_scratchpad, writing_draft, code_exercise) '
        + 'are presented via the blocks tools. After calling one, END YOUR TURN immediately — the '
        + "student's answer arrives as the next message. Never answer a block yourself.",
      // The base prompt's research rules name the ai-sdk route's tools, none of which exist here.
      // Without this correction a frontier question with no research tools in sight has no honest
      // script to follow — and a live sitting caught the model inventing one: it answered "what's
      // the newest research on spaced repetition?" from recall while claiming "I read the FSRS
      // wiki page and the LECTOR paper directly", with zero tool calls in the turn.
      // The availability clause is mode-split because a cold-start sitting hit the OPPOSITE
      // failure: freeform always holds WebSearch/WebFetch (vaultGap returns 'freeform'
      // unconditionally, so buildOptions always spreads SDK_RESEARCH_TOOLS in), but no HARNESS gap
      // line is ever sent in this mode — so the model, obeying the gap-line rule, refused to
      // research a subject the vault had never seen and compiled six pages of unsourced training
      // knowledge instead.
      'On this route the research tools named above (`find_recent_papers`, `find_canonical_sources`, '
        + '`web_search`, `read_url`, `paper_references`, `ingest_url`) DO NOT EXIST. Your only '
        + 'research tools are WebSearch and WebFetch, '
        + (mode === 'freeform'
          ? 'available on every turn in this mode — freeform is where a subject gets researched and '
            + 'compiled, so search before writing pages on a subject the vault lacks, and list in a '
            + 'page\'s `sources` only what you actually searched or fetched. '
          : 'and only on turns where the harness grants them (it says so in a HARNESS gap line). ')
        + 'When the student asks what is new, recent, or '
        + 'frontier and you cannot call WebSearch this turn — or the call fails — say plainly that '
        + 'you could not reach the live indices, and label anything you offer instead as unverified '
        + 'model memory with its training cutoff. NEVER claim to have read, fetched, or checked a '
        + 'source unless you actually called WebFetch or WebSearch on it this session.',
    ].join('\n\n');
  }

  /** The Agent SDK's own built-in research tools. This route has no ai-sdk tool set to hand
   *  webTools.ts's `web_search`/`read_url` to — but it does not need one: WebSearch and WebFetch
   *  ship with the SDK. Naming them here is what makes the subscription route able to research at
   *  all, and therefore what makes "sign in with your Claude subscription" an honest offer rather
   *  than a quietly worse product. */
  const SDK_RESEARCH_TOOLS = ['WebSearch', 'WebFetch'];

  function buildOptions(
    mode: Mode, slugs: string[], resumeId: string | undefined, gap: VaultGap | null,
    gradingOnly = false,
  ): Options {
    const activeLoreweaverTools = mode === 'freeform' ? [...TEACH_TOOLS, ...FREEFORM_EXTRA_TOOLS] : TEACH_TOOLS;
    const allowedTools = [
      ...activeLoreweaverTools.map((n) => `${LOREWEAVER_PREFIX}${n}`),
      ...blockAllowlist(gradingOnly),
      // Every mode, matching session.ts: drilling a banked problem is a teaching activity.
      `${COURSE_PREFIX}course_problems`, `${COURSE_PREFIX}mark_course_problem`,
      // Same gate as the ai-sdk route: research when the vault has a gap, never otherwise.
      ...(gap ? SDK_RESEARCH_TOOLS : []),
    ];
    const options: Options = {
      model: stripClaudeSdkPrefix(cfg.models.tutor.model),
      systemPrompt: buildSystemPrompt(mode),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 24,
      includePartialMessages: true,
      allowedTools,
      mcpServers: {
        loreweaver: {
          type: 'stdio',
          command: cfg.loreweaver.command,
          args: cfg.loreweaver.args,
          env: {
            ...process.env as Record<string, string>,
            LOREWEAVER_VAULT: cfg.vault,
            LOREWEAVER_EMBEDDINGS: cfg.loreweaver.embeddings,
          },
        },
        blocks: createSdkMcpServer({ name: 'blocks', tools: blockMcpTools() }),
        course: createSdkMcpServer({ name: 'course', tools: courseMcpTools(cfg.vault) }),
      },
      // Block/loreweaver tool inputs can't be arg-wrapped like session.ts's guardMcpTools (the SDK
      // executes them itself, not us). canUseTool would be the natural rewrite seam, but it is
      // SDK-CONFIRMED DEAD here, on two independent counts: the SDK's own runtime warning
      // (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED, seen in the journal on a live subscription-login run)
      // says permissionMode 'bypassPermissions' auto-approves every tool call before canUseTool is
      // consulted — AND, separately, that bare `allowedTools` entries (exactly what `allowedTools`
      // above is: plain tool names, no `Tool(scope)` syntax) shadow canUseTool too. So switching
      // permissionMode to 'default' alone would NOT have fixed this — allowedTools would still
      // shadow the callback. The SDK's own warning names the actual fix: a PreToolUse hook, which
      // is not shadowed by either cause. PreToolUseHookSpecificOutput.updatedInput rewrites tool
      // input the same way canUseTool's updatedInput would have (see the SDK's sdk.d.ts). Verified
      // mechanism — see README's "Argument sanitization" section.
      hooks: {
        PreToolUse: [{
          hooks: [async (input) => {
            if (input.hook_event_name !== 'PreToolUse' || !input.tool_name.startsWith(LOREWEAVER_PREFIX)) {
              return {};
            }
            const bare = input.tool_name.slice(LOREWEAVER_PREFIX.length);
            const updatedInput = sanitizeToolArgs(input.tool_input, bare, cfg.student, slugs);
            console.error('[sdk-sanitize]', input.tool_name);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                updatedInput,
              },
            };
          }],
        }],
        // Graph-cache invalidation for THIS route. The ai-sdk route's writes all pass through
        // src/server/mcp.ts's invalidateIfWrite, but here the Agent SDK spawns its own Loreweaver
        // stdio server (mcpServers.loreweaver above) and executes tool calls itself — a
        // record_evidence on this route never touches the harness's Loreweaver wrapper, so without
        // this hook a freshly recorded misconception kept its stale graph payload for up to a TTL
        // (the exact bug c5b64f4 fixed on the other route). PostToolUse fires only on success —
        // failures go to PostToolUseFailure — which preserves mcp.ts's only-invalidate-on-success
        // rule. Keep the tool list in sync with invalidateIfWrite by hand.
        PostToolUse: [{
          hooks: [async (input) => {
            if (input.hook_event_name === 'PostToolUse'
              && (input.tool_name === RECORD_EVIDENCE_TOOL || input.tool_name === `${LOREWEAVER_PREFIX}write_page`)) {
              invalidateGraphCache();
            }
            return {};
          }],
        }],
      },
    };
    if (resumeId) options.resume = resumeId;
    return options;
  }

  // Which mode each thread's LAST turn ran in. Session context (due reviews, suggested lessons,
  // student state) is injected only on a thread's first turn — so a learner who flipped the mode
  // selector mid-conversation got a tutor still acting on the context of the mode they left. A
  // live decay sitting caught it: "review" selected over a thread whose turn-1 context predated
  // the slippage, and the tutor — knowing only a history where everything was just aced —
  // answered "what have I let slip?" with a researched lecture on forgetting curves instead of
  // re-proving the slipped page. In-memory on purpose: after a restart the map is empty and no
  // re-injection happens, which is the pre-existing behavior, not a new failure.
  const lastModeByThread = new Map<string, Mode>();

  async function respond(messages: UIMessage[], mode: Mode, threadId = 'default'): Promise<Response> {
    const pending = pendingBlockOutputs(messages);

    const stream = createUIMessageStream({
      originalMessages: messages,
      onError: turnError,
      execute: async ({ writer }) => {
        const grades: Awaited<ReturnType<typeof gradeBlockOutput>>[] = [];
        for (const p of pending) {
          const grading = await gradeBlockOutput(p.tool, p.input, p.output, cfg);
          p.output.grading = grading;
          grades.push(grading);
        }
        for (const p of pending) {
          writer.write({ type: 'tool-output-available', toolCallId: p.toolCallId, output: p.output });
        }
        // Step boundary before this turn's own content. streamText gives the ai-sdk route one of
        // these per step; this hand-rolled stream never did, so on a grade turn (which ai@7
        // APPENDS to the existing assistant message) the graded block stayed inside the "last
        // step" and runtime.tsx's blockOutputsComplete auto-resubmitted forever — a live probe
        // watched the resumed session receive the stale user text ~40 times. Rule 1a's structural
        // withhold exposed this: previously the model staging a fresh block over the win
        // falsified the predicate by accident.
        writer.write({ type: 'start-step' });

        const slugs = await lw.listSlugs();
        const isFirstTurn = messages.filter((m) => m.role === 'assistant').length === 0;
        // A block submission is a continuation, not a new ask — pendingBlockOutputs only matches
        // when the LAST message is the assistant's, so the student typed nothing this turn. Gap
        // detection keys off lastUserText, which on these turns is the already-answered message
        // that staged the block: re-running it re-issues the same research directive over the
        // graded card (a live sitting watched the tutor re-research and re-teach the whole topic
        // in the grade turn because of it).
        const gap = pending.length ? null : await vaultGap(mode, messages, slugs, {
          search: (query) => lw.call('search', { query }) as Promise<any>,
          readPage: async (slug) => (await lw.call('read_page', { slug })).page,
        });

        // A mode switch mid-thread re-arms the context injection (see lastModeByThread above).
        // Block submissions are excluded: they arrive under the same mode that staged the block,
        // and a grade turn must stay a grade turn.
        const prevMode = lastModeByThread.get(threadId);
        const modeSwitched = !isFirstTurn && !pending.length && prevMode !== undefined && prevMode !== mode;
        lastModeByThread.set(threadId, mode);

        const promptParts: string[] = [];
        if (isFirstTurn) promptParts.push(await bootstrap(mode, slugs));
        else if (modeSwitched) {
          promptParts.push(`HARNESS: the student just switched the tutor mode to ${mode.toUpperCase()}. `
            + 'Fresh session context follows — trust it over anything earlier in this conversation '
            + '(mastery and due reviews may have changed since the conversation started).\n\n'
            + await bootstrap(mode, slugs));
        }
        if (gap && gap.reason !== 'freeform') {
          promptParts.push(`HARNESS: your memory has a gap here — ${gap.detail}. WebSearch and `
            + 'WebFetch are unlocked for this turn. Research it, cite what you read, and teach from '
            + `that rather than from ${gap.slug ? 'the existing page' : 'memory'}. You have NO `
            + 'page-writing tools here, so nothing you find is saved — offer freeform afterwards.');
        }
        if (grades.length) {
          // The submission itself rides along. On the ai-sdk route the model re-reads the full
          // message history every turn, block outputs included; here the resumed SDK session holds
          // only the block-display sentinel ("their answer arrives next message") — so a grades
          // prompt that asserts a verdict without showing the work reads as unverifiable, and a
          // live sitting (audit 45) caught the model refusing to record_evidence over exactly
          // that: "I'm not seeing an actual code submission from you". Showing the work also lets
          // the tutor diagnose the specific mistake, not just relay a verdict. Bounded per block —
          // a full_body submission is small, but nothing here should be able to flood a prompt.
          const submissions = pending.map((p) => {
            const { grading: _, ...output } = p.output ?? {};
            return `- ${p.tool} ${JSON.stringify(p.input)}\n  student's output: ${JSON.stringify(output).slice(0, 2_000)}`;
          }).join('\n');
          promptParts.push(
            `HARNESS: the student answered the block(s) you displayed. Their actual work:\n${submissions}\n\n`
            + `Graded mechanically/by the grader as: ${grades.map((g) => `${g.verdict} (${g.detail})`).join('; ')}. `
            + `You MUST now call record_evidence for: ${JSON.stringify(grades.flatMap((g) => g.evidence))} — then respond to the student. `
            + 'The block tools are withheld this turn: deliver the grade and END on your offer of the next step; the student will answer.',
          );
        }
        // Same stale-text hazard as the gap above, but worse: the resumed session already HOLDS
        // that user message from the turn that staged the block, so replaying it reads to the
        // model as the student re-sending the identical request. A live sitting watched it
        // conclude "this is the third time this exact request has come through", re-teach, and
        // stage a diagnostic quick check over the graded card — the grades prompt is the whole
        // turn. (The fresh-session fallback below still works: bootstrap + the student's shown
        // work carry the context.)
        const userText = lastUserText(messages);
        if (userText && !pending.length) promptParts.push(userText);
        const promptText = promptParts.join('\n\n');

        // Runs ONE query() (fresh or resumed), translating its message stream into UI chunks on
        // `writer` as it arrives. Returns the captured session id (from the init/system message)
        // and whether record_evidence was called — used by the resume-fallback and guardrail logic
        // below. Throws if the underlying query ends in a non-success result or the generator
        // itself throws (a resume against a stale/pruned session id is expected to surface this
        // way — the caller decides whether to catch-and-fall-back or let it propagate).
        const runQuery = async (prompt: string, resumeId: string | undefined) => {
          const options = buildOptions(mode, slugs, resumeId, gap, pending.length > 0);
          let capturedSessionId: string | undefined;
          let sawRecordEvidence = false;
          // Per-message-batch state: index -> what content_block_start told us about that index.
          // Reset at each stream_event message_start because indices are scoped to ONE raw API
          // turn, and a single query() can contain several raw turns (multi-step tool loop).
          let blockKind = new Map<number, 'text' | 'tool_use'>();
          let textIds = new Map<number, string>();
          // Whether ANY text partial streamed via stream_events THIS raw API turn. Reset to false
          // at stream_event message_start; set true at content_block_start for a text block.
          // Per-raw-turn boolean, not an index-keyed set — a set can't work here for two independent
          // reasons, both confirmed against a real SDK probe (includePartialMessages:true): (a) the
          // SDK emits one `assistant` envelope PER CONTENT BLOCK, mid-stream — e.g. the [thinking]
          // envelope arrives (and, under the old Set scheme, cleared the tracking state) BEFORE the
          // [text] envelope for the same raw turn is even seen, so "clear after an assistant
          // envelope" wiped state meant for a later block in the SAME turn; (b) stream_events carry
          // the raw API's content-block index, but each per-block assistant envelope carries its
          // single block at index 0 of its OWN content array — the two index spaces never line up,
          // so an index-keyed lookup can never match. (Envelope uuids are per-envelope — the
          // stream_event envelopes and the `assistant` envelope for the same raw turn all carry
          // DIFFERENT uuids — so uuids are equally useless as a key.) With includePartialMessages
          // on, ALL text in a raw turn streams via partials, so ANY assistant-envelope text for that
          // turn is a duplicate by construction — hence a single flag suffices, and nothing needs to
          // be cleared on the assistant envelope itself. The fallback branch below exists solely for
          // streams that emit no partials at all (fakes/tests, or partials disabled): there this flag
          // simply never flips true, and the fallback still emits everything (existing behavior for
          // such fakes is preserved).
          let partialsStreamedText = false;
          let textCounter = 0;
          const pendingLoreweaverCalls = new Set<string>(); // toolCallId awaiting a tool_result

          for await (const message of queryImpl({ prompt, options })) {
            if (message.type === 'system' && message.subtype === 'init') {
              capturedSessionId = message.session_id;
            } else if (message.type === 'stream_event') {
              const event = message.event as any;
              if (event.type === 'message_start') {
                blockKind = new Map();
                textIds = new Map();
                partialsStreamedText = false;
              } else if (event.type === 'content_block_start') {
                const block = event.content_block;
                if (block?.type === 'text') {
                  const id = `sdk-text-${++textCounter}`;
                  blockKind.set(event.index, 'text');
                  textIds.set(event.index, id);
                  partialsStreamedText = true;
                  writer.write({ type: 'text-start', id });
                } else if (block?.type === 'tool_use') {
                  blockKind.set(event.index, 'tool_use');
                }
              } else if (event.type === 'content_block_delta') {
                if (blockKind.get(event.index) === 'text' && event.delta?.type === 'text_delta') {
                  writer.write({ type: 'text-delta', id: textIds.get(event.index)!, delta: event.delta.text });
                }
              } else if (event.type === 'content_block_stop') {
                if (blockKind.get(event.index) === 'text') {
                  writer.write({ type: 'text-end', id: textIds.get(event.index)! });
                }
              }
            } else if (message.type === 'assistant') {
              const content = (message.message as any).content as any[];
              content.forEach((block) => {
                if (block.type === 'text') {
                  // Fallback path: only emit if partials didn't already stream THIS TURN's text
                  // (includePartialMessages off, or a fake that skips stream_events entirely). Not
                  // an index/uuid check — see partialsStreamedText's declaration for why neither can
                  // work against the real per-block envelope cadence.
                  if (!partialsStreamedText) {
                    const id = `sdk-text-${++textCounter}`;
                    writer.write({ type: 'text-start', id });
                    if (block.text) writer.write({ type: 'text-delta', id, delta: block.text });
                    writer.write({ type: 'text-end', id });
                  }
                } else if (block.type === 'tool_use') {
                  const name = block.name as string;
                  if (name.startsWith(BLOCKS_PREFIX)) {
                    writer.write({
                      type: 'tool-input-available', toolCallId: block.id,
                      toolName: name.slice(BLOCKS_PREFIX.length), input: block.input,
                    });
                  } else if (name.startsWith(LOREWEAVER_PREFIX)) {
                    if (name === RECORD_EVIDENCE_TOOL) sawRecordEvidence = true;
                    pendingLoreweaverCalls.add(block.id);
                    writer.write({
                      type: 'tool-input-available', toolCallId: block.id,
                      toolName: name.slice(LOREWEAVER_PREFIX.length), input: block.input,
                    });
                  } else if (SDK_RESEARCH_TOOLS.includes(name)) {
                    // Research must be visible: the sourcing honesty story rests on the learner
                    // seeing "searched the web" in the transcript when (and only when) it happened.
                    pendingLoreweaverCalls.add(block.id);
                    writer.write({
                      type: 'tool-input-available', toolCallId: block.id,
                      toolName: name, input: block.input,
                    });
                  }
                }
              });
              // Deliberately no clearing here: partialsStreamedText tracks "did partials already
              // cover this turn's text", and per-block envelopes (thinking, text, tool_use, ...) can
              // arrive interleaved with that turn's remaining stream_events — clearing on ANY
              // assistant envelope would wipe state a later block's fallback check still needs. It
              // only resets at the next raw turn's stream_event message_start.
            } else if (message.type === 'user') {
              const content = (message.message as any).content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'tool_result' && pendingLoreweaverCalls.has(block.tool_use_id)) {
                    pendingLoreweaverCalls.delete(block.tool_use_id);
                    let output = (message as any).tool_use_result
                      ?? (Array.isArray(block.content) ? block.content.map((c: any) => c?.text ?? '').join(' ') : { ok: true });
                    // A failed built-in tool (WebFetch dying on restricted egress) marks the
                    // tool_result BLOCK is_error without any isError field on the payload — the
                    // chip's only failure signal. Dropping it rendered "read a web page" over a
                    // fetch that returned "Socket is closed", caught on a live cold-start sitting.
                    if (block.is_error && !(output && typeof output === 'object' && (output as any).isError)) {
                      output = { isError: true, content: output };
                    }
                    writer.write({ type: 'tool-output-available', toolCallId: block.tool_use_id, output });
                  }
                }
              }
            } else if (message.type === 'result') {
              if (message.subtype !== 'success') {
                throw new Error(`claude-sdk tutor query failed (${message.subtype}): ${(message as any).errors?.join('; ') ?? 'unknown'}`);
              }
            }
          }
          return { capturedSessionId, sawRecordEvidence };
        };

        const storedId = loadSdkSession(cfg.vault, threadId);
        let runResult: Awaited<ReturnType<typeof runQuery>> | undefined;
        if (storedId) {
          try {
            runResult = await runQuery(promptText, storedId);
          } catch (e) {
            console.error(`[claude-sdk-tutor] resume of session ${storedId} failed, starting a fresh session:`, e);
          }
        }
        if (!runResult) {
          const freshPrompt = storedId
            ? `HARNESS: Prior conversation summary unavailable; student state follows.\n\n${await bootstrap(mode, slugs)}\n\n${promptText}`
            : promptText;
          runResult = await runQuery(freshPrompt, undefined);
        }
        if (runResult.capturedSessionId) saveSdkSession(cfg.vault, threadId, runResult.capturedSessionId);

        if (grades.length && !runResult.sawRecordEvidence) {
          const nudgeResult = await runQuery(
            'HARNESS GUARDRAIL: you did not call record_evidence for the graded block result. Do it now, then continue.',
            runResult.capturedSessionId ?? storedId,
          );
          if (nudgeResult.capturedSessionId) saveSdkSession(cfg.vault, threadId, nudgeResult.capturedSessionId);
          if (!nudgeResult.sawRecordEvidence) {
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
export type ClaudeSdkTutorSession = ReturnType<typeof createClaudeSdkTutorSession>;
