import { describe, it, expect } from 'vitest';
import { learnerText, matchPages } from '../../src/client/lib/conversationTopic.js';
import type { UIMessage } from '../../src/shared/uiMessages.js';

// A real vault's titles and the conversation that found This topic empty: four questions answered
// from web search alone, no page opened or written.
const pages = [
  { slug: 'inference', title: 'Inference infrastructure engineering: a learning path for serving models' },
  { slug: 'focus', title: 'Focus as directing and returning attention' },
  { slug: 'flow-supports', title: 'Flow Supports Learning, but Does Not Prove It' },
  { slug: 'flow-immersive', title: 'Flow: immersive engagement and enabling conditions' },
  { slug: 'retrieval', title: 'Retrieval Practice for Durable Learning' },
  { slug: 'rust-ownership', title: 'Rust Ownership and Moves' },
  { slug: 'rust-borrowing', title: 'Rust Borrowing and Slices' },
  { slug: 'rust-lifetimes', title: 'Rust Lifetimes' },
];
const asked = ['hey', 'tell me about focus', 'and flow state', 'how can learning and flow be put together',
  'is flow counterproductive to learning?'].join('\n');

describe('matchPages', () => {
  it('finds the pages a conversation is about, and not a subject that only shares "learning"', () => {
    const matched = matchPages(asked, pages);
    expect(matched[0]).toBe('flow-supports');
    expect(new Set(matched)).toEqual(new Set(['flow-supports', 'focus', 'flow-immersive']));
  });

  it('matches nothing for small talk', () => {
    expect(matchPages('hey\nthanks', pages)).toEqual([]);
  });

  it('matches a plural to its singular title word', () => {
    expect(matchPages('what are lifetimes in rust', pages)[0]).toBe('rust-lifetimes');
  });
});

describe('learnerText', () => {
  it('reads only what the learner typed', () => {
    const messages = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'tell me about focus' }] },
      { id: '2', role: 'assistant', parts: [{ type: 'text', text: 'Rust ownership is…' }] },
    ] as UIMessage[];
    expect(learnerText(messages)).toBe('tell me about focus');
  });
});
