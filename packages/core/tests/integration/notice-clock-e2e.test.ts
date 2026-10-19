import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIdleFixture } from '../helpers/idle-fixture.js';

const emitted: Array<{ body: string }> = [];
vi.mock('../../src/notifications/emit.js', () => ({
  emitNotification: async (args: { body: string }) => {
    emitted.push({ body: args.body });
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

/**
 * ISS-1229, judge j16: a stuck-issue notice counted from the row's last write, so any edit to the
 * issue made it read as if it had stood at its status for less time than it had. Each case writes
 * the row long after the issue entered its status, which a count from `updated_at` cannot survive.
 */

const fx = registerIdleFixture(1229);
const NOW = new Date('2026-09-20T16:00:00.000Z');

let idle: typeof import('../../src/pipeline/idle-issues.js');
let stranded: typeof import('../../src/pipeline/stranded-issues.js');

beforeAll(async () => {
  idle = await import('../../src/pipeline/idle-issues.js');
  stranded = await import('../../src/pipeline/stranded-issues.js');
}, 60_000);

beforeEach(async () => {
  emitted.length = 0;
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
});

async function enteredAt(issueId: string, from: string, to: string, at: string): Promise<void> {
  await fx.db.execute(sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, source, created_at)
    VALUES ('issue', ${issueId}, ${from}, ${to}, 'user', 'test', ${at})
  `);
}

describe('how long a stuck-issue notice says the issue has stood', () => {
  it('an idle notice counts from when the issue entered its status', async () => {
    await fx.seedRunner('online');
    const issueId = await fx.seedIssue({ status: 'open', updatedAt: '2026-09-20T15:00:00.000Z' });
    await enteredAt(issueId, 'draft', 'open', '2026-09-18T15:00:00.000Z');

    await idle.reconcileIdleIssues(NOW);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.body).toMatch(/^ISS-\d+ has read Open for 2 days /);
  });

  it('a waiting-park notice counts from when the issue was parked', async () => {
    const issueId = await fx.seedIssue({
      status: 'waiting',
      updatedAt: '2026-09-19T10:00:00.000Z',
    });
    await enteredAt(issueId, 'in_progress', 'waiting', '2026-09-17T15:00:00.000Z');

    await stranded.detectStrandedIssues(NOW);

    expect(emitted.map((e) => e.body)).toEqual([
      `ISS-${fx.lastSeq} "idle row": it has been parked for 3 days.`,
    ]);
  });
});
