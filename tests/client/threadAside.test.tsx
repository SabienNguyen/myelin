// @vitest-environment jsdom
//
// Inline asides through the real client wiring (aside-plan.md task A2): a learner selects a
// passage of a tutor message, asks about just that, and the answer lands on that message without
// ever becoming a chat turn — and `/aside` in the composer reaches the same endpoint instead of
// POSTing /api/chat. Two harnesses:
//   - `renderApp`: the real Runtime -> useChatCoreRuntime -> Thread wiring (App-focus-mode's own
//     pattern), for the selection-driven flow — it needs the real message DOM to select inside.
//   - `renderComposer`: Composer alone behind a minimal local runtime, for `/aside` — jsdom cannot
//     type into Tiptap's contenteditable (commandEditor.test.tsx works around this the same way),
//     so the composer's own CommandEditorHandle is reached through Composer's test-only
//     `testEditorHandleRef` prop instead of simulated keystrokes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { AssistantRuntimeProvider, Tools, useAui, useLocalRuntime } from '@assistant-ui/react';
import { ChatStore, ChatStoreContext } from '../../src/client/chatCore/index.js';
import { Composer } from '../../src/client/components/Thread.js';
import { Thread } from '../../src/client/components/Thread.js';
import { Runtime } from '../../src/client/runtime.js';
import { toolkit } from '../../src/client/toolkit.js';
import type { CommandEditorHandle } from '../../src/client/components/CommandEditor.js';
import type { UIMessage } from '../../src/shared/uiMessages.js';

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (Range.prototype as any).getBoundingClientRect ??=
    () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  // jsdom has no Range.getClientRects either, and ProseMirror's scrollIntoView reaches for it when
  // the tests insert content into the composer — an unhandled TypeError after the test passed.
  (Range.prototype as any).getClientRects ??= () => [];
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
afterEach(async () => {
  cleanup();
  // @tiptap/react's useEditor defers editor.destroy() to a setTimeout(fn, 1) after unmount
  // (EditorInstanceManager.scheduleDestroy in node_modules/@tiptap/react/dist/index.js ~line 486),
  // so a remount within that tick can cancel the destroy. cleanup() above unmounts Composer's
  // CommandEditor synchronously and returns without waiting, so that 1ms timer used to fire after
  // vitest tore down this file's jsdom — editor.destroy() then reached into a gone `document` and
  // vitest reported an unhandled error ("Editor.unmount ... TypeError: document is not defined",
  // sometimes surfacing instead as a stale-DOM-method TypeError deeper in prosemirror-view)
  // even though every test had already passed. Waiting past the 1ms lets it run while jsdom is
  // still alive; it's a real timer (not fake), and Node fires an earlier-registered shorter timer
  // before a later-registered longer one, so this ordering is deterministic, not a coin flip.
  await new Promise((resolve) => setTimeout(resolve, 10));
  vi.unstubAllGlobals();
  sessionStorage.clear(); // the composer keeps a per-thread draft there
});

function selectWithin(node: Node, from: number, to: number) {
  const textNode = node.firstChild ?? node;
  const range = document.createRange();
  range.setStart(textNode, from);
  range.setEnd(textNode, to);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

// ── selection-driven flow: the real Runtime/Thread wiring ─────────────────────────────────────

const ASSISTANT_TEXT = 'The derivative of x squared is two x, a fact worth sitting with.';

function stubFetchForThread(initial: UIMessage[], asideHandler: (body: any) => any) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/thread/test') return { ok: true, json: async () => initial } as any;
    if (url === '/api/aside') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return asideHandler(body);
    }
    return { ok: true, json: async () => ({}) } as any;
  }));
}

async function renderApp(initial: UIMessage[], asideHandler: (body: any) => any) {
  stubFetchForThread(initial, asideHandler);
  await act(async () => {
    render(<Runtime mode="learn" threadId="test"><Thread /></Runtime>);
  });
  await waitFor(() => expect(screen.getByText(new RegExp(ASSISTANT_TEXT.slice(0, 20)))).not.toBeNull());
  // CommandEditor's Tiptap instance autofocuses itself once, asynchronously (immediatelyRender:
  // false + autofocus:true) — in jsdom, focus moving to the composer's contenteditable collapses
  // whatever text selection the test just made in the transcript, exactly as it would in a real
  // browser if the composer stole focus mid-selection. Settling here, before any selection is
  // made, keeps the test's selection from racing that one-time focus move.
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
}

