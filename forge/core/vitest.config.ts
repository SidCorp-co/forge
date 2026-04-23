import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default run: unit tests only — no Postgres required. Integration tests
    // under `tests/integration/**` are invoked via the `test:integration`
    // script once a test DB is available (see tests/README.md).
    include: ['src/**/*.test.ts'],
    environment: 'node',
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
