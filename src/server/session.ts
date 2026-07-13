import {
  ToolLoopAgent, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse,
  isStepCount, toUIMessageStream, tool, type LanguageModel, type ModelMessage, type ToolSet, type UIMessage,
} from 'ai';
import type { z } from 'zod';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES, type BlockToolName } from '../shared/blocks.js';
import { recentLapses } from './anki/inbound.js';
import type { HarnessConfig } from './config.js';
import { gradeBlockOutput } from './grading.js';
import type { Loreweaver } from './mcp.js';
import { modelFor } from './models.js';
import { buildBootstrapContext, buildInstructions, type Mode } from './prompt.js';
import { logGuardrail } from './sessionStore.js';

// Tools the tutor may use per mode; write/link/compile only in freeform (spec §5).
const TEACH_TOOLS = ['read_page', 'search', 'get_student_state', 'record_evidence',
  'next_lessons', 'find_analogies', 'list_paths', 'read_path'];

// Tools whose `student` argument must always be the configured student — models
// (especially small local ones) invent ids like "student" otherwise.
const STUDENT_TOOLS = ['record_evidence', 'get_student_state', 'next_lessons', 'find_analogies'];

/** Drop null/undefined args (MCP zod schemas want optional fields ABSENT, not null). */
export function sanitizeToolArgs(args: any, toolName: string, student: string): any {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (v != null) out[k] = v;
  if (STUDENT_TOOLS.includes(toolName)) out.student = student;
  return out;
}

/** Wrap MCP tools so every execute() sees sanitized args — the model cannot send a wrong
 * student id or a null optional field no matter what it generates. */
function guardMcpTools(tools: ToolSet, student: string): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, t]: [string, any]) => [name, {
    ...t,
    execute: t.execute
      ? (args: any, opts: any) => t.execute(sanitizeToolArgs(args, name, student), opts)
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

  async function bootstrap(mode: Mode): Promise<string> {
    const [state, lessonsRes] = await Promise.all([
      lw.call('get_student_state', { student: cfg.student }),
      lw.call('next_lessons', { student: cfg.student }),
    ]);
    const lessons = lessonsRes.lessons ?? [];
    return buildBootstrapContext({
      mode, state,
      lessons,
      reviewsDue: lessons.filter((l: any) => l.reason === 'review-due').map((l: any) => l.slug),
      ankiLapses: recentLapses(cfg.vault),
    });
  }

  async function respond(messages: UIMessage[], mode: Mode): Promise<Response> {
    // 1. Grade any fresh block outputs BEFORE the model sees them.
    const pending = pendingBlockOutputs(messages);
    const grades: Awaited<ReturnType<typeof gradeBlockOutput>>[] = [];
    for (const p of pending) {
      const grading = await gradeBlockOutput(p.tool, p.input, p.output, cfg);
      p.output.grading = grading; // model sees student work + machine grade together
      grades.push(grading);
    }

    const mcpTools = guardMcpTools(await lw.tools(), cfg.student);
    const activeMcp = Object.fromEntries(Object.entries(mcpTools)
      .filter(([n]) => mode === 'freeform' || TEACH_TOOLS.includes(n)));

    const agent = new ToolLoopAgent({
      model,
      instructions: `${buildInstructions()}\nThe student's id is "${cfg.student}" — always pass exactly this as the \`student\` argument.`,
      tools: { ...activeMcp, ...blockTools() },
      stopWhen: isStepCount(24),
    });

    const isFirstTurn = messages.filter((m) => m.role === 'assistant').length === 0;
    const context: ModelMessage[] = [];
    if (isFirstTurn) context.push({ role: 'user', content: await bootstrap(mode) });
    if (grades.length) context.push({
      role: 'user',
      content: `HARNESS: graded block results attached above: ${grades.map((g) => `${g.verdict} (${g.detail})`).join('; ')}. ` +
        `You MUST now call record_evidence for: ${JSON.stringify(grades.flatMap((g) => g.evidence))} — then respond to the student.`,
    });

    const model_messages = [...context, ...(await convertToModelMessages(messages))];

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
      execute: async ({ writer }) => {
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
          writer.merge(toUIMessageStream({ stream: result.stream }));
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