describe('inline asides — selection flow (real Thread wiring)', () => {
  const initial: UIMessage[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'How do I take a derivative?' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: ASSISTANT_TEXT }] },
  ];

  it('selecting text in the tutor message offers "ask aside"; submitting POSTs the quote and question and renders the part on that message', async () => {
    let asideBody: any = null;
    await renderApp(initial, (body) => {
      asideBody = body;
      return {
        ok: true,
        json: async () => ({
          part: {
            type: 'data-aside',
            id: 'aside-1',
            data: {
              asideId: 'aside-1',
              quote: body.quote,
              question: body.question,
              answer: 'A derivative measures instantaneous rate of change.',
              sources: [],
              vaultPages: [],
              fromMemory: true,
              createdAt: '2026-09-22T00:00:00.000Z',
            },
          },
        }),
      };
    });

    const para = screen.getByText(new RegExp(ASSISTANT_TEXT.slice(0, 20)));
    selectWithin(para, 4, 24); // "derivative of x squared"
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });

    const askButton = await screen.findByRole('button', { name: 'ask aside' });
    fireEvent.click(askButton);

    const textarea = await screen.findByRole('textbox', { name: /aside question/i });
    fireEvent.change(textarea, { target: { value: 'why x squared specifically?' } });
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));

    await waitFor(() => expect(asideBody).not.toBeNull());
    expect(asideBody.threadId).toBe('test');
    expect(asideBody.messageId).toBe('a1');
    expect(asideBody.question).toBe('why x squared specifically?');
    expect(asideBody.quote).toContain('derivative of x squa');

    expect(await screen.findByText(/aside ·/)).not.toBeNull();
    expect(screen.getByText(/instantaneous rate of change/)).not.toBeNull();
  });

  it('a bare submit with no typed question sends "Explain "<quote>""', async () => {
    let asideBody: any = null;
    await renderApp(initial, (body) => {
      asideBody = body;
      return {
        ok: true,
        json: async () => ({
          part: { type: 'data-aside', id: 'aside-2', data: {
            asideId: 'aside-2', question: body.question, answer: 'Because area scales with the square.',
            sources: [], vaultPages: [], fromMemory: true, createdAt: '2026-09-22T00:00:00.000Z',
          } },
        }),
      };
    });
    const para = screen.getByText(new RegExp(ASSISTANT_TEXT.slice(0, 20)));
    selectWithin(para, 4, 24);
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    fireEvent.click(await screen.findByRole('button', { name: 'ask aside' }));
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(asideBody).not.toBeNull());
    expect(asideBody.question).toMatch(/^Explain "/);
  });

  it('Escape cancels the form; the ask-aside button is gone and no request is sent', async () => {
    await renderApp(initial, () => { throw new Error('should not be called'); });
    const para = screen.getByText(new RegExp(ASSISTANT_TEXT.slice(0, 20)));
    selectWithin(para, 4, 24);
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    fireEvent.click(await screen.findByRole('button', { name: 'ask aside' }));
    const textarea = await screen.findByRole('textbox', { name: /aside question/i });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /aside question/i })).toBeNull());
  });

  it('a server error shows the alert and keeps the typed question', async () => {
    await renderApp(initial, () => ({ ok: false, status: 502, json: async () => ({ error: 'the model failed' }) }));
    const para = screen.getByText(new RegExp(ASSISTANT_TEXT.slice(0, 20)));
    selectWithin(para, 4, 24);
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    fireEvent.click(await screen.findByRole('button', { name: 'ask aside' }));
    const textarea = await screen.findByRole('textbox', { name: /aside question/i });
    fireEvent.change(textarea, { target: { value: 'why does that hold?' } });
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('the model failed');
    expect((screen.getByRole('textbox', { name: /aside question/i }) as HTMLTextAreaElement).value)
      .toBe('why does that hold?');
  });
});

describe('inline asides — the form holds one request at a time', () => {
  const initial: UIMessage[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'How do I take a derivative?' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: ASSISTANT_TEXT }] },
  ];
  const openForm = async () => {
    selectWithin(screen.getByText(new RegExp(ASSISTANT_TEXT.slice(0, 20))), 4, 24);
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    fireEvent.click(await screen.findByRole('button', { name: 'ask aside' }));
    return await screen.findByRole('textbox', { name: /aside question/i }) as HTMLTextAreaElement;
  };

  it('a double click and a second Enter while the answer is out send one request', async () => {
    let asked = 0;
    let release!: () => void;
    await renderApp(initial, () => {
      asked += 1;
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, json: async () => ({ part: {
          type: 'data-aside', id: 'aside-1',
          data: { asideId: 'aside-1', question: 'q', answer: 'held answer', sources: [], vaultPages: [], fromMemory: true, createdAt: '2026-09-22T00:00:00.000Z' },
        } }) });
      });
    });
    const textarea = await openForm();
    const submit = screen.getByRole('button', { name: 'submit' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(asked).toBe(1);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); });
    expect(await screen.findByText('held answer')).not.toBeNull();
    expect(asked).toBe(1);
  });

  it('the Enter that accepts an IME conversion does not submit', async () => {
    let asked = 0;
    await renderApp(initial, () => { asked += 1; return { ok: true, json: async () => ({}) }; });
    const textarea = await openForm();
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true, keyCode: 229 });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(asked).toBe(0);
    expect(screen.getByRole('textbox', { name: /aside question/i })).toBe(textarea);
  });

  it('from the keyboard: the message\'s own "ask aside" opens the form quoting it, and the quote can be trimmed', async () => {
    let asideBody: any = null;
    await renderApp(initial, (body) => {
      asideBody = body;
      return { ok: true, json: async () => ({ part: {
        type: 'data-aside', id: 'aside-2',
        data: { asideId: 'aside-2', question: body.question, answer: 'trimmed answer', sources: [], vaultPages: [], fromMemory: true, createdAt: '2026-09-22T00:00:00.000Z' },
      } }) };
    });
    fireEvent.click(screen.getByRole('button', { name: 'ask aside about this answer' }));
    const quote = await screen.findByRole('textbox', { name: 'quoted passage' }) as HTMLTextAreaElement;
    expect(quote.value).toBe(ASSISTANT_TEXT);
    fireEvent.change(quote, { target: { value: 'two x' } });
    fireEvent.change(screen.getByRole('textbox', { name: /aside question/i }), { target: { value: 'why two?' } });
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    expect(await screen.findByText('trimmed answer')).not.toBeNull();
    expect(asideBody).toMatchObject({ messageId: 'a1', quote: 'two x', question: 'why two?' });
  });
});

