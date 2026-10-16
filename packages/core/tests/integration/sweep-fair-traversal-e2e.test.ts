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
    // Every row is equally and permanently eligible: parked at `waiting` since it was made, well
    // past the grace, and nothing in this pass will ever change that. The park time is strictly
    // increasing so the traversal order is total and the assertions below can name pages by it.
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq, created_at, updated_at)
      SELECT gen_random_uuid(), ${projectId}, 'strand ' || g, 'waiting', ${owner.id}, g,
             now() - interval '30 days' + (g || ' seconds')::interval,
             now() - interval '30 days' + (g || ' seconds')::interval
      FROM generate_series(1, ${total}) g
    `);
  }, 60_000);

  /**
   * Every row already told about, so no row is owed a sighting beside the page (owed-sighting.ts)
   * and what a pass reads is its page alone: the cursor is what these cases measure.
   */
  async function everyRowTold(): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO notifications (project_id, issue_id, type, kind, tier, state, title, resolution_key,
                                 pending_since, last_seen_at, created_at)
      SELECT i.project_id, i.id, 'issue_stranded', 'condition', 'ticket', 'firing', 'told',
             'issue:' || i.id || ':stranded', now(), now(), now()
        FROM issues i
    `);
  }

  /** How many rows a pass at `at` saw: each condition it saw carries that pass's clock. */
  async function seenAt(at: Date): Promise<number> {
    const rows = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM notifications WHERE last_seen_at = ${at.toISOString()}::timestamptz`,
    );
    return rows[0]?.n ?? 0;
  }

  const T = (minute: number) => new Date(Date.UTC(2030, 0, 1, 0, minute));

  it('reads one bounded page rather than the whole candidate set', async () => {
    await everyRowTold();
    const res = await mods.detectStrandedIssues(T(1));

    expect(res.detected).toBe(mods.STRANDED_SCAN_LIMIT);
    expect(await seenAt(T(1))).toBe(mods.STRANDED_SCAN_LIMIT);
  });

  it('sees the rows past its bound on the very next pass', async () => {
    await everyRowTold();
    await mods.detectStrandedIssues(T(1));

    const second = await mods.detectStrandedIssues(T(2));

    expect(second.detected).toBe(OVERFLOW);
    // Every one of the 205 candidates has now been seen, so nothing sat behind the bound.
    expect((await seenAt(T(1))) + (await seenAt(T(2)))).toBe(mods.STRANDED_SCAN_LIMIT + OVERFLOW);
  });

  it('wraps back to the oldest candidate once the traversal has run out', async () => {
    await everyRowTold();
    await mods.detectStrandedIssues(T(1));
    await mods.detectStrandedIssues(T(2));

    // The short second page ends the traversal, so the third starts again at the oldest row.
    const third = await mods.detectStrandedIssues(T(3));

    expect(third.detected).toBe(mods.STRANDED_SCAN_LIMIT);
  });

  it('keeps each pass proportional to its bound, not to the table', async () => {
    await everyRowTold();
    const first = await mods.detectStrandedIssues(T(1));
    const second = await mods.detectStrandedIssues(T(2));
    const third = await mods.detectStrandedIssues(T(3));

    for (const pass of [first, second, third]) {
      expect(pass.detected).toBeLessThanOrEqual(mods.STRANDED_SCAN_LIMIT);
    }
  });

  it('reads, beside its page, the rows not yet told about, newest first (ISS-1229 r12)', async () => {
    const first = await mods.detectStrandedIssues(T(1));

    // The page holds the 200 oldest; the five newest are owed a sighting beside it.
    expect(first.detected).toBe(mods.STRANDED_SCAN_LIMIT + OVERFLOW);
  });
});
