import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { HarnessConfig } from './config.js';
import type { Converter } from './convert.js';
import { downloadToTemp } from './download.js';
import { compileNext, ingestBook } from './ingest.js';
import type { Loreweaver } from './mcp.js';

/** The tutor's own paper-fetching tool — freeform mode only (wired in session.ts alongside
 * web_search/read_url). Downloads a URL, ingests it in paper mode, then fires a background
 * compile so the resulting vault pages come from the actual paper text rather than the model's
 * memory. Structured errors, never throws — matches webTools.ts style. */
export function buildIngestTools(
  lw: Loreweaver, cfg: HarnessConfig,
  deps: { download?: typeof downloadToTemp; converter?: Converter } = {},
): ToolSet {
  const download = deps.download ?? downloadToTemp;

  return {
    ingest_paper: tool({
      description: 'Download a research paper by URL (arXiv PDF, journal PDF, etc.) and queue it '
        + "for compilation into vault pages. Use after a web_search with category 'science' turns "
        + 'up the best source — pages then compile from the actual paper text, not from memory. '
        + 'Compiling runs in the background and can take minutes; tell the student it is underway '
        + 'rather than waiting on it.',
      inputSchema: z.object({
        url: z.string().url(),
        title: z.string().optional().describe('Paper title, if known — overrides title detection from the PDF.'),
      }),
      execute: async ({ url, title }) => {
        try {
          const downloaded = await download(url);
          const result = await ingestBook(cfg, downloaded.path, {
            converter: deps.converter, mode: 'paper', title,
          });
          // Fire-and-forget: local compile models take minutes and must not stall the chat turn.
          void compileNext(lw, cfg, 1).catch(console.error);
          return { queued: result.book, compiling: true };
        } catch (e: any) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),
  };
}
