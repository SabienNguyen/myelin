// Ported VERBATIM from ~/Dev/personal/the-gap apps/web/src/hooks/useDetectorState.ts (READ ONLY
// there) — the only place that touches wall-clock time/timers for the detector state machines
// (../detectors.ts itself stays a pure reducer with no DOM/timer dependency). Drives one 1s 'tick'
// event per second (the idle-threshold clock has nothing else to wake it up when the learner just
// stops typing on an already-empty gap) plus whatever 'keystroke' / 'gap-empty-check' /
// 'run-result' events the caller dispatches.

import { useEffect, useState } from 'react';
import {
  createDetectorState,
  reduceDetectors,
  offersOf,
  dismiss,
  type DetectorEvent,
  type DetectorState,
  type Offer,
  type Offers,
} from '../detectors.js';

const TICK_MS = 1_000;

export interface UseDetectorState {
  offers: Offers;
  dispatch: (event: DetectorEvent) => void;
  dismissOffer: (offer: Offer) => void;
}

export function useDetectorState(): UseDetectorState {
  const [state, setState] = useState<DetectorState>(() => createDetectorState(Date.now()));

  useEffect(() => {
    const id = setInterval(() => {
      setState((s) => reduceDetectors(s, { type: 'tick', at: Date.now() }));
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  function dispatch(event: DetectorEvent): void {
    setState((s) => reduceDetectors(s, event));
  }

  function dismissOffer(offer: Offer): void {
    setState((s) => dismiss(s, offer));
  }

  return { offers: offersOf(state), dispatch, dismissOffer };
}
