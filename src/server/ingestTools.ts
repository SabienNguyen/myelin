import { z } from 'zod';
import type { HarnessConfig } from './config.js';
import type { Converter } from './convert.js';
import { downloadToTemp } from './download.js';
import { startConversion } from './ingest.js';
import type { LoopTool } from './llm/index.js';
import type { Engram } from './mcp.js';
import { zodTool } from './zodTool.js';
import { dirname } from 'node:path';

/** The tutor's own paper-fetching tool — freeform mode only (wired in session.ts alongside
 * web_search/read_url). Downloads a URL, ingests it in paper mode, then fires a background
 * compile so the resulting vault pages come from the actual paper text rather than the model's
 * memory. Structured errors, never throws — matches webTools.ts style. */
export function buildIngestTools(
  lw: Engram, cfg: HarnessConfig,
  deps: { download?: typeof downloadToTemp; converter?: Converter } = {},
): LoopTool[] {
  const download = deps.download ?? downloadToTemp;

  return [
    zodTool('ingest_paper', {
      description: 'Download a research paper by URL (arXiv PDF, journal PDF, etc.) and queue it '
        + "for compilation into vault pages. Use after a web_search with category 'science' turns "
        + 'up the best source — pages then compile from the actual paper text, not from memory. '
        + 'Compiling runs in the background and can take minutes; tell the student it is underway '
        + 'rather than waiting on it.',
      input: z.object({
        url: z.string().url(),
        title: z.string().optional().describe('Paper title, if known — overrides title detection from the PDF.'),
        authors: z.array(z.string()).optional().describe(
          'Who YOU believe wrote this, if you know — verbatim names. Recorded as a CLAIM and shown '
          + 'to the student as unverified. It never overrides a byline the source itself or its '
          + 'platform reports; if the two disagree, the source wins and your claim is recorded as '
          + 'wrong. Omit it rather than guessing.',
        ),
      }),
      execute: async ({ url, title, authors }) => {
        try {
          const downloaded = await download(url);
          // Conversion AND compile both run in the background — neither may stall the chat turn.
          // The Library tab shows the 'converting' placeholder immediately (reload-safe).
          // startConversion itself kicks ensureCompileDrain on completion (when cfg.autoCompile
          // isn't explicitly false) — a single code path for auto-compiling, shared with the
          // upload/URL ingest routes.
          const result = startConversion(lw, cfg, downloaded.path, {
            converter: deps.converter, mode: 'paper', title, sourceUrl: url,
            cleanupInputDir: dirname(downloaded.path),
            provenance: { origin: { kind: 'url', url }, claimed: authors },
          });
          return { queued: result.book, converting: true, compiling: 'starts after conversion' };
        } catch (e: any) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),
  ];
}
