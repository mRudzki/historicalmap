import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['db/**/*.test.ts', 'scripts/**/*.test.ts', 'apps/api/**/*.test.ts'],
    globalSetup: ['db/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
