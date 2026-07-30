// The composer's input: a minimal Tiptap editor (document/paragraph/text + undo history) whose
// one extra trick is slash commands — typing "/" at the DOCUMENT START (nowhere else, so a
// mid-sentence "/" in prose never false-triggers) opens a floating menu of the commands in
// slashCommands.ts; selecting one inserts an atomic chip node that serializes to the structured
// `{ command, text }` payload chatStore sends. The menu is plain React state driven by
// @tiptap/suggestion's render lifecycle — anchored above the composer with CSS, so no floating-ui
// wiring and no portal.
import { useMemo, useRef, useState, type RefObject } from 'react';
import { Extension, Node, type Editor as TiptapEditor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Placeholder, UndoRedo } from '@tiptap/extensions';
import { PluginKey, TextSelection } from '@tiptap/pm/state';
import { EditorContent, useEditor } from '@tiptap/react';
import { Suggestion } from '@tiptap/suggestion';
import type { Command } from '../../shared/commands.js';
import {
  filterCommands, serializeComposerDoc, type CommandSpec, type ComposerPayload,
} from '../lib/slashCommands.js';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    commandChip: {
      /** Insert the chip for `command` at the document start, replacing any existing chip —
       * the at-most-one-command-per-message rule lives here, not in the menu. */
      setCommandChip: (command: Command) => ReturnType;
    };
  }
}

/** The atomic chip: one inline leaf node per command. `atom: true` means it has no inside for
 * the caret to land in; the Backspace shortcut below makes deleting it a single press. */
const CommandChip = Node.create({
  name: 'commandChip',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  addAttributes() {
    return { command: { default: null } };
  },
  parseHTML() {
    return [{
      tag: 'span[data-command-chip]',
      getAttrs: (el) => ({ command: el.getAttribute('data-command-chip') }),
    }];
  },
  renderHTML({ node }) {
    return ['span', { 'data-command-chip': node.attrs.command, class: 'command-chip' }, `/${node.attrs.command}`];
  },
  addCommands() {
    return {
      setCommandChip: (command) => ({ tr, dispatch, editor }) => {
        if (dispatch) {
          // Walk tr.doc, not editor.state.doc: inside a chain the transaction already carries
          // earlier steps (the suggestion's deleteRange), and stale positions would delete the
          // wrong range. Deleting back-to-front keeps the remaining positions valid.
          const existing: number[] = [];
          tr.doc.descendants((n, pos) => { if (n.type.name === this.name) existing.push(pos); });
          for (const pos of existing.reverse()) tr.delete(pos, pos + 1);
          // Position 1 = the start of the first paragraph's content — the only place the
          // suggestion can trigger, so chip placement and trigger placement agree. Caret lands
          // explicitly AFTER the chip: the mapped selection is not guaranteed to.
          tr.insert(1, editor.schema.nodes[this.name]!.create({ command }));
          tr.setSelection(TextSelection.create(tr.doc, 2));
        }
        return true;
      },
    };
  },
  addKeyboardShortcuts() {
    return {
      // ONE backspace deletes the whole chip. The default chain (selectNodeBackward) would only
      // SELECT the atom on the first press and delete on the second — fine for a mention, wrong
      // for a chip that reads as a single token of the message.
      Backspace: () => this.editor.commands.command(({ state, tr, dispatch }) => {
        const { empty, $from } = state.selection;
        if (!empty) return false;
        const before = $from.nodeBefore;
        if (!before || before.type.name !== this.name) return false;
        if (dispatch) tr.delete($from.pos - before.nodeSize, $from.pos);
        return true;
      }),
    };
  },
});

interface MenuState {
  items: CommandSpec[];
  index: number;
  /** The suggestion's own select callback — calling it runs the configured `command` below
   * (delete the "/query" text, insert the chip) with the plugin's live range. */
  select: (spec: CommandSpec) => void;
}

export interface CommandEditorHandle {
  /** The doc as the send payload. Reading does not clear — submit decides whether to send. */
  serialize(): ComposerPayload;
  clear(): void;
  focus(): void;
  /** The live Tiptap editor. The parent has no use for it today; tests drive content through
   * its commands because jsdom cannot type into a contenteditable. */
  editor: TiptapEditor;
}

/**
 * Props over context on purpose: the parent (Thread.tsx's Composer) owns the form, the Send
 * button, and the attach flow; this component owns only the editable area. `handleRef` is the
 * parent's imperative line to the doc at submit time; `onEnter` fires for a bare Enter
 * (Shift+Enter inserts a paragraph break instead, and Enter with the slash menu open selects).
 */
