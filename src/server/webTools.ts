import { anthropic } from '@ai-sdk/anthropic';
import { tool, type ToolSet } from 'ai';
import { convert } from 'html-to-text';
import { z } from 'zod';
import type { HarnessConfig } from './config.js';

const MAX_PAGE_CHARS = 9_000;
const MAX_RESULTS = 6;
/** Ceiling on server-side searches per tutor turn. High enough to cross-check several sources
 *  (instruction 13 asks for at least two), low enough that a confused turn cannot spend the
 *  session searching. */
const MAX_SEARCHES_PER_TURN = 8;

/** Which search backend a model route can actually use.
 *
 *  `webSearch_20260209` is a PROVIDER-EXECUTED tool: Anthropic runs the search on their side and
 *  the results never pass through this process. That makes it free of local infrastructure — the
 *  API key the tutor already needs is the whole setup — but it also means it only exists on an
 *  Anthropic-routed model. An `ollama:` tutor gets nothing back from it. */
function isAnthropicRouted(modelId: string | undefined): boolean {
  if (!modelId) return false;
  // Mirrors models.ts's routing: `ollama:` goes to the OpenAI-compatible provider, `claude-sdk:`
  // never reaches this tool set (claudeSdkTutor.ts owns that route and brings its own tools),
  // anything else is an Anthropic model id.
  return !modelId.startsWith('ollama:') && !modelId.startsWith('claude-sdk:');
}

/** Research tools for the tutor: web search plus a readable-page fetcher.
 *
 * Search has two backends, in preference order:
 *
 *   1. **Anthropic's server-side web search** (`web_search_20260209`, dynamic filtering) whenever
 *      the tutor runs on an Anthropic-routed model. Nothing to install, nothing to host — which is
 *      the point: research used to require a self-hosted SearXNG, so out of the box the tutor
 *      could only teach from model memory and from files the learner supplied by hand.
 *   2. **A configured SearXNG** (`search.searxng`), which is what a local `ollama:` tutor can use,
 *      since a provider-executed tool has no meaning off Anthropic's servers.
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
export function buildWebTools(cfg: HarnessConfig, modelId?: string): ToolSet {
  const tools: ToolSet = {
    read_url: tool({
      description: 'Fetch a web page and return its readable text (truncated). Use on the most '
        + 'promising search results, or on any URL the student names, before writing or updating '
        + 'vault pages.',
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(20_000),
            headers: { 'user-agent': 'myelin/1.0 (personal tutoring app)' },
          });
          if (!res.ok) return { error: `fetch failed: HTTP ${res.status}` };
          const html = await res.text();
          const text = convert(html, {
            wordwrap: false,
            selectors: [
              { selector: 'nav', format: 'skip' },
              { selector: 'footer', format: 'skip' },
              { selector: 'script', format: 'skip' },
              { selector: 'style', format: 'skip' },
              { selector: 'a', options: { ignoreHref: true } },
              { selector: 'img', format: 'skip' },
            ],
          }).replace(/\n{3,}/g, '\n\n').trim();
          return {
            url,
            truncated: text.length > MAX_PAGE_CHARS,
            text: text.slice(0, MAX_PAGE_CHARS),
          };
        } catch (e: any) {
          return { error: `fetch unavailable: ${e?.message ?? e}` };
        }
      },
    }),
  };

  if (isAnthropicRouted(modelId)) {
    tools.web_search = anthropic.tools.webSearch_20260209({ maxUses: MAX_SEARCHES_PER_TURN });
    return tools;
  }

  if (cfg.search?.searxng) {
    const base = cfg.search.searxng.replace(/\/$/, '');
    tools.web_search = tool({
      description: 'Search the web (local SearXNG). Use when starting or refreshing a subject: '
        + 'cross-check at least two sources before writing pages, and cite result URLs in the '
        + 'page\'s sources frontmatter.',
      inputSchema: z.object({ query: z.string(), category: z.enum(['general', 'science', 'it', 'news']).optional() }),
      execute: async ({ query, category }) => {
        try {
          const url = `${base}/search?format=json&q=${encodeURIComponent(query)}`
            + (category ? `&categories=${category}` : '');
          const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
          if (!res.ok) return { error: `search failed: HTTP ${res.status}` };
          const data = await res.json() as { results?: { url: string; title: string; content?: string }[] };
          return {
            results: (data.results ?? []).slice(0, MAX_RESULTS)
              .map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' })),
          };
        } catch (e: any) {
          return { error: `search unavailable: ${e?.message ?? e}` };
        }
      },
    });
  }

  // No search backend at all — a local model with no SearXNG. read_url still ships, and
  // instruction 13 tells the tutor to mark pages as unverified model knowledge when it cannot
  // search. Registering a web_search that always errors would be worse: the model would keep
  // retrying a tool that cannot ever work.
  return tools;
}
