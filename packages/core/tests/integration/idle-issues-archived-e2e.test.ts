/**
 * ISS-1229 r10 — judge-22 archived its scratch project with ISS-1 at In progress and the notice
 * kept coming. The idle sweep reads no issue of an archived project, and resolves the idle notice
 * it raised there before the archive.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIdleFixture } from '../helpers/idle-fixture.js';

const emitted: Array<{ title: string }> = [];
vi.mock('../../src/notifications/emit.js', () => ({
  emitNotification: async (args: { title: string }) => {
    emitted.push({ title: args.title });
    return { delivered: 1 };
  },
}));
vi.mock('../../src/notifications/project-admins.js', async () => {
  const { sql } = await import('drizzle-orm');
  return {
    projectAdminUserIdsFor: async (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, [`admin-of-${id}`]])),
    projectAdminUserIds: async () => ['admin'],
    projectHasAdminSql: () => sql`TRUE`,
  };
});

const fx = registerIdleFixture(1300);
const NOW = new Date('2026-09-20T16:00:00.000Z');

let reconcileIdleIssues: typeof import('../../src/pipeline/idle-issues.js').reconcileIdleIssues;

beforeAll(async () => {
  reconcileIdleIssues = (await import('../../src/pipeline/idle-issues.js')).reconcileIdleIssues;
}, 60_000);

beforeEach(async () => {
  emitted.length = 0;
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
});

const archive = () =>
  fx.db.execute(sql`UPDATE projects SET archived_at = now() WHERE id = ${fx.projectId}`);

describe('the idle sweep on an archived project', () => {
  it('reads its issue as nothing, writes no finding and raises no notice', async () => {
    await fx.seedRunner('online');
    const issueId = await fx.seedIssue({ status: 'in_progress' });
    await archive();

    const result = await reconcileIdleIssues(NOW);

    expect(result.detected).toBe(0);
    expect(emitted).toEqual([]);
    const rows = (await fx.db.execute(
      sql`SELECT session_context -> 'strand' AS strand FROM issues WHERE id = ${issueId}`,
    )) as unknown as Array<{ strand: unknown }>;
    expect(rows[0]?.strand ?? null).toBeNull();
  });

  it('resolves the idle notice it raised before the archive', async () => {
    const issueId = await fx.seedIssue({ status: 'in_progress' });
    await fx.db.execute(sql`
      INSERT INTO notifications (id, project_id, issue_id, type, kind, tier, state, title, resolution_key)
      VALUES (${randomUUID()}, ${fx.projectId}, ${issueId}, 'issue_stranded', 'condition', 'ticket',
              'firing', 'idle', ${`issue:${issueId}:idle`})
    `);
    await archive();

    await reconcileIdleIssues(NOW);

    const open = (await fx.db.execute(
      sql`SELECT 1 FROM notifications WHERE issue_id = ${issueId} AND resolved_at IS NULL`,
    )) as unknown as unknown[];
    expect(open).toHaveLength(0);
  });
});
