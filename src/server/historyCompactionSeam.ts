// Where history compaction picks its model, kept apart from historyCompaction.ts so that module
// stays pure and importable by tests without dragging in the model layer — the same split
// gap/generateSeam.ts makes for exercise generation.
//
// The COMPILE role, not the tutor. Compile is already the harness's distillation role — the one
// that turns a chapter into pages and a description into an exercise — and summarizing a stretch
// of transcript is that same shape: read this text, give back a shorter faithful text. Charging it
// to the tutor would spend the expensive role on the work being done to make the tutor affordable.
//
// One call per compaction event, and the result is stored, so a thread long enough to compact five
// times has paid for five summarizations in its whole life.
import { generateStructured } from './llm/index.js';
import type { HarnessConfig } from './config.js';
import { chatModelFor } from './models.js';
import { recordUsage } from './usageLedger.js';
import type { CompactionDeps } from './historyCompaction.js';

export function compactionDeps(cfg: HarnessConfig): CompactionDeps {
  return {
    summarize: async (prompt, schema) => {
      const { object, usage } = await generateStructured({
        model: chatModelFor('compile', cfg),
        prompt,
        schema,
        schemaName: 'history_summary',
      });
      recordUsage(cfg.vault, {
        role: 'compile', model: cfg.models?.compile?.model ?? 'unknown', usage,
        contextTokens: cfg.models?.compile?.contextTokens,
      });
      return object;
    },
  };
}
