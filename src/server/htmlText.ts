import { convert } from 'html-to-text';

/** Chrome-stripping selectors shared by every HTML→text path. Kept in ONE place because the tutor's
 *  `read_url` and the ingest downloader must agree: a page the tutor can read and cite should be a
 *  page the learner can also ADD, and two extractors would drift into disagreeing about what the
 *  page even says. */
const SELECTORS = [
  { selector: 'nav', format: 'skip' as const },
  { selector: 'footer', format: 'skip' as const },
  { selector: 'header', format: 'skip' as const },
  { selector: 'aside', format: 'skip' as const },
  { selector: 'script', format: 'skip' as const },
  { selector: 'style', format: 'skip' as const },
  { selector: 'a', options: { ignoreHref: true } },
  { selector: 'img', format: 'skip' as const },
  // Documentation-site chrome. Sphinx, MkDocs, Docusaurus and ReadTheDocs put the sidebar, the
  // per-page table of contents and the "Report a bug / Edit on GitHub" rail in ordinary <div>s, so
  // the structural selectors above miss them entirely. Left in, that text is indistinguishable from
  // article prose downstream: ingesting the Python tutorial banked "Errors and Exceptions / NEXT
  // TOPIC" and "Report a bug / Improve this page" as if they were exam problems.
  { selector: '[role="navigation"]', format: 'skip' as const },
  { selector: '[role="complementary"]', format: 'skip' as const },
  { selector: '.sphinxsidebar', format: 'skip' as const },
  { selector: '.headerlink', format: 'skip' as const },
  { selector: '.toc', format: 'skip' as const },
  { selector: '.toctree-wrapper', format: 'skip' as const },
  { selector: '.breadcrumbs', format: 'skip' as const },
  { selector: '.wy-nav-side', format: 'skip' as const },
  { selector: '.md-sidebar', format: 'skip' as const },
  { selector: '.theme-doc-sidebar-container', format: 'skip' as const },
  { selector: '.admonition-title', format: 'skip' as const },
];

/** Readable text from an HTML document, with navigation/boilerplate dropped and runs of blank
 *  lines collapsed. */
export function htmlToText(html: string): string {
  return convert(html, { wordwrap: false, selectors: SELECTORS })
    // Sphinx renders a pilcrow anchor after every heading; when the .headerlink skip misses it
    // (older themes put the character in the heading's own text) it rides along on the end of the
    // title — "KEY CONCEPTS AND TERMINOLOGY¶" — into page titles and slugs.
    .replace(/¶/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The document's <title>, trimmed, or null. Used to name an ingested web page in the Library —
 *  without it a saved article shows up as the last path segment of its URL, which for most CMS
 *  routes is a number. */
export function htmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const raw = htmlToText(m[1]).replace(/\s+/g, ' ').trim();
  return raw || null;
}
