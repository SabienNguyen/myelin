// Citation chasing: the references of an ingested paper, extracted so the tutor can offer them
// as next reads. Discovery breadth is frontierResearch.ts's job (what's new, who to read);
// this is depth — the paper in front of you names its own intellectual parents, and following
// them is how a field is actually learned.
//
// Parsing is deliberately conservative. Reference formats are a swamp; the useful invariant is
// that an ACTIONABLE reference carries a resolvable id — DOI, arXiv id, or URL — and those have
// stable shapes. Entries without one still list as text (the learner can search them), but only
// id-bearing entries get an ingest offer.

export interface PaperReference {
  /** The reference's text, trimmed to one line. */
  text: string;
  /** Resolvable link when the entry carried an id: doi.org URL, arXiv abs URL, or the raw URL. */
  url?: string;
  /** arXiv PDF URL when the id was an arXiv id — what ingest_url wants for direct ingestion. */
  pdfUrl?: string;
}

const MAX_REFS = 40;

const DOI = /\b(10\.\d{4,9}\/[^\s"<>,;]+)/;
const ARXIV = /\barXiv:\s*(\d{4}\.\d{4,5})(v\d+)?/i;
const URL_RE = /\bhttps?:\/\/[^\s"<>)\]]+/;

/** The references section of a converted paper: everything after the last heading that names it.
 *  Last, not first — papers cite "References" in prose; the section heading is at the end. */
export function referencesSection(markdown: string): string | null {
  const m = [...markdown.matchAll(/^#{1,4}\s*(references|bibliography|works cited)\s*$/gim)];
  if (m.length === 0) return null;
  return markdown.slice(m[m.length - 1].index! + m[m.length - 1][0].length);
}

/**
 * Split a references section into entries. Two shapes cover the bulk of real converts:
 * numbered markers ("[1] …", "1. …") and blank-line-separated hanging blocks. A section that
 * yields fewer than 2 entries is judged not-really-references and returns [].
 */
export function extractReferences(markdown: string): PaperReference[] {
  const section = referencesSection(markdown);
  if (!section) return [];
  const numbered = section.split(/\n\s*(?:\[\d+\]|\d{1,3}\.)\s+/).slice(1);
  const blocks = numbered.length >= 2
    ? numbered
    : section.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b.length > 20);
  return blocks.slice(0, MAX_REFS).map((raw): PaperReference => {
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
    const arxiv = text.match(ARXIV);
    if (arxiv) {
      const id = arxiv[1] + (arxiv[2] ?? '');
      return { text, url: `https://arxiv.org/abs/${id}`, pdfUrl: `https://arxiv.org/pdf/${id}` };
    }
    const doi = text.match(DOI);
    if (doi) return { text, url: `https://doi.org/${doi[1].replace(/[.,;]$/, '')}` };
    const url = text.match(URL_RE);
    if (url) return { text, url: url[0].replace(/[.,;]$/, '') };
    return { text };
  }).filter((r) => r.text.length > 10);
}
