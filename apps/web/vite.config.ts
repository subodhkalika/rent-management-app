import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// Dev-only: where the API lives when running `vite dev`. On the host this is
// localhost:8787 (wrangler dev's default). In Docker Compose the api service
// is a separate container reachable only by its service name, so compose sets
// API_PROXY_TARGET=http://api:8787. Read via process.env (Node, config-eval
// time) — this is not import.meta.env, so no VITE_ prefix applies.
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8787';

// Dev-only: when the source is bind-mounted from a macOS host into a Linux
// container, native filesystem events don't cross the mount and chokidar
// never fires — fall back to polling. Gate behind an env var so a native
// host run (no bind mount) doesn't pay the CPU cost of polling by default.
const useCompatFsWatch = process.env.CHOKIDAR_USEPOLLING === 'true';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    watch: {
      usePolling: useCompatFsWatch,
    },
    // Proxy in dev so the session cookie is same-origin and we sidestep CORS and
    // SameSite entirely. In production the API is on its own Workers domain and
    // real CORS applies — see apps/api/src/index.ts.
    proxy: {
      '/v1': { target: apiProxyTarget, changeOrigin: true },
      '/api/auth': { target: apiProxyTarget, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
