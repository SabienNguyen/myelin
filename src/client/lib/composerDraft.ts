// The composer's unsent draft, per conversation. The composer unmounts on a reload, on a thread
// switch and on every trip to the notebooks screen, and a typed /advanced chip plus a paragraph
// went with it. sessionStorage, same reasoning as pendingAsk.ts: this tab only, gone with it.
// The value is the editor's own JSON doc, so a command chip comes back as a chip.
import type { JSONContent } from '@tiptap/core';

const key = (threadId: string) => `myelin.draft.${threadId}`;

export function loadDraft(threadId: string): JSONContent | null {
  try {
    const raw = sessionStorage.getItem(key(threadId));
    if (raw === null) return null;
    const doc = JSON.parse(raw) as JSONContent;
    return doc?.type === 'doc' ? doc : null;
  } catch (e) {
    console.error('[draft] could not restore the unsent message:', e);
    return null;
  }
}

/** `null` forgets the draft (sent, or emptied by the learner). */
export function saveDraft(threadId: string, doc: JSONContent | null): void {
  try {
    if (doc === null) sessionStorage.removeItem(key(threadId));
    else sessionStorage.setItem(key(threadId), JSON.stringify(doc));
  } catch (e) {
    console.error('[draft] could not keep the unsent message:', e);
  }
}
