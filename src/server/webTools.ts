import { htmlToText } from './htmlText.js';
import { fetchWithRetry, HttpStatusError, isRetryableError, isRetryableStatus, withRetry } from './retry.js';
import { assertPublicUrl, fetchGuarded, UrlRefusedError } from './urlGuard.js';
import { z } from 'zod';
import type { HarnessConfig } from './config.js';
import type { LoopTool, ServerTool } from './llm/index.js';
import { modelRouteFor } from './models.js';
import { zodTool } from './zodTool.js';

const MAX_PAGE_CHARS = 9_000;
const MAX_RESULTS = 6;
/** Ceiling on server-side searches per tutor turn. High enough to cross-check several sources
 *  (instruction 13 asks for at least two), low enough that a confused turn cannot spend the
 *  session searching. */
const MAX_SEARCHES_PER_TURN = 8;
const MAX_REDIRECTS = 5;

/** Injected so the suite can read its own 127.0.0.1 fixture server; production always gets
 *  `assertPublicUrl`. */
export interface WebToolDeps {
  guard?: (url: string) => Promise<void>;
}

/** `read_url`'s fetch: every redirect hop is guarded (see fetchGuarded). Each hop is retried — a
 *  blip here used to cost the whole turn, the model saw a dead source and taught from memory. A
 *  404/403 still fails immediately: those are answers about the URL, not accidents (retry.ts). */
function fetchPublicPage(url: string, guard: (url: string) => Promise<void>): Promise<Response> {
  return fetchGuarded(url, guard, (target) => withRetry(
    async () => {
      const r = await fetch(target, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: { 'user-agent': 'myelin/1.0 (personal tutoring app)' },
      });
      if (!r.ok && !(r.status >= 300 && r.status < 400)) throw new HttpStatusError(r.status, target);
      return r;
    },
    (e) => (e instanceof HttpStatusError ? isRetryableStatus(e.status) : isRetryableError(e)),
    { onRetry: (n, why) => console.error(`[read_url] retry ${n} for ${target}: ${why}`) },
  ), MAX_REDIRECTS);
}

/** `web_search_20260209` is a PROVIDER-EXECUTED tool: Anthropic runs the search on their side and
 *  the results never pass through this process. That makes it free of local infrastructure — the
 *  API key the tutor already needs is the whole setup — but it also means it only exists on an
 *  Anthropic-routed model. An `ollama:` or `openai:` tutor gets nothing back from it: an
 *  `openai:` route is still an OpenAI-compatible chat-completions wire (see openaiCompat.ts),
 *  which has no concept of a provider-executed Anthropic tool and drops it silently, so declaring
 *  it there would be a no-op that also lies to the learner about search working. `oai:` is the
 *  second exception (O2): its Responses API wire carries OpenAI's OWN built-in web_search, mapped
 *  below.
 */
function usesProviderSearch(modelId: string | undefined): boolean {
  return modelId !== undefined
    && (modelRouteFor(modelId) === 'anthropic' || modelRouteFor(modelId) === 'oai');
}

/** Loop-executed tools plus provider-executed ones, carried separately because they travel
 *  different routes: `tools` join the turn's LoopTool registry; `serverTools` go to runLoop's
 *  serverTools and reach the provider wire verbatim. */
export interface WebTools {
  tools: LoopTool[];
  serverTools: ServerTool[];
}

/** Research tools for the tutor: web search plus a readable-page fetcher.
 *
 * Search has two backends, in preference order:
 *
 *   1. **Provider-executed search** — Anthropic's `web_search_20260209` (dynamic filtering) for an
 *      Anthropic-routed model, or OpenAI's built-in `web_search` (O2) for an `oai:`-routed one.
 *      Nothing to install, nothing to host — which is the point: research used to require a
 *      self-hosted SearXNG, so out of the box the tutor could only teach from model memory and
 *      from files the learner supplied by hand.
 *   2. **A configured SearXNG** (`search.searxng`), which is what an `ollama:` or `openai:`
 *      tutor can use, since a provider-executed tool has no meaning off Anthropic's or OpenAI's
 *      own servers.
 *
 * `read_url` is deliberately UNGATED. It needs no infrastructure at all, and a learner who names a
 * specific URL should be readable regardless of which search backend exists.
 *
 * Errors come back as structured values (never throws) so the model can react — "search is down"
 * is teaching-relevant information, not a stack trace. Provider-executed search is the exception
 * by construction: its failures are handled inside the provider round-trip, not here.
 *
 * The single-writer rule holds either way: findings only reach the vault when the tutor calls
 * write_page with source URLs.
 */
