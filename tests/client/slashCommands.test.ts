import { describe, it, expect } from 'vitest';
import { COMMANDS } from '../../src/shared/commands.js';
import { COMMAND_SPECS, filterCommands, serializeComposerDoc } from '../../src/client/lib/slashCommands.js';

// ProseMirror JSON shorthands matching what editor.getJSON() emits.
const chip = (command: string) => ({ type: 'commandChip', attrs: { command } });
const text = (t: string) => ({ type: 'text', text: t });
const para = (...content: object[]) => ({ type: 'paragraph', ...(content.length ? { content } : {}) });
const doc = (...content: object[]) => ({ type: 'doc', content });

describe('COMMAND_SPECS', () => {
  it('offers every wire command exactly once — menu and validation cannot drift', () => {
    expect(COMMAND_SPECS.map((s) => s.command).sort()).toEqual([...COMMANDS].sort());
  });

  it('filterCommands prefix-matches the name; the empty query lists everything', () => {
    expect(filterCommands('')).toEqual(COMMAND_SPECS);
    expect(filterCommands('be').map((s) => s.command)).toEqual(['beginner']);
    expect(filterCommands('BE').map((s) => s.command)).toEqual(['beginner']); // case-blind
    expect(filterCommands('zzz')).toEqual([]);
  });
});

describe('serializeComposerDoc', () => {
  it('chip contributes command, the remaining text is text', () => {
    expect(serializeComposerDoc(doc(para(chip('beginner'), text(' explain limits')))))
      .toEqual({ command: 'beginner', text: 'explain limits' });
  });

  it('text-only doc has no command key at all', () => {
    const out = serializeComposerDoc(doc(para(text('plain question'))));
    expect(out).toEqual({ text: 'plain question' });
    expect('command' in out).toBe(false);
  });

  it('a bare chip serializes to a command with empty text', () => {
    expect(serializeComposerDoc(doc(para(chip('write'))))).toEqual({ command: 'write', text: '' });
  });

  it('paragraphs join as newlines; outer whitespace trims', () => {
    expect(serializeComposerDoc(doc(para(text('  first ')), para(text('second')))))
      .toEqual({ text: 'first \nsecond' });
    expect(serializeComposerDoc(doc(para()))).toEqual({ text: '' }); // the empty editor
  });

  it('an off-vocabulary chip (hand-edited restore) is dropped, not sent', () => {
    expect(serializeComposerDoc(doc(para(chip('sudo'), text('hi'))))).toEqual({ text: 'hi' });
  });
});
