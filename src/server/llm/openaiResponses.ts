// OpenAI Responses API adapter over plain fetch — the `oai:` route (O2). Distinct from
// openaiCompat.ts's /chat/completions wire: this one talks to /v1/responses, which is what gets
// OpenAI's built-in `web_search` server tool and `reasoning.effort` alongside function tools (the
// chat-completions wire refuses tools while reasoning is on, per openaiCompat's
// isReasoningToolsConflict comment — this route exists specifically to sidestep that).
import {
  errorFromResponse, isServerTool, parseToolArguments, zeroUsage, LlmHttpError,
  type ChatMessage, type ChatModel, type ChatRequest, type ContentPart, type FinishReason,
  type GenerateResult, type StreamEvent, type ThinkingPart, type ToolCallPart, type Usage,
} from './types.js';
import { sseFrames } from './sse.js';
import { withRetries, type RetryOptions } from './retry.js';

export interface OpenAIResponsesModelOptions {
  modelId: string;
  /** Resolved PER CALL by the caller (models.ts reads process.env.OPENAI_API_KEY fresh on every
   *  chatModelFor, the same reasoning openaiCompat documents) — this adapter just uses whatever
   *  it is given, with no env fallback of its own. */
  apiKey?: string;
  baseUrl?: string;
  retry?: RetryOptions;
  /** Milliseconds allowed for the endpoint to return response HEADERS, per attempt — see
   *  openaiCompat's OpenAICompatModelOptions.timeoutMs for why this is a headers deadline, not a
   *  whole-request one. Default 120s. */
  timeoutMs?: number;
}

const PROVIDER = 'openai-responses';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

type Json = Record<string, unknown>;

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

function usageOf(u?: WireUsage): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0, // this wire has no cache-write accounting
  };
}

/**
 * Reasoning continuity, packed into ThinkingPart.
 *
 * ThinkingPart (types.ts) has exactly one string field for provider echo plumbing —
 * `signature` — because that is all the Anthropic wire needs. The Responses API needs TWO
 * things back to keep a reasoning item alive across a tool step: the item's own `id` and its
 * `encrypted_content` blob. Rather than widen ThinkingPart (which would touch loop.ts, wire.ts,
 * and the anthropic adapter for a field only this adapter uses), both are packed as one JSON
 * string into `signature`. `text` still carries the reasoning summary for display; `redacted` is
 * never set here — this wire has no redacted-reasoning concept, that is Anthropic-specific.
 */
interface ReasoningSignature { id: string; encrypted_content: string }

function packReasoningSignature(id: string, encryptedContent: string): string {
  return JSON.stringify({ id, encrypted_content: encryptedContent } satisfies ReasoningSignature);
}

/** Inverse of packReasoningSignature. Returns undefined for a signature this adapter did not
 *  produce (malformed JSON, or missing fields) rather than throwing — a reasoning item that
 *  cannot be reconstructed is dropped from the request with a console.error, same as the
 *  degrade-loudly rule everywhere else in this module; it never poisons the whole turn. */
function unpackReasoningSignature(signature: string): ReasoningSignature | undefined {
  try {
    const obj = JSON.parse(signature) as Partial<ReasoningSignature>;
    if (typeof obj.id === 'string' && typeof obj.encrypted_content === 'string') {
      return { id: obj.id, encrypted_content: obj.encrypted_content };
    }
  } catch { /* not this adapter's signature — fall through to undefined */ }
  return undefined;
}

/** ChatMessages → Responses `input` items. Message text rides as a plain string per the
 *  documented `content: string | array of content items` shape — an array of `input_image`/
 *  `input_text` parts is used only when a message actually carries a file, exactly like
 *  openaiCompat's wireMessages switching content shape on `hasImage`. */
