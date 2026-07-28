// One-shot "write this up" signal. The tutor in a teaching mode (learn/review/quiz) can't write
// pages — the single-writer rule keeps writing freeform-only (session.ts). Rather than make the
// learner hunt for the mode selector and flip to freeform by hand, the tutor offers a "write this
// up" button (OfferWrite.tsx); clicking it arms this flag and sends one message. The chat
// transport (runtime.tsx) reads the flag into that single request's body as `writeUp`, and the
// server promotes just that turn to freeform semantics so the vault write path unlocks — the
// learner's visible mode never changes, and the next turn reverts on its own.
//
// A module-level latch, not React state, precisely because the arming component (OfferWrite, deep
// in the message list) and the reader (the transport, at the runtime root) have no shared React
// context to thread a value through — and the value's whole life is "true for the very next
// send, then gone." consume() clears as it reads so a stray later send can't inherit it.
let armed = false;

export function armWriteIntent(): void {
  armed = true;
}

/** Read and clear the flag. Returns true at most once per arming — the next send only. */
export function consumeWriteIntent(): boolean {
  const was = armed;
  armed = false;
  return was;
}
