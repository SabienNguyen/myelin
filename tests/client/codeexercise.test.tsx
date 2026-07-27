// @vitest-environment jsdom
import { useLayoutEffect, useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { CodeExercise, CodeExerciseInner } from '../../src/client/components/blocks/CodeExercise.js';
import { panelBus } from '../../src/client/lib/panelBus.js';

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

// Final integration (docs/superpowers/plans/2026-07-21-coding-stage.md B2c): a mined artifact's
// single rung — same shape as a built-in rung (answer-stripped), plus meta.
const minedRung = {
  id: 'packages-core-src-fetch-all-pages--full_body--0',
  template: 'full_body',
  artifactId: 'packages-core-src-fetch-all-pages',
  visible_pre: 'export async function fetchAllPages(url) {\n',
  visible_post: '\n}',
  reference_answer: '',
  prose: {},
};
const minedEntryFixture = {
  rung: minedRung,
  meta: {
    title: 'Fetch All Pages',
    family: 'mined:the-gap',
    source: { repo: '/repo', commit: 'abc123', path: 'src/fetch.ts' },
  },
};

function mockFetch(
  runResponse: any = { pass: true, results: [{ name: 't1', pass: true }] },
  helpResponse: any = { hint: 'name what handles a null body before touching a reader.' },
  mined: any[] = [],
) {
  return vi.fn(async (url: string, init?: any) => {
    // getLadder now appends ?pattern=<args.pattern> so generated ladders resolve; the mock serves
    // the same fixture for any pattern, which is exactly what the pattern-less sidecar proxy does.
    if (url === '/api/gap/ladder' || url.startsWith('/api/gap/ladder?')) {
      return {
        ok: true,
        json: async () => ({
          ladder: { pattern: 'stream-consumer', targetArtifactId: 'stream-consumer', siblingArtifactId: 'route-handler', rungs: [] },
          rungs: [workedExampleRung, inlineCompletionRung, fullBodyRung],
          mined,
        }),
      } as any;
    }
    if (url === '/api/gap/run') {
      void init;
      return { ok: true, json: async () => runResponse } as any;
    }
    if (url === '/api/gap/help') {
      void init;
      return { ok: true, json: async () => helpResponse } as any;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

// Injectable seam for the full_body gap editor — see CodeExercise.tsx's `Editor` prop doc: jsdom
// mounts real CM6 fine, but simulating actual keystrokes into a contentEditable CM6 view isn't
// worth the fragility. RungEditor v2 (docs/superpowers/plans/2026-07-21-coding-stage.md): mirrors
// the real component's contract (RungEditor.tsx's top comment) by reporting its resolved starting
// doc (here, just `scaffold` — this stub never restores a draft) to the caller immediately on
// mount, not only on the learner's first real edit, so wroteCode's exact-compare-against-the-
// original-scaffold logic (CodeExercise.tsx) sees an accurate starting value in these tests too.
// Empty deps ([]), reading `onDocChange` through a ref rather than listing it directly — same
// reason RungEditor.tsx's own mount effect does this (its top comment): `onDocChange` here is
// CodeExercise.tsx's onFullBodyDocChange, whose deps include `detector` from useDetectorState.ts,
// which is verbatim-ported and returns a brand-new object every render (never memoized) — an
// effect keyed on `onDocChange`'s identity would re-fire every time it's called (since calling it
// triggers a state update, which produces a NEW onDocChange next render), looping forever.
const TextEditor = ({ scaffold, onDocChange }: any) => {
  const onDocChangeRef = useRef(onDocChange);
  onDocChangeRef.current = onDocChange;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // Layout effect, deliberately: the real RungEditor cannot be typed into before its mount
  // effect runs (the CM6 view IS the input, and that effect creates it), so its starting-doc
  // report can never clobber an edit. This stand-in's textarea exists at first commit — with a
  // passive effect, findBy* could observe it, the test could type, and THEN the stale mount
  // report would fire setCode(scaffold) over the typed text (seen live: wroteCode:false flake).
  // Reporting at layout time closes the fidelity gap: report lands before the DOM is observable.
  useLayoutEffect(() => { onDocChangeRef.current(scaffold); }, []);
  return <textarea aria-label="gap-input" defaultValue={scaffold} onChange={(e) => onDocChange(e.target.value)} />;
};

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
    // No ladder nav (that's the "no skipping ahead" invariant this test guards) — a Task-tab
    // sibling-worked-example link legitimately mentions "worked example" text elsewhere (P1), so
    // this checks the ladder progress nav specifically rather than any occurrence of the phrase.
    expect(screen.queryByRole('navigation', { name: /ladder progress/i })).toBeNull();
  });
});

describe('CodeExercise — mined pattern resolution (final integration, docs/superpowers/plans/2026-07-21-coding-stage.md)', () => {
  it('a mined pattern resolves via payload.mined by rung.artifactId, renders single-rung with no ladder chrome, and shows brief-panel provenance', async () => {
    (globalThis as any).fetch = mockFetch(undefined, undefined, [minedEntryFixture]);
    render(<CodeExerciseInner
      args={{ pattern: 'packages-core-src-fetch-all-pages', rung: 'ladder', pageSlug: 'packages-core-src-fetch-all-pages' }}
      addResult={vi.fn()} Editor={TextEditor}
    />);

    await screen.findByLabelText('gap-input');
    // No ladder progression chrome for a single-rung mined exercise — even though args.rung
    // asked for 'ladder' (the tutor has no way to know a mined pattern is single-rung ahead of
    // time; the UI degrades gracefully regardless of what it was asked for).
    expect(screen.queryByRole('navigation', { name: /ladder progress/i })).toBeNull();

    // Brief panel: meta.title (not the raw artifactId) as the heading, family badge, source path.
    expect(screen.getByRole('heading', { name: 'Fetch All Pages' })).toBeTruthy();
    expect(screen.getByText('mined:the-gap')).toBeTruthy();
    expect(screen.getByText('/repo — src/fetch.ts')).toBeTruthy();
  });

  it("single-rung mined flow completes via Submit with the pinned result contract, rungReached = the mined rung's template", async () => {
    (globalThis as any).fetch = mockFetch(
      { pass: true, results: [{ name: 't1', pass: true }, { name: 't2', pass: true }] },
      undefined,
      [minedEntryFixture],
    );
    const addResult = vi.fn();
    render(<CodeExerciseInner
      args={{ pattern: 'packages-core-src-fetch-all-pages', rung: 'ladder', pageSlug: 'packages-core-src-fetch-all-pages' }}
      addResult={addResult} Editor={TextEditor}
    />);
    const input = await screen.findByLabelText('gap-input');
    fireEvent.change(input, { target: { value: 'return fetchPage(url);' } });

    // 5s, not findBy's 1s default: the auto-run debounce alone is 900ms, so the default left
    // ~100ms of real margin — a loaded runner turned that into the suite's rarest flake.
    await screen.findByText('2/2 passing', {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));

    expect(addResult).toHaveBeenCalledExactlyOnceWith({
      completed: true, rungReached: 'full_body', testsPassed: 2, testsTotal: 2, wroteCode: true,
    });
  }, 10_000);

  // An unknown pattern and a down sandbox are DIFFERENT failures and must not share copy: the ladder
  // answered fine here, so claiming the sandbox is unresponsive would be false and would misdirect
  // anyone debugging. Both now render a proper block card with an escape that records no evidence.
  it('an unknown pattern reports a missing exercise — not an offline sandbox — and offers no retry', async () => {
    (globalThis as any).fetch = mockFetch(undefined, undefined, [minedEntryFixture]);
    render(<CodeExerciseInner
      args={{ pattern: 'totally-unknown-pattern', rung: 'full_body', pageSlug: 'totally-unknown-pattern' }}
      addResult={vi.fn()}
    />);

    expect(await screen.findByText(/isn’t available yet/i)).toBeTruthy();
    expect(screen.getByText(/no coding exercise has been written for/i)).toBeTruthy();
    // Retrying an intact ladder would return the identical answer, so the button is not offered.
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    // The endpoint/status stays available for debugging, folded away rather than shown first.
    expect(screen.getByText(/technical detail/i)).toBeTruthy();
  });

  it('a failed ladder fetch reports an offline sandbox, offers a retry, and can be skipped without evidence', async () => {
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 502 })) as any;
    const addResult = vi.fn();
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={addResult}
    />);

    expect(await screen.findByText(/can’t start right now/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    // The raw "GET /api/gap/ladder failed: 502" must not be the headline a learner reads.
    expect(screen.queryByText(/^could not load the exercise/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /skip this exercise/i }));
    // unavailable:true is what makes grading.ts record NOTHING rather than blaming the learner with
    // 'struggled' for a service being down.
    expect(addResult).toHaveBeenCalledWith(expect.objectContaining({ unavailable: true, completed: false }));
  });

  it('built-in patterns are unaffected by mined entries present in the same payload', async () => {
    (globalThis as any).fetch = mockFetch(undefined, undefined, [minedEntryFixture]);
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={vi.fn()} Editor={TextEditor}
    />);
    await screen.findByLabelText('gap-input');
    // The built-in's own raw pattern string still titles the brief panel — no meta.title
    // substitution, no mined badge, even though an unrelated mined entry is present.
    expect(screen.getByRole('heading', { name: 'stream-consumer' })).toBeTruthy();
    expect(screen.queryByText('mined:the-gap')).toBeNull();
  });
});

