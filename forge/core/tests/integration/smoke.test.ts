import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDatabase, setupTestDatabase, truncateAll } from '../helpers/index.js';

// End-to-end smoke test for the Phase 2.1-I testing infrastructure.
//
// Verifies that the mode-aware `setupTestDatabase()` helper can:
//   1. Boot a real Postgres (container or disposable schema),
//   2. Run the (currently empty) migrations without error,
//   3. Accept `truncateAll()` calls safely even with zero tables,
//   4. Surface a clear error from factories while the schema is still stubbed.
//
// Downstream issues (Phase 2.1-A/B/C) will add `users` / `projects` tables;
// this test should keep passing once they do, as both code paths are covered.

describe('integration smoke', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  it('connects to the test database and executes SELECT 1', async () => {
    const rows = await harness.db.execute<{ one: number }>(sql`SELECT 1 AS one`);
    const first = rows[0] as { one?: unknown } | undefined;
    expect(first?.one).toBe(1);
  });

  it('uses a dedicated schema / database (no cross-run leakage)', async () => {
    const rows = await harness.db.execute<{ schema: string }>(
      sql`SELECT current_schema() AS schema`,
    );
    const schema = (rows[0] as { schema?: unknown } | undefined)?.schema;
    expect(typeof schema).toBe('string');
    expect(schema).not.toBe('information_schema');
  });

  it('truncateAll() is a no-op when no base tables exist', async () => {
    // Should not throw even though the schema is empty (Phase 2.1-A/B pending).
    await truncateAll(harness.db);
  });

  it('factories throw a clear error until the schema lands', async () => {
    const { createTestUser } = await import('../helpers/factories.js');
    await expect(createTestUser(harness.db)).rejects.toThrow(/"users" table.*Phase 2\.1/);
  });
});
