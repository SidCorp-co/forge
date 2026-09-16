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
    // cm:edge contract -> packages/core/tests/helpers/db.ts — global-setup builds the migrated template ONCE; db.ts clones it per file. Dropping this line silently restores a container boot + full migration replay per test file (~8.6s each).
    globalSetup: ['./tests/helpers/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    pool: 'forks',
    // cm:why vitest 5 removed `poolOptions`; parallel forks (the former `singleFork: false`) is the default, so the block is dropped rather than translated.
    fileParallelism: true,
    // cm:edge contract -> scripts/check-flow-coverage.mjs — that checker reads this report as the AUTHORITATIVE source: a cm:flow step counts as defended only when the integration suite executed it. Narrowing `include` here silently turns settled steps into out-of-scope faults.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
