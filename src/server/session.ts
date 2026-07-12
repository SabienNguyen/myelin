import {
  ToolLoopAgent, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse,
  isStepCount, toUIMessageStream, tool, type LanguageModel, type ModelMessage, type ToolSet, type UIMessage,
} from 'ai';
import type { z } from 'zod';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES, type BlockToolName } from '../shared/blocks.js';
import type { HarnessConfig } from './config.js';
import { gradeBlockOutput } from './grading.js';
import type { Loreweaver } from './mcp.js';
import { modelFor } from './models.js';
import { buildBootstrapContext, buildInstructions, type Mode } from './prompt.js';
import { logGuardrail } from './sessionStore.js';

// Tools the tutor may use per mode; write/link/compile only in freeform (spec §5).
const TEACH_TOOLS = ['read_page', 'search', 'get_student_state', 'record_evidence',
  'next_lessons', 'find_analogies', 'list_paths', 'read_path'];

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
  const out: { tool: BlockToolName; input: any; output: any }[] = [];
  const last = messages[messages.length - 1];
  for (const msg of [last]) {
    if (msg?.role !== 'assistant') continue;
    for (const part of msg.parts as any[]) {
      const name = String(part.type).replace(/^tool-/, '') as BlockToolName;
      if (part.type?.startsWith('tool-') && BLOCK_TOOL_NAMES.includes(name)
        && part.state === 'output-available' && !part.output?.grading) {
        out.push({ tool: name, input: part.input, output: part.output });
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
      ankiLapses: [], // populated by Task 11's lapse query; empty until then
    });
  }

  async function respond(messages: UIMessage[], mode: Mode): Promise<Response> {
    // 1. Grade any fresh block outputs BEFORE the model sees them.
    const pending = pendingBlockOutputs(messages);
    const grades = [];
    for (const p of pending) {
      const grading = await gradeBlockOutput(p.tool, p.input, p.output, cfg);
      p.output.grading = grading; // model sees student work + machine grade together
      grades.push(grading);
    }

    const mcpTools = await lw.tools();
    const activeMcp = Object.fromEntries(Object.entries(mcpTools)
      .filter(([n]) => mode === 'freeform' || TEACH_TOOLS.includes(n)));

    const agent = new ToolLoopAgent({
      model,
      instructions: buildInstructions(),
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
      execute: async ({ writer }) => {
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
