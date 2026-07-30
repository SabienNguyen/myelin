// @vitest-environment jsdom
// CommandEditor in jsdom: mounting works, but jsdom cannot TYPE into a contenteditable — so
// content is driven through the editor's own commands (the handle exposes the instance for
// exactly this), while keyboard behavior (Enter, Backspace, menu navigation) goes through real
// keydown events, which ProseMirror's keymap and the suggestion plugin both handle.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { useRef, type RefObject } from 'react';
import { CommandEditor, type CommandEditorHandle } from '../../src/client/components/CommandEditor.js';

beforeAll(() => {
  // jsdom's Range lacks the layout methods ProseMirror probes while rendering a cursor.
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  Range.prototype.getClientRects ??= () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
});

const noop = () => {};

function Harness({ handleRef, onEnter = noop, onEmptyChange = noop }: {
  handleRef: RefObject<CommandEditorHandle | null>;
  onEnter?: () => void;
  onEmptyChange?: (empty: boolean) => void;
}) {
  return <CommandEditor handleRef={handleRef} onEnter={onEnter} onEmptyChange={onEmptyChange} />;
}

/** Mount and wait for the editor (immediatelyRender: false mounts it in an effect). */
async function mount(over: { onEnter?: () => void; onEmptyChange?: (empty: boolean) => void } = {}) {
  const ref: RefObject<CommandEditorHandle | null> = { current: null };
  const utils = render(<Harness handleRef={ref} {...over} />);
  await waitFor(() => expect(ref.current).not.toBeNull());
  const handle = () => ref.current!;
  const dom = () => utils.container.querySelector('.tiptap') as HTMLElement;
  return { ...utils, handle, dom };
}

describe('CommandEditor', () => {
  it('chip + text serializes to the { command, text } payload; text-only stays command-free', async () => {
    const { handle } = await mount();
    act(() => {
      handle().editor.commands.insertContent('explain limits');
      handle().editor.commands.setCommandChip('beginner');
    });
    expect(handle().serialize()).toEqual({ command: 'beginner', text: 'explain limits' });

    act(() => { handle().clear(); handle().editor.commands.insertContent('plain question'); });
    expect(handle().serialize()).toEqual({ text: 'plain question' });
  });

  it('a second chip replaces the first — never two commands in one message', async () => {
    const { handle } = await mount();
    act(() => {
      handle().editor.commands.setCommandChip('beginner');
      handle().editor.commands.setCommandChip('advanced');
    });
    expect(handle().serialize()).toEqual({ command: 'advanced', text: '' });
    const chips = JSON.stringify(handle().editor.getJSON()).match(/commandChip/g) ?? [];
    expect(chips).toHaveLength(1);
  });

  it('typing "/" at the document start opens the menu; the query filters it; Enter selects', async () => {
    const { handle, dom } = await mount();
    act(() => { handle().editor.commands.insertContent('/'); });
    const listbox = await screen.findByRole('listbox', { name: 'Commands' });
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(8);

    act(() => { handle().editor.commands.insertContent('qu'); });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getByRole('option', { name: /\/quiz/ })).toBeTruthy();

    // Enter with the menu open selects instead of submitting.
    const onEnter = vi.fn();
    fireEvent.keyDown(dom(), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(handle().serialize()).toEqual({ command: 'quiz', text: '' });
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('does NOT trigger on a "/" mid-sentence — document start only', async () => {
    const { handle } = await mount();
    act(() => { handle().editor.commands.insertContent('what is 1'); });
    act(() => { handle().editor.commands.insertContent('/'); });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Enter submits when no menu is open; Escape closes the menu without selecting', async () => {
    const onEnter = vi.fn();
    const { handle, dom } = await mount({ onEnter });
    act(() => { handle().editor.commands.insertContent('hello'); });
    fireEvent.keyDown(dom(), { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledTimes(1);

    act(() => { handle().clear(); handle().editor.commands.insertContent('/'); });
    await screen.findByRole('listbox');
    fireEvent.keyDown(dom(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(handle().serialize()).toEqual({ text: '/' }); // nothing selected, the slash is just text
  });

  it('one Backspace deletes the whole chip', async () => {
    const { handle, dom } = await mount();
    act(() => { handle().editor.commands.setCommandChip('review'); });
    expect(handle().serialize()).toEqual({ command: 'review', text: '' });
    // setCommandChip leaves the caret right after the chip.
    fireEvent.keyDown(dom(), { key: 'Backspace' });
    expect(handle().serialize()).toEqual({ text: '' });
  });
});
