// @vitest-environment jsdom
// A tool call the server REJECTS (zod refuses the model's input) still renders through the
// block's done-branch, with an output that is NOT the result contract — an error object.
// One unguarded property read there unmounted the whole React root: a malformed quiz blanked
// the entire app in audit 27. These tests pin that every block with a done-branch survives an
// error-shaped result and still renders SOMETHING (the app must outlive the model's mistake).
import { describe, it, expect, vi } from 'vitest';
// WritingDraftInner now offers a revise round via the thread runtime — same seam the panel
// tests mock (tests/client/libraryPanel.test.tsx).
vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return { ...actual, useThreadRuntime: () => ({ append: appendSpy }) };
});
const appendSpy = vi.fn();
import { render, screen } from '@testing-library/react';
import { MathScratchpad } from '../../src/client/components/blocks/MathScratchpad.js';
import { Quiz, QuizInner } from '../../src/client/components/blocks/Quiz.js';
import { StructuredCheck } from '../../src/client/components/blocks/StructuredCheck.js';
import { WritingDraftInner } from '../../src/client/components/blocks/WritingDraft.js';

// What the client actually receives for a rejected call: not {answers}, not {values}, not {draft}.
const errorResult = { error: 'Invalid input: expected string, received undefined' };

describe('blocks survive a server-rejected (non-contract) result', () => {
  it('Quiz renders its items instead of crashing on result.answers', () => {
    render(<Quiz
      args={{ title: 'Stream parsing check', items: [
        { id: 'q1', type: 'choice', prompt: 'Which survives across reads?', choices: ['a', 'b'], pageSlug: 's' },
      ] }}
      result={errorResult}
      addResult={vi.fn()}
    />);
    expect(screen.getByText('Stream parsing check')).toBeTruthy();
    expect(screen.getByText(/which survives across reads/i)).toBeTruthy();
  });

  it('Quiz short-answer inputs each carry a distinct accessible name', () => {
    // A screen-reader user must not meet a row of blank "edit text" fields — each answer input is
    // named by its position, since the visible prompt above it isn't programmatically tied to it.
    // QuizInner (not Quiz): the writing view of Quiz renders through StagePortal, which lands
    // outside the test container — QuizInner is the same body the portal hosts.
    render(<QuizInner
      args={{ title: 'T', items: [
        { id: 'q1', type: 'short', prompt: 'Define entropy', pageSlug: 's' },
        { id: 'q2', type: 'short', prompt: 'Define enthalpy', pageSlug: 's' },
      ] }}
      addResult={vi.fn()}
    />);
    expect(screen.getByRole('textbox', { name: /answer for question 1/i })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /answer for question 2/i })).toBeTruthy();
  });

  it('StructuredCheck renders the prompt and a blank answer on missing result.values', () => {
    render(<StructuredCheck
      args={{ prompt: 'How many?', pageSlug: 's', checker: { kind: 'numeric', expected: 3 } }}
      result={errorResult}
      addResult={vi.fn()}
    />);
    expect(screen.getByText(/how many/i)).toBeTruthy();
    expect(screen.getByText(/\(blank\)/)).toBeTruthy();
  });

  it('MathScratchpad renders the done card instead of crashing KaTeX on missing finalLatex', () => {
    const { container } = render(<MathScratchpad
      args={{ problemLatex: 'x^2', stepMode: false, expectedLatex: '2x', variable: 'x', pageSlug: 'p' }}
      result={errorResult}
      addResult={vi.fn()}
    />);
    expect(container.querySelector('.block.done')).toBeTruthy();
    // The problem statement still shows, so the card reads as a question even without an answer.
    expect(container.querySelector('.katex')).toBeTruthy();
  });

  it('WritingDraft renders the prompt on missing result.draft', () => {
    render(<WritingDraftInner
      args={{ prompt: 'Argue X', round: 1, pageSlug: 'thesis' }}
      result={errorResult}
      addResult={vi.fn()}
    />);
    expect(screen.getByText(/argue x/i)).toBeTruthy();
  });
});

describe('matching renders its labels and options as notation, not raw source', () => {
  // The block prompt goes through KaTeX and the learner's answer through the prettifier; the
  // matching left column and dropdown were the one spot left showing raw `x^2` — and worse, a
  // `$…$` label leaked its delimiters literally. Grading must stay byte-identical: the <option>'s
  // value stays the raw string even when its visible text is prettified.
  it('a `$…$` left label renders through KaTeX, not as literal dollar signs', () => {
    const { container } = render(<StructuredCheck
      args={{ prompt: 'Match them', pageSlug: 's', checker: {
        kind: 'matching',
        items: [{ left: '$\\sin x$', right: 'cos x' }],
        options: ['cos x', '-sin x'],
      } }}
      result={null}
      addResult={vi.fn()}
    />);
    const left = container.querySelector('.structured-left');
    expect(left?.querySelector('.katex')).toBeTruthy();
    expect(left?.textContent).not.toContain('$');
  });

  it('an ASCII-maths option shows prettified text but submits its raw value', () => {
    const { container } = render(<StructuredCheck
      args={{ prompt: 'Match them', pageSlug: 's', checker: {
        kind: 'matching',
        items: [{ left: 'f', right: 'x^2' }],
        options: ['x^2', '2x'],
      } }}
      result={null}
      addResult={vi.fn()}
    />);
    // The learner reads x²…
    const pretty = Array.from(container.querySelectorAll('option')).find((o) => o.textContent === 'x²');
    expect(pretty).toBeTruthy();
    // …but the value the grader receives is the raw string it graded against.
    expect((pretty as HTMLOptionElement).value).toBe('x^2');
    // The left label is also prettified (no raw `x^2` caret anywhere in the card).
    expect(container.querySelector('.structured-matching')?.textContent).not.toContain('x^2');
  });
});

describe('toolkit rejects a fabricated submission for an errored call', () => {
  // The layer above the survival tests: when assistant-ui marks the part isError, the toolkit
  // must not hand the error to the block at all — audit 41 caught a rejected quick_check
  // rendering as a done card claiming the learner answered "(blank)".
  it('renders a failed note instead of the block when isError is set', async () => {
    const { toolkit } = await import('../../src/client/toolkit.js');
    const { container } = render(<>{(toolkit as any).quick_check.render({
      args: { question: 'q?' }, result: 'Invalid input', isError: true, addResult: vi.fn(),
    })}</>);
    expect(container.querySelector('.tool-note.failed')?.textContent).toMatch(/quick check could not be shown/);
    expect(container.querySelector('.block')).toBeNull();
  });
});

describe('errored block copy tells the right story', () => {
  it('a schema rejection blames the malformed call; a cancellation blames nobody', async () => {
    const { toolkit } = await import('../../src/client/toolkit.js');
    const render1 = (toolkit as any).quick_check.render({
      args: {}, result: 'Invalid input: expected string, received undefined', addResult: vi.fn(), isError: true,
    });
    expect(render1.props.children).toContain('could not be shown');
    const render2 = (toolkit as any).quick_check.render({
      args: {}, result: 'tool call was aborted', addResult: vi.fn(), isError: true,
    });
    expect(render2.props.children).toContain('skipped; the conversation moved on');
  });
});
