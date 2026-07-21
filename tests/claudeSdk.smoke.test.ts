import { describe, it, expect } from 'vitest';
import { claudeSdkGenerate } from '../src/server/claudeSdk.js';

// Opt-in only: hits the real Claude Agent SDK (and therefore your Claude Pro/Max subscription via
// the local `claude` CLI login) — never runs in CI. `LW_SDK_SMOKE=1 npx vitest run
// tests/claudeSdk.smoke.test.ts` to exercise it manually.
describe.skipIf(!process.env.LW_SDK_SMOKE)('claudeSdkGenerate — live smoke test (LW_SDK_SMOKE)', () => {
  it('gets a real response from the subscription-backed Agent SDK', async () => {
    const { text } = await claudeSdkGenerate({ model: 'sonnet', prompt: 'Say OK', maxTurns: 1 });
    expect(text.trim().length).toBeGreaterThan(0);
  }, 60_000);
});
