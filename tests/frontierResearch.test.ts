// Frontier research: the tutor's "what's newest on X" answered from live indices, never memory.
import { describe, it, expect } from 'vitest';
import { findCanonicalPapers, findRecentPapers, searchArxiv, searchCrossref, concernsTopic } from '../src/server/frontierResearch.js';

const ARXIV_XML = `<?xml version="1.0"?><feed>
<entry>
  <id>http://arxiv.org/abs/2507.11111v1</id>
  <title>Paged Attention Revisited:
    Faster KV Cache</title>
  <published>2026-07-20T17:00:00Z</published>
  <summary>We revisit paged attention and make the KV cache faster.</summary>
  <author><name>A. Researcher</name></author><author><name>B. Coauthor</name></author>
</entry>
<entry>
  <id>http://arxiv.org/abs/2507.00002v2</id>
  <title>Speculative Decoding Survey</title>
  <published>2026-07-01T09:00:00Z</published>
  <summary>A survey.</summary>
  <author><name>C. Writer</name></author>
</entry>
</feed>`;

const CROSSREF_JSON = {
  message: {
    items: [
      {
        title: ['Paged attention revisited: faster KV cache'],
        author: [{ given: 'A', family: 'Researcher' }],
        created: { 'date-time': '2026-07-22T00:00:00Z' },
        URL: 'https://doi.org/10.1000/paged',
        DOI: '10.1000/paged',
        'is-referenced-by-count': 4182,
      },
      {
        title: ['Quantization in the Wild'],
        author: [{ given: 'D', family: 'Quant' }],
        created: { 'date-time': '2026-06-15T00:00:00Z' },
        URL: 'https://doi.org/10.1000/quant',
        DOI: '10.1000/quant',
      },
    ],
  },
};

// The live failure this guards against: asked for canonical sources on inference-serving systems,
// findCanonicalPapers used to sort Crossref by citation count with no topic filter, so the
// MOST-CITED paper sharing even one word won. It returned DADA2 (amplicon-sequencing software —
// "inference" as in statistics) and, on a reworded retry, ImageNet ("large-scale" image database)
// — both landmark papers, neither in a field the learner asked about.
const REAL_TOPIC = 'inference infrastructure engineering: serving large language models, systems, GPU inference';

const DADA2_ITEM = {
  title: ['DADA2: High-resolution sample inference from Illumina amplicon data'],
  author: [{ given: 'B', family: 'Callahan' }],
  created: { 'date-time': '2016-05-23T00:00:00Z' },
  URL: 'https://doi.org/10.1000/dada2',
  DOI: '10.1000/dada2',
  'is-referenced-by-count': 12000,
};

const IMAGENET_ITEM = {
  title: ['ImageNet: A large-scale hierarchical image database'],
  author: [{ given: 'J', family: 'Deng' }],
  created: { 'date-time': '2009-06-20T00:00:00Z' },
  URL: 'https://doi.org/10.1000/imagenet',
  DOI: '10.1000/imagenet',
  'is-referenced-by-count': 45000,
};

const ON_TOPIC_HIGH_ITEM = {
  title: ['GPU Inference Systems: An Engineering Survey of Serving Large Language Models'],
  author: [{ given: 'A', family: 'Systems' }],
  created: { 'date-time': '2024-01-10T00:00:00Z' },
  URL: 'https://doi.org/10.1000/survey',
  DOI: '10.1000/survey',
  'is-referenced-by-count': 1500,
};

const ON_TOPIC_LOW_ITEM = {
  title: ['Efficient Memory Management for Serving Large Language Models: A Systems Approach'],
  author: [{ given: 'W', family: 'Kwon' }],
  created: { 'date-time': '2023-09-12T00:00:00Z' },
  URL: 'https://doi.org/10.1000/paged2',
  DOI: '10.1000/paged2',
  'is-referenced-by-count': 300,
};

const ON_TOPIC_NO_COUNT_ITEM = {
  title: ['A Systems Survey of GPU Inference Infrastructure for Serving Language Models'],
  author: [{ given: 'C', family: 'NoCount' }],
  created: { 'date-time': '2024-03-01T00:00:00Z' },
  URL: 'https://doi.org/10.1000/nocount',
  DOI: '10.1000/nocount',
  // No is-referenced-by-count key: Crossref reported nothing for this one.
};

