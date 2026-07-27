// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Mermaid } from '../../src/client/components/Mermaid.js';

// The real library is megabytes of parser and needs a layout engine; what these tests pin is
// Mermaid.tsx's own state machine, so a mock that fails on half-written charts is enough.
const renderMock = vi.fn(async (_id: string, chart: string) => {
  if (String(chart ?? '').includes('INCOMPLETE')) throw new Error('Parse error');
  return { svg: `<svg data-chart-len="${String(chart ?? '').length}"></svg>` };
});
vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: (id: string, chart: string) => renderMock(id, chart) },
}));

beforeEach(() => renderMock.mockClear());

describe('Mermaid — streaming resilience', () => {
  it('a failure on a half-written chart does not latch: the completed chart renders', async () => {
    // Streaming delivers the fence incrementally; the component sees a partial chart first.
    const { rerender } = render(<Mermaid chart={'graph TD\n  A --> INCOMPLETE'} />);
    await waitFor(() => expect(screen.getByText(/diagram did not render/)).toBeTruthy());

    // The stream completes; the same component instance gets the full chart.
    rerender(<Mermaid chart={'graph TD\n  A --> B\n  B --> C'} />);
    await waitFor(() => expect(document.querySelector('.mermaid-diagram')).toBeTruthy());
    expect(screen.queryByText(/diagram did not render/)).toBeNull();
  });

  it('a genuinely broken final chart still degrades to labelled source', async () => {
    render(<Mermaid chart={'graph TD\n  INCOMPLETE'} />);
    await waitFor(() => expect(screen.getByText(/diagram did not render/)).toBeTruthy());
    expect(screen.getByText(/INCOMPLETE/)).toBeTruthy();
  });
});
