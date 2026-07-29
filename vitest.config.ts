import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // Anchored to THIS repo's tests/ dir, not vitest's default **-glob: CI checks out the
    // engram repo nested inside the workspace (.github/workflows/ci.yml), and the default
    // include would run that repo's suite here too — under the wrong config and a second copy
    // of @vitest/expect, which fails on a jest-matchers global collision.
    include: ['tests/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['tests/client/**', 'jsdom'], ['**', 'node']],
  },
});
