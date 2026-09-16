import { defineConfig } from 'vitest/config';
// cm:ignore CM013 — vitest-5 API migration only (removed `poolOptions`, now the default); the header's fork/DB behaviour it describes is unchanged, so there is no stale prose to reword.

// Integration-only config. Runs against a real Postgres resolved by
// tests/helpers/db.ts (container or disposable schema, via TEST_DB_MODE).
//
// Parallel forks. In schema mode (default, local) each worker gets its own
// disposable schema (tests/helpers/schema-mode.ts). In container mode (CI)
// workers share ONE database, so concurrent `TRUNCATE ... CASCADE` collides
// with other workers' in-flight queries and Postgres aborts one as a deadlock
// victim (40P01) — `truncateAll` retries that transient abort. (Serial mode
// would avoid it but cross-file env leakage in one process un-skips the
// live-embeddings suite, so parallel + retry is the cleaner fix.)
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./tests/helpers/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    pool: 'forks',
    fileParallelism: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
