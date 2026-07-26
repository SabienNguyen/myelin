// Which applied blocks could confirm THIS page — backlog item 3, the honest completion of the
// mastered ceiling. A learner looking at "no exercise has confirmed it" needs to know whether that
// means *you have not done the exercise* or *no exercise exists here yet*; same sentence position,
// opposite meaning, and until this module the UI could not tell them which.
//
// The trap the backlog named, avoided on purpose: no per-subject registry. Every signal below is
// DERIVED from something that exists — a ladder in the sandbox, notation in the page's own body,
// the checker list in shared/blocks.ts — so a new ladder or a new checker widens the answer
// without anyone remembering to edit a table.

import { builtinPatterns } from './gap/service.js';

export interface AppliedRoute {
  block: 'code_exercise' | 'math_scratchpad' | 'structured_check' | 'writing_draft';
  /** Learner-readable: what to ask the tutor for. */
  ask: string;
  /** Why this route applies to this page — the derivation, said plainly. */
  why: string;
}

/** LaTeX in the page's own body is the signal that its material is equation-shaped — the thing
 *  math_scratchpad grades by numeric equivalence. Derived from content, not from a domain label. */
function bodyHasMath(body: string): boolean {
  return /\$[^$]+\$|\\frac|\\int|\\sum|\\sqrt/.test(body);
}

export function appliedRoutesFor(
  page: { slug: string; body: string },
  patterns: string[] = builtinPatterns(),
): AppliedRoute[] {
  const routes: AppliedRoute[] = [];

  if (patterns.includes(page.slug)) {
    routes.push({
      block: 'code_exercise',
      ask: 'a code exercise',
      why: 'a real coding ladder exists for this page — passing its tests is machine-verified',
    });
  }

  if (bodyHasMath(page.body)) {
    routes.push({
      block: 'math_scratchpad',
      ask: 'a worked problem',
      why: 'this page’s own notation can be graded by numeric equivalence',
    });
  }

  // Always present, and that is the point of structured_check: its checkers (numeric, unit,
  // chem_equation, notes, set, sequence, matching, pattern) are subject-agnostic mechanics.
  routes.push({
    block: 'structured_check',
    ask: 'a structured check',
    why: 'mechanical checkers work in any subject — derive, compute, order, match, or name',
  });

  // Last on purpose: the rubric route exists for work nothing mechanical can check, and it caps
  // at practicing. Offering it FIRST anywhere would undersell the routes that reach mastered.
  routes.push({
    block: 'writing_draft',
    ask: 'a rubric-judged draft',
    why: 'produced work judged against stated criteria — advances you, capped below mastered',
  });

  return routes;
}

/** The one genuinely-absent case worth naming: a programming page with NO ladder. Everything else
 *  always has a mechanical route; here the best route (real tests) does not exist yet, and saying
 *  so beats letting the learner think they skipped an exercise that was never written. */
export function missingLadder(
  page: { slug: string; domain?: string },
  patterns: string[] = builtinPatterns(),
): boolean {
  return (page.domain ?? '') === 'programming' && !patterns.includes(page.slug);
}