describe('CodeExercise — full_body grading (mechanical, via real tests)', () => {
  // Real timers: RungEditor's debounce (900ms — ../../../src/client/components/blocks/gap/hooks/
  // useDebouncedRun.ts) fires on a real setTimeout; jsdom + testing-library's findBy/waitFor use
  // real timers/MutationObserver internally too, so faking global timers here just hangs those.
  it('a passing auto-run shows results but does NOT complete the block — Run is not Submit (P2)', async () => {
    (globalThis as any).fetch = mockFetch({ pass: true, results: [{ name: 't1', pass: true }, { name: 't2', pass: true }] });
    const addResult = vi.fn();
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={addResult} Editor={TextEditor}
    />);
    const input = await screen.findByLabelText('gap-input');
    fireEvent.change(input, { target: { value: 'return onToken(chunk);' } });

    // 5s, not findBy's 1s default: the auto-run debounce alone is 900ms, so the default left
    // ~100ms of real margin — a loaded runner turned that into the suite's rarest flake.
    await screen.findByText('2/2 passing', {}, { timeout: 5000 });
    expect(addResult).not.toHaveBeenCalled();
  }, 10_000);

  it('Run posts { mode: "file", code: <whole doc> } — RungEditor v2, item 4', async () => {
    const fetchMock = mockFetch({ pass: true, results: [{ name: 't1', pass: true }] });
    (globalThis as any).fetch = fetchMock;
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={vi.fn()} Editor={TextEditor}
    />);
    const input = await screen.findByLabelText('gap-input');
    fireEvent.change(input, { target: { value: 'return onToken(chunk);' } });
    await screen.findByText('1/1 passing', {}, { timeout: 5000 });

    const runCall = fetchMock.mock.calls.find((c: any[]) => {
      if (c[0] !== '/api/gap/run') return false;
      const body = JSON.parse(c[1].body);
      return body.code === 'return onToken(chunk);';
    });
    expect(runCall).toBeTruthy();
    const body = JSON.parse(runCall![1].body);
    expect(body).toMatchObject({ rungId: fullBodyRung.id, code: 'return onToken(chunk);', mode: 'file' });
  }, 10_000);

  it('explicitly clicking Submit after a passing run completes with wroteCode:true', async () => {
    (globalThis as any).fetch = mockFetch({ pass: true, results: [{ name: 't1', pass: true }, { name: 't2', pass: true }] });
    const addResult = vi.fn();
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={addResult} Editor={TextEditor}
    />);
    const input = await screen.findByLabelText('gap-input');
    fireEvent.change(input, { target: { value: 'return onToken(chunk);' } });

    // 5s, not findBy's 1s default: the auto-run debounce alone is 900ms, so the default left
    // ~100ms of real margin — a loaded runner turned that into the suite's rarest flake.
    await screen.findByText('2/2 passing', {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));

    expect(addResult).toHaveBeenCalledExactlyOnceWith({
      completed: true, rungReached: 'full_body', testsPassed: 2, testsTotal: 2, wroteCode: true,
    });
  }, 10_000);

  it('Submit with no run yet (or failing tests) opens an inline confirm instead of completing silently', async () => {
    (globalThis as any).fetch = mockFetch({ pass: false, results: [{ name: 't1', pass: false }] });
    const addResult = vi.fn();
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={addResult} Editor={TextEditor}
    />);
    await screen.findByLabelText('gap-input');

    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));
    expect(addResult).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('alertdialog', { name: /confirm submit/i });
    expect(confirm).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /submit anyway/i }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({
      completed: true, rungReached: 'full_body', testsPassed: 0, testsTotal: 0, wroteCode: false,
    });
  });

  it('passing tests with an empty gap (guided/watched only) completes with wroteCode:false', async () => {
    // An empty gap never even POSTs (InlineCompletion/full_body both skip a blank submission —
    // ported behavior) — simulate the guided case as a "stop here" on an untouched full_body
    // screen instead, since Submit only matters once there's something to submit.
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

describe('CodeExercise — IDE focus mode (P1, docs/superpowers/plans/2026-07-20-gap-integration.md)', () => {
  beforeEach(() => { (globalThis as any).fetch = mockFetch(); });

  it('mounting with no result emits focusMode:true; unmounting emits focusMode:false', async () => {
    const seen: boolean[] = [];
    const un = panelBus.subscribe((e) => { if (e.type === 'focusMode') seen.push(e.on); });
    const { unmount } = render(
      <CodeExerciseInner args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }} addResult={vi.fn()} Editor={TextEditor} />,
    );
    await screen.findByLabelText('gap-input');
    expect(seen).toEqual([true]);
    unmount();
    expect(seen).toEqual([true, false]);
    un();
  });

  it('the CodeExercise wrapper only mounts the focus-triggering inner while unanswered — a result clears focus mode', async () => {
    // StagePortal (CodeExercise's Inner is only ever mounted via it) portals into a real
    // #stage-root element — provide the same target SidePanel.tsx renders in the real app.
    const stageRoot = document.createElement('div');
    stageRoot.id = 'stage-root';
    document.body.appendChild(stageRoot);

    const seen: boolean[] = [];
    const un = panelBus.subscribe((e) => { if (e.type === 'focusMode') seen.push(e.on); });
    const { rerender } = render(
      <CodeExercise args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }} result={undefined} addResult={vi.fn()} />,
    );
    await screen.findByText(/code exercise waiting on the stage/i);
    expect(seen).toEqual([true]);

    rerender(
      <CodeExercise
        args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
        result={{ completed: true, rungReached: 'full_body', testsPassed: 2, testsTotal: 2, wroteCode: true }}
        addResult={vi.fn()}
      />,
    );
    expect(seen).toEqual([true, false]);
    un();
    stageRoot.remove();
  });
});

