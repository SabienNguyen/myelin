// Citation chasing: a paper's own references, conservatively parsed, ids made resolvable.
import { describe, it, expect } from 'vitest';
import { extractReferences, referencesSection } from '../src/server/references.js';

const PAPER = `# Attention Is All You Need

We refer the reader to the references below.

## 3 Results

Numbers.

## References

[1] J. Ba, J. Kiros, G. Hinton. Layer normalization. arXiv:1607.06450, 2016.

[2] D. Bahdanau et al. Neural machine translation by jointly learning to align and translate.
https://example.org/bahdanau2015

[3] A. Author. Some offline book chapter with no identifier at all, Springer, 1998.

[4] B. Writer. A DOI-bearing article. Journal of Things, doi:10.1000/xyz123.
`;

describe('referencesSection', () => {
  it('finds the LAST references heading, not a prose mention', () => {
    const s = referencesSection(PAPER);
    expect(s).toContain('Layer normalization');
    expect(s).not.toContain('Numbers');
  });
  it('a paper without one returns null', () => {
    expect(referencesSection('# Title\n\nBody only.')).toBeNull();
  });
});

describe('extractReferences', () => {
  it('extracts numbered entries with resolvable ids where present', () => {
    const refs = extractReferences(PAPER);
    expect(refs).toHaveLength(4);
    expect(refs[0].url).toBe('https://arxiv.org/abs/1607.06450');
    expect(refs[0].pdfUrl).toBe('https://arxiv.org/pdf/1607.06450');
    expect(refs[1].url).toBe('https://example.org/bahdanau2015');
    expect(refs[2].url).toBeUndefined();      // listed, not actionable — honest
    expect(refs[3].url).toBe('https://doi.org/10.1000/xyz123');
  });
  it('yields nothing for a section that is not really references', () => {
    expect(extractReferences('## References\n\nSee above.')).toEqual([]);
  });

  it('does not swallow a closing bracket into a DOI URL (parenthetical / bracketed ids)', () => {
    // A DOI written in parens or brackets used to keep the closing character, producing a dead
    // doi.org link — the "follow this citation" offer pointing at a URL that never resolves.
    const md = [
      '## References',
      '',
      '[1] Smith, A. A paper. Journal. (10.1234/abcd.2020)',
      '[2] Jones, B. Another. See [10.5555/xyzzy] for details.',
    ].join('\n');
    const refs = extractReferences(md);
    expect(refs[0].url).toBe('https://doi.org/10.1234/abcd.2020');
    expect(refs[1].url).toBe('https://doi.org/10.5555/xyzzy');
  });
});
