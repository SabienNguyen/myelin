// @vitest-environment jsdom
//
// Regression test for the P1 review finding (docs/superpowers/plans/2026-07-20-gap-integration.md
// — post-review fix): a real browser session sending "Practice stream-consumer with a code
// exercise" hit React's "Maximum update depth exceeded" and crashed the whole tree (chip visible,
// #stage-root empty, .app.focus-mode gone) even though every unit test that mounted
// CodeExercise/CodeExerciseInner in isolation stayed green. Root cause: Thread.tsx's
// ThreadPrimitive.Messages `components.AssistantMessage`/`UserMessage` were inline arrow
// functions recreated every render of Thread() — a fresh function IDENTITY each time reads to
// assistant-ui as "a different component type here", so the whole per-role message subtree (and
// anything a block portals out of it) unmounted and remounted on every single Thread re-render.
// CodeExerciseInner's mount effect (panelBus.setFocusMode(true)/cleanup(false), CodeExercise.tsx)
// turned that into a feedback loop: App re-render -> Thread re-renders -> new component identity
// -> AssistantMessage subtree remounts -> CodeExerciseInner's unmount(false)-then-mount(true)
// flips App's focusMode state -> App re-renders again -> repeat, until React's nested-update-count
// guard throws and tears the tree down.
//
// This test mounts the REAL App-level wiring (App -> Runtime's provider slot -> Thread ->
// SidePanel -> the code_exercise block via its real StagePortal) so a regression in EITHER
// Thread.tsx's component identity OR CodeExercise.tsx's mount effect would reproduce the same
// crash here that the browser saw — narrower unit tests that only mount CodeExercise in isolation
// (tests/client/codeexercise.test.tsx) cannot catch this because the loop only exists when
// assistant-ui's real message-rendering machinery is driving the remounts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup, act } from '@testing-library/react';
import { useEffect, useRef, type PropsWithChildren } from 'react';
import { AssistantRuntimeProvider, Tools, useAui, useLocalRuntime } from '@assistant-ui/react';
import { toolkit } from '../../src/client/toolkit.js';

// Swap out Runtime.tsx's real chat wiring (network fetch + AI SDK transport) for a minimal, real
// assistant-ui local runtime seeded with exactly the scripted turn the review reproduced against:
// one assistant message with a `code_exercise` tool call and NO result yet — the
// "mount-with-no-result" state CodeExerciseInner's focus-mode effect fires on. This keeps
// everything downstream (AssistantRuntimeProvider, ThreadPrimitive, MessagePrimitive, the real
// toolkit) exactly as production wires it; only the network-backed transport is replaced.
function TestRuntime({ children }: PropsWithChildren<Record<string, unknown>>) {
  const runtime = useLocalRuntime({
    async run() {
      return {
        content: [
          { type: 'text' as const, text: "Let's practice the stream consumer pattern for real — full body this time." },
          {
            type: 'tool-call' as const,
            toolCallId: 'tc-code-exercise-1',
            toolName: 'code_exercise',
            argsText: JSON.stringify({ pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' }),
            args: { pattern: 'stream-consumer', rung: 'full_body', pageSlug: 'stream-consumer' },
          },
        ],
      };
    },
  });
  const aui = useAui({ tools: Tools({ toolkit }) });
  const kicked = useRef(false);
  useEffect(() => {
    if (kicked.current) return;
    kicked.current = true;
    void runtime.thread.append({
      role: 'user',
      content: [{ type: 'text', text: 'Practice stream-consumer with a code exercise' }],
    });
  }, [runtime]);
  return <AssistantRuntimeProvider runtime={runtime} aui={aui}>{children}</AssistantRuntimeProvider>;
}

vi.mock('../../src/client/runtime.js', () => ({ Runtime: TestRuntime }));

const { App } = await import('../../src/client/App.js');

const fullBodyRung = {
  id: 'stream-consumer--full_body--0',
  template: 'full_body',
  artifactId: 'stream-consumer',
  visible_pre: 'export async function consumeStream(response, onToken) {\n',
  visible_post: '\n}',
  reference_answer: '',
  prose: {},
};

// jsdom has no ResizeObserver, and its elements have no scrollTo — assistant-ui's real
// ThreadPrimitive.Viewport (Thread.tsx uses it) needs both to exist at all, even though this
// test doesn't care about resize/scroll behavior itself.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/gap/ladder') {
      return {
        ok: true,
        json: async () => ({
          ladder: { pattern: 'stream-consumer', targetArtifactId: 'stream-consumer', siblingArtifactId: null, rungs: [] },
          rungs: [fullBodyRung],
        }),
      } as any;
    }
    // Anything else (status polling, etc.) — resolve quietly rather than throwing, this test
    // isn't exercising those paths.
    return { ok: true, json: async () => ({}) } as any;
  }));
}

describe('App-level wiring — P1 focus-mode remount regression', () => {
  beforeEach(() => {
    stubFetch();
    vi.stubGlobal('ResizeObserver', StubResizeObserver);
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
    location.hash = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    location.hash = '';
  });

  it('mounting a code_exercise block through the real Thread/App wiring does not loop, and stage content stays mounted with focus mode on', async () => {
    const realError = console.error.bind(console);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(realError);

    await act(async () => {
      render(<App />);
    });

    // Let the scripted turn's tool call render and CodeExerciseInner mount (its own effect fetches
    // /api/gap/ladder — see stubFetch above).
    await waitFor(() => {
      expect(document.getElementById('stage-root')?.children.length).toBeGreaterThan(0);
    });

    // Give any update-depth feedback loop a chance to manifest — the real bug threw within a
    // handful of synchronous re-render cycles right after mount, well inside this window.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const updateDepthErrors = consoleErrorSpy.mock.calls
      .map((args) => args.map((a) => String(a)).join(' '))
      .filter((text) => /Maximum update depth exceeded/.test(text));
    expect(updateDepthErrors).toEqual([]);

    // The crash's exact symptom: stage content unmounted and focus mode flipped back off.
    expect(document.getElementById('stage-root')?.children.length).toBeGreaterThan(0);
    expect(document.querySelector('.app.focus-mode')).not.toBeNull();

    consoleErrorSpy.mockRestore();
  });
});
