import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';
import { workerOverride } from '../../scripts/lib/worker-override.mjs';

// vitest defaults to one worker per core minus one, PER PACKAGE, and turbo fans the
// packages out at the same time — which put a 12-core box at load average 27 and made
// the machine unusable while the suites ran. A share of the cores, floored, keeps the
// whole fan-out inside the box. VITEST_MAX_WORKERS overrides it for a one-off run, and a value
// that is not a positive whole number is refused by name.
function workers(share: number, { cap = Number.POSITIVE_INFINITY, min = 1 } = {}): number {
  const override = workerOverride(process.env, 'packages/web-v2/vitest.config.ts');
  if (override !== undefined) return override;
  return Math.max(min, Math.min(cap, Math.floor((cpus().length || 1) / share) || 1));
}

// vitest config for web-v2's unit suite. The `@/` alias mirrors tsconfig `paths`
// so feature modules resolve the same way under test as under `next build`.
//
// This said "pure feature logic — no DOM" until 2026-09-17, which stopped being
// true some time before: 81 files under `src/` open with
// `// @vitest-environment jsdom` and render React through testing-library. The
// default `environment` below is still `node`, so those files each opt in for
// themselves; what was wrong was the sentence, not the setting.
export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    maxWorkers: workers(3, { min: 2 }),
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
    // The guard fails a test that lists the repository root without declaring it (ISS-1314).
    setupFiles: ['./src/vitest.setup.ts', '../../scripts/lib/whole-tree-guard.mjs'],
  },
});
