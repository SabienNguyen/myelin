// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownLink } from '../../src/client/components/MarkdownText.js';
import { panelBus } from '../../src/client/lib/panelBus.js';

describe('MarkdownLink', () => {
  it('routes clicks to the panel bus instead of navigating', () => {
    const seen: any[] = [];
    const un = panelBus.subscribe((e) => seen.push(e));
    render(<MarkdownLink href="#/page/derivatives">derivatives</MarkdownLink>);
    fireEvent.click(screen.getByText('derivatives'));
    un();
    expect(seen).toEqual([{ type: 'openPage', slug: 'derivatives' }]);
  });
});
