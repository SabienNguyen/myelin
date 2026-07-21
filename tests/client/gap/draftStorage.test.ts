// @vitest-environment jsdom
//
// Node 22+ defines its own lazy `globalThis.localStorage` getter (the Web Storage API, gated
// behind `--localstorage-file`) that vitest's jsdom environment does not appear to override —
// accessing it here without the flag prints an ExperimentalWarning and returns `undefined`,
// shadowing jsdom's own working implementation. draftStorage.ts targets the real browser (where
// `window.localStorage` always works), so this file stubs in a small real Storage-like object for
// the duration of these tests rather than relying on the ambient global.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gapDraftKey, loadDraft, saveDraft, clearDraft } from '../../../src/client/components/blocks/gap/draftStorage.js';

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

let storage: Storage;

beforeEach(() => {
  storage = makeMemoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('gapDraftKey', () => {
  it('formats as gap-draft:<exerciseId>:<rung>', () => {
    expect(gapDraftKey('stream-consumer', 'full_body')).toBe('gap-draft:stream-consumer:full_body');
  });
});

describe('saveDraft / loadDraft / clearDraft', () => {
  it('round-trips a saved draft under its key', () => {
    const key = gapDraftKey('stream-consumer', 'full_body');
    expect(loadDraft(key)).toBeUndefined();

    saveDraft(key, 'return onToken(chunk);');
    expect(loadDraft(key)).toBe('return onToken(chunk);');

    clearDraft(key);
    expect(loadDraft(key)).toBeUndefined();
  });

  it('keys are scoped independently per exercise+rung', () => {
    const a = gapDraftKey('stream-consumer', 'full_body');
    const b = gapDraftKey('stream-consumer', 'inline_completion');
    saveDraft(a, 'code for full_body');
    saveDraft(b, 'code for inline_completion');
    expect(loadDraft(a)).toBe('code for full_body');
    expect(loadDraft(b)).toBe('code for inline_completion');
    clearDraft(a);
    expect(loadDraft(a)).toBeUndefined();
    expect(loadDraft(b)).toBe('code for inline_completion'); // unaffected by clearing the other key
  });

  it('never throws when localStorage access fails (private-browsing/quota) — best-effort only', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('storage disabled'); });
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
    vi.spyOn(storage, 'removeItem').mockImplementation(() => { throw new Error('storage disabled'); });

    const key = gapDraftKey('stream-consumer', 'full_body');
    expect(() => saveDraft(key, 'x')).not.toThrow();
    expect(() => loadDraft(key)).not.toThrow();
    expect(loadDraft(key)).toBeUndefined();
    expect(() => clearDraft(key)).not.toThrow();
  });
});
