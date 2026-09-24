import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // harper.js/binary finds its .wasm with new URL(…, import.meta.url); pre-bundled into
  // node_modules/.vite/deps that URL points at a file that is not there, so the dev server serves
  // the package as-is.
  optimizeDeps: { exclude: ['harper.js'] },
  server: {
    proxy: {
      // HARNESS_API lets a second (sandbox) backend be targeted without editing this file
      '/api': process.env.HARNESS_API ?? 'http://localhost:4820',
    },
  },
});
