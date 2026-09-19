import { defineConfig } from 'vitest/config';
import { testWorkers } from '../../scripts/lib/test-workers.mjs';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./tests/helpers/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: testWorkers({ share: 4, cap: 3, min: 1 }),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