const fakeFetch = (arxivOk = true, crossrefOk = true): typeof fetch => (async (url: any) => {
  const u = String(url);
  if (u.includes('export.arxiv.org')) {
    return arxivOk
      ? new Response(ARXIV_XML, { status: 200 })
      : new Response('down', { status: 503 });
  }
  return crossrefOk
    ? new Response(JSON.stringify(CROSSREF_JSON), { status: 200 })
    : new Response('down', { status: 503 });
}) as typeof fetch;

describe('searchArxiv', () => {
  it('parses entries with collapsed titles, authors, dates, and pdf links', async () => {
    const got = await searchArxiv('kv cache', fakeFetch());
    expect(got).toHaveLength(2);
    expect(got[0].title).toBe('Paged Attention Revisited: Faster KV Cache');
    expect(got[0].authors).toEqual(['A. Researcher', 'B. Coauthor']);
    expect(got[0].date).toBe('2026-07-20');
    expect(got[0].pdfUrl).toBe('https://arxiv.org/pdf/2507.11111v1');
  });
});

describe('searchCrossref', () => {
  it('maps items and drops entries without a date or url', async () => {
    const got = await searchCrossref('kv cache', fakeFetch());
    expect(got).toHaveLength(2);
    expect(got[0].url).toBe('https://doi.org/10.1000/paged');
  });

  it("defaults rows to the per-source cap when called the way findRecentPapers calls it", async () => {
    const urls: string[] = [];
    const spy: typeof fetch = (async (u: any) => {
      urls.push(String(u));
      return new Response(JSON.stringify(CROSSREF_JSON), { status: 200 });
    }) as typeof fetch;
    await searchCrossref('kv cache', spy, 'created');
    expect(urls[0]).toContain('rows=8');
    expect(urls[0]).not.toContain('sort=score');
  });
});

describe('findRecentPapers', () => {
  it('merges newest-first and dedups the preprint/published pair, arXiv copy winning', async () => {
    const { papers, sourceErrors } = await findRecentPapers('kv cache', fakeFetch());
    expect(sourceErrors).toEqual([]);
    // 4 raw results, one dedup (paged attention) -> 3.
    expect(papers).toHaveLength(3);
    const paged = papers.find((p) => /paged attention/i.test(p.title))!;
    expect(paged.source).toBe('arXiv'); // the copy with a PDF wins
    expect(papers.map((p) => p.date)).toEqual([...papers.map((p) => p.date)].sort().reverse());
  });

  it('one index down still returns the other, with the miss named', async () => {
    const { papers, sourceErrors } = await findRecentPapers('kv cache', fakeFetch(false, true));
    expect(papers.length).toBeGreaterThan(0);
    expect(sourceErrors).toHaveLength(1);
    expect(sourceErrors[0]).toContain('arXiv');
  });

  it('both indices down throws an error the tutor can say out loud', async () => {
    await expect(findRecentPapers('kv cache', fakeFetch(false, false)))
      .rejects.toThrow(/no index reachable/);
  });
});

