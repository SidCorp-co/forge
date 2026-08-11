import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default run: unit tests only — no Postgres required. Integration tests
    // under `tests/integration/**` are invoked via the `test:integration`
    // script once a test DB is available (see tests/README.md).
    include: ['src/**/*.test.ts'],
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
