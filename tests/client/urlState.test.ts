import { describe, it, expect } from 'vitest';
import { parseHash, serializeHash, type UrlState } from '../../src/client/lib/urlState.js';

describe('parseHash', () => {
  it('defaults on an empty hash', () => {
    expect(parseHash('')).toEqual({ threadId: 'default', tab: 'stage', pageSlug: null, tabExplicit: false });
  });

  it('defaults on a bare "#"', () => {
    expect(parseHash('#')).toEqual({ threadId: 'default', tab: 'stage', pageSlug: null, tabExplicit: false });
  });

  it('defaults on unrelated junk', () => {
    expect(parseHash('#garbage')).toEqual({ threadId: 'default', tab: 'stage', pageSlug: null, tabExplicit: false });
  });

  it('defaults when the threadId segment is missing', () => {
    expect(parseHash('#/t/')).toEqual({ threadId: 'default', tab: 'stage', pageSlug: null, tabExplicit: false });
  });

  it('parses just a threadId', () => {
    expect(parseHash('#/t/t-abc123')).toEqual({ threadId: 't-abc123', tab: 'stage', pageSlug: null, tabExplicit: false });
  });

  it('parses threadId + tab', () => {
    expect(parseHash('#/t/t-abc123/graph')).toEqual({ threadId: 't-abc123', tab: 'graph', pageSlug: null, tabExplicit: true });
    expect(parseHash('#/t/t-abc123/library')).toEqual({ threadId: 't-abc123', tab: 'library', pageSlug: null, tabExplicit: true });
  });

  it('parses threadId + page + slug', () => {
    expect(parseHash('#/t/t-abc123/page/derivatives')).toEqual({
      threadId: 't-abc123', tab: 'page', pageSlug: 'derivatives', tabExplicit: true,
    });
  });

  it('tolerates a page segment with no slug (falls back to null slug)', () => {
    expect(parseHash('#/t/default/page')).toEqual({ threadId: 'default', tab: 'page', pageSlug: null, tabExplicit: true });
  });

  it('decodes a percent-encoded slug', () => {
    expect(parseHash('#/t/default/page/a%20b')).toEqual({ threadId: 'default', tab: 'page', pageSlug: 'a b', tabExplicit: true });
  });

  it('falls back to default threadId for an invalid threadId but keeps parsing the tab', () => {
    expect(parseHash('#/t/inva!id/graph')).toEqual({ threadId: 'default', tab: 'graph', pageSlug: null, tabExplicit: true });
  });

  it('accepts a 64-char threadId and rejects a 65-char one', () => {
    const ok = 'a'.repeat(64);
    const tooLong = 'a'.repeat(65);
    expect(parseHash(`#/t/${ok}`).threadId).toBe(ok);
    expect(parseHash(`#/t/${tooLong}`).threadId).toBe('default');
  });

  it('ignores an unrecognized tab segment, defaulting to stage', () => {
    expect(parseHash('#/t/default/bogus-tab')).toEqual({ threadId: 'default', tab: 'stage', pageSlug: null, tabExplicit: false });
  });

  it('never throws on malformed percent-encoding', () => {
    expect(parseHash('#/t/default/page/%')).toEqual({ threadId: 'default', tab: 'stage', pageSlug: null, tabExplicit: false });
  });

  // tabExplicit is the map-as-home signal (SidePanel): a hash that NAMED a tab must never be
  // re-homed, and a hash that merely fell back to the stage default may be.
  it('marks a hash that names the stage tab explicitly as explicit', () => {
    expect(parseHash('#/t/default/stage')).toEqual({ threadId: 'default', tab: 'stage', pageSlug: null, tabExplicit: true });
  });
});

describe('serializeHash', () => {
  it('serializes the stage tab as just the thread', () => {
    expect(serializeHash({ threadId: 'default', tab: 'stage', pageSlug: null })).toBe('#/t/default');
  });

  it('serializes a non-page, non-stage tab', () => {
    expect(serializeHash({ threadId: 't-abc', tab: 'graph', pageSlug: null })).toBe('#/t/t-abc/graph');
    expect(serializeHash({ threadId: 't-abc', tab: 'library', pageSlug: null })).toBe('#/t/t-abc/library');
  });

  it('serializes the page tab with a slug', () => {
    expect(serializeHash({ threadId: 't-abc', tab: 'page', pageSlug: 'derivatives' })).toBe(
      '#/t/t-abc/page/derivatives',
    );
  });

  it('encodes special characters in the slug', () => {
    expect(serializeHash({ threadId: 'default', tab: 'page', pageSlug: 'a b/c' })).toBe(
      '#/t/default/page/a%20b%2Fc',
    );
  });

  it('falls back to the bare thread when tab is page but no slug is set', () => {
    expect(serializeHash({ threadId: 'default', tab: 'page', pageSlug: null })).toBe('#/t/default');
  });

  it('falls back to a default threadId when given an invalid one', () => {
    expect(serializeHash({ threadId: 'inva!id', tab: 'stage', pageSlug: null })).toBe('#/t/default');
  });
});

describe('parseHash/serializeHash round-trip', () => {
  // The stage default serializes to a bare `#/t/<id>` (no tab segment), so it parses back as
  // NOT explicit; every other tab is named in the hash and parses back explicit.
  const cases: UrlState[] = [
    { threadId: 'default', tab: 'stage', pageSlug: null, tabExplicit: false },
    { threadId: 't-abc123', tab: 'graph', pageSlug: null, tabExplicit: true },
    { threadId: 't-abc123', tab: 'library', pageSlug: null, tabExplicit: true },
    { threadId: 't-abc123', tab: 'page', pageSlug: 'derivatives', tabExplicit: true },
    { threadId: 'default', tab: 'page', pageSlug: 'a b/c', tabExplicit: true },
  ];

  it.each(cases)('round-trips %j', (state) => {
    expect(parseHash(serializeHash(state))).toEqual(state);
  });
});
