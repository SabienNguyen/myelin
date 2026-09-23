import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // Anchored to THIS repo's tests/ dir, not vitest's default **-glob: CI checks out the
    // engram repo nested inside the workspace (.github/workflows/ci.yml), and the default
    // include would run that repo's suite here too — under the wrong config and a second copy
    // of @vitest/expect, which fails on a jest-matchers global collision.
    include: ['tests/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['tests/client/**', 'jsdom'], ['**', 'node']],
    // Node 26 makes `localStorage` an own property of globalThis (a getter that reads as
    // undefined unless --localstorage-file is passed) even when nobody ever passes
    // --experimental-webstorage. Because the key already exists, jsdom's environment sees
    // `'localStorage' in globalThis` as true and skips installing jsdom's own working
    // localStorage over it, so `localStorage.clear()` in a test's afterEach throws. Passing
    // --no-experimental-webstorage removes that own property so jsdom's shim installs as
    // usual. Only do this on a Node that recognizes the flag: allowedNodeEnvironmentFlags.has()
    // returns false rather than throwing for a flag an older Node doesn't define, so on a Node
    // without it (CI runs Node 22 — .github/workflows/ci.yml) execArgv stays [] and behavior is
    // unchanged there.
    execArgv: process.allowedNodeEnvironmentFlags.has('--experimental-webstorage')
      ? ['--no-experimental-webstorage']
      : [],
  },
});
