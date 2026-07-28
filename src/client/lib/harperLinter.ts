// Real, mechanical writing feedback — Harper (writewithharper.com), an open-source English
// grammar/style checker compiled to WebAssembly, run entirely in the browser. It exists here to
// answer a specific weakness: writing was the one applied subject whose feedback was a MODEL's
// opinion, softer than the mechanical grading every other subject gets. Harper's lints are
// deterministic and located — a definite subject–verb disagreement, a real spelling slip, a
// passive-voice or redundancy flag — so the mechanics of a draft can be graded the honest way, and
// the model is left to judge only what a rule engine can't (argument, structure, taste).
//
// Loaded through a dynamic import so the ~MB WASM binary is a lazy chunk that costs nothing until a
// learner actually opens a writing exercise — and so importing this module (e.g. from a test that
// renders the block) never drags the binary into a Node/jsdom context that can't run it.

export interface DraftLint {
  start: number;
  end: number;
  /** A human-readable category — "Spelling", "Agreement", "Readability", "Redundancy", … */
  kind: string;
  message: string;
  /** The exact offending text (draft.slice(start, end)). */
  problem: string;
  /** Harper's first suggested replacement, when it has one. */
  suggestion?: string;
}

let linterPromise: Promise<{ lint: (t: string) => Promise<DraftLint[]> }> | null = null;

function getLinter() {
  if (!linterPromise) {
    linterPromise = (async () => {
      const { LocalLinter } = await import('harper.js');
      const { binaryInlined } = await import('harper.js/binaryInlined');
      const linter = new LocalLinter({ binary: binaryInlined });
      await linter.setup();
      return {
        lint: async (text: string): Promise<DraftLint[]> => {
          const lints = await linter.lint(text, { language: 'plaintext' });
          return lints.map((l) => {
            const span = l.span();
            const suggestions = l.suggestions();
            return {
              start: span.start,
              end: span.end,
              kind: l.lint_kind_pretty(),
              message: l.message(),
              problem: l.get_problem_text(),
              suggestion: suggestions.length ? suggestions[0].get_replacement_text() : undefined,
            };
          });
        },
      };
    })();
  }
  return linterPromise;
}

/** Lint a draft, returning located grammar/style issues. Empty for empty/whitespace text. Never
 *  throws to the caller — a WASM load failure yields an empty list, so the writing block degrades to
 *  model-only feedback rather than breaking (the same degrade-loudly instinct as the speak tool). */
export async function lintDraft(text: string): Promise<DraftLint[]> {
  if (!text.trim()) return [];
  try {
    const linter = await getLinter();
    return await linter.lint(text);
  } catch {
    linterPromise = null; // let a later attempt retry the load
    return [];
  }
}
