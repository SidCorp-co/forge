import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    // cm:hack ISS-172 until:QA phase on dev — the suites and their global setup are removed; restore this file from the commit before the removal
    // The guard fails a test that lists the repository root without declaring it (ISS-1314).
    setupFiles: ['../../scripts/lib/whole-tree-guard.mjs'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
