import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

// maplibre-gl loads its worker (and a shared chunk it imports) by URL. Vite would bundle the
// main file only, so emit both next to the app under a stable path.
function maplibreWorker(): Plugin {
  const dist = path.dirname(fileURLToPath(import.meta.resolve('maplibre-gl')));
  return {
    name: 'maplibre-worker',
    apply: 'build',
    generateBundle() {
      for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
        this.emitFile({ type: 'asset', fileName: `maplibre/${file}`, source: readFileSync(path.join(dist, file)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [maplibreWorker()],
  server: { port: 5174 },
  build: {
    rollupOptions: {
      input: { main: 'index.html', privacy: 'privacy.html', legal: 'legal.html' },
    },
  },
  // In dev, the dep-optimizer breaks maplibre's worker URL.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  test: { include: ['src/**/*.test.ts'] }, // e2e/ is Playwright's
});
