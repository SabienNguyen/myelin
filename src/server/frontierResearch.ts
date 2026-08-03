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
  /** Crossref's is-referenced-by-count for this DOI. Absent for arXiv, and absent rather than 0
   *  when Crossref reported nothing — a caller showing this to a learner (curate.ts) must be able
   *  to say "no count reported" instead of claiming an uncited paper. */
  citations?: number;
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

export async function searchCrossref(
  topic: string, fetchImpl: typeof fetch = fetch, sort: 'created' | 'is-referenced-by-count' = 'created',
): Promise<FrontierPaper[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(topic)}`
    + `&sort=${sort}&order=desc&rows=${MAX_PER_SOURCE}`
    + '&select=title,author,created,URL,DOI,container-title,is-referenced-by-count';
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
    ...(typeof it['is-referenced-by-count'] === 'number'
      ? { citations: it['is-referenced-by-count'] }
      : {}),
  })).filter((p) => p.title && p.date && p.url);
}

/**
 * Both indices, merged newest-first, deduplicated by near-identical title (a preprint and its
 * published version are the same paper to a learner — the arXiv copy wins because it has a PDF).
 */
/** Does this paper actually concern the topic asked about?
 *
 *  arXiv's `all:"phrase"` does not match strictly, and results are sorted by submission date — so
 *  the NEWEST loosely-matching paper wins over the most relevant one. Asked for recent work on
 *  mixture-of-experts ROUTING, the top hit was "The location-routing problem for UAV monitoring":
 *  a real, recent paper about a different sense of one shared word.
 *
 *  Filtering on the topic's distinctive words costs nothing and is provider-agnostic, so it fixes
 *  Crossref's looseness too. Deliberately lenient — a paper needs MOST of the distinctive words,
 *  not all, because titles legitimately abbreviate ("MoE routing") and the abstract may carry the
 *  rest. Short words are ignored: they are the ones that collide across fields.
 */
export function concernsTopic(paper: Pick<FrontierPaper, 'title' | 'summary'>, topic: string): boolean {
  const words = [...new Set(topic.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))];
  // Fewer than two distinctive words cannot distinguish a sense — "kv cache" reduces to "cache",
  // and demanding that literal word would drop papers about the same thing that phrase it
  // differently. The failure this guards against needs several words to detect: the UAV paper
  // matched one of "mixture", "experts", "routing". With less to go on, trust the index.
  if (words.length < 2) return true;
  const hay = `${paper.title} ${paper.summary ?? ''}`.toLowerCase();
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits * 2 >= words.length; // at least half the distinctive words
}

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

  // Drop papers that merely share a word with the topic. If that leaves nothing, keep what the
  // indices returned rather than reporting an empty frontier — a loose answer beats none, and the
  // tutor presents these with their dates for the learner to judge.
  const onTopic = all.filter((p) => concernsTopic(p, topic));
  const kept = onTopic.length > 0 ? onTopic : all;

  const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = new Map<string, FrontierPaper>();
  for (const p of kept) {
    const k = titleKey(p.title);
    const prior = seen.get(k);
    if (!prior || (prior.source === 'Crossref' && p.source === 'arXiv')) seen.set(k, p);
  }
  const papers = [...seen.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_TOTAL);
  return { papers, sourceErrors };
}

/**
 * The CANONICAL artifacts of a field — Crossref sorted by citation count instead of date.
 *
 * The distinction this serves (3blue1brown's framing, and this app's own): a model's best role in
 * learning is LIBRARIAN, not author — route the learner to the load-bearing human artifacts and
 * the people behind them, then let the artifacts teach. Newest-first answers "what is happening";
 * most-cited answers "who should I read first". Both end in ingest_url, never in generated prose.
 */
export async function findCanonicalPapers(
  topic: string, fetchImpl: typeof fetch = fetch,
): Promise<{ papers: FrontierPaper[]; sourceErrors: string[] }> {
  try {
    const papers = (await searchCrossref(topic, fetchImpl, 'is-referenced-by-count')).slice(0, MAX_TOTAL);
    return { papers, sourceErrors: [] };
  } catch (e: any) {
    throw new Error(`no index reachable — Crossref: ${e?.message ?? e}`);
  }
}