export function CommandEditor({ handleRef, onEnter, onEmptyChange }: {
  handleRef: RefObject<CommandEditorHandle | null>;
  onEnter: () => void;
  onEmptyChange: (empty: boolean) => void;
}) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Refs, not deps: the extensions are built once (useMemo []) and must always see the current
  // callbacks and menu state — rebuilding extensions would recreate the whole editor.
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;
  const onEmptyRef = useRef(onEmptyChange);
  onEmptyRef.current = onEmptyChange;

  const extensions = useMemo(() => [
    Document, Paragraph, Text, UndoRedo,
    Placeholder.configure({ placeholder: 'Ask your tutor…' }),
    CommandChip,
    Extension.create({
      name: 'composerKeymap',
      addKeyboardShortcuts() {
        return {
          // Defer to the suggestion while its menu is open (returning false lets the plugin's
          // handleKeyDown turn Enter into a selection); otherwise Enter submits.
          Enter: () => {
            if (menuRef.current !== null) return false;
            onEnterRef.current();
            return true;
          },
          'Shift-Enter': () => this.editor.commands.splitBlock(),
        };
      },
    }),
    Extension.create({
      name: 'slashSuggestion',
      addProseMirrorPlugins() {
        return [Suggestion<CommandSpec, CommandSpec>({
          editor: this.editor,
          pluginKey: new PluginKey('slashSuggestion'),
          char: '/',
          startOfLine: true,
          // Document start only — position 1 is the first paragraph's first content position.
          allow: ({ range }) => range.from === 1,
          items: ({ query }) => filterCommands(query),
          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).setCommandChip(props.command).run();
          },
          render: () => ({
            onStart: (p) => setMenu({ items: p.items, index: 0, select: p.command }),
            onUpdate: (p) => setMenu((m) => ({
              items: p.items,
              index: Math.min(m?.index ?? 0, Math.max(0, p.items.length - 1)),
              select: p.command,
            })),
            // Escape is handled by the plugin itself (it exits, which fires onExit).
            onExit: () => setMenu(null),
            onKeyDown: ({ event }) => {
              const m = menuRef.current;
              if (m === null || m.items.length === 0) return false;
              if (event.key === 'ArrowDown') {
                setMenu({ ...m, index: (m.index + 1) % m.items.length });
                return true;
              }
              if (event.key === 'ArrowUp') {
                setMenu({ ...m, index: (m.index - 1 + m.items.length) % m.items.length });
                return true;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                m.select(m.items[m.index]!);
                return true;
              }
              return false;
            },
          }),
        })];
      },
    }),
  ], []);

  const editor = useEditor({
    extensions,
    autofocus: true,
    // jsdom lacks the layout APIs Tiptap's coordinate code touches on immediate render; the
    // browser behavior is identical either way.
    immediatelyRender: false,
    // Explicit textbox role: a bare contenteditable gets NO implicit ARIA role (HTML-AAM), so
    // without this the composer vanishes from the accessibility tree — and from every
    // getByRole('textbox') query. The label carries the old placeholder text so the control
    // reads the same to assistive tech as the textarea it replaced.
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Ask your tutor…',
      },
    },
    onUpdate: ({ editor: e }) => onEmptyRef.current(e.isEmpty),
  });

  // Rebuild the handle every render — cheap, and it always closes over the live editor.
  handleRef.current = editor === null ? null : {
    serialize: () => serializeComposerDoc(editor.getJSON()),
    clear: () => { editor.commands.clearContent(true); onEmptyRef.current(true); },
    focus: () => { editor.commands.focus(); },
    editor,
  };

  const open = menu !== null && menu.items.length > 0;
  return (
    <div className="composer-editor">
      {open && (
        <div className="slash-menu" role="listbox" aria-label="Commands">
          {menu.items.map((s, i) => (
            <button
              key={s.command}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={i === menu.index}
              className={`slash-option${i === menu.index ? ' active' : ''}`}
              // mousedown, not click: the editor must not lose focus (blur closes the suggestion
              // before a click would land).
              onMouseDown={(e) => { e.preventDefault(); menu.select(s); }}
            >
              <span className="slash-name">/{s.command}</span>
              <span className="slash-hint">{s.hint}</span>
            </button>
          ))}
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
