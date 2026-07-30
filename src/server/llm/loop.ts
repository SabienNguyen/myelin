// The tool loop the harness owns: call → execute → append → continue. This is where the
// block-pause semantics live (external tools halt the run) and where rails mode, guardrail
// hooks, and context assembly plug in later.
import {
  zeroUsage,
  type ChatMessage, type ChatModel, type ContentPart, type ServerTool, type StreamEvent,
  type ToolCallPart, type ToolDecl, type Usage,
} from './types.js';

export type LoopTool = ToolDecl & {
  /** Absent means external (block tools): the loop halts after the assistant's call so an outer
   * layer — the client, for block tools — supplies the result on resubmit. */
  execute?: (input: unknown) => Promise<unknown>;
  /** Safe to run concurrently with other parallel-safe tools in the same step — set it ONLY on
   * tools that never write the vault (or anything else): reads can interleave, writes cannot.
   * Absent/false preserves strict sequencing, so a tool that mutates state costs nothing to leave
   * unmarked. */
  parallel?: boolean;
};

export type LoopEvent =
  | StreamEvent
  | { type: 'step-start' | 'step-finish' }
  // Emitted as each loop-executed tool settles, so the wire layer can round-trip the output to
  // the client's already-rendered tool part (the provider stream itself never carries results).
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown; isError?: boolean };

export interface RunLoopOptions {
  model: ChatModel;
  system?: string;
  messages: ChatMessage[];
  tools: LoopTool[];
  /** Provider-executed tools (e.g. Anthropic web search), forwarded to the model verbatim.
   * They run inside the provider's own turn — never executed or halted on here. */
  serverTools?: ServerTool[];
  maxSteps: number;
  cache?: boolean;
  /** Caller abort (client disconnect, supersession): forwarded into every model request — an
   * abort cancels the in-flight provider call — and checked between steps and before tool
   * execution, so an abandoned run stops burning tokens and tool side effects. */
  signal?: AbortSignal;
  onEvent?: (e: LoopEvent) => void;
}

export interface LoopStep {
  toolCalls: ToolCallPart[];
  text: string;
}

export interface LoopResult {
  /** Full transcript: the input messages plus everything the loop appended. */
  messages: ChatMessage[];
  steps: LoopStep[];
  usage: Usage;
  stopReason: 'end' | 'external-tool' | 'max-steps';
}

