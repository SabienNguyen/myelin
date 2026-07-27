// Frontier research: the tutor's "what's newest on X" answered from live indices, never memory.
import { describe, it, expect } from 'vitest';
import { findRecentPapers, searchArxiv, searchCrossref } from '../src/server/frontierResearch.js';

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
