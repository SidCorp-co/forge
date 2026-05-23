/**
 * ISS-196 — real-Postgres smoke test for the reconciler tick. The unit suite
 * in `src/pipeline/reconciler.test.ts` mocks `db.execute`, so a drizzle-side
 * regression in how the SELECT is parameterised (e.g. JS arrays expanding as
 * a record tuple under `ANY(...::text[])`) only surfaces against a live
 * Postgres. This test boots the real schema and asserts `runReconcilerOnce`
 * executes both the stuck-issue SELECT and the stale-outbox SELECT without
 * throwing.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// `db/client.js` validates env on import (JWT_SECRET, DEVICE_TOKEN_PEPPER).
// Stub them with non-empty values before importing the reconciler module so
// the env-validation gate doesn't trip in the container-mode integration run.
process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-196 reconciler (real Postgres)', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  it('runs the stuck-issue and stale-outbox SELECTs without throwing', async () => {
    // Seed an issue that the reconciler should NOT rescue — `updated_at` is
    // fresh, so the 60-second filter excludes it. The point of the test is
    // that the query parses and executes; we don't want a real
    // `reEnqueueForIssue` to fire here (no pg-boss in this harness).
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id, updated_at)
      VALUES (${issueId}, ${project.id}, 'fresh', 'confirmed', ${user.id}, now())
    `);

    const { runReconcilerOnce } = await import('../../src/pipeline/reconciler.js');

    const result = await runReconcilerOnce();
    expect(result.rescued).toBe(0);
    expect(result.stale).toBe(0);
  });

  it('selects a stuck issue when updated_at is older than the threshold', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const issueId = randomUUID();
    // updated_at intentionally older than 60s — qualifies as stuck.
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id, updated_at)
      VALUES (${issueId}, ${project.id}, 'stale', 'confirmed', ${user.id}, now() - interval '5 minutes')
    `);

    // Verify the reconciler's SELECT (in-list builder) finds this row. We hit
    // the same SQL by importing the module's internal helper isn't worth it;
    // instead, re-run the parameterised IN-list query directly to prove the
    // shape postgres-js accepts.
    const { AUTO_DISPATCH_STATUSES } = await import('../../src/pipeline/registry.js');
    const statusList = sql.join(
      AUTO_DISPATCH_STATUSES.map((s) => sql`${s}`),
      sql`, `,
    );
    const rows = await harness.db.execute<{ id: string }>(sql`
      SELECT i.id FROM issues i
      WHERE i.status IN (${statusList})
        AND i.updated_at < now() - interval '60 seconds'
    `);
    expect(rows.map((r) => r.id)).toContain(issueId);
  });
});
