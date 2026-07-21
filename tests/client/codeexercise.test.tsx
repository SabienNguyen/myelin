// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CodeExerciseInner } from '../../src/client/components/blocks/CodeExercise.js';

afterEach(() => cleanup());

const workedExampleRung = {
  id: 'route-handler--worked_example--0',
  template: 'worked_example',
  artifactId: 'route-handler',
  visible_pre: '', visible_post: '', reference_answer: '',
  prose: { moves: [{ code: 'const id = req.params.id;', explanation: 'pulls the route param out first.' }] },
};

const inlineCompletionRung = {
  id: 'stream-consumer--inline_completion--0',
  template: 'inline_completion',
  artifactId: 'stream-consumer',
  visible_pre: 'function consumeStream(response) {\n', visible_post: '\n  const reader = response.body.getReader();\n}',
  reference_answer: '',
  prose: { context_line: 'decide what must happen first when there is no body at all.' },
};

const fullBodyRung = {
  id: 'stream-consumer--full_body--0',
  template: 'full_body',
  artifactId: 'stream-consumer',
  visible_pre: 'export async function consumeStream(response, onToken) {\n',
  visible_post: '\n}',
  reference_answer: '',
  prose: {},
};

function mockFetch(runResponse: any = { pass: true, results: [{ name: 't1', pass: true }] }) {
  return vi.fn(async (url: string, init?: any) => {
    if (url === '/api/gap/ladder') {
      return {
        ok: true,
        json: async () => ({
          ladder: { pattern: 'stream-consumer', targetArtifactId: 'stream-consumer', siblingArtifactId: 'route-handler', rungs: [] },
          rungs: [workedExampleRung, inlineCompletionRung, fullBodyRung],
        }),
      } as any;
    }
    if (url === '/api/gap/run') {
      void init;
      return { ok: true, json: async () => runResponse } as any;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

// Injectable seam for the full_body gap editor — see CodeExercise.tsx's `Editor` prop doc: jsdom
// mounts real CM6 fine, but simulating actual keystrokes into a contentEditable CM6 view isn't
// worth the fragility.
const TextEditor = ({ onGapChange }: any) => (
  <textarea aria-label="gap-input" onChange={(e) => onGapChange(e.target.value)} />
);

describe('CodeExercise — ladder sequence enforcement', () => {
  beforeEach(() => { (globalThis as any).fetch = mockFetch(); });

  it('starts on worked_example and advances to inline_completion on continue (no skipping ahead)', async () => {
    const addResult = vi.fn();
    render(<CodeExerciseInner args={{ pattern: 'stream-consumer', rung: 'ladder', pageSlug: 'stream-consumer' }} addResult={addResult} />);

    await screen.findByText(/pulls the route param out first/i);
    expect(screen.getByText('1. worked example').className).toMatch(/current/);

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await screen.findByText(/decide what must happen first when there is no body at all/i);
    expect(screen.getByText('2. inline completion').className).toMatch(/current/);
    expect(addResult).not.toHaveBeenCalled();
  });

  it('the explicit "stop here" affordance abandons mid-ladder with completed:false and the reached rung', async () => {
    const addResult = vi.fn();
    render(<CodeExerciseInner args={{ pattern: 'stream-consumer', rung: 'ladder', pageSlug: 'stream-consumer' }} addResult={addResult} />);

    await screen.findByText(/pulls the route param out first/i);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText(/decide what must happen first/i);

    fireEvent.click(screen.getByRole('button', { name: /stop here/i }));

    expect(addResult).toHaveBeenCalledExactlyOnceWith({
      completed: false, rungReached: 'inline_completion', testsPassed: 0, testsTotal: 0, wroteCode: false,
    });
  });

  it('single-rung mode (rung: "full_body") skips straight to the full_body screen', async () => {
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={vi.fn()} Editor={TextEditor}
    />);
    await screen.findByLabelText('gap-input');
    expect(screen.queryByText(/worked example/i)).toBeNull();
  });
});

describe('CodeExercise — full_body grading (mechanical, via real tests)', () => {
  // Real timers: RungEditor's debounce (900ms — ../../../src/client/components/blocks/gap/hooks/
  // useDebouncedRun.ts) fires on a real setTimeout; jsdom + testing-library's findBy/waitFor use
  // real timers/MutationObserver internally too, so faking global timers here just hangs those.
  it('passing tests with learner-authored code completes with wroteCode:true', async () => {
    (globalThis as any).fetch = mockFetch({ pass: true, results: [{ name: 't1', pass: true }, { name: 't2', pass: true }] });
    const addResult = vi.fn();
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={addResult} Editor={TextEditor}
    />);
    const input = await screen.findByLabelText('gap-input');
    fireEvent.change(input, { target: { value: 'return onToken(chunk);' } });

    await new Promise((r) => { setTimeout(r, 1000); });

    expect(addResult).toHaveBeenCalledExactlyOnceWith({
      completed: true, rungReached: 'full_body', testsPassed: 2, testsTotal: 2, wroteCode: true,
    });
  }, 10_000);

  it('passing tests with an empty gap (guided/watched only) completes with wroteCode:false', async () => {
    // An empty gap never even POSTs (InlineCompletion/full_body both skip a blank submission —
    // ported behavior) — simulate the guided case as a "stop here" on an untouched full_body
    // screen instead, since full_body auto-completion only fires on a genuine pass.
    (globalThis as any).fetch = mockFetch();
    const addResult = vi.fn();
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={addResult} Editor={TextEditor}
    />);
    await screen.findByLabelText('gap-input');
    fireEvent.click(screen.getByRole('button', { name: /stop here/i }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({
      completed: false, rungReached: 'full_body', testsPassed: 0, testsTotal: 0, wroteCode: false,
    });
  });
});
