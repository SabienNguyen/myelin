// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AsidePart } from '../../src/client/components/AsidePart.js';
import { panelBus } from '../../src/client/lib/panelBus.js';
import type { AsideData } from '../../src/shared/aside.js';

afterEach(cleanup);

function makeAside(over: Partial<AsideData> = {}): AsideData {
  return {
    asideId: 'a1',
    question: 'what is a derivative',
    answer: 'A derivative is the instantaneous rate of change of a function.',
    sources: [],
    vaultPages: [],
    fromMemory: false,
    createdAt: '2026-09-22T00:00:00.000Z',
    ...over,
  };
}

describe('AsidePart', () => {
  it('renders the summary from the quote, the markdown answer, sources and vault page links', () => {
    render(<AsidePart data={makeAside({
      quote: 'instantaneous rate of change',
      sources: [{ url: 'https://example.com/calc', title: 'Calculus primer' }],
      vaultPages: ['derivatives'],
    })} />);
    expect(screen.getByText('aside · instantaneous rate of change')).not.toBeNull();
    expect(screen.getByText(/instantaneous rate of change of a function/)).not.toBeNull();
    const link = screen.getByRole('link', { name: 'Calculus primer' });
    expect(link.getAttribute('href')).toBe('https://example.com/calc');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('button', { name: 'derivatives' })).not.toBeNull();
  });

  it('falls back to the first words of the question when there is no quote', () => {
    render(<AsidePart data={makeAside({ question: 'why does the chain rule work the way it does' })} />);
    expect(screen.getByText('aside · why does the chain rule work…')).not.toBeNull();
  });

  it('a vault page link opens the page through panelBus, not a navigation', () => {
    const spy = vi.spyOn(panelBus, 'openPage');
    render(<AsidePart data={makeAside({ vaultPages: ['derivatives'] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'derivatives' }));
    expect(spy).toHaveBeenCalledWith('derivatives');
    spy.mockRestore();
  });

  it('shows the from-memory line only when fromMemory is true', () => {
    render(<AsidePart data={makeAside({ fromMemory: true })} />);
    expect(screen.getByText('from memory — not checked')).not.toBeNull();
  });

  it('renders nothing for malformed data rather than throwing', () => {
    const { container } = render(<AsidePart data={null} />);
    expect(container.textContent).toBe('');
  });
});