describe('CodeExercise — ambient offers dock as brief-panel tabs (P1)', () => {
  it('a fired detector adds a lit tab to the brief panel; dismissing it removes the tab', async () => {
    // Two consecutive syntax-error runs trip the docs detector (DOCS_STREAK = 2, detectors.ts).
    (globalThis as any).fetch = mockFetch({ pass: false, results: [], syntaxError: 'unexpected token' });
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={vi.fn()} Editor={TextEditor}
    />);
    const input = await screen.findByLabelText('gap-input');

    expect(screen.queryByRole('tab', { name: /docs/i })).toBeNull();

    fireEvent.change(input, { target: { value: 'a' } });
    await new Promise((r) => { setTimeout(r, 1000); });
    fireEvent.change(input, { target: { value: 'ab' } });
    await new Promise((r) => { setTimeout(r, 1000); });

    const docsTab = await screen.findByRole('tab', { name: /docs/i });
    expect(docsTab.querySelector('.ide-tab-badge')).not.toBeNull();

    fireEvent.click(docsTab);
    expect(await screen.findByText(/you look like you might be here/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('tab', { name: /docs/i })).toBeNull();
  }, 10_000);
});

describe('CodeExercise — Help tab (Track A, docs/superpowers/plans/2026-07-21-coding-stage.md)', () => {
  beforeEach(() => { (globalThis as any).fetch = mockFetch(); });

  it('always present (not gated by a detector) and posts to /api/gap/help with pattern/rung/draft/failures', async () => {
    const fetchMock = mockFetch(
      { pass: false, results: [{ name: 'handles a null body', pass: false }] },
      { hint: 'name what handles a null body before touching a reader.' },
    );
    (globalThis as any).fetch = fetchMock;
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={vi.fn()} Editor={TextEditor}
    />);
    const input = await screen.findByLabelText('gap-input');
    fireEvent.change(input, { target: { value: 'return chunk;' } });
    await screen.findByText(/0\/1 passing/i);

    fireEvent.click(screen.getByRole('tab', { name: /help/i }));
    const composer = screen.getByPlaceholderText('ask about this exercise…');
    fireEvent.change(composer, { target: { value: 'why does the null body test fail?' } });
    fireEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    const hint = await screen.findByText(/name what handles a null body/i);
    expect(hint).toBeTruthy();
    expect(screen.getByText('why does the null body test fail?')).toBeTruthy();

    const helpCall = fetchMock.mock.calls.find((c: any[]) => c[0] === '/api/gap/help');
    expect(helpCall).toBeTruthy();
    const body = JSON.parse(helpCall![1].body);
    expect(body).toMatchObject({
      pattern: 'stream-consumer',
      rung: 'full_body',
      question: 'why does the null body test fail?',
      draft: 'return chunk;',
      failures: ['handles a null body'],
    });
  }, 10_000);

  it('the transcript accumulates across exchanges and survives switching tabs away and back', async () => {
    let call = 0;
    (globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
      if (url === '/api/gap/ladder' || url.startsWith('/api/gap/ladder?')) {
        return {
          ok: true,
          json: async () => ({
            ladder: { pattern: 'stream-consumer', targetArtifactId: 'stream-consumer', siblingArtifactId: 'route-handler', rungs: [] },
            rungs: [workedExampleRung, inlineCompletionRung, fullBodyRung],
          }),
        } as any;
      }
      if (url === '/api/gap/help') {
        void init;
        call += 1;
        return { ok: true, json: async () => ({ hint: `hint number ${call}` }) } as any;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={vi.fn()} Editor={TextEditor}
    />);
    await screen.findByLabelText('gap-input');

    fireEvent.click(screen.getByRole('tab', { name: /help/i }));
    fireEvent.change(screen.getByPlaceholderText('ask about this exercise…'), { target: { value: 'first question' } });
    fireEvent.click(screen.getByRole('button', { name: /^ask$/i }));
    await screen.findByText('hint number 1');

    // Switch away (Help tab's own content unmounts — FocusLayout only renders the active tab) and
    // back: the transcript is lifted to CodeExercise.tsx, so it must still be there.
    fireEvent.click(screen.getByRole('tab', { name: /^task$/i }));
    fireEvent.click(screen.getByRole('tab', { name: /help/i }));
    expect(screen.getByText('first question')).toBeTruthy();
    expect(screen.getByText('hint number 1')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('ask about this exercise…'), { target: { value: 'second question' } });
    fireEvent.click(screen.getByRole('button', { name: /^ask$/i }));
    await screen.findByText('hint number 2');
    expect(screen.getByText('first question')).toBeTruthy();
    expect(screen.getByText('second question')).toBeTruthy();
  }, 10_000);

  it('Ctrl+/ switches to the Help tab and focuses the composer from elsewhere in focus mode', async () => {
    render(<CodeExerciseInner
      args={{ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }}
      addResult={vi.fn()} Editor={TextEditor}
    />);
    await screen.findByLabelText('gap-input');
    expect(screen.queryByPlaceholderText('ask about this exercise…')).toBeNull(); // Task tab active by default

    fireEvent.keyDown(window, { key: '/', ctrlKey: true });

    // findBy* under a loaded full-suite run can exceed the default 1s; the focus itself is
    // rAF-scheduled, and "flush one frame" assumed an ordering jsdom does not guarantee under
    // load — this was the suite's one recurring flake. Poll for the CONDITION, not the frame.
    const composer = await screen.findByPlaceholderText('ask about this exercise…', {}, { timeout: 5000 });
    await waitFor(() => expect(document.activeElement).toBe(composer), { timeout: 5000 });
  });
});