function wireInput(messages: ChatMessage[]): Json[] {
  const out: Json[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      let text = '';
      const items: Json[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          text += part.text;
        } else if (part.type === 'thinking') {
          const sig = part.signature !== undefined ? unpackReasoningSignature(part.signature) : undefined;
          if (sig) {
            items.push({ type: 'reasoning', id: sig.id, encrypted_content: sig.encrypted_content, summary: [] });
          } else if (part.signature !== undefined) {
            console.error('openaiResponses: dropping a reasoning item whose signature this adapter did not produce');
          }
        } else if (part.type === 'tool-call') {
          items.push({
            type: 'function_call',
            call_id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.input ?? {}),
          });
        }
      }
      if (text) items.unshift({ type: 'message', role: 'assistant', content: text });
      out.push(...items);
    } else {
      let text = '';
      const parts: Json[] = [];
      let hasImage = false;
      const outputs: Json[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          text += part.text;
          parts.push({ type: 'input_text', text: part.text });
        } else if (part.type === 'file') {
          if (part.mediaType.startsWith('image/')) {
            hasImage = true;
            parts.push({ type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` });
          }
          // Non-image files have no portable Responses-input encoding here; dropped, same call
          // openaiCompat's wireMessages makes for PDFs on that wire.
        } else if (part.type === 'tool-result') {
          outputs.push({
            type: 'function_call_output',
            call_id: part.toolCallId,
            output: typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
          });
        }
      }
      if (hasImage) out.push({ type: 'message', role: 'user', content: parts });
      else if (text) out.push({ type: 'message', role: 'user', content: text });
      out.push(...outputs);
    }
  }
  return out;
}

function buildBody(modelId: string, req: ChatRequest, stream: boolean): Json {
  const fnTools = (req.tools ?? []).filter((t) => !isServerTool(t));
  const serverTools = (req.tools ?? []).filter(isServerTool);

  const include: string[] = ['reasoning.encrypted_content'];
  // A web_search_call's `action.sources` — the URLs the search actually consulted — is only
  // populated by the API when the request opts in here (verified against OpenAI's Responses API
  // docs: include value `web_search_call.action.sources`, "Include the sources of the web search
  // tool call."). Without it, action.sources is always empty and the union in the streaming loop
  // below has nothing but url_citation annotations to draw on — and the model frequently skips
  // those when it goes straight into another tool call instead of citing inline, which is exactly
  // how a completed search ends up saved with sources: []. Scoped to when web_search is actually
  // offered: nothing else in this route's `include` list is sent unconditionally either.
  if (serverTools.some((t) => t.type === 'web_search')) include.push('web_search_call.action.sources');

  const body: Json = {
    model: modelId,
    stream,
    // The two flags this whole route exists to send: no server-side conversation state (the
    // harness already keeps history), and the encrypted reasoning payload back so a tool step
    // can re-attach it — see packReasoningSignature above for where it goes on the way back in.
    store: false,
    include,
    input: wireInput(req.messages),
  };
  if (req.system !== undefined) body.instructions = req.system;

  const tools: Json[] = fnTools.map((t) => ({
    type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false,
  }));
  for (const t of serverTools) {
    // The only server tool this route knows how to place: `{ type: 'web_search', name:
    // 'web_search' }` is the exact shape webTools.ts (O2) hands over for the `oai` provider.
    // Anything else would otherwise be silently dropped on the floor — throw instead, the same
    // choice openaiCompat makes for a responseSchema the fallback path can't reach.
    if (t.type !== 'web_search') {
      throw new Error(`openaiResponses: unsupported server tool type '${t.type}'`);
    }
    tools.push({ type: 'web_search' });
  }
  if (tools.length) body.tools = tools;

  if (req.toolChoice) {
    body.tool_choice = req.toolChoice === 'auto' ? 'auto' : { type: 'function', name: req.toolChoice.name };
  }
  // Sent WITH tools — that is the point of this route (openaiCompat's chat-completions wire
  // refuses function tools while reasoning is on; the Responses API does not).
  if (req.effort !== undefined) body.reasoning = { effort: req.effort };
  // Constrained decoding only when nothing else is claiming the model's output shape.
  if (req.responseSchema && !fnTools.length) {
    body.text = {
      format: {
        type: 'json_schema', name: req.responseSchema.name, schema: req.responseSchema.schema, strict: true,
      },
    };
  }
  if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  // Only the two knobs this wire understands; top_k/min_p/repetition_penalty are the local-model
  // levers openaiCompat sends — OpenAI rejects them outright, so they are never forwarded here.
  if (req.sampler?.topP !== undefined) body.top_p = req.sampler.topP;
  return body;
}

async function postOnce(
  opts: OpenAIResponsesModelOptions, baseUrl: string, body: Json, signal?: AbortSignal,
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withRetries(async () => {
    // Per-attempt controller so the header timeout can be cleared once headers arrive — see
    // openaiCompat's postOnce for why a plain AbortSignal.timeout would kill a healthy stream.
    const ctrl = new AbortController();
    const forwardAbort = () => ctrl.abort(signal!.reason);
    signal?.throwIfAborted();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(
      () => ctrl.abort(new LlmHttpError(PROVIDER, 408, `no response headers within ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
      const res = await fetch(`${baseUrl}/responses`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
      });
      if (!res.ok) throw await errorFromResponse(PROVIDER, res);
      return res;
    } catch (e) {
      signal?.removeEventListener('abort', forwardAbort);
      throw ctrl.signal.aborted ? ctrl.signal.reason : e;
    } finally {
      clearTimeout(timer);
    }
  }, { ...opts.retry, signal });
}

// ---- wire item/event shapes actually read (minimal — see docs verification note in the report) --

interface WireFunctionCallItem {
  type: 'function_call'; id: string; call_id: string; name: string; arguments: string;
}
interface WireReasoningItem {
  type: 'reasoning'; id: string; encrypted_content?: string;
  summary?: { type: 'summary_text'; text: string }[];
}
interface WireWebSearchCallItem {
  type: 'web_search_call'; id: string; status?: string;
  action?: { type: string; query?: string; queries?: string[]; sources?: { url: string; title?: string }[] };
}
interface WireAnnotation { type: string; url?: string; title?: string }
interface WireMessageItem {
  type: 'message'; id: string; role: string;
  content?: { type: string; text?: string; annotations?: WireAnnotation[] }[];
}
// Deliberately no catch-all member here: TypeScript would widen `type: string` into every
// narrowed switch case below (its literal always overlaps a broader `string`), collapsing
// `item`/other fields back to unknown for every branch. Event or item kinds this adapter has no
// case for still parse fine at runtime — JSON.parse doesn't care about the static type — and the
// switch's `default` branch below is what actually ignores them.
type WireOutputItem = WireFunctionCallItem | WireReasoningItem | WireWebSearchCallItem | WireMessageItem;

type WireEvent =
  | { type: 'response.output_item.added'; output_index: number; item: WireOutputItem }
  | { type: 'response.output_item.done'; output_index: number; item: WireOutputItem }
  | { type: 'response.output_text.delta'; item_id: string; delta: string }
  | { type: 'response.function_call_arguments.delta'; item_id: string; delta: string }
  | { type: 'response.reasoning_summary_text.delta'; item_id: string; delta: string }
  | { type: 'response.completed' | 'response.incomplete'; response: { status?: string; usage?: WireUsage } }
  | { type: 'response.failed'; response?: { error?: { message?: string } } }
  | { type: 'error'; message?: string; code?: string };

function citationsOf(item: WireMessageItem): { url: string; title?: string }[] {
  const out: { url: string; title?: string }[] = [];
  for (const part of item.content ?? []) {
    for (const a of part.annotations ?? []) {
      if (a.type === 'url_citation' && a.url) out.push({ url: a.url, title: a.title });
    }
  }
  return out;
}

function dedupeByUrl(sources: { url: string; title?: string }[]): { url: string; title?: string }[] {
  const seen = new Map<string, { url: string; title?: string }>();
  for (const s of sources) {
    const existing = seen.get(s.url);
    if (!existing) seen.set(s.url, s);
    // First occurrence wins the map slot (so insertion order — action.sources ahead of
    // annotations — is preserved), but a later duplicate still donates its title if the first
    // one didn't have one: action.sources and url_citation are independent OpenAI features and
    // either can be the one that names a given page.
    else if (!existing.title && s.title) seen.set(s.url, { url: s.url, title: s.title });
  }
  return [...seen.values()];
}

function mapFinish(status: string | undefined, sawToolCalls: boolean): FinishReason {
  if (sawToolCalls) return 'tool-calls';
  if (status === 'incomplete') return 'length';
  return 'stop';
}

export function openaiResponsesModel(opts: OpenAIResponsesModelOptions): ChatModel {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  async function* streamImpl(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const res = await postOnce(opts, baseUrl, buildBody(opts.modelId, req, true), req.signal);
    if (!res.body) throw new LlmHttpError(PROVIDER, res.status, 'response had no body');

    const openTextIds = new Set<string>();
    // function_call items are addressed by item_id in delta events but must echo their call_id
    // on the wire (function_call_output.call_id) — tracked by item id, keyed to the call_id the
    // rest of the turn (and the next request) actually uses.
    const calls = new Map<string, { callId: string; name: string; args: string }>();
    let sawToolCalls = false;
    // web_search_call results are deferred to response.completed: the citations that belong to
    // a search usually arrive on a LATER message item's url_citation annotations, so emitting
    // server-tool-call/-result as soon as the call item itself closes would race the very
    // annotations the plan asks this event to carry.
    const pendingSearches: { id: string; query: string; actionSources: { url: string; title?: string }[] }[] = [];
    const citations: { url: string; title?: string }[] = [];
    let usage = zeroUsage();
    let status: string | undefined;

    for await (const frame of sseFrames(res.body)) {
      let ev: WireEvent;
      try {
        ev = JSON.parse(frame.data) as WireEvent;
      } catch {
        console.error('openaiResponses: skipping non-JSON SSE frame:', frame.data.slice(0, 200));
        continue;
      }
      switch (ev.type) {
        case 'response.output_item.added': {
          const item = ev.item;
          if (item.type === 'function_call') {
            calls.set(item.id, { callId: item.call_id, name: item.name, args: item.arguments ?? '' });
            yield { type: 'tool-input-start', toolCallId: item.call_id, toolName: item.name };
          } else if (item.type === 'reasoning') {
            yield { type: 'thinking-start', id: item.id };
          }
          break;
        }
        case 'response.output_text.delta': {
          if (!openTextIds.has(ev.item_id)) {
            openTextIds.add(ev.item_id);
            yield { type: 'text-start', id: ev.item_id };
          }
          yield { type: 'text-delta', id: ev.item_id, text: ev.delta };
          break;
        }
        case 'response.function_call_arguments.delta': {
          const st = calls.get(ev.item_id);
          if (!st) break;
          st.args += ev.delta;
          yield { type: 'tool-input-delta', toolCallId: st.callId, delta: ev.delta };
          break;
        }
        case 'response.reasoning_summary_text.delta': {
          yield { type: 'thinking-delta', id: ev.item_id, text: ev.delta };
          break;
        }
        case 'response.output_item.done': {
          const item = ev.item;
          if (item.type === 'message') {
            if (openTextIds.has(item.id)) {
              openTextIds.delete(item.id);
              yield { type: 'text-end', id: item.id };
            }
            citations.push(...citationsOf(item));
          } else if (item.type === 'function_call') {
            const st = calls.get(item.id) ?? { callId: item.call_id, name: item.name, args: item.arguments };
            sawToolCalls = true;
            yield { type: 'tool-call', toolCallId: st.callId, toolName: st.name, ...parseToolArguments(item.arguments) };
          } else if (item.type === 'reasoning') {
            const text = (item.summary ?? []).map((s) => s.text).join('');
            yield {
              type: 'thinking-end', id: item.id, text,
              ...(item.encrypted_content !== undefined
                ? { signature: packReasoningSignature(item.id, item.encrypted_content) }
                : {}),
            };
          } else if (item.type === 'web_search_call') {
            const query = item.action?.query ?? item.action?.queries?.[0] ?? '';
            pendingSearches.push({
              id: item.id, query,
              actionSources: (item.action?.sources ?? []).map((s) => ({ url: s.url, title: s.title })),
            });
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          usage = usageOf(ev.response?.usage);
          status = ev.response?.status;
          break;
        }
        case 'response.failed': {
          throw new LlmHttpError(PROVIDER, 500, ev.response?.error?.message ?? 'response failed');
        }
        case 'error': {
          throw new LlmHttpError(PROVIDER, 500, ev.message ?? 'stream error');
        }
        default:
          break; // ping/keepalive and item kinds this adapter has no behavior for
      }
    }

    for (const search of pendingSearches) {
      const sources = dedupeByUrl([...search.actionSources, ...citations]);
      yield { type: 'server-tool-call', toolCallId: search.id, toolName: 'web_search', input: { query: search.query } };
      yield { type: 'server-tool-result', toolCallId: search.id, toolName: 'web_search', output: { query: search.query, sources } };
    }
    yield { type: 'finish', reason: mapFinish(status, sawToolCalls), usage };
  }

  async function generateImpl(req: ChatRequest): Promise<GenerateResult> {
    // Collected via the same stream() path rather than a second non-streaming parser: the
    // Responses API's non-stream body is just the assembled form of the same items this adapter
    // already knows how to read, and duplicating that mapping would be the exact drift risk
    // no-slop-code's "do not re-implement" rule warns about.
    let text = '';
    const toolCalls: ToolCallPart[] = [];
    const thinking: ThinkingPart[] = [];
    let usage = zeroUsage();
    let finishReason: FinishReason = 'stop';
    const openTexts = new Map<string, string>();

    for await (const ev of streamImpl(req)) {
      if (ev.type === 'text-delta') {
        openTexts.set(ev.id, (openTexts.get(ev.id) ?? '') + ev.text);
      } else if (ev.type === 'tool-call') {
        toolCalls.push({
          type: 'tool-call', toolCallId: ev.toolCallId, toolName: ev.toolName, input: ev.input,
          ...(ev.inputError !== undefined ? { inputError: ev.inputError } : {}),
        });
      } else if (ev.type === 'thinking-end') {
        thinking.push({
          type: 'thinking', text: ev.text,
          ...(ev.signature !== undefined ? { signature: ev.signature } : {}),
        });
      } else if (ev.type === 'finish') {
        usage = ev.usage;
        finishReason = ev.reason;
      }
    }
    for (const t of openTexts.values()) text += t;
    return { text, toolCalls, ...(thinking.length ? { thinking } : {}), usage, finishReason };
  }

  return {
    generate: generateImpl,
    stream: streamImpl,
  };
}
