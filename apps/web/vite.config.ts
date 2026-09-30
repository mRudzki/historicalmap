import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5174 },
  // maplibre-gl spawns its own worker; the dev dep-optimizer breaks the worker URL.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  test: { include: ['src/**/*.test.ts'] }, // e2e/ is Playwright's
});
