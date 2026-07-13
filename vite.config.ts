import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // HARNESS_API lets a second (sandbox) backend be targeted without editing this file
      '/api': process.env.HARNESS_API ?? 'http://localhost:4820',
    },
  },
});
