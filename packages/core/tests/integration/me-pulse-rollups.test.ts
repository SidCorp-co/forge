/**
 * ISS-988 — `GET /api/me/pulse` rollups, against real Postgres.
 *
 * The buckets, the `date_trunc` week walk read in both directions, and the
 * `percentile_disc` per job type are all raw SQL, so a mocked db proves none of
 * them. Split from the liveness suite: one describe holding both outgrew the
 * 150-line function budget.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { truncateAll } from '../helpers/index.js';
import { type PulseHarness, pulseSeeders, setupPulseHarness } from './me-pulse-fixtures.js';

let h: PulseHarness;
let seed: ReturnType<typeof pulseSeeders>;

beforeAll(async () => {
  h = await setupPulseHarness();
  seed = pulseSeeders(h);
}, 120_000);

afterAll(async () => {
  if (h?.harness) await h.harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(h.harness.db);
});

describe('GET /api/me/pulse — rollups (ISS-988) · where the work sits', () => {
  it('splits the buckets and excludes the finished statuses', async () => {
    const { user, project, token } = await seed.member();
    const at = async (status: string, seq: number) =>
      seed.addIssue({ projectId: project.id, userId: user.id, status, seq });
    await at('open', 1);
    await at('approved', 2);
    await at('developed', 3);
    await at('awaiting_release', 4);
    await at('waiting', 5);
    await at('closed', 6);
    await at('dropped', 7);
    await at('draft', 8);

    const body = await seed.pulse(token);
    expect(body.work.buckets).toEqual({
      open: 2,
      inProgress: 1,
      awaitingRelease: 1,
      humanBlocked: 1,
    });
  });

  it('reports a project that has never run an issue pipeline as null rather than as old', async () => {
    const { user, project, token } = await seed.member();
    await seed.addIssue({ projectId: project.id, userId: user.id, status: 'open' });

    const body = await seed.pulse(token);
    expect(body.work.perProject[0]?.lastIssueRunAt).toBeNull();
    expect(body.work.neverRanProjects.total).toBe(1);
    expect(body.work.silentProjects.total).toBe(0);
  });

  it('names a project holding a backlog whose last run is past the silence threshold', async () => {
    const { user, project, token } = await seed.member();
    const silentIssue = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'open',
    });
    await h.harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${randomUUID()}, ${project.id}, ${silentIssue}, 'issue', 'completed', now() - interval '30 days')
    `);

    const body = await seed.pulse(token);
    expect(body.work.silentProjects.total).toBe(1);
    expect(body.work.neverRanProjects.total).toBe(0);
  });

  it('names an issue that has waited on release past the threshold', async () => {
    const { user, project, token } = await seed.member();
    await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'awaiting_release',
      updatedAgo: '4 days',
    });

    const body = await seed.pulse(token);
    expect(body.work.releaseWaiting.total).toBe(1);
    expect(body.work.releaseWaiting.shown[0]?.status).toBe('awaiting_release');
  });
});

describe('GET /api/me/pulse — rollups (ISS-988) · the output', () => {
  it('splits the finished issues on merge evidence', async () => {
    const { user, project, token } = await seed.member();
    await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'closed',
      seq: 1,
      mergedAt: true,
    });
    await seed.addIssue({ projectId: project.id, userId: user.id, status: 'closed', seq: 2 });
    await seed.addIssue({ projectId: project.id, userId: user.id, status: 'dropped', seq: 3 });
    await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'closed',
      seq: 4,
      reopenCount: 2,
    });

    const body = await seed.pulse(token);
    expect(body.quality.finished).toEqual({ merged: 1, closedUnmerged: 2, dropped: 1 });
    expect(body.quality.reopened).toEqual({ issues: 1, events: 2 });
  });

  // cm:guard `markMergedOnClose` stamps `merged_at` on EVERY close, so the bare column degenerates to "closed" and reports never-merged work as shipped. This plants exactly that row — a close whose activity_log entry carries the same timestamp as the stamp — and it must land in `closedUnmerged` (ISS-817, ISS-988 criterion 17).
  it('does not read a close that stamped its own merged_at as merge evidence', async () => {
    const { user, project, token } = await seed.member();
    const id = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'closed',
      seq: 11,
      mergedAt: true,
    });
    await seed.addTransition({
      issueId: id,
      userId: user.id,
      to: 'closed',
      stampedAtMergedAt: true,
    });

    const body = await seed.pulse(token);
    expect(body.quality.finished.merged).toBe(0);
    expect(body.quality.finished.closedUnmerged).toBe(1);
  });

  it('reads a logged transition into the release rung as merge evidence', async () => {
    const { user, project, token } = await seed.member();
    const id = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'closed',
      seq: 12,
    });
    await seed.addTransition({ issueId: id, userId: user.id, to: 'awaiting_release' });

    const body = await seed.pulse(token);
    expect(body.quality.finished.merged).toBe(1);
    expect(body.quality.finished.closedUnmerged).toBe(0);
  });

  it('keeps a third run kind out of both named lanes', async () => {
    const { user, project, token } = await seed.member();
    await seed.openRun(project.id, 'issue', null, user.id);
    await seed.openRun(project.id, 'system');
    await seed.openRun(project.id, 'interactive');

    const body = await seed.pulse(token);
    expect(body.quality.runFailure.pipeline.total).toBe(1);
    expect(body.quality.runFailure.scheduler.total).toBe(1);
    expect(body.quality.runFailure.other.total).toBe(1);
  });

  it('keeps an unclassified session failure as a row rather than dropping it', async () => {
    const { user, project, token } = await seed.member();
    const runId = await seed.openRun(project.id, 'system');
    for (const reason of [sql`NULL`, sql`'runner_unreachable'`]) {
      await h.harness.db.execute(sql`
        INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, status, failure_reason)
        VALUES (${randomUUID()}, ${project.id}, ${user.id}, ${runId}, 'failed', ${reason})
      `);
    }

    const body = await seed.pulse(token);
    const reasons = Object.fromEntries(
      body.quality.sessionFailures.map((r) => [r.reason, r.count]),
    );
    expect(reasons.unclassified).toBe(1);
    expect(reasons.runner_unreachable).toBe(1);
  });

  it('counts fix against code jobs and reports a median per job type', async () => {
    const { user, project, token } = await seed.member();
    const runId = await seed.openRun(project.id, 'issue', null, user.id);
    await seed.addJob({
      projectId: project.id,
      runId,
      userId: user.id,
      status: 'done',
      type: 'code',
    });
    await seed.addJob({
      projectId: project.id,
      runId,
      userId: user.id,
      status: 'done',
      type: 'fix',
    });
    await h.harness.db.execute(sql`
      UPDATE jobs SET dispatched_at = queued_at, finished_at = queued_at + interval '30 seconds'
      WHERE project_id = ${project.id}
    `);

    const body = await seed.pulse(token);
    expect(body.quality.rework).toEqual({ fix: 1, code: 1 });
    const fix = body.quality.pipelineFlow.find((r) => r.type === 'fix');
    expect(fix?.count).toBe(1);
    expect(fix?.medianSeconds).toBe(30);
  });
});

describe('GET /api/me/pulse — rollups (ISS-988) · the flow', () => {
  it('returns twelve weeks and counts a close and its later reopen in both directions', async () => {
    const { user, project, token } = await seed.member();
    const issueId = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'reopen',
    });
    const event = async (from: string, to: string, ago: string) =>
      h.harness.db.execute(sql`
        INSERT INTO activity_log (id, issue_id, actor_type, actor_id, action, payload, created_at)
        VALUES (${randomUUID()}, ${issueId}, 'user', ${user.id}, 'issue.statusChanged',
                ${JSON.stringify({ from, to })}::jsonb, now() - ${ago}::interval)
      `);
    await event('in_progress', 'closed', '3 weeks');
    await event('closed', 'reopen', '1 week');

    const body = await seed.pulse(token);
    expect(body.flow).toHaveLength(12);
    expect(body.flow.reduce((a, w) => a + w.closed, 0)).toBe(1);
    expect(body.flow.reduce((a, w) => a + w.reopened, 0)).toBe(1);
    expect(body.flow.at(-1)?.backlog).toBe(1);
  });
});

describe('GET /api/me/pulse — rollups (ISS-988) · thresholds', () => {
  it('names every cutoff the surface marks against', async () => {
    const { token } = await seed.member();
    const body = await seed.pulse(token);
    expect(body.thresholds).toMatchObject({
      abandonedIssueSeconds: expect.any(Number),
      releaseWaitingSeconds: expect.any(Number),
      projectSilenceSeconds: expect.any(Number),
      silenceWarnSeconds: expect.any(Number),
      silenceAlarmSeconds: expect.any(Number),
      identityCap: expect.any(Number),
    });
  });
});
