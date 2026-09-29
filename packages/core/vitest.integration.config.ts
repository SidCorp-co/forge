import { defineConfig } from 'vitest/config';
import { integrationWorkers } from './tests/helpers/integration-workers.js';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./tests/helpers/global-setup.ts'],
    // The guard fails a test that lists the repository root without declaring it (ISS-1314).
    setupFiles: ['../../scripts/lib/whole-tree-guard.mjs'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    pool: 'forks',
    fileParallelism: true,
    // How many files at once follows the machine this run is on: tests/helpers/integration-workers.ts.
    maxWorkers: integrationWorkers().count,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
