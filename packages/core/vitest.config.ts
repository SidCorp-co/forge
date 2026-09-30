import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';

// vitest defaults to one worker per core minus one, PER PACKAGE, and turbo fans the
// packages out at the same time — which put a 12-core box at load average 27 and made
// the machine unusable while the suites ran. A share of the cores, floored, keeps the
// whole fan-out inside the box. VITEST_MAX_WORKERS overrides it for a one-off run; anything but a
// positive whole number is refused here, not shared, as the images copy only packages/.
function workers(share: number, { cap = Number.POSITIVE_INFINITY, min = 1 } = {}): number {
  const override = process.env.VITEST_MAX_WORKERS;
  if (override !== undefined && override !== '') {
    if (!/^[1-9][0-9]*$/.test(override)) {
      throw new Error(
        `VITEST_MAX_WORKERS="${override}" is not a worker count for packages/core/vitest.config.ts. ` +
          'It takes a positive whole number such as 4, or is left unset so the machine decides.',
      );
    }
    return Number(override);
  }
  return Math.max(min, Math.min(cap, Math.floor((cpus().length || 1) / share) || 1));
}

export default defineConfig({
  test: {
    maxWorkers: workers(3, { min: 2 }),
    include: [
      'src/**/*.test.ts',
      'tests/helpers/**/*.test.ts',
      '../contracts/src/**/*.test.ts',
      '../../scripts/**/*.test.mjs',
    ],
    environment: 'node',
    // cm:flow step is defended, and a cache on that path is a silent way to degrade a gate.
    fsModuleCache: true,
    // See vitest.setup.ts — the three required env vars, so a unit test whose subject is a pure
    // function does not have to mock the env module to reach a populated integration registry.
    // The guard fails a test that lists the repository root without declaring it (ISS-1314).
    setupFiles: ['./vitest.setup.ts', '../../scripts/lib/whole-tree-guard.mjs'],
    hookTimeout: 60_000,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
