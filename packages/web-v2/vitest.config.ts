import { cpus } from 'node:os';
import { resolve } from 'node:path';
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
        `VITEST_MAX_WORKERS="${override}" is not a worker count for packages/web-v2/vitest.config.ts. ` +
          'It takes a positive whole number such as 4, or is left unset so the machine decides.',
      );
    }
    return Number(override);
  }
  return Math.max(min, Math.min(cap, Math.floor((cpus().length || 1) / share) || 1));
}

const src = (p: string) => resolve(__dirname, p);

// The aliases mirror tsconfig.json `paths`, so a test resolves `@/` and the workspace sources the
// way `next build` does — `@forge/contracts` from its sources, since its dist is a build output.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@forge\/contracts\/(.*)$/, replacement: src('../contracts/src/$1') },
      { find: '@forge/core/public', replacement: src('../core/src/public.ts') },
      { find: '@forge/core/admin-types', replacement: src('../core/src/admin/types.ts') },
      { find: '@forge/observability', replacement: src('../observability/src/index.ts') },
      { find: /^@\/(.*)$/, replacement: src('src/$1') },
    ],
  },
  test: {
    maxWorkers: workers(3, { min: 2 }),
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
    // The guard fails a test that lists the repository root without declaring it (ISS-1314), and
    // runs first, so no setup file takes a listing function before it is watched.
    setupFiles: ['../../scripts/lib/whole-tree-guard.mjs', './src/vitest.setup.ts'],
  },
});
