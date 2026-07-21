// P2 (editor polish): draft autosave for the gap pane. Persists the learner's in-progress code to
// localStorage keyed per exercise+rung (`gap-draft:<exerciseId>:<rung>`) so a reload or an
// accidental navigate-away doesn't lose typed work — restored on RungEditor mount, cleared once
// the learner explicitly Submits (see CodeExercise.tsx). Every localStorage call is guarded: this
// is a nice-to-have, never something that should throw and take the exercise down with it (private
// browsing storage quotas, disabled storage, etc. all fail silently here).

export function gapDraftKey(exerciseId: string, rung: string): string {
  return `gap-draft:${exerciseId}:${rung}`;
}

export function loadDraft(key: string): string | undefined {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

export function saveDraft(key: string, code: string): void {
  try {
    window.localStorage.setItem(key, code);
  } catch {
    // best-effort — see top comment.
  }
}

export function clearDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // best-effort — see top comment.
  }
}
