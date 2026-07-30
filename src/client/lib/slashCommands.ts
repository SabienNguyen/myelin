// The composer's slash-command menu entries plus the doc serializer — pure functions over
// ProseMirror JSON, kept out of CommandEditor.tsx so tests can pin the payload shape without
// mounting Tiptap in jsdom.
import { COMMANDS, type Command } from '../../shared/commands.js';

export interface CommandSpec {
  command: Command;
  /** One line under the name in the menu — terse, lowercase-leaning, no mechanics narration. */
  hint: string;
}

/** Menu order: stances first (they persist), then the one-shot machinery routes. */
export const COMMAND_SPECS: CommandSpec[] = [
  { command: 'beginner', hint: 'explain from zero — every term defined, analogies before formalism' },
  { command: 'intermediate', hint: 'assume foundations — connect new ideas to what you know' },
  { command: 'advanced', hint: 'assume fluency — papers first, edge cases up front' },
  { command: 'learn', hint: 'switch to learn mode — teach the next lesson' },
  { command: 'review', hint: 'switch to review mode — re-prove due pages first' },
  { command: 'quiz', hint: 'switch to quiz mode — open with a quiz' },
  { command: 'freeform', hint: 'switch to freeform mode — follow your lead, write pages' },
  { command: 'write', hint: 'write this up as a page — one turn only' },
];

/** Prefix match on the command name; the empty query lists everything. */
export function filterCommands(query: string): CommandSpec[] {
  const q = query.trim().toLowerCase();
  return q === '' ? COMMAND_SPECS : COMMAND_SPECS.filter((s) => s.command.startsWith(q));
}

/** What a send carries — the structured replacement for raw "/beginner …" prose. */
export interface ComposerPayload {
  command?: Command;
  text: string;
}

/** The subset of ProseMirror's JSON shape the serializer walks (editor.getJSON()). */
interface PMNodeJSON {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PMNodeJSON[];
}

/**
 * Doc → { command?, text }: the first command chip contributes `command`, every text node joins
 * into `text` (paragraphs as newlines, then trimmed). The editor enforces at-most-one chip
 * (inserting a second replaces the first), so "first chip wins" here is a backstop for a
 * hand-restored doc, not a policy with two answers.
 */
export function serializeComposerDoc(doc: PMNodeJSON): ComposerPayload {
  let command: Command | undefined;
  const lines: string[] = [];
  for (const block of doc.content ?? []) {
    let line = '';
    for (const node of block.content ?? []) {
      if (node.type === 'commandChip') {
        const c = node.attrs?.command;
        if (command === undefined && typeof c === 'string' && (COMMANDS as readonly string[]).includes(c)) {
          command = c as Command;
        }
      } else if (typeof node.text === 'string') {
        line += node.text;
      }
    }
    lines.push(line);
  }
  const text = lines.join('\n').trim();
  return { ...(command !== undefined ? { command } : {}), text };
}
