import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeLinkList, deleteLinkDirectory, readLinkDirectories, saveLinkDirectory,
} from '../src/server/linkList.js';

// A miniature awesome-scalability: sections of bulleted external links with blurbs, a short intro,
// badges — the exact shape that used to compile into shallow table-of-contents pages.
function awesomeFixture(linksPerSection = 8, sections = ['Principles', 'Scalability', 'Availability']): string {
  const head = [
    '# Awesome Scalability',
    '',
    '![build](https://img.shields.io/badge/build-passing-green.svg)',
    '',
    'A curated list of readings on building large-scale systems.',
    '',
  ];
  const body = sections.flatMap((s, si) => [
    `## ${s}`,
    '',
    ...Array.from({ length: linksPerSection }, (_, i) =>
      `- [${s} reading ${i + 1}](https://example.com/${si}/${i}) - Why ${s.toLowerCase()} matters, part ${i + 1}`),
    '',
  ]);
  return [...head, ...body].join('\n');
}

// A normal project README: prose-dominant, code fences, a modest References section.
const NORMAL_README = `# widget-engine

Widget-engine renders widgets from a declarative spec.

## Install

\`\`\`bash
npm install widget-engine
\`\`\`

## Usage

Create a spec file and point the engine at it. The engine walks the spec,
resolves each widget's dependencies, and renders bottom-up. Rendering is
pure: the same spec always produces the same output tree.

Widgets can be nested arbitrarily. A parent widget receives its children
already rendered, which keeps custom widgets simple to write.

Configuration lives in \`widget.config.js\`. Every option has a default;
an empty config is valid. The scheduler batches re-renders per frame.

Error handling follows the render boundary model: a widget that throws is
replaced by its fallback, and the error is reported once per mount.

- Fast: renders 10k widgets in under a frame
- Small: 4kb gzipped
- Typed: full TypeScript definitions

## References

- [React reconciliation](https://react.dev/learn/reconciliation) - inspiration
- [Incremental DOM](https://google.github.io/incremental-dom/) - prior art
`;

describe('analyzeLinkList — detection', () => {
  it('recognizes the awesome-list shape', () => {
    const a = analyzeLinkList(awesomeFixture());
    expect(a.isLinkList).toBe(true);
    expect(a.total).toBe(24);
    expect(a.sections.map((s) => s.title)).toEqual(['Principles', 'Scalability', 'Availability']);
  });

  it('a normal prose README with a references section is NOT a link list', () => {
    const a = analyzeLinkList(NORMAL_README);
    expect(a.isLinkList).toBe(false);
    expect(a.sections).toEqual([]);
    expect(a.total).toBe(0);
  });

  it('under 15 external links is never a directory, however link-dense', () => {
    const a = analyzeLinkList(awesomeFixture(4, ['One', 'Two', 'Three'])); // 12 links, nothing else
    expect(a.isLinkList).toBe(false);
  });

  it('internal anchors and relative links do not count as resources', () => {
    // A table of contents made of #anchors — every awesome list HAS one, but a doc that is ONLY
    // a TOC of itself has nothing to explode.
    const toc = ['# Doc', '', ...Array.from({ length: 30 }, (_, i) => `- [Section ${i}](#section-${i})`)].join('\n');
    expect(analyzeLinkList(toc).isLinkList).toBe(false);
  });

  it('links inside code fences are masked out', () => {
    const fenced = [
      '# Examples', '',
      '```md',
      ...Array.from({ length: 30 }, (_, i) => `- [x](https://example.com/${i})`),
      '```',
    ].join('\n');
    expect(analyzeLinkList(fenced).isLinkList).toBe(false);
  });
});

describe('analyzeLinkList — extraction', () => {
  it('captures title, url, and the curator blurb as note', () => {
    const a = analyzeLinkList(awesomeFixture());
    const first = a.sections[0].links[0];
    expect(first).toEqual({
      title: 'Principles reading 1',
      url: 'https://example.com/0/0',
      note: 'Why principles matters, part 1',
    });
  });

  it('a bullet that is only a link gets no note field', () => {
    const md = ['# L', '', ...Array.from({ length: 20 }, (_, i) => `- [t${i}](https://e.com/${i})`)].join('\n');
    const a = analyzeLinkList(md);
    expect(a.isLinkList).toBe(true);
    expect(a.sections[0].links[0]).toEqual({ title: 't0', url: 'https://e.com/0' });
  });

  it('duplicate urls are catalogued once', () => {
    const md = ['# L', '', ...Array.from({ length: 20 }, () => '- [same](https://e.com/one) - again'),
      ...Array.from({ length: 16 }, (_, i) => `- [u${i}](https://e.com/u${i})`)].join('\n');
    const a = analyzeLinkList(md);
    expect(a.sections[0].links.filter((l) => l.url === 'https://e.com/one')).toHaveLength(1);
  });

  it('badge/image links are decoration, not resources', () => {
    const md = ['# L', '',
      ...Array.from({ length: 5 }, (_, i) => `- [b${i}](https://img.shields.io/badge/x-${i}.svg)`),
      ...Array.from({ length: 20 }, (_, i) => `- [r${i}](https://e.com/r${i})`)].join('\n');
    const a = analyzeLinkList(md);
    expect(a.isLinkList).toBe(true);
    expect(a.total).toBe(20); // the five badges are not among the catalogued resources
    expect(a.sections[0].links.every((l) => !l.url.includes('shields.io'))).toBe(true);
  });

  it('the cap is counted, never silent', () => {
    const md = ['# Big', '', ...Array.from({ length: 900 }, (_, i) => `- [t${i}](https://e.com/${i})`)].join('\n');
    const a = analyzeLinkList(md);
    expect(a.total).toBe(800);
    expect(a.omitted).toBe(100);
  });

  it('links before any heading land in a default section', () => {
    const md = Array.from({ length: 20 }, (_, i) => `- [t${i}](https://e.com/${i})`).join('\n');
    const a = analyzeLinkList(md);
    expect(a.sections[0].title).toBe('Links');
    expect(a.sections[0].links).toHaveLength(20);
  });
});

describe('link-directory storage', () => {
  it('save / read / delete round-trip', () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-linklist-'));
    const entry = {
      name: 'awesome-scalability', source: 'https://github.com/x/awesome-scalability',
      file: 'README.md', savedAt: '2026-07-29T00:00:00.000Z',
      sections: [{ title: 'Principles', links: [{ title: 't', url: 'https://e.com/1' }] }],
      total: 1, omitted: 0,
    };
    saveLinkDirectory(vault, entry);
    expect(readLinkDirectories(vault)).toEqual([entry]);
    expect(deleteLinkDirectory(vault, 'awesome-scalability')).toBe(true);
    expect(readLinkDirectories(vault)).toEqual([]);
  });

  it('delete refuses traversal-shaped names and missing files', () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-linklist-'));
    expect(deleteLinkDirectory(vault, '../evil')).toBe(false);
    expect(deleteLinkDirectory(vault, 'nope')).toBe(false);
  });

  it('an empty or missing dir reads as no directories', () => {
    expect(readLinkDirectories(mkdtempSync(join(tmpdir(), 'lwh-linklist-')))).toEqual([]);
  });
});
