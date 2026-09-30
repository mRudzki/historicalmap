import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5175',
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    // Own port and the isolated e2e API/tiles (see scripts/e2e-setup.sh); never reuse the dev server.
    command: 'npm run build && npm run preview -- --port 5175 --strictPort',
    env: { VITE_API_URL: 'http://localhost:3002', VITE_TILES_URL: 'http://localhost:3101' },
    url: 'http://localhost:5175',
    reuseExistingServer: false,
  },
});