export function buildWebTools(cfg: HarnessConfig, modelId?: string, deps: WebToolDeps = {}): WebTools {
  const guard = deps.guard ?? assertPublicUrl;
  const tools: LoopTool[] = [
    zodTool('read_url', {
      description: 'Fetch a web page and return its readable text (truncated). Use on the most '
        + 'promising search results, or on any URL the student names, before writing or updating '
        + 'vault pages.',
      input: z.object({ url: z.string().url() }),
      // A pure fetch — nothing local is written — so a model that fans out several reads gets
      // them concurrently (loop.ts's parallel runs) instead of paying the latency serially.
      parallel: true,
      execute: async ({ url }) => {
        try {
          const res = await fetchPublicPage(url, guard);
          const html = await res.text();
          const text = htmlToText(html);
          return {
            url,
            truncated: text.length > MAX_PAGE_CHARS,
            text: text.slice(0, MAX_PAGE_CHARS),
          };
        } catch (e: any) {
          if (e instanceof HttpStatusError) return { error: `fetch failed: HTTP ${e.status}` };
          if (e instanceof UrlRefusedError) return { error: `refused: ${e.message}` };
          return { error: `fetch unavailable: ${e?.message ?? e}` };
        }
      },
    }),
  ];

  if (usesProviderSearch(modelId)) {
    if (modelRouteFor(modelId!) === 'oai') {
      // The exact shape openaiResponses.ts (O1) maps onto `{ type: 'web_search' }` on the wire.
      // Unlike Anthropic's tool there is no `max_uses` knob on this wire to pass through.
      return { tools, serverTools: [{ type: 'web_search', name: 'web_search' }] };
    }
    // Pinned deliberately: web_search_20250305 is the older basic variant; _20260209 is the one
    // with dynamic filtering, and it is what the model actually behaves well with.
    return {
      tools,
      serverTools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES_PER_TURN }],
    };
  }

  if (cfg.search?.searxng) {
    const base = cfg.search.searxng.replace(/\/$/, '');
    tools.push(zodTool('web_search', {
      description: 'Search the web (local SearXNG). Use when starting or refreshing a subject: '
        + 'cross-check at least two sources before writing pages, and cite result URLs in the '
        + 'page\'s sources frontmatter.',
      input: z.object({ query: z.string(), category: z.enum(['general', 'science', 'it', 'news']).optional() }),
      // Read-only like read_url: SearXNG queries write nothing, so cross-checking several
      // sources at once is safe to interleave.
      parallel: true,
      execute: async ({ query, category }) => {
        try {
          const url = `${base}/search?format=json&q=${encodeURIComponent(query)}`
            + (category ? `&categories=${category}` : '');
          // A failed search reads to the model as "nothing exists on this", which is a worse
          // lie than a slow answer — so it retries too.
          const res = await fetchWithRetry(url, { signal: AbortSignal.timeout(15_000) },
            { onRetry: (n, why) => console.error(`[web_search] retry ${n}: ${why}`) });
          const data = await res.json() as { results?: { url: string; title: string; content?: string }[] };
          return {
            results: (data.results ?? []).slice(0, MAX_RESULTS)
              .map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' })),
          };
        } catch (e: any) {
          if (e instanceof HttpStatusError) return { error: `search failed: HTTP ${e.status}` };
          return { error: `search unavailable: ${e?.message ?? e}` };
        }
      },
    }));
    return { tools, serverTools: [] };
  }

  // No search backend at all — an ollama:/openai: model with no SearXNG configured. read_url
  // still ships, and instruction 13 tells the tutor to mark pages as unverified model knowledge
  // when it cannot search. Registering a web_search that always errors would be worse: the model
  // would keep retrying a tool that cannot ever work.
  return { tools, serverTools: [] };
}
