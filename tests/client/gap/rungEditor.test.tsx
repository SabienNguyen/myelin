// @vitest-environment jsdom
//
// RungEditor v2 (docs/superpowers/plans/2026-07-21-coding-stage.md, "whole-file IDE"): mounts the
// REAL RungEditor (real CM6, not the CodeExercise.tsx `Editor` prop stub — see that file's top
// comment on why jsdom mounting real CM6 is fine, it's only *keystroke* simulation into a
// contentEditable that's fragile). Replaces the old three-stacked-pane continuous-line-numbering
// suite entirely — see this file's git history for that version — with coverage for the single-
// doc world: scaffold loads verbatim, natural line numbers (no offset arithmetic left to test),
// the marker highlight appears/disappears, edit-anywhere (including inside the pre/post regions
// the old read-only panes used to lock), draft restore, and the Ctrl/Cmd+Enter run keymap.
//
// Whole-doc replace, jsdom-side: a real browser keeps document.getSelection() and CM6's own
// view.state.selection in sync via native contentEditable + selectionchange plumbing, so the
// e2e suite (tests/e2e/gap-exercise.e2e.ts) can select-all via the DOM Selection API and paste.
// jsdom's Selection/Range implementation over contentEditable does NOT feed back into CM6's model
// the same way (confirmed empirically — a DOM-only select-all-then-paste here just inserts at
// CM6's untouched default cursor position instead of replacing), so replaceWholeDoc below drives
// the view directly via EditorView.findFromDOM + view.dispatch — still the real CM6
// transaction/update pipeline (onDocChange, draft autosave, the marker decoration all fire exactly
// as they would from a real edit), just reached without depending on jsdom's incomplete
// Selection<->contentEditable sync.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { RungEditor } from '../../../src/client/components/blocks/gap/RungEditor.js';
import { gapDraftKey, saveDraft, loadDraft } from '../../../src/client/components/blocks/gap/draftStorage.js';

// Node 22+'s own lazy `globalThis.localStorage` getter shadows jsdom's working implementation
// without `--localstorage-file` (see tests/client/gap/draftStorage.test.ts's top comment) — same
// in-memory Storage stub, stubbed fresh per test.
function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  } as Storage;
}

