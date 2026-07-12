import { describe, it, expect } from 'vitest';
import { panelBus, wikiPreprocess } from '../../src/client/lib/panelBus.js';

describe('panelBus', () => {
  it('notifies subscribers of page opens', () => {
    const seen: any[] = [];
    const un = panelBus.subscribe((e) => seen.push(e));
    panelBus.openPage('chain-rule');
    un();
    expect(seen).toEqual([{ type: 'openPage', slug: 'chain-rule' }]);
  });
});

describe('wikiPreprocess', () => {
  it('rewrites wiki links with and without labels', () => {
    expect(wikiPreprocess('see [[chain-rule]] and [[loss-functions|losses]]'))
      .toBe('see [chain-rule](#/page/chain-rule) and [losses](#/page/loss-functions)');
  });
});
