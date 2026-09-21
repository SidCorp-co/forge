import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';

// vitest defaults to one worker per core minus one, PER PACKAGE, and turbo fans the
// packages out at the same time — which put a 12-core box at load average 27 and made
// the machine unusable while the suites ran. A share of the cores, floored, keeps the
// whole fan-out inside the box. VITEST_MAX_WORKERS overrides it for a one-off run.
function workers(share: number, { cap = Number.POSITIVE_INFINITY, min = 1 } = {}): number {
  const override = Number(process.env.VITEST_MAX_WORKERS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  return Math.max(min, Math.min(cap, Math.floor((cpus().length || 1) / share) || 1));
}

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./tests/helpers/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: workers(4, { cap: 3 }),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