export async function runLoop(opts: RunLoopOptions): Promise<LoopResult> {
  const messages = [...opts.messages];
  const steps: LoopStep[] = [];
  const usage = zeroUsage();
  // The wire sees plain declarations; execute stays loop-side.
  const decls: (ToolDecl | ServerTool)[] = [
    ...opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    ...(opts.serverTools ?? []),
  ];
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  let stopReason: LoopResult['stopReason'] = 'max-steps';

  for (let step = 0; step < opts.maxSteps; step++) {
    opts.signal?.throwIfAborted();
    opts.onEvent?.({ type: 'step-start' });
    let text = '';
    const thinking: ContentPart[] = [];
    const toolCalls: ToolCallPart[] = [];
    for await (const ev of opts.model.stream({
      system: opts.system,
      messages,
      tools: decls.length ? decls : undefined,
      cache: opts.cache,
      signal: opts.signal,
    })) {
      opts.onEvent?.(ev);
      if (ev.type === 'text-delta') {
        text += ev.text;
      } else if (ev.type === 'thinking-end') {
        // thinking-end carries the assembled block (text+signature, or the redacted payload), so
        // no delta re-accumulation here. Collected even when empty: a signature with no visible
        // text (display-omitted thinking) must still round-trip.
        thinking.push({
          type: 'thinking', text: ev.text,
          ...(ev.signature !== undefined ? { signature: ev.signature } : {}),
          ...(ev.redacted !== undefined ? { redacted: ev.redacted } : {}),
        });
      } else if (ev.type === 'tool-call') {
        toolCalls.push({ type: 'tool-call', toolCallId: ev.toolCallId, toolName: ev.toolName, input: ev.input });
      } else if (ev.type === 'finish') {
        usage.inputTokens += ev.usage.inputTokens;
        usage.outputTokens += ev.usage.outputTokens;
        usage.cacheReadTokens += ev.usage.cacheReadTokens;
        usage.cacheWriteTokens += ev.usage.cacheWriteTokens;
      }
    }
    opts.onEvent?.({ type: 'step-finish' });
    steps.push({ toolCalls, text });

    // Thinking first, mirroring wire order (it streams ahead of text and tool calls): the
    // Anthropic API rejects the next request when thinking is active and the thinking block that
    // preceded a tool_use is missing from the echoed assistant turn — this line is the fix.
    const content: ContentPart[] = [
      ...thinking,
      ...(text ? [{ type: 'text', text } satisfies ContentPart] : []),
      ...toolCalls,
    ];
    // A no-text no-tool-call step appends nothing: an empty content array is invalid on the
    // Anthropic wire and would poison the transcript for any later request built from it.
    if (content.length) messages.push({ role: 'assistant', content });

    if (toolCalls.length === 0) {
      stopReason = 'end';
      break;
    }

    // A declared tool without execute pauses the WHOLE run after the assistant message: results
    // cannot be partially supplied (both wires demand a result for every call in the next
    // message), so nothing executes and the resubmit provides all outputs.
    if (toolCalls.some((c) => {
      const t = byName.get(c.toolName);
      return t !== undefined && t.execute === undefined;
    })) {
      stopReason = 'external-tool';
      break;
    }

    // Checked once more here: the abort may have landed while the stream above drained. Tool
    // execution has side effects (vault writes via MCP) — an abandoned run must not commit them.
    // Deliberately NOT re-checked between the settlements below: once an execute has started (a
    // write may already have landed), its result must still reach the transcript.
    opts.signal?.throwIfAborted();
    // Runs one call and emits its tool-result the moment it settles (the client sees outputs as
    // they arrive); the caller owns result ORDERING. Never throws — a tool failure is an isError
    // result the model can recover from, and under Promise.all a throw would also cancel nothing
    // yet abandon the siblings' results.
    const execCall = async (call: ToolCallPart): Promise<ContentPart> => {
      const tool = byName.get(call.toolName);
      let output: unknown;
      let isError = false;
      if (!tool) {
        // A hallucinated tool name is reported as a failed result so the model can recover,
        // rather than halting the run as if a client were going to answer it.
        output = `unknown tool: ${call.toolName}`;
        isError = true;
      } else {
        try {
          output = await tool.execute!(call.input);
        } catch (e) {
          output = e instanceof Error ? e.message : String(e);
          isError = true;
        }
      }
      opts.onEvent?.({
        type: 'tool-result',
        toolCallId: call.toolCallId, toolName: call.toolName, output,
        ...(isError ? { isError: true } : {}),
      });
      return {
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output,
        ...(isError ? { isError: true } : {}),
      };
    };
    // Parallel-safe (LoopTool.parallel) calls fan out; everything else keeps today's strict
    // sequencing. Partitioned IN CALL ORDER into maximal runs of consecutive safe calls, so a
    // write between two reads still sees the first read finished and blocks the second — and
    // results land in the results message in ORIGINAL call order regardless of settlement order
    // (both provider wires demand a result per call; order stability keeps transcripts
    // deterministic). An unknown tool name is NOT safe: its error result stays position-faithful.
    const isSafe = (c: ToolCallPart) => byName.get(c.toolName)?.parallel === true;
    const results: ContentPart[] = [];
    for (let i = 0; i < toolCalls.length;) {
      let j = i;
      while (j < toolCalls.length && isSafe(toolCalls[j])) j++;
      if (j - i > 1) {
        results.push(...await Promise.all(toolCalls.slice(i, j).map(execCall)));
        i = j;
      } else {
        results.push(await execCall(toolCalls[i]));
        i++;
      }
    }
    messages.push({ role: 'user', content: results });
  }

  return { messages, steps, usage, stopReason };
}
