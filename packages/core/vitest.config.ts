import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // cm:why `packages/contracts` declares no test script and no vitest config, so its only test file ran NOWHERE — not in `pnpm test`, not in CI's `pnpm --filter @forge/core test`. Included from here rather than given a runner of its own because contracts is a type-only surface whose one behavioural unit (the kernel↔label map) is consumed by core.
    include: ['src/**/*.test.ts', '../contracts/src/**/*.test.ts'],
    environment: 'node',
    hookTimeout: 60_000,
    // cm:why vitest's 5s default assumes a test body does only assertions; here a test's first touch of a mocked module pays the module-graph load, and under 8-way parallelism on a loaded box that crossed 5s — the sole cause of the two long-standing "flaky" files
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
