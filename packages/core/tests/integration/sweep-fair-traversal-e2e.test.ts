/**
 * ISS-1021 — a bounded notify-only pass must still reach every candidate.
 *
 * These passes write nothing on the rows they surface, so a row stays eligible after it has been
 * notified. That makes a plain `ORDER BY ... LIMIT n` a permanent blind spot rather than a
 * deferral: the same first page is read on every tick and candidate n+1 is never surfaced at all,
 * which is strictly worse than the unbounded scan it replaces. The cursor in
 * `src/pipeline/sweep-cursor.ts` is the other half of the bound.
 *
 * The property under test is liveness, and it is not visible in one call — it only appears across
 * consecutive passes over a candidate set larger than one page. That is why this is an integration
 * test with a real page of rows rather than a unit test with a stubbed query.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  detectStrandedIssues: typeof import('../../src/pipeline/stranded-issues.js').detectStrandedIssues;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  STRANDED_SCAN_LIMIT: typeof import('../../src/pipeline/stranded-issues.js').STRANDED_SCAN_LIMIT;
};
type CursorMod = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  resetSweepCursorsForTest: typeof import('../../src/pipeline/sweep-cursor.js').resetSweepCursorsForTest;
};

describe('a bounded notify-only sweep reaches every candidate (ISS-1021)', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let cursors: CursorMod;
  let projectId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';
    mods = (await import('../../src/pipeline/stranded-issues.js')) as unknown as Mods;
    cursors = (await import('../../src/pipeline/sweep-cursor.js')) as unknown as CursorMod;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  /** One page plus a remainder — the smallest set that can show the blind spot. */
  const OVERFLOW = 5;

  beforeEach(async () => {
    await truncateAll(harness.db);
    cursors.resetSweepCursorsForTest();

    const owner = await createTestUser(harness.db);
    const org = await seedOrg(harness.db, owner.id);
    const project = await createTestProject(harness.db, owner.id, { orgId: org.id });
    projectId = project.id;
    const admin = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      userId: admin.id,
      projectId,
      role: 'admin',
    });

    const total = mods.STRANDED_SCAN_LIMIT + OVERFLOW;
    // Every row is equally and permanently eligible: parked at `waiting`, well past the grace, and
    // nothing in this pass will ever change that. `updated_at` is strictly increasing so the
    // traversal order is total and the assertions below can name pages by it.
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq, updated_at)
      SELECT gen_random_uuid(), ${projectId}, 'strand ' || g, 'waiting', ${owner.id}, g,
             now() - interval '30 days' + (g || ' seconds')::interval
      FROM generate_series(1, ${total}) g
    `);
  }, 60_000);

  async function pageIds(): Promise<string[]> {
    // The detector returns counts, not ids, so the page is read back off what it surfaced this
    // tick: `sweep_group_key` is minute-truncated, so instead the notification rows carry the
    // issue each strand named.
    const rows = await harness.db.execute<{ issue_id: string }>(
      sql`SELECT DISTINCT issue_id FROM notifications WHERE type = 'issue_stranded'`,
    );
    return rows.map((r) => r.issue_id);
  }

  it('reads one bounded page rather than the whole candidate set', async () => {
    const res = await mods.detectStrandedIssues();

    expect(res.detected).toBe(mods.STRANDED_SCAN_LIMIT);
    expect(res.detected).toBeLessThan(mods.STRANDED_SCAN_LIMIT + OVERFLOW);
  });

  // cm:guard THE case F1 is about. Without the cursor this pass reads the same 200 rows forever
  // and these last five are never surfaced at all — the count would read 200 on both passes and
  // every assertion about detection would still look healthy.
  it('surfaces the rows past its bound on the very next pass', async () => {
    await mods.detectStrandedIssues();
    const afterFirst = new Set(await pageIds());
    expect(afterFirst.size).toBe(mods.STRANDED_SCAN_LIMIT);

    const second = await mods.detectStrandedIssues();

    expect(second.detected).toBe(OVERFLOW);
    const afterSecond = await pageIds();
    // Every one of the 205 candidates has now been named, so nothing sat behind the bound.
    expect(new Set(afterSecond).size).toBe(mods.STRANDED_SCAN_LIMIT + OVERFLOW);
  });

  it('wraps back to the oldest candidate once the traversal has run out', async () => {
    await mods.detectStrandedIssues();
    await mods.detectStrandedIssues();

    // The short second page ends the traversal, so the third starts again at the oldest row.
    const third = await mods.detectStrandedIssues();

    expect(third.detected).toBe(mods.STRANDED_SCAN_LIMIT);
  });

  it('keeps each pass proportional to its bound, not to the table', async () => {
    const first = await mods.detectStrandedIssues();
    const second = await mods.detectStrandedIssues();
    const third = await mods.detectStrandedIssues();

    for (const pass of [first, second, third]) {
      expect(pass.detected).toBeLessThanOrEqual(mods.STRANDED_SCAN_LIMIT);
    }
  });
});