// ── `/aside` composer routing (Composer alone, no contenteditable typing needed) ───────────────

function TestComposerHarness({ store, editorHandleRef }: {
  store: ChatStore; editorHandleRef: RefObject<CommandEditorHandle | null>;
}) {
  const runtime = useLocalRuntime({ async run() { return { content: [{ type: 'text' as const, text: 'ok' }] }; } });
  const aui = useAui({ tools: Tools({ toolkit }) });
  return (
    <ChatStoreContext.Provider value={store}>
      <AssistantRuntimeProvider runtime={runtime} aui={aui}>
        <Composer testEditorHandleRef={editorHandleRef} />
      </AssistantRuntimeProvider>
    </ChatStoreContext.Provider>
  );
}

async function renderComposer(initialMessages: UIMessage[]) {
  const store = new ChatStore({
    threadId: 'test', initialMessages, requestContext: () => ({ mode: 'learn', writeUp: false }),
  });
  const editorHandleRef: RefObject<CommandEditorHandle | null> = { current: null };
  render(<TestComposerHarness store={store} editorHandleRef={editorHandleRef} />);
  await waitFor(() => expect(editorHandleRef.current).not.toBeNull());
  return { store, editorHandleRef };
}

describe('/aside — composer routing', () => {
  it('calls askAside against the latest assistant message and never POSTs /api/chat', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url === '/api/aside') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toEqual({ threadId: 'test', messageId: 'a1', question: 'hello' });
        return {
          ok: true,
          json: async () => ({ part: { type: 'data-aside', id: 'x', data: {
            asideId: 'x', question: 'hello', answer: 'answer text', sources: [], vaultPages: [],
            fromMemory: true, createdAt: '2026-09-22T00:00:00.000Z',
          } } }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }));

    const { store, editorHandleRef } = await renderComposer([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello there' }] },
    ]);

    act(() => {
      editorHandleRef.current!.editor.commands.insertContent('hello');
      editorHandleRef.current!.editor.commands.setCommandChip('aside');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(calls).toContain('/api/aside'));
    expect(calls).not.toContain('/api/chat');

    await waitFor(() => {
      const last = store.getState().messages.find((m) => m.id === 'a1')!;
      expect(last.parts.some((p) => p.type === 'data-aside')).toBe(true);
    });
  });

  it('with no assistant message yet, shows the error and sends nothing', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as any; }));

    const { editorHandleRef } = await renderComposer([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ]);

    act(() => {
      editorHandleRef.current!.editor.commands.insertContent('hello');
      editorHandleRef.current!.editor.commands.setCommandChip('aside');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'no tutor message to ask about yet');
    expect(calls).toEqual([]);
  });

  it('refuses an aside with attachments, and keeps the question and files', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as any; }));
    const { editorHandleRef } = await renderComposer([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello there' }] },
    ]);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'diagram.png', { type: 'image/png' })] } });
    await screen.findByText('diagram.png');
    act(() => {
      editorHandleRef.current!.editor.commands.insertContent('what is this?');
      editorHandleRef.current!.editor.commands.setCommandChip('aside');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/can’t carry attachments/);
    expect(calls).toEqual([]);
    expect(screen.getByText('diagram.png')).not.toBeNull();
    expect(editorHandleRef.current!.serialize()).toEqual({ command: 'aside', text: 'what is this?' });
  });

  it('keeps the question in the editor when the aside fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ error: 'the model failed' }) }) as any));
    const { editorHandleRef } = await renderComposer([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello there' }] },
    ]);
    act(() => {
      editorHandleRef.current!.editor.commands.insertContent('why?');
      editorHandleRef.current!.editor.commands.setCommandChip('aside');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toBe('the model failed');
    expect(editorHandleRef.current!.serialize()).toEqual({ command: 'aside', text: 'why?' });
  });
});
