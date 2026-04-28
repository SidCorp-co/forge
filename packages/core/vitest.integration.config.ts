import { defineConfig } from 'vitest/config';

// Integration-only config. Runs against a real Postgres resolved by
// tests/helpers/db.ts (container or disposable schema, via TEST_DB_MODE).
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    hookTimeout: 60_000,
    testTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        // Allow parallel integration files; per-worker schema names keep them
        // isolated (see tests/helpers/schema-mode.ts).
        singleFork: false,
      },
    },
  },
});
