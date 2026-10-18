import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIdleFixture } from '../helpers/idle-fixture.js';

const emitted: Array<{ issueId: string; body: string }> = [];
vi.mock('../../src/notifications/emit.js', () => ({
  emitNotification: async (args: { issueId: string; body: string }) => {
    emitted.push({ issueId: args.issueId, body: args.body });
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
 * ISS-1229 round 13, judge-30's failure of criterion 67: an Open issue whose title was edited twelve
 * minutes in was told 30.6 minutes after entering Open, because the idle sweep's grace ran from
 * `updated_at`, which any field write moves. The grace runs from when nothing has worked the issue
 * since: the later of entering its status and its last job, run or run session ending.
 */

const fx = registerIdleFixture(1329);
const MIN = 60_000;
const HOUR = 60 * MIN;

let idle: typeof import('../../src/pipeline/idle-issues.js');

beforeAll(async () => {
  idle = await import('../../src/pipeline/idle-issues.js');
}, 60_000);

beforeEach(async () => {
  emitted.length = 0;
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
});

const iso = (d: Date) => d.toISOString();

const enteredAt = (issueId: string, from: string, to: string, at: Date) =>
  fx.enterStatus(issueId, from, to, iso(at));

async function finishedRun(issueId: string, at: Date): Promise<void> {
  await fx.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at, finished_at)
    VALUES (${randomUUID()}, ${fx.projectId}, ${issueId}, 'issue', 'completed',
            ${iso(new Date(at.getTime() - HOUR))}, ${iso(at)})
  `);
}

async function finishedJob(issueId: string, at: Date): Promise<void> {
  const runId = await fx.seedLiveJob(issueId);
  await fx.db.execute(sql`
    UPDATE jobs SET status = 'done', finished_at = ${iso(at)} WHERE pipeline_run_id = ${runId}
  `);
  await fx.db.execute(sql`
    UPDATE pipeline_runs SET status = 'completed', finished_at = ${iso(new Date(at.getTime() - 2 * HOUR))}
     WHERE id = ${runId}
  `);
}

async function endedRunSession(issSeq: number, at: Date): Promise<void> {
  await fx.seedIssueLease(issSeq, 'completed');
  const key = `ISS-${issSeq}`;
  await fx.db.execute(sql`
    UPDATE agent_sessions SET updated_at = ${iso(at)}
     WHERE id IN (SELECT session_id FROM issue_leases WHERE issue_key = ${key})
  `);
  await fx.db.execute(sql`
    UPDATE pipeline_runs SET status = 'completed', finished_at = ${iso(new Date(at.getTime() - 2 * HOUR))}
     WHERE id IN (SELECT run_id FROM issue_leases WHERE issue_key = ${key})
  `);
}

const told = (issueId: string) => emitted.some((e) => e.issueId === issueId);

async function resetCursors(): Promise<void> {
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
}

describe('the idle sweep times its grace from when nothing has worked the issue', () => {
  it('tells an Open issue edited twelve minutes in on the same clock as its unedited twin', async () => {
    await fx.seedRunner('online');
    const now = new Date('2026-10-17T12:00:00.000Z');
    const entered = new Date(now.getTime() - 16 * MIN);
    const control = await fx.seedIssue({ status: 'open', updatedAt: iso(entered) });
    await enteredAt(control, 'draft', 'open', entered);
    const edited = await fx.seedIssue({
      status: 'open',
      updatedAt: iso(new Date(entered.getTime() + 12 * MIN)),
    });
    await enteredAt(edited, 'draft', 'open', entered);

    await idle.reconcileIdleIssues(now);

    expect(told(control)).toBe(true);
    expect(told(edited)).toBe(true);
    expect(emitted.find((e) => e.issueId === edited)?.body).toMatch(
      /^Nothing has worked it for 16 minutes:/,
    );
  });

  it('waits out an Open issue fourteen minutes after it entered, however long ago it was last edited', async () => {
    await fx.seedRunner('online');
    const now = new Date('2026-10-17T12:00:00.000Z');
    const issue = await fx.seedIssue({
      status: 'open',
      updatedAt: iso(new Date(now.getTime() - 3 * HOUR)),
    });
    await enteredAt(issue, 'draft', 'open', new Date(now.getTime() - 14 * MIN));

    await idle.reconcileIdleIssues(now);

    expect(told(issue)).toBe(false);
  });

  it.each(['job', 'run', 'run session'] as const)(
    'holds an issue In progress for five hours while its %s ended an hour ago, and tells it once the grace runs out from that ending',
    async (kind) => {
      const now = new Date('2026-10-17T12:00:00.000Z');
      const ended = new Date(now.getTime() - HOUR);
      const issue = await fx.seedIssue({
        status: 'in_progress',
        updatedAt: iso(new Date(now.getTime() - 3 * HOUR)),
      });
      await enteredAt(issue, 'open', 'in_progress', new Date(now.getTime() - 5 * HOUR));
      if (kind === 'job') await finishedJob(issue, ended);
      else if (kind === 'run') await finishedRun(issue, ended);
      else await endedRunSession(fx.lastSeq, ended);

      await idle.reconcileIdleIssues(now);
      expect(told(issue)).toBe(false);

      // An edit to the row after the ending moves nothing: the clock is the work, not the row.
      const later = new Date(ended.getTime() + 2 * HOUR + MIN);
      await fx.db.execute(sql`
        UPDATE issues SET title = 'edited', updated_at = ${iso(new Date(later.getTime() - 5 * MIN))}
         WHERE id = ${issue}
      `);
      await resetCursors();
      await idle.reconcileIdleIssues(later);
      expect(told(issue)).toBe(true);
    },
  );
});
