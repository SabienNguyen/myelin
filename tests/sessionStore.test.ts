import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveThread, loadThread, listThreads, deleteThread, addPartToMessage,
} from '../src/server/sessionStore.js';

const makeVault = () => {
  const vault = mkdtempSync(join(tmpdir(), 'lwh-vault-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  writeFileSync(join(vault, 'pages', 'target.md'), 'vault page — must never be touched by the harness');
  return vault;
};

describe('sessionStore threadId validation (single-writer invariant)', () => {
  it('rejects path-traversal threadIds in saveThread and writes nothing outside .harness/sessions', () => {
    const vault = makeVault();
    expect(() => saveThread(vault, '../evil', [{ hi: true }])).toThrow(/threadId/);
    expect(() => saveThread(vault, '../pages/target', [])).toThrow(/threadId/);
    expect(existsSync(join(vault, 'evil.json'))).toBe(false);
    expect(existsSync(join(vault, '.harness', 'evil.json'))).toBe(false);
    // the vault page is untouched
    expect(readFileSync(join(vault, 'pages', 'target.md'), 'utf8')).toMatch(/never be touched/);
  });

  it('rejects traversal, separators, and over-long ids in loadThread too', () => {
    const vault = makeVault();
    expect(() => loadThread(vault, '../pages/target.md')).toThrow(/threadId/);
    expect(() => loadThread(vault, 'a/b')).toThrow(/threadId/);
    expect(() => loadThread(vault, '')).toThrow(/threadId/);
    expect(() => loadThread(vault, 'x'.repeat(65))).toThrow(/threadId/);
  });

  it('still round-trips a valid threadId', () => {
    const vault = makeVault();
    saveThread(vault, 'default_thread-1', [{ id: 'u1' }]);
    expect(loadThread(vault, 'default_thread-1')).toEqual([{ id: 'u1' }]);
    expect(existsSync(join(vault, '.harness', 'sessions', 'default_thread-1.json'))).toBe(true);
  });
});

describe('loadThread / saveThread — corrupt-file and duplicate-id hardening', () => {
  // Regression: a saved thread that (however it happened) contains two messages sharing an `id`
  // used to reach assistant-ui's MessageRepository unchanged, which throws "A message with the
  // same id already exists" while restoring and blanks the ENTIRE app at mount.

  it('loadThread dedupes messages with the same id, keeping the LAST occurrence, order preserved', () => {
    const vault = makeVault();
    const sessionsDir = join(vault, '.harness', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const onDisk = [
      { id: 'u1', v: 'first-copy' },
      { id: 'a1', v: 'only-a1' },
      { id: 'u1', v: 'second-copy' }, // duplicate of u1 — the more complete re-persist
    ];
    writeFileSync(join(sessionsDir, 'dupes.json'), JSON.stringify(onDisk));

    const loaded = loadThread(vault, 'dupes');
    expect(loaded).toEqual([
      { id: 'a1', v: 'only-a1' },
      { id: 'u1', v: 'second-copy' },
    ]);
  });

  it('loadThread returns [] for a file containing invalid JSON, instead of throwing', () => {
    const vault = makeVault();
    const sessionsDir = join(vault, '.harness', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'broken.json'), '{not valid json');

    expect(loadThread(vault, 'broken')).toEqual([]);
  });

  it('loadThread returns [] for a file containing a JSON object (non-array)', () => {
    const vault = makeVault();
    const sessionsDir = join(vault, '.harness', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'notarray.json'), JSON.stringify({ oops: 'this is an object' }));

    expect(loadThread(vault, 'notarray')).toEqual([]);
  });

  it('saveThread dedupes duplicate ids before writing, so the file on disk is already clean', () => {
    const vault = makeVault();
    saveThread(vault, 'willdupe', [
      { id: 'u1', v: 'stale' },
      { id: 'u1', v: 'fresh' },
      { id: 'a1', v: 'unique' },
    ]);

    const onDisk = JSON.parse(readFileSync(join(vault, '.harness', 'sessions', 'willdupe.json'), 'utf8'));
    expect(onDisk).toEqual([
      { id: 'u1', v: 'fresh' },
      { id: 'a1', v: 'unique' },
    ]);
  });
});

// Two tabs on the same thread each PUT their own view. A blind replace let the staler tab
// silently erase the other tab's whole exchange (found by a live two-tab probe) — saveThread
// merges by id instead. Threads only grow (no edit/branch UI), so union loses nothing.
describe('saveThread — concurrent-writer merge', () => {
  it('a stale writer cannot erase messages it never saw', () => {
    const vault = makeVault();
    saveThread(vault, 't', [{ id: 'a1', v: 'tab A user' }, { id: 'a2', v: 'tab A reply' }]);
    // Tab B loaded before A's exchange existed; its view has only its own turn.
    saveThread(vault, 't', [{ id: 'b1', v: 'tab B user' }, { id: 'b2', v: 'tab B reply' }]);
    expect(loadThread(vault, 't')).toEqual([
      { id: 'a1', v: 'tab A user' }, { id: 'a2', v: 'tab A reply' },
      { id: 'b1', v: 'tab B user' }, { id: 'b2', v: 'tab B reply' },
    ]);
  });

  it('the normal single-tab flow is unchanged: a superset write IS the file, fresher versions win', () => {
    const vault = makeVault();
    saveThread(vault, 't', [{ id: 'u1', v: 'user' }, { id: 'as1', v: 'streaming…' }]);
    saveThread(vault, 't', [{ id: 'u1', v: 'user' }, { id: 'as1', v: 'final text' }, { id: 'u2', v: 'next' }]);
    expect(loadThread(vault, 't')).toEqual([
      { id: 'u1', v: 'user' }, { id: 'as1', v: 'final text' }, { id: 'u2', v: 'next' },
    ]);
  });
});

// shared/messages.ts deliberately supports messages without a string `id` — dedupeById never
// matches one against anything. The merge above used to key its map on the raw `m?.id`, so
// `undefined` was a live key: every id-less message in a write folded onto the last of them, and
// an id-less message already on disk was replaced by whichever one the writer happened to send.
// The writers hand saveThread unvalidated client JSON, and the thread file is the one artifact
// the learner cannot regenerate.
describe('saveThread — id-less messages are never merged onto each other', () => {
  it('keeps every id-less message in a single write instead of folding them into the last one', () => {
    const vault = makeVault();
    const idless = [{ role: 'user', v: 'first' }, { role: 'assistant', v: 'second' }];
    saveThread(vault, 't', idless);
    saveThread(vault, 't', idless); // the same view re-persisted, as a second tab or a retry does

    // Pinned exactly, not with toContain: an id-less message cannot be matched against the file,
    // so re-persisting the same view appends rather than updating in place. That duplication is
    // the accepted cost of never folding two distinct messages into one, and a loose assertion
    // would let a regression back to folding slip through.
    const out = loadThread(vault, 't') as any[];
    expect(out.map((m) => m.v)).toEqual(['first', 'second', 'first', 'second']);
  });

  it('does not let an id-less message from the writer overwrite a different one on disk', () => {
    const vault = makeVault();
    saveThread(vault, 't', [{ role: 'user', v: 'the question the learner actually asked' }]);
    saveThread(vault, 't', [{ role: 'assistant', v: 'a later turn, also id-less' }]);

    const out = loadThread(vault, 't') as any[];
    expect(out.map((m) => m.v)).toEqual([
      'the question the learner actually asked',
      'a later turn, also id-less',
    ]);
  });

  it('treats a non-string id as id-less, exactly as dedupeById does', () => {
    const vault = makeVault();
    saveThread(vault, 't', [{ id: 7, v: 'numeric id on disk' }]);
    saveThread(vault, 't', [{ id: 7, v: 'unrelated message, same numeric id' }]);

    const out = loadThread(vault, 't') as any[];
    expect(out.map((m) => m.v)).toEqual(['numeric id on disk', 'unrelated message, same numeric id']);
  });

  it('still merges string ids in place, with id-less neighbours present', () => {
    const vault = makeVault();
    saveThread(vault, 't', [{ v: 'id-less opener' }, { id: 'a1', v: 'streaming…' }]);
    saveThread(vault, 't', [{ id: 'a1', v: 'final text' }]);

    const out = loadThread(vault, 't') as any[];
    expect(out.map((m) => m.v)).toEqual(['id-less opener', 'final text']);
  });
});

describe('listThreads', () => {
  it('returns [] when no sessions dir exists yet', () => {
    const vault = makeVault();
    expect(listThreads(vault)).toEqual([]);
  });

  it('titles from the first user message text, newest first, skipping a corrupt file', () => {
    const vault = makeVault();
    saveThread(vault, 'older', [{ role: 'user', parts: [{ type: 'text', text: 'What is a derivative?' }] }]);
    const olderPath = join(vault, '.harness', 'sessions', 'older.json');
    const past = new Date(Date.now() - 60_000);
    utimesSync(olderPath, past, past);

    saveThread(vault, 'newer', [
      { role: 'assistant', parts: [{ type: 'text', text: 'ignored, not a user message' }] },
      { role: 'user', parts: [{ type: 'text', text: 'Help me with fractions' }] },
    ]);
    writeFileSync(join(vault, '.harness', 'sessions', 'corrupt.json'), '{not json');

    const threads = listThreads(vault);
    expect(threads.map((t) => t.id)).toEqual(['newer', 'older']);
    expect(threads[0].title).toBe('Help me with fractions');
    expect(threads[0].messages).toBe(2);
    expect(threads[1].title).toBe('What is a derivative?');
    expect(threads.some((t) => t.id === 'corrupt')).toBe(false);
    expect(new Date(threads[0].updatedAt).getTime()).toBeGreaterThan(new Date(threads[1].updatedAt).getTime());
  });

  it('falls back to the thread id when there is no user text', () => {
    const vault = makeVault();
    saveThread(vault, 'no-user-text', []);
    const threads = listThreads(vault);
    expect(threads[0].title).toBe('no-user-text');
  });

  it('titles from the first sentence when it is a real one', () => {
    const vault = makeVault();
    saveThread(vault, 't-studio', [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Quiz me across Calculus I. One question per page, mixed in order: Limits, Derivatives, Chain rule.' }] }]);
    saveThread(vault, 't-short', [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Why? Because the derivative is a limit of slopes, and I want to see it.' }] }]);
    const byId = Object.fromEntries(listThreads(vault).map((t) => [t.id, t.title]));
    expect(byId['t-studio']).toBe('Quiz me across Calculus I.');
    // "Why?" is too short to stand as a title, so the opening keeps going.
    expect(byId['t-short']).toBe('Why? Because the derivative is a limit of slopes, and I want…');
  });

  it('does not end a title at an abbreviation or a lowercase continuation, and knows CJK stops', () => {
    const vault = makeVault();
    const say = (id: string, text: string) => saveThread(vault, id, [{ id: 'u', role: 'user', parts: [{ type: 'text', text }] }]);
    say('t-eg', 'Explain limits, e.g. what x approaches. Then derivatives.');
    say('t-lower', 'Walk me through v. 2 of the proof. Slowly please.');
    say('t-cjk', '什么是导数和极限的关系呢？请详细解释一下这个概念的定义');
    const byId = Object.fromEntries(listThreads(vault).map((t) => [t.id, t.title]));
    expect(byId['t-eg']).toBe('Explain limits, e.g. what x approaches.');
    expect(byId['t-lower']).toBe('Walk me through v. 2 of the proof.');
    expect(byId['t-cjk']).toBe('什么是导数和极限的关系呢？');
  });

  it('cuts a long title on a code point, never inside a surrogate pair', () => {
    const vault = makeVault();
    saveThread(vault, 'astral', [{ role: 'user', parts: [{ type: 'text', text: `${'x'.repeat(59)}${'\u{1D4B3}'.repeat(10)}` }] }]);
    const [t] = listThreads(vault);
    expect(t.title).toBe(`${'x'.repeat(59)}\u{1D4B3}…`);
    expect(t.title.isWellFormed()).toBe(true);
  });

  it('trims long titles to ~60 chars', () => {
    const vault = makeVault();
    saveThread(vault, 'longone', [{ role: 'user', parts: [{ type: 'text', text: 'x'.repeat(120) }] }]);
    const threads = listThreads(vault);
    expect(threads[0].title.length).toBeLessThanOrEqual(61);
  });
});

describe('deleteThread', () => {
  it('removes a valid thread file', () => {
    const vault = makeVault();
    saveThread(vault, 'todelete', [{ id: 'u1' }]);
    deleteThread(vault, 'todelete');
    expect(existsSync(join(vault, '.harness', 'sessions', 'todelete.json'))).toBe(false);
  });

  it('rejects an invalid threadId and touches nothing', () => {
    const vault = makeVault();
    expect(() => deleteThread(vault, '../pages/target')).toThrow(/threadId/);
    expect(readFileSync(join(vault, 'pages', 'target.md'), 'utf8')).toMatch(/never be touched/);
  });

  it('is a no-op for a missing (but validly-named) thread', () => {
    const vault = makeVault();
    expect(() => deleteThread(vault, 'doesnotexist')).not.toThrow();
  });
});

// asideRoute.ts persists a `data-aside` part outside the normal chat-turn save (addPartToMessage),
// after the message it anchors to already exists. A browser tab that snapshotted the message
// before the aside landed then PUTs its own (aside-less) copy back — saveThread's ordinary
// "incoming replaces disk, same position" rule would silently erase the aside the moment that
// stale save lands, which is exactly the loss union-by-id already exists to prevent for whole
// messages.
describe('addPartToMessage + saveThread — a data-aside part survives a later save that lacks it', () => {
  it('addPartToMessage adds a part to the right message, replacing a same-id part in place', () => {
    const vault = makeVault();
    saveThread(vault, 't', [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }]);

    addPartToMessage(vault, 't', 'a1', { type: 'data-aside', id: 'aside-1', data: { answer: 'first' } });
    let out = loadThread(vault, 't') as any[];
    expect(out[0].parts).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'data-aside', id: 'aside-1', data: { answer: 'first' } },
    ]);

    // Asking again about the same aside updates it in place rather than duplicating it.
    addPartToMessage(vault, 't', 'a1', { type: 'data-aside', id: 'aside-1', data: { answer: 'revised' } });
    out = loadThread(vault, 't') as any[];
    expect(out[0].parts).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'data-aside', id: 'aside-1', data: { answer: 'revised' } },
    ]);
  });

  it('throws for an unknown messageId rather than silently doing nothing', () => {
    const vault = makeVault();
    saveThread(vault, 't', [{ id: 'a1', role: 'assistant', parts: [] }]);
    expect(() => addPartToMessage(vault, 't', 'no-such-message', { type: 'data-aside', id: 'x', data: {} }))
      .toThrow(/no-such-message/);
  });

  it('a later client save of the anchored message WITHOUT the aside part keeps it on disk', () => {
    const vault = makeVault();
    saveThread(vault, 't', [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'question' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
    ]);
    addPartToMessage(vault, 't', 'a1', { type: 'data-aside', id: 'aside-1', data: { answer: 'aside answer' } });

    // A tab that snapshotted BEFORE the aside landed sends its own view back — no data-aside part.
    saveThread(vault, 't', [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'question' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
    ]);

    const out = loadThread(vault, 't') as any[];
    const anchor = out.find((m) => m.id === 'a1');
    expect(anchor.parts).toContainEqual({ type: 'data-aside', id: 'aside-1', data: { answer: 'aside answer' } });
  });

  it('a save that DOES carry the aside part (e.g. echoing it back) is not duplicated', () => {
    const vault = makeVault();
    saveThread(vault, 't', [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] }]);
    addPartToMessage(vault, 't', 'a1', { type: 'data-aside', id: 'aside-1', data: { answer: 'v1' } });

    saveThread(vault, 't', [
      {
        id: 'a1', role: 'assistant',
        parts: [{ type: 'text', text: 'answer' }, { type: 'data-aside', id: 'aside-1', data: { answer: 'v1' } }],
      },
    ]);

    const out = loadThread(vault, 't') as any[];
    const asideParts = out.find((m) => m.id === 'a1').parts.filter((p: any) => p.type === 'data-aside');
    expect(asideParts).toHaveLength(1);
  });
});

