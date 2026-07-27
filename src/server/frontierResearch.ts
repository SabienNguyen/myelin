// Frontier research: "what is the newest work on X?" answered from the actual literature.
//
// A tutor asked about the frontier has exactly one honest move: look. Its training data has a
// cutoff and the learner is asking about AFTER it, so this module queries the two big keyless
// indices — arXiv (preprints: CS, ML, math, physics) and Crossref (published work, every field)
// — sorted by recency, and returns dated results the tutor presents as "found today", never as
// remembered knowledge. Ingesting a found paper rides the existing ingest_url tool; this module
// only finds.
//
// Both requests are best-effort and independent: one index down must not blank the other's
// results, and both down returns an error the tutor can say out loud.

export interface FrontierPaper {
  title: string;
  authors: string[];
  /** ISO date (published/created). */
  date: string;
  source: 'arXiv' | 'Crossref';
  /** Landing/abstract URL. */
  url: string;
  /** PDF URL when the index provides one (arXiv always does) — what ingest_url wants. */
  pdfUrl?: string;
  summary?: string;
}

const MAX_PER_SOURCE = 8;
const MAX_TOTAL = 10;

/** Pull one XML tag's text content out of an entry block. arXiv's Atom feed is stable and flat
 *  enough for this; a full XML parser would be a dependency for two tags. */
function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

export async function searchArxiv(topic: string, fetchImpl: typeof fetch = fetch): Promise<FrontierPaper[]> {
  const q = encodeURIComponent(`all:"${topic}"`);
  const url = `https://export.arxiv.org/api/query?search_query=${q}&start=0&max_results=${MAX_PER_SOURCE}`
    + '&sortBy=submittedDate&sortOrder=descending';
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`arXiv responded ${res.status}`);
  const xml = await res.text();
  const entries = xml.split('<entry>').slice(1);
  return entries.map((block): FrontierPaper => {
    const id = tagText(block, 'id'); // e.g. http://arxiv.org/abs/2501.01234v1
    const absUrl = id.replace('http://', 'https://');
    return {
      title: tagText(block, 'title'),
      authors: [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim()),
      date: tagText(block, 'published').slice(0, 10),
      source: 'arXiv',
      url: absUrl,
      pdfUrl: absUrl.replace('/abs/', '/pdf/'),
      summary: tagText(block, 'summary').slice(0, 400),
    };
  }).filter((p) => p.title && p.date);
}

export async function searchCrossref(topic: string, fetchImpl: typeof fetch = fetch): Promise<FrontierPaper[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(topic)}`
    + `&sort=created&order=desc&rows=${MAX_PER_SOURCE}`
    + '&select=title,author,created,URL,DOI,container-title';
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Crossref responded ${res.status}`);
  const body = await res.json() as any;
  const items: any[] = body?.message?.items ?? [];
  return items.map((it): FrontierPaper => ({
    title: (it.title?.[0] ?? '').replace(/\s+/g, ' ').trim(),
    authors: (it.author ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(' ')),
    date: it.created?.['date-time']?.slice(0, 10) ?? '',
    source: 'Crossref',
    url: it.URL ?? (it.DOI ? `https://doi.org/${it.DOI}` : ''),
  })).filter((p) => p.title && p.date && p.url);
}

/**
 * Both indices, merged newest-first, deduplicated by near-identical title (a preprint and its
 * published version are the same paper to a learner — the arXiv copy wins because it has a PDF).
 */
export async function findRecentPapers(
  topic: string, fetchImpl: typeof fetch = fetch,
): Promise<{ papers: FrontierPaper[]; sourceErrors: string[] }> {
  const [arxiv, crossref] = await Promise.allSettled([
    searchArxiv(topic, fetchImpl), searchCrossref(topic, fetchImpl),
  ]);
  const sourceErrors: string[] = [];
  const all: FrontierPaper[] = [];
  if (arxiv.status === 'fulfilled') all.push(...arxiv.value);
  else sourceErrors.push(`arXiv: ${(arxiv.reason as Error)?.message ?? arxiv.reason}`);
  if (crossref.status === 'fulfilled') all.push(...crossref.value);
  else sourceErrors.push(`Crossref: ${(crossref.reason as Error)?.message ?? crossref.reason}`);
  if (all.length === 0 && sourceErrors.length === 2) {
    throw new Error(`no index reachable — ${sourceErrors.join('; ')}`);
  }

  const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = new Map<string, FrontierPaper>();
  for (const p of all) {
    const k = titleKey(p.title);
    const prior = seen.get(k);
    if (!prior || (prior.source === 'Crossref' && p.source === 'arXiv')) seen.set(k, p);
  }
  const papers = [...seen.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_TOTAL);
  return { papers, sourceErrors };
}
