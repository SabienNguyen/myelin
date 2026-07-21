// Ported VERBATIM (pure reducer, no adaptation needed) from ~/Dev/personal/the-gap
// apps/web/src/detectors.ts (READ ONLY there).
//
// Behavioral-detection state machines: kept as PURE functions with no DOM/timer dependency so
// they are unit-testable in isolation. The caller (./hooks/useDetectorState.ts) is the only place
// that touches wall-clock time or timers; everything here just folds DetectorEvents (which each
// carry their own timestamp) into DetectorState, and offersOf reads that state back out as the
// three ambient, dismissible, never-modal offers (≥20s idle on empty gap -> offer plan-writing
// panel; same test failing 3 consecutive runs -> predict-then-run; 2 consecutive syntax errors ->
// doc cards).
//
// Dismissal semantics: "a dismissed offer never re-fires for the SAME trigger instance ... but may
// re-fire on a NEW instance." Each of the three rules tracks its own "current instance id" — a
// monotonic counter bumped exactly when a NEW instance of that rule's trigger begins (a fresh idle
// period after a keystroke; a fresh failing-set streak after a different set or a pass; a fresh
// syntax-error streak after a non-syntax-error run) — and dismiss() records the instance id active
// at the moment of dismissal. offersOf() only lets an offer fire when the CURRENT instance id
// differs from the dismissed one, so a still-growing streak stays suppressed (same id) while a
// genuinely new streak is unaffected (a new, never-recorded id).

export interface DetectorEvent {
  type: 'keystroke' | 'run-result' | 'tick' | 'gap-empty-check';
  at: number;
  failingSet?: string[];
  syntaxError?: boolean;
  gapEmpty?: boolean;
}

export interface Offers {
  plan: boolean;
  predictRun: boolean;
  docs: boolean;
}

export type Offer = keyof Offers;

export interface DetectorState {
  /** The timestamp of the most recent event the reducer has seen — offersOf's idle-threshold check
   *  reads this as "now" (offersOf itself takes no clock/argument, per the pinned signature). */
  now: number;

  /** Bumped on every keystroke: a keystroke both resets the idle clock AND starts a fresh idle
   *  "instance" for dismissal purposes. */
  idleInstanceId: number;
  lastKeystrokeAt: number;
  gapEmpty: boolean;
  planDismissedForInstance: number | null;

  /** Bumped whenever a NEW failing-set streak starts (the first failing run after a pass, or a
   *  failing run whose sorted-name set differs from the immediately preceding one). Consecutive
   *  runs with the identical set keep this id and just grow failingStreakCount. */
  failingStreakInstanceId: number;
  failingStreakKey: string | null;
  failingStreakCount: number;
  predictRunDismissedForInstance: number | null;

  /** Same pattern as failingStreak*, for consecutive syntax-error runs. */
  syntaxStreakInstanceId: number;
  syntaxStreakCount: number;
  docsDismissedForInstance: number | null;
}

const IDLE_THRESHOLD_MS = 20_000;
const PREDICT_RUN_STREAK = 3;
const DOCS_STREAK = 2;

export function createDetectorState(now: number, initialGapEmpty = true): DetectorState {
  return {
    now,
    idleInstanceId: 0,
    lastKeystrokeAt: now,
    gapEmpty: initialGapEmpty,
    planDismissedForInstance: null,
    failingStreakInstanceId: 0,
    failingStreakKey: null,
    failingStreakCount: 0,
    predictRunDismissedForInstance: null,
    syntaxStreakInstanceId: 0,
    syntaxStreakCount: 0,
    docsDismissedForInstance: null,
  };
}

/** Order-independent identity for a failing-test-name set: two runs with the same names in a
 *  different order are the SAME streak instance. ' ' can't appear in a test name, so it's a
 *  safe join separator. */
function sortedSetKey(names: string[]): string {
  return [...names].sort().join(' ');
}

export function reduceDetectors(state: DetectorState, ev: DetectorEvent): DetectorState {
  const withNow: DetectorState = { ...state, now: ev.at };

  switch (ev.type) {
    case 'keystroke':
      return { ...withNow, idleInstanceId: withNow.idleInstanceId + 1, lastKeystrokeAt: ev.at };

    case 'gap-empty-check':
      return { ...withNow, gapEmpty: ev.gapEmpty ?? withNow.gapEmpty };

    case 'tick':
      return withNow;

    case 'run-result': {
      if (ev.syntaxError === true) {
        // A syntax error run has no test results to inform the failing-set streak either way —
        // leave it untouched; only the syntax-error streak advances.
        const syntaxStreakCount = withNow.syntaxStreakCount + 1;
        const syntaxStreakInstanceId =
          syntaxStreakCount === 1 ? withNow.syntaxStreakInstanceId + 1 : withNow.syntaxStreakInstanceId;
        return { ...withNow, syntaxStreakCount, syntaxStreakInstanceId };
      }

      // Any non-syntax-error run-result breaks a run of consecutive syntax errors.
      let next: DetectorState = { ...withNow, syntaxStreakCount: 0 };

      const failingSet = ev.failingSet ?? [];
      if (failingSet.length === 0) {
        // A passing run clears the failing-set streak entirely.
        next = { ...next, failingStreakKey: null, failingStreakCount: 0 };
      } else {
        const key = sortedSetKey(failingSet);
        if (key === next.failingStreakKey) {
          next = { ...next, failingStreakCount: next.failingStreakCount + 1 };
        } else {
          next = {
            ...next,
            failingStreakKey: key,
            failingStreakCount: 1,
            failingStreakInstanceId: next.failingStreakInstanceId + 1,
          };
        }
      }
      return next;
    }
  }
}

export function offersOf(state: DetectorState): Offers {
  const idleMs = state.now - state.lastKeystrokeAt;
  const plan =
    idleMs >= IDLE_THRESHOLD_MS && state.gapEmpty && state.planDismissedForInstance !== state.idleInstanceId;

  const predictRun =
    state.failingStreakCount >= PREDICT_RUN_STREAK &&
    state.predictRunDismissedForInstance !== state.failingStreakInstanceId;

  const docs =
    state.syntaxStreakCount >= DOCS_STREAK && state.docsDismissedForInstance !== state.syntaxStreakInstanceId;

  return { plan, predictRun, docs };
}

export function dismiss(state: DetectorState, offer: Offer): DetectorState {
  switch (offer) {
    case 'plan':
      return { ...state, planDismissedForInstance: state.idleInstanceId };
    case 'predictRun':
      return { ...state, predictRunDismissedForInstance: state.failingStreakInstanceId };
    case 'docs':
      return { ...state, docsDismissedForInstance: state.syntaxStreakInstanceId };
  }
}
