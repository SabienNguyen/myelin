import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

/**
 * Third model route (T40): `claude-sdk:<model>` draws from the user's Claude Pro/Max
 * subscription via the Agent SDK's local Claude Code login — no API key involved. This is a
 * ONE-SHOT route (compile chunks, grader/card-gen calls): the interactive tutor role is
 * explicitly OUT OF SCOPE — bridging the SDK's async-generator streaming to the harness's
 * HITL chat UI is a separate project (see README "Model routes" section).
 */
export const CLAUDE_SDK_PREFIX = 'claude-sdk:';

export function isClaudeSdkModel(id: string): boolean {
  return id.startsWith(CLAUDE_SDK_PREFIX);
}

/** Strips the `claude-sdk:` prefix, leaving the bare model id/alias the Agent SDK expects. */
export function stripClaudeSdkPrefix(id: string): string {
  return id.slice(CLAUDE_SDK_PREFIX.length);
}

export interface ClaudeSdkMcpConfig {
  loreweaver: { command: string; args: string[]; env?: Record<string, string> };
}

export interface ClaudeSdkGenerateOpts {
  model: string; // WITHOUT the claude-sdk: prefix
  prompt: string;
  system?: string;
  maxTurns?: number;
  mcp?: ClaudeSdkMcpConfig;
  allowedTools?: string[];
}

export interface ClaudeSdkResult {
  text: string;
  toolCallNames: string[]; // normalized: 'mcp__loreweaver__write_page' -> 'write_page'
}

/**
 * MCP tool names surfaced by the Agent SDK are prefixed `mcp__<server>__<tool>` (confirmed in
 * the installed @anthropic-ai/claude-agent-sdk typings, e.g. the toolAliases doc example
 * `mcp__workspace__bash` and the disallowedTools doc `mcp__server__tool_name`). The compile
 * honesty gate checks for the bare tool name ('write_page'), so normalize here rather than at
 * every call site.
 */
function bareToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const parts = name.split('__');
  return parts.length > 2 ? parts.slice(2).join('__') : name;
}

/**
 * Runs ONE Agent SDK query to completion and returns the final assistant text plus the bare
 * names of every tool the model called along the way (needed by ingest.ts's compile honesty
 * gate). permissionMode is 'bypassPermissions' — this is a local personal app with no untrusted
 * multi-tenant input, so we skip the interactive approval loop entirely (bypassPermissions
 * additionally requires allowDangerouslySkipPermissions per the SDK's own typings).
 */
export async function claudeSdkGenerate(opts: ClaudeSdkGenerateOpts): Promise<ClaudeSdkResult> {
  const options: Options = {
    model: opts.model,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  };
  if (opts.system !== undefined) options.systemPrompt = opts.system;
  if (opts.maxTurns !== undefined) options.maxTurns = opts.maxTurns;
  if (opts.allowedTools !== undefined) options.allowedTools = opts.allowedTools;
  if (opts.mcp) {
    options.mcpServers = {
      loreweaver: {
        type: 'stdio',
        command: opts.mcp.loreweaver.command,
        args: opts.mcp.loreweaver.args,
        ...(opts.mcp.loreweaver.env ? { env: opts.mcp.loreweaver.env } : {}),
      },
    };
  }

  const toolCallNames: string[] = [];
  let text = '';
  for await (const message of query({ prompt: opts.prompt, options })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') toolCallNames.push(bareToolName(block.name));
      }
    } else if (message.type === 'result') {
      if (message.subtype === 'success') {
        text = message.result;
      } else {
        throw new Error(`claude-sdk query failed (${message.subtype}): ${message.errors.join('; ')}`);
      }
    }
  }
  return { text, toolCallNames };
}
