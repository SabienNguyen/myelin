// @vitest-environment jsdom
// The block-rendering safety net, pinned against the live incident that created it: the tutor
// called math_scratchpad with {pageSlug, prompt} (no problemLatex), the SDK rejected it, the
// bridge forwarded it anyway, and KaTeX's throw unmounted the entire React root — a blank window
// mid-lesson. Two layers now stand between a bad call and a blank app: schema validation at
// render (the same zod schemas the server uses), and an error boundary for whatever class of
// crash is invented next.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { toolkit } from '../../src/client/toolkit.js';

afterEach(cleanup);

const renderTool = (name: string, props: any) => {
  const entry = (toolkit as any)[name];
  const Render = entry.render;
  return render(<Render addResult={vi.fn()} {...props} />);
};

describe('toolkit block guards', () => {
  it('the live incident: math_scratchpad without problemLatex renders a note, not a crash', () => {
    renderTool('math_scratchpad', {
      args: {
        pageSlug: 'the-essence-of-calculus',
        prompt: 'Using the ordinary triangle-area formula, what is the area?',
      },
      result: undefined,
    });
    expect(screen.getByText(/math scratchpad could not be shown — the tutor sent it malformed/i)).not.toBeNull();
  });

  it('a well-formed math_scratchpad still renders the block, with schema defaults applied', () => {
    renderTool('math_scratchpad', {
      args: {
        problemLatex: 'x^2', expectedLatex: '2x', stepMode: false, pageSlug: 'derivatives',
        // `variable` omitted — the schema defaults it; the component must see canonical args.
      },
      result: undefined,
    });
    expect(screen.queryByText(/could not be shown/i)).toBeNull();
  });

  it('quick_check with a non-array choices field renders the malformed note', () => {
    renderTool('quick_check', {
      args: { prompt: 'pick one', choices: 'a, b, c', pageSlug: 'p' },
      result: undefined,
    });
    expect(screen.getByText(/quick check could not be shown — the tutor sent it malformed/i)).not.toBeNull();
  });

  it('a component that throws at render costs one card, never the tree (boundary)', () => {
    // Malformed enough to pass no schema — so go through the boundary directly: a valid quiz
    // whose result payload violates the component's assumptions used to be the crash vector.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderTool('writing_draft', {
      args: { prompt: 'write', rubric: ['a'], round: 1, pageSlug: 'p' },
      // grading.annotations with a non-contract shape exercises deep component paths; whatever
      // throws must land in the boundary, not the root.
      result: { draft: null, grading: { annotations: { annotations: [{ span: null }] } } },
    });
    // Either the component tolerated it (fine) or the boundary caught it (fine) — what must be
    // true is that SOMETHING rendered and no exception escaped to the test.
    expect(document.body.innerHTML.length).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
