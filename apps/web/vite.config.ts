import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev, call the API as /api/... ; it's forwarded to apps/api on :8787 without the prefix.
    // Better Auth is the exception: it's served at /api/auth on the API too, so that prefix is kept.
    // Order matters: the first matching key wins.
    proxy: {
      '/api/auth': {
        target: 'http://localhost:8787',
      },
      '/api': {
        target: 'http://localhost:8787',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
