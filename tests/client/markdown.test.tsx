// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WikiLink } from '../../src/client/components/MarkdownText.js';
import { panelBus } from '../../src/client/lib/panelBus.js';

describe('WikiLink', () => {
  it('routes clicks to the panel bus instead of navigating', () => {
    const seen: any[] = [];
    const un = panelBus.subscribe((e) => seen.push(e));
    render(<WikiLink href="#/page/derivatives">derivatives</WikiLink>);
    fireEvent.click(screen.getByText('derivatives'));
    un();
    expect(seen).toEqual([{ type: 'openPage', slug: 'derivatives' }]);
  });
});
