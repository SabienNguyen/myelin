// @vitest-environment jsdom
// The graded done-view of a label_diagram: a missed region names the anatomy it should have been,
// not just an ✗. An ✗ alone marks the learner wrong without teaching the correct label — the same
// honesty the pattern checker gives by echoing its expected value. Correct regions reveal nothing.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LabelDiagram } from '../../src/client/components/blocks/LabelDiagram.js';

const args = {
  prompt: 'Label the chambers.', pageSlug: 'heart',
  svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
  regions: [
    { id: 'lv', x: 35, y: 55, label: 'left ventricle' },
    { id: 'rv', x: 65, y: 55, label: 'right ventricle' },
  ],
  distractors: ['aorta', 'left atrium'],
};

describe('label_diagram done-view reveals the correct label on a miss', () => {
  it('a swapped pair shows what each region should have been', () => {
    render(<LabelDiagram
      args={args}
      result={{
        placements: [
          { regionId: 'lv', label: 'right ventricle' },
          { regionId: 'rv', label: 'left ventricle' },
        ],
        grading: { verdict: 'incorrect', detail: '0/2 regions labelled correctly',
          perItem: [{ id: 'lv', correct: false }, { id: 'rv', correct: false }] },
      }}
      addResult={vi.fn()}
    />);
    // Each miss names the region's true label.
    expect(screen.getByText(/should be .*left ventricle/)).toBeTruthy();
    expect(screen.getByText(/should be .*right ventricle/)).toBeTruthy();
    // The ✗ glyphs carry words a screen reader can say, and the verdict is a live region.
    expect(screen.getAllByRole('img', { name: 'incorrect' })).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toContain('0/2');
  });

  it('a fully-correct diagram reveals nothing (no answer given away)', () => {
    const { container } = render(<LabelDiagram
      args={args}
      result={{
        placements: [
          { regionId: 'lv', label: 'left ventricle' },
          { regionId: 'rv', label: 'right ventricle' },
        ],
        grading: { verdict: 'correct', detail: '2/2 regions labelled correctly',
          perItem: [{ id: 'lv', correct: true }, { id: 'rv', correct: true }] },
      }}
      addResult={vi.fn()}
    />);
    expect(container.querySelector('.label-correct')).toBeNull();
  });
});
