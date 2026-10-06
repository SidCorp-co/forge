import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';

// One throwaway Postgres per run (tests/helpers/global-setup.ts) and one database per file cloned
// from its migrated template (tests/helpers/file-database.ts), so files run in parallel safely.
function workers(): number {
  const override = process.env.VITEST_MAX_WORKERS;
  if (override !== undefined && override !== '') {
    if (!/^[1-9][0-9]*$/.test(override)) {
      throw new Error(
        `VITEST_MAX_WORKERS="${override}" is not a worker count for vitest.integration.config.ts. ` +
          'It takes a positive whole number such as 4, or is left unset so the machine decides.',
      );
    }
    return Number(override);
  }
  return Math.max(1, Math.min(6, Math.floor((cpus().length || 1) / 3)));
}

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    fsModuleCache: true,
    globalSetup: ['./tests/helpers/global-setup.ts'],
    // The guard fails a test that lists the repository root without declaring it (ISS-1314).
    setupFiles: ['../../scripts/lib/whole-tree-guard.mjs', './tests/helpers/file-database.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: workers(),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