/**
 * A late writer must never reorder recorded history. The merge used to place messages the writer
 * had not seen in FRONT, so a turn that finished after the learner had already asked something
 * else pushed the newer exchange ahead of the older one — a transcript reading "what is a
 * decorator?" before the question asked minutes before it.
 */
describe('the thread merge preserves disk order', () => {
  it('appends a late writer\'s view instead of jumping it to the front', () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-order-'));
    // The conversation as it actually happened.
    saveThread(vault, 't', [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first question' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'second question' }] },
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'answer two' }] },
    ]);
    // A detached turn-1 lands late, knowing only its own two messages.
    saveThread(vault, 't', [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first question' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'the FULL answer one' }] },
    ]);
    const out = loadThread(vault, 't') as any[];
    expect(out.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']); // order unchanged
    // ...and the late writer's fresher content replaced the stub, in place.
    expect(JSON.stringify(out[1])).toContain('the FULL answer one');
  });

  it('still keeps content a writer never saw', () => {
    const vault = mkdtempSync(join(tmpdir(), 'lwh-order2-'));
    saveThread(vault, 't', [{ id: 'a', role: 'user', parts: [] }, { id: 'b', role: 'assistant', parts: [] }]);
    saveThread(vault, 't', [{ id: 'c', role: 'user', parts: [] }]);
    expect((loadThread(vault, 't') as any[]).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});
