import { describe, it, expect } from 'vitest';
import { threadTopic, vaultGap } from '../src/server/session.js';
import type { UIMessage } from '../src/shared/uiMessages.js';

// A continuation turn ("ok", "next", "sure") carries no topic tokens, so the old vaultGap always
// returned null for it — even when the thread's current page is a stub, unsourced, or too thin to
// teach from. That let a tutor write an ungrounded umbrella page once, then teach three more
// concepts off it forever, because every "lets go!" read as "nothing to check". threadTopic finds
// what the thread is actually about — the slug of the most recent record_evidence/write_page/
// read_page tool call — so vaultGap can check THAT page instead of giving up.

const userSays = (text: string): UIMessage => ({ id: 'u', role: 'user', parts: [{ type: 'text', text }] });

const toolPart = (name: string, input: unknown): UIMessage => ({
  id: `a-${name}`,
  role: 'assistant',
  parts: [{ type: `tool-${name}`, toolCallId: `c-${name}`, state: 'output-available', input }],
});

describe('threadTopic', () => {
  it('is null when the thread has no record_evidence, write_page or read_page call', () => {
    expect(threadTopic([userSays('hi')])).toBeNull();
  });

  it('reads the slug off a record_evidence call', () => {
    const messages = [userSays('teach me x'), toolPart('record_evidence', { slug: 'inference-batching' })];
    expect(threadTopic(messages)).toBe('inference-batching');
  });

  it('reads the slug off a write_page call', () => {
    const messages = [toolPart('write_page', { slug: 'queue-latency' })];
    expect(threadTopic(messages)).toBe('queue-latency');
  });

  it('reads the slug off a read_page call', () => {
    const messages = [toolPart('read_page', { slug: 'request-lifecycle' })];
    expect(threadTopic(messages)).toBe('request-lifecycle');
  });

  it('takes the LAST topic-bearing tool part by message order, not the first', () => {
    const messages = [
      toolPart('read_page', { slug: 'batching' }),
      userSays('ok now the queue'),
      toolPart('write_page', { slug: 'queue-latency' }),
    ];
    expect(threadTopic(messages)).toBe('queue-latency');
  });

  it('ignores tool parts whose input has no string slug', () => {
    const messages = [
      toolPart('record_evidence', { slug: 'batching' }),
      toolPart('search', { query: 'batching' }),
      toolPart('record_evidence', { misconception: 'no slug here' }),
    ];
    expect(threadTopic(messages)).toBe('batching');
  });

  it('skips a call that failed, whether the loop or engram reported it', () => {
    const failed = (name: string, slug: string, part: object): UIMessage => ({
      id: `f-${slug}`, role: 'assistant',
      parts: [{ type: `tool-${name}`, toolCallId: `f-${slug}`, input: { slug }, ...part }] as any,
    });
    const messages = [
      toolPart('read_page', { slug: 'batching' }),
      failed('read_page', 'zz-nonexistent-page', { state: 'output-available', output: { isError: true, content: [] } }),
      failed('record_evidence', 'made-up', { state: 'output-error', errorText: 'page not found' }),
    ];
    expect(threadTopic(messages)).toBe('batching');
  });

  it('ignores unrelated tool calls entirely', () => {
    const messages = [toolPart('search', { query: 'inference infra' })];
    expect(threadTopic(messages)).toBeNull();
  });
});

describe('vaultGap falls back to the thread topic on a continuation turn', () => {
  const messagesOn = (slug: string) => [
    userSays('teach me inference infra'),
    toolPart('write_page', { slug }),
    userSays('lets go!'),
  ];

  it('returns null (not empty-vault/no-page) when there is no thread topic either', async () => {
    let searched = false;
    const gap = await vaultGap('learn', [userSays('ok')], ['some-other-page'], {
      search: async () => { searched = true; return []; },
      readPage: async () => ({ meta: {}, body: '' }),
    });
    expect(gap).toBeNull();
    expect(searched).toBe(false);
  });

  it('does not call search when falling back to the thread topic', async () => {
    let searched = false;
    await vaultGap('learn', messagesOn('inference-infra-overview'), ['inference-infra-overview'], {
      search: async () => { searched = true; return []; },
      readPage: async () => ({ meta: { sources: [] }, body: 'x'.repeat(500) }),
    });
    expect(searched).toBe(false);
  });

  it('flags the current-topic page as unsourced when it cites nothing', async () => {
    const gap = await vaultGap('learn', messagesOn('inference-infra-overview'), ['inference-infra-overview'], {
      search: async () => [],
      readPage: async (slug) => {
        expect(slug).toBe('inference-infra-overview');
        return { meta: { sources: [] }, body: 'x'.repeat(500) };
      },
    });
    expect(gap).toEqual({
      reason: 'unsourced',
      slug: 'inference-infra-overview',
      detail: expect.stringContaining('inference-infra-overview'),
    });
    expect(gap?.detail).toMatch(/current topic|lesson/i);
  });

  it('flags the current-topic page as a stub', async () => {
    const gap = await vaultGap('learn', messagesOn('batching'), ['batching'], {
      search: async () => [],
      readPage: async () => ({ meta: { status: 'stub', sources: [] }, body: '' }),
    });
    expect(gap?.reason).toBe('stub');
    expect(gap?.slug).toBe('batching');
  });

  it('flags the current-topic page as thin', async () => {
    const gap = await vaultGap('learn', messagesOn('batching'), ['batching'], {
      search: async () => [],
      readPage: async () => ({ meta: { sources: ['https://example.com'] }, body: 'short' }),
    });
    expect(gap?.reason).toBe('thin');
    expect(gap?.slug).toBe('batching');
  });

  it('returns null when the current-topic page is solid: sourced, not a stub, not thin', async () => {
    const gap = await vaultGap('learn', messagesOn('batching'), ['batching'], {
      search: async () => [],
      readPage: async () => ({
        meta: { sources: ['https://example.com'] },
        body: 'x'.repeat(500),
      }),
    });
    expect(gap).toBeNull();
  });

  it('treats a read-page failure on the fallback as covered, and logs it', async () => {
    const errors: unknown[][] = [];
    const spy = (...args: unknown[]) => { errors.push(args); };
    const original = console.error;
    console.error = spy as typeof console.error;
    try {
      const gap = await vaultGap('learn', messagesOn('batching'), ['batching'], {
        search: async () => [],
        readPage: async () => { throw new Error('engram unreachable'); },
      });
      expect(gap).toBeNull();
      expect(errors.length).toBe(1);
      expect(String(errors[0]?.[0])).toContain('[vault-gap]');
    } finally {
      console.error = original;
    }
  });

  it('still checks progress questions and bare greetings before falling back to a topic', async () => {
    let searched = false;
    let read = false;
    const gap = await vaultGap('learn', [
      ...messagesOn('batching'),
      userSays('hi'),
    ], ['batching'], {
      search: async () => { searched = true; return []; },
      readPage: async () => { read = true; return { meta: { status: 'stub', sources: [] }, body: '' }; },
    });
    expect(gap).toBeNull();
    expect(searched).toBe(false);
    expect(read).toBe(false);
  });
});
