import {
  createSdkMcpServer, query, tool,
  type Options, type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES, type BlockToolName } from '../shared/blocks.js';
import { recentLapses } from './anki/inbound.js';
import { stripClaudeSdkPrefix } from './claudeSdk.js';
import type { HarnessConfig } from './config.js';
import { gradeBlockOutput } from './grading.js';
import type { Loreweaver } from './mcp.js';
import { buildBootstrapContext, buildInstructions, type Mode } from './prompt.js';
import { sanitizeToolArgs } from './session.js';
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
const FREEFORM_EXTRA_TOOLS = ['write_page', 'link_pages', 'compile_source'];

const LOREWEAVER_PREFIX = 'mcp__loreweaver__';
const BLOCKS_PREFIX = 'mcp__blocks__';
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
  return BLOCK_TOOL_NAMES.map((name) => tool(
    name,
    `Present a ${name} block to the student and wait for their work.`,
    BLOCK_TOOLS[name].input.shape,
    async () => ({
      content: [{ type: 'text' as const, text: 'Displayed to the student. End your turn now; their answer arrives next message.' }],
    }),
  ));
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
      mode, state,
      lessons,
      reviewsDue: lessons.filter((l: any) => l.reason === 'review-due').map((l: any) => l.slug),
      ankiLapses: recentLapses(cfg.vault),
    });
    return `${ctx}\nVault pages (the ONLY valid slugs — use them verbatim): ${slugs.join(', ')}`;
  }

  function turnError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[claude-sdk-turn-error]', msg);
    return `The tutor hit an error and this turn was lost: ${msg.slice(0, 200)}`;
  }

  function buildSystemPrompt(mode: Mode): string {
    return [
      buildInstructions(),
      `The student's id is "${cfg.student}" — always pass exactly this as the \`student\` argument.`,
      `Mode: ${mode.toUpperCase()}.`,
      'Interactive learning blocks (quick_check, quiz, math_scratchpad, writing_draft, code_exercise) '
        + 'are presented via the blocks tools. After calling one, END YOUR TURN immediately — the '
        + "student's answer arrives as the next message. Never answer a block yourself.",
    ].join('\n\n');
  }

  function buildOptions(mode: Mode, slugs: string[], resumeId: string | undefined): Options {
    const activeLoreweaverTools = mode === 'freeform' ? [...TEACH_TOOLS, ...FREEFORM_EXTRA_TOOLS] : TEACH_TOOLS;
    const allowedTools = [
      ...activeLoreweaverTools.map((n) => `${LOREWEAVER_PREFIX}${n}`),
      ...BLOCK_TOOL_NAMES.map((n) => `${BLOCKS_PREFIX}${n}`),
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
      },
    };
    if (resumeId) options.resume = resumeId;
    return options;
  }

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

        const slugs = await lw.listSlugs();
        const isFirstTurn = messages.filter((m) => m.role === 'assistant').length === 0;

        const promptParts: string[] = [];
        if (isFirstTurn) promptParts.push(await bootstrap(mode, slugs));
        if (grades.length) {
          promptParts.push(
            `HARNESS: graded block results attached above: ${grades.map((g) => `${g.verdict} (${g.detail})`).join('; ')}. `
            + `You MUST now call record_evidence for: ${JSON.stringify(grades.flatMap((g) => g.evidence))} — then respond to the student.`,
          );
        }
        const userText = lastUserText(messages);
        if (userText) promptParts.push(userText);
        const promptText = promptParts.join('\n\n');

        // Runs ONE query() (fresh or resumed), translating its message stream into UI chunks on
        // `writer` as it arrives. Returns the captured session id (from the init/system message)
        // and whether record_evidence was called — used by the resume-fallback and guardrail logic
        // below. Throws if the underlying query ends in a non-success result or the generator
        // itself throws (a resume against a stale/pruned session id is expected to surface this
        // way — the caller decides whether to catch-and-fall-back or let it propagate).
        const runQuery = async (prompt: string, resumeId: string | undefined) => {
          const options = buildOptions(mode, slugs, resumeId);
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
                    const output = (message as any).tool_use_result
                      ?? (Array.isArray(block.content) ? block.content.map((c: any) => c?.text ?? '').join(' ') : { ok: true });
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
