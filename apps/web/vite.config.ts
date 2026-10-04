import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // Proxy in dev so the session cookie is same-origin and we sidestep CORS and
    // SameSite entirely. In production the API is on its own Workers domain and
    // real CORS applies — see apps/api/src/index.ts.
    proxy: {
      '/v1': { target: 'http://localhost:8787', changeOrigin: true },
      '/api/auth': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