beforeEach(() => { vi.stubGlobal('localStorage', makeMemoryStorage()); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SCAFFOLD = [
  'function consumeStream(response) {',
  '  // ── YOUR TURN ─────────────────────────────────────',
  '  // Implement the body of consumeStream.',
  '  // ──────────────────────────────────────────────────',
  '}',
].join('\n');

function lineNumberTexts(container: HTMLElement): string[] {
  // CM6's gutter renders one extra `.cm-gutterElement` — a `visibility: hidden` width-reserving
  // spacer sized off the max line number (see @codemirror/view's SingleGutterView) — ahead of the
  // real per-line markers. Same selector/class as the real ones, so filter by that inline style.
  return Array.from(container.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement'))
    .filter((el) => el.style.visibility !== 'hidden')
    .map((el) => el.textContent ?? '');
}

function markerLineTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.cm-your-turn-marker'))
    .map((el) => el.textContent ?? '');
}

// See this file's top comment on why this drives the view directly rather than a synthetic paste.
function replaceWholeDoc(pane: HTMLElement, text: string): void {
  const view = EditorView.findFromDOM(pane);
  if (!view) throw new Error('EditorView.findFromDOM found nothing — is `pane` the editor container?');
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

describe('RungEditor v2 — one whole-file editor', () => {
  it('loads the scaffold verbatim as one continuous, naturally-numbered document', () => {
    const { container } = render(<RungEditor scaffold={SCAFFOLD} onDocChange={() => {}} />);

    const pane = container.querySelector('[data-testid="gap-editor"]')!;
    expect(pane.querySelector('.cm-content')!.textContent).toBe(SCAFFOLD.replace(/\n/g, ''));
    // 5 lines, numbered 1..5 from the top — no per-pane offset arithmetic left in this world.
    expect(lineNumberTexts(container)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('highlights the marker\'s own contiguous comment lines, nothing else', () => {
    const { container } = render(<RungEditor scaffold={SCAFFOLD} onDocChange={() => {}} />);

    expect(markerLineTexts(container)).toEqual([
      '  // ── YOUR TURN ─────────────────────────────────────',
      '  // Implement the body of consumeStream.',
      '  // ──────────────────────────────────────────────────',
    ]);
  });

  it('reports the resolved starting doc to the caller immediately on mount, before any edit', () => {
    const seen: string[] = [];
    render(<RungEditor scaffold={SCAFFOLD} onDocChange={(doc) => seen.push(doc)} />);
    expect(seen).toEqual([SCAFFOLD]);
  });

  it('is editable everywhere — including text the old read-only pre/post panes used to lock', () => {
    const seen: string[] = [];
    const { container } = render(<RungEditor scaffold={SCAFFOLD} onDocChange={(doc) => seen.push(doc)} />);
    const pane = container.querySelector('[data-testid="gap-editor"]')!;

    const rewritten = [
      'function consumeStream(response) {',
      '  return doTheWork(response);',
      '}',
    ].join('\n');
    replaceWholeDoc(pane as HTMLElement, rewritten);

    expect(seen.at(-1)).toBe(rewritten);
    expect(pane.querySelector('.cm-content')!.textContent).toBe(rewritten.replace(/\n/g, ''));
  });

  it('the highlight disappears once the learner edits the marker away — never restored', () => {
    const { container } = render(<RungEditor scaffold={SCAFFOLD} onDocChange={() => {}} />);
    const pane = container.querySelector('[data-testid="gap-editor"]')!;

    expect(markerLineTexts(container).length).toBeGreaterThan(0);

    replaceWholeDoc(pane as HTMLElement, 'function consumeStream(response) {\n  return null;\n}');

    expect(markerLineTexts(container)).toEqual([]);
  });

  it('restores a saved draft over the scaffold on mount, and reports the DRAFT (not the scaffold) immediately', () => {
    const key = gapDraftKey('stream-consumer', 'full_body');
    const draft = 'function consumeStream(response) {\n  return already.written;\n}';
    saveDraft(key, draft);

    const seen: string[] = [];
    const { container } = render(
      <RungEditor scaffold={SCAFFOLD} onDocChange={(doc) => seen.push(doc)} draftKey={key} />,
    );

    expect(container.querySelector('.cm-content')!.textContent).toBe(draft.replace(/\n/g, ''));
    expect(seen).toEqual([draft]);
  });

  it('autosaves edits under draftKey', () => {
    const key = gapDraftKey('stream-consumer', 'full_body');
    const { container } = render(<RungEditor scaffold={SCAFFOLD} onDocChange={() => {}} draftKey={key} />);
    const pane = container.querySelector('[data-testid="gap-editor"]')!;

    const edited = 'function consumeStream(response) {\n  return 1;\n}';
    replaceWholeDoc(pane as HTMLElement, edited);

    expect(loadDraft(key)).toBe(edited);
  });

  it('does not persist a draft for the mount-time sync alone — only real edits autosave', () => {
    const key = gapDraftKey('stream-consumer', 'full_body');
    render(<RungEditor scaffold={SCAFFOLD} onDocChange={() => {}} draftKey={key} />);
    expect(loadDraft(key)).toBeUndefined();
  });

  it('Ctrl-Enter and Cmd-Enter both fire onRunRequest (not swallowed by basicSetup\'s Mod-Enter -> insertBlankLine)', () => {
    let runs = 0;
    const { container } = render(
      <RungEditor scaffold={SCAFFOLD} onDocChange={() => {}} onRunRequest={() => { runs += 1; }} />,
    );
    const content = container.querySelector('[data-testid="gap-editor"] .cm-content') as HTMLElement;
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    expect(runs).toBe(2);
    // And the doc itself is untouched — insertBlankLine did NOT sneak a blank line in.
    expect(content.textContent).toBe(SCAFFOLD.replace(/\n/g, ''));
  });
});
