import { tool, type ToolSet } from 'ai';
import { convert } from 'html-to-text';
import { z } from 'zod';
import type { HarnessConfig } from './config.js';

const MAX_PAGE_CHARS = 9_000;
const MAX_RESULTS = 6;

/** Research tools for freeform mode: a local SearXNG metasearch + a readable-page fetcher.
 * Errors come back as structured values (never throws) so the model can react — "search is
 * down" is teaching-relevant information, not a stack trace. The single-writer rule holds:
 * findings only reach the vault when the tutor calls write_page with source URLs. */
export function buildWebTools(cfg: HarnessConfig): ToolSet {
  if (!cfg.search?.searxng) return {};
  const base = cfg.search.searxng.replace(/\/$/, '');

  return {
    web_search: tool({
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
    }),
    read_url: tool({
      description: 'Fetch a web page and return its readable text (truncated). Use on the most '
        + 'promising search results before writing or updating vault pages.',
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(20_000),
            headers: { 'user-agent': 'loreweaver-harness/1.0 (personal tutoring app)' },
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
}
