import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environmentMatchGlobs: [['tests/client/**', 'jsdom'], ['**', 'node']],
  },
});