describe('findCanonicalPapers', () => {
  it('asks Crossref for a relevance-sorted pool wide enough to filter, not a citation-sorted one', async () => {
    const urls: string[] = [];
    const spy: typeof fetch = (async (u: any) => {
      urls.push(String(u));
      return new Response(JSON.stringify(CROSSREF_JSON), { status: 200 });
    }) as typeof fetch;
    const { papers } = await findCanonicalPapers('kv cache', spy);
    expect(urls[0]).toContain('sort=score');
    expect(urls[0]).toContain('rows=40');
    expect(papers.length).toBeGreaterThan(0);
  });

  it('carries the citation count through, and leaves it ABSENT when Crossref reported none', async () => {
    // curate.ts shows this number to the learner as a checkable reason to read a paper, so a
    // missing count has to stay missing — a defaulted 0 would read as "never cited".
    const spy: typeof fetch = (async () => new Response(JSON.stringify(CROSSREF_JSON), { status: 200 })) as typeof fetch;
    const { papers } = await findCanonicalPapers('kv cache', spy);
    expect(papers[0].citations).toBe(4182);
    expect(papers[1].citations).toBeUndefined();
  });

  it('drops the most-cited results when they only share a word with the topic (DADA2, ImageNet)', async () => {
    const body = { message: { items: [DADA2_ITEM, IMAGENET_ITEM, ON_TOPIC_LOW_ITEM, ON_TOPIC_HIGH_ITEM] } };
    const spy: typeof fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    const { papers } = await findCanonicalPapers(REAL_TOPIC, spy);
    const titles = papers.map((p) => p.title);
    expect(titles.some((t) => /DADA2/.test(t))).toBe(false);
    expect(titles.some((t) => /ImageNet/.test(t))).toBe(false);
    expect(titles).toHaveLength(2);
  });

  it('orders on-topic survivors by citation count, descending, no-count papers last', async () => {
    // Deliberately shuffled and interleaved with the junk items — the pool arrives relevance
    // sorted, not citation sorted, so this order has to come from findCanonicalPapers itself.
    const body = {
      message: { items: [ON_TOPIC_NO_COUNT_ITEM, DADA2_ITEM, ON_TOPIC_LOW_ITEM, IMAGENET_ITEM, ON_TOPIC_HIGH_ITEM] },
    };
    const spy: typeof fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    const { papers } = await findCanonicalPapers(REAL_TOPIC, spy);
    expect(papers.map((p) => p.citations)).toEqual([1500, 300, undefined]);
  });

  it('returns no papers plus a note when nothing survives the topic filter — never a junk fallback', async () => {
    const body = { message: { items: [DADA2_ITEM, IMAGENET_ITEM] } };
    const spy: typeof fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    const { papers, sourceErrors, note } = await findCanonicalPapers(REAL_TOPIC, spy);
    expect(papers).toEqual([]);
    expect(sourceErrors).toEqual([]);
    expect(note).toMatch(/no on-topic canonical papers/i);
  });
});

/**
 * arXiv's `all:"phrase"` does not match strictly and results are sorted by submission date, so the
 * NEWEST loosely-matching paper wins over the most relevant one. Asked for recent work on
 * mixture-of-experts ROUTING, the top hit was "The location-routing problem for UAV monitoring
 * under time-varying noise constraints" — a real, recent paper about a different sense of one word.
 */
describe('findRecentPapers timeout', () => {
  it('settles instead of hanging forever when a source never responds', async () => {
    // A real fetch would honor the AbortSignal passed in `init` and reject; this fake mimics
    // that so the test proves the signal is actually wired up, not just that fetch was called.
    const neverRespondingFetch: typeof fetch = (async (_url: any, init?: any) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
    })) as typeof fetch;

    // Both sources fail, so findRecentPapers rejects rather than hanging — the point of this
    // test is that it settles at all within the tiny timeout, not what it settles to.
    await expect(findRecentPapers('kv cache', neverRespondingFetch, 5)).rejects.toThrow(/timed out/i);
  });
});

describe('frontier results are filtered to the topic', () => {
  const T = 'mixture-of-experts routing';

  it('rejects a paper sharing only one word', () => {
    expect(concernsTopic({
      title: 'The location-routing problem for UAV monitoring under time-varying noise constraints',
      summary: 'We study vehicle routing for unmanned aerial monitoring under noise limits.',
    }, T)).toBe(false);
  });

  it('keeps a paper that is genuinely about it', () => {
    expect(concernsTopic({
      title: 'Expert Choice Routing for Sparse Mixture-of-Experts Transformers',
      summary: 'We revisit routing in mixture-of-experts layers.',
    }, T)).toBe(true);
  });

  it('keeps one that abbreviates in the title but elaborates in the abstract', () => {
    expect(concernsTopic({
      title: 'MoE routing at scale',
      summary: 'Routing tokens to experts in a mixture-of-experts model.',
    }, T)).toBe(true);
  });

  it('never filters on short words alone', () => {
    // "the of a" has nothing distinctive; everything passes rather than nothing.
    expect(concernsTopic({ title: 'Anything at all', summary: '' }, 'the of a')).toBe(true);
  });

  it('does not filter a one-word topic, which cannot distinguish a sense', () => {
    // "kv cache" reduces to the single distinctive word "cache"; demanding it literally would drop
    // papers about the same thing phrased differently.
    expect(concernsTopic({ title: 'Paged Attention Revisited', summary: '' }, 'kv cache')).toBe(true);
    expect(concernsTopic({ title: 'Anything', summary: '' }, 'transformers')).toBe(true);
  });
});
