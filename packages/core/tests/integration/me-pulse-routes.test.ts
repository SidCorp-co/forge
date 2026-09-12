/**
 * ISS-988 — `GET /api/me/pulse` against real Postgres.
 *
 * Every figure this endpoint answers is raw SQL: anti-joins from `pipeline_runs`
 * to live `jobs`, an idle clock that coalesces four job timestamps and falls back
 * to the issue's own, `date_trunc` week buckets read in both directions, and a
 * `percentile_disc` per job type. None of it is exercised by a mocked db, and
 * the one figure the dashboard existed to get wrong — a run at `running` with
 * nothing working it — is exactly an anti-join.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import type { PulseResponse } from '../../src/me/pulse-types.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('GET /api/me/pulse (ISS-988)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

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

    const { mePulseRoutes } = await import('../../src/me/pulse-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/me', mePulseRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function member() {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    return { user, project, token: await signUserToken(user.id) };
  }

  const pulse = async (token: string, query = ''): Promise<PulseResponse> => {
    const res = await app.request(`/api/me/pulse${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as PulseResponse;
  };

  let seq = 100;

  // `pipeline_runs_issue_kind_chk` refuses an `issue`-kind run with no issue, so
  // one is seeded here rather than the kind being quietly relaxed to 'system'.
  async function openRun(
    projectId: string,
    kind = 'issue',
    issueId: string | null = null,
    userId?: string,
  ) {
    const id = randomUUID();
    let linked = issueId;
    if (kind === 'issue' && linked === null && userId) {
      linked = await addIssue({ projectId, userId, status: 'in_progress', seq: seq++ });
    }
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${id}, ${projectId}, ${linked}, ${kind}, 'running', now())
    `);
    return id;
  }

  async function addJob(args: {
    projectId: string;
    runId: string;
    userId: string;
    status: string;
    type?: string;
    issueId?: string | null;
    queuedAgo?: string;
  }) {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, type, status, created_by, queued_at)
      VALUES (${id}, ${args.projectId}, ${args.runId}, ${args.issueId ?? null}, ${args.type ?? 'code'},
              ${args.status}, ${args.userId}, now() - ${args.queuedAgo ?? '1 minute'}::interval)
    `);
    return id;
  }

  async function addIssue(args: {
    projectId: string;
    userId: string;
    status?: string;
    seq?: number;
    updatedAgo?: string;
    mergedAt?: boolean;
    reopenCount?: number;
  }) {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, updated_at, merged_at, reopen_count)
      VALUES (${id}, ${args.projectId}, ${args.seq ?? 1}, 'seeded', ${args.status ?? 'open'}, ${args.userId},
              now() - ${args.updatedAgo ?? '1 minute'}::interval,
              ${args.mergedAt ? sql`now()` : sql`NULL`}, ${args.reopenCount ?? 0})
    `);
    return id;
  }

  describe('scope', () => {
    it('401s an unauthenticated request', async () => {
      const res = await app.request('/api/me/pulse');
      expect(res.status).toBe(401);
    });

    it('answers an empty pulse for a caller who can see no project', async () => {
      const user = await createTestUser(harness.db);
      await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
      const body = await pulse(await signUserToken(user.id));
      expect(body.work.buckets).toEqual({
        open: 0,
        inProgress: 0,
        awaitingRelease: 0,
        humanBlocked: 0,
      });
      expect(body.liveness.silenceSeconds).toBeNull();
    });

    it('leaves out a project the caller cannot see', async () => {
      const mine = await member();
      const theirs = await member();
      await addIssue({ projectId: theirs.project.id, userId: theirs.user.id, status: 'open' });
      await addIssue({ projectId: mine.project.id, userId: mine.user.id, status: 'open', seq: 2 });

      const body = await pulse(mine.token);
      expect(body.work.buckets.open).toBe(1);
      expect(body.work.perProject.map((p) => p.id)).toEqual([mine.project.id]);
    });

    it('narrows to one organization when orgId names it', async () => {
      const mine = await member();
      await addIssue({ projectId: mine.project.id, userId: mine.user.id, status: 'open' });
      const body = await pulse(mine.token, `?orgId=${randomUUID()}`);
      expect(body.work.perProject).toEqual([]);
      expect(body.work.buckets.open).toBe(0);
    });
  });

  describe('liveness is counted off jobs, never off run status', () => {
    it('counts a running run with no live job as claimed-but-empty', async () => {
      const { user, project, token } = await member();
      const runId = await openRun(project.id, 'issue', null, user.id);
      await addJob({ projectId: project.id, runId, userId: user.id, status: 'done' });

      const body = await pulse(token);
      expect(body.liveness.stuckRuns.total).toBe(1);
      expect(body.liveness.stuckRuns.shown[0]?.runId).toBe(runId);
      expect(body.liveness.jobsRunning).toBe(0);
      expect(body.work.perProject[0]?.stuckRuns).toBe(1);
    });

    it('leaves a running run with a live job out of the stuck count', async () => {
      const { user, project, token } = await member();
      const runId = await openRun(project.id, 'issue', null, user.id);
      await addJob({ projectId: project.id, runId, userId: user.id, status: 'running' });

      const body = await pulse(token);
      expect(body.liveness.stuckRuns.total).toBe(0);
      expect(body.liveness.jobsRunning).toBe(1);
    });

    it('leaves a run out of the stuck count on a `held` job alone', async () => {
      const { user, project, token } = await member();
      const runId = await openRun(project.id, 'issue', null, user.id);
      await addJob({ projectId: project.id, runId, userId: user.id, status: 'held' });

      const body = await pulse(token);
      expect(body.liveness.stuckRuns.total).toBe(0);
      expect(body.liveness.jobsHeld).toBe(1);
    });

    it('separates queued from running and names the live jobs it counts', async () => {
      const { user, project, token } = await member();
      const runId = await openRun(project.id, 'issue', null, user.id);
      await addJob({ projectId: project.id, runId, userId: user.id, status: 'queued' });
      await addJob({ projectId: project.id, runId, userId: user.id, status: 'dispatched' });

      const body = await pulse(token);
      expect(body.liveness.jobsQueued).toBe(1);
      expect(body.liveness.jobsRunning).toBe(1);
      expect(body.liveness.liveJobs.total).toBe(2);
      expect(body.liveness.liveJobs.shown).toHaveLength(2);
    });

    it('dates the silence from the newest job activity and fills every heartbeat day', async () => {
      const { user, project, token } = await member();
      const runId = await openRun(project.id, 'issue', null, user.id);
      await addJob({
        projectId: project.id,
        runId,
        userId: user.id,
        status: 'done',
        queuedAgo: '3 days',
      });

      const body = await pulse(token);
      expect(body.liveness.silenceSeconds).toBeGreaterThan(2 * 86_400);
      expect(body.liveness.heartbeat).toHaveLength(30);
      expect(body.liveness.heartbeat.at(-1)?.issueRuns).toBe(1);
      expect(body.liveness.heartbeat[0]?.issueRuns).toBe(0);
    });
  });

  describe('an issue in flight that nothing is working', () => {
    it('counts an idle in_progress issue with no live job as abandoned', async () => {
      const { user, project, token } = await member();
      await addIssue({
        projectId: project.id,
        userId: user.id,
        status: 'in_progress',
        updatedAgo: '17 hours',
      });

      const body = await pulse(token);
      expect(body.work.abandoned.total).toBe(1);
      expect(body.work.abandoned.shown[0]?.issueRef).toBe('ISS-1');
      expect(body.work.perProject[0]?.abandonedIssues).toBe(1);
    });

    it('leaves an in_progress issue inside the idle threshold alone', async () => {
      const { user, project, token } = await member();
      await addIssue({
        projectId: project.id,
        userId: user.id,
        status: 'in_progress',
        updatedAgo: '1 minute',
      });

      const body = await pulse(token);
      expect(body.work.abandoned.total).toBe(0);
    });

    it('leaves an in_progress issue with a live job alone however old it is', async () => {
      const { user, project, token } = await member();
      const issueId = await addIssue({
        projectId: project.id,
        userId: user.id,
        status: 'in_progress',
        updatedAgo: '30 days',
      });
      const runId = await openRun(project.id, 'issue', issueId);
      await addJob({ projectId: project.id, runId, userId: user.id, status: 'running', issueId });

      const body = await pulse(token);
      expect(body.work.abandoned.total).toBe(0);
    });

    it('dates an in_progress issue that never carried a job from the issue itself', async () => {
      const { user, project, token } = await member();
      await addIssue({
        projectId: project.id,
        userId: user.id,
        status: 'in_progress',
        updatedAgo: '5 days',
      });

      const body = await pulse(token);
      expect(body.work.abandoned.total).toBe(1);
      expect(body.work.abandoned.shown[0]?.ageSeconds).toBeGreaterThan(4 * 86_400);
    });
  });

  describe('where the work sits', () => {
    it('splits the buckets and excludes the finished statuses', async () => {
      const { user, project, token } = await member();
      const seed = async (status: string, seq: number) =>
        addIssue({ projectId: project.id, userId: user.id, status, seq });
      await seed('open', 1);
      await seed('approved', 2);
      await seed('developed', 3);
      await seed('awaiting_release', 4);
      await seed('waiting', 5);
      await seed('closed', 6);
      await seed('dropped', 7);
      await seed('draft', 8);

      const body = await pulse(token);
      expect(body.work.buckets).toEqual({
        open: 2,
        inProgress: 1,
        awaitingRelease: 1,
        humanBlocked: 1,
      });
    });

    it('reports a project that has never run an issue pipeline as null rather than as old', async () => {
      const { user, project, token } = await member();
      await addIssue({ projectId: project.id, userId: user.id, status: 'open' });

      const body = await pulse(token);
      expect(body.work.perProject[0]?.lastIssueRunAt).toBeNull();
      expect(body.work.neverRanProjects.total).toBe(1);
      expect(body.work.silentProjects.total).toBe(0);
    });

    it('names a project holding a backlog whose last run is past the silence threshold', async () => {
      const { user, project, token } = await member();
      const silentIssue = await addIssue({ projectId: project.id, userId: user.id, status: 'open' });
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
        VALUES (${randomUUID()}, ${project.id}, ${silentIssue}, 'issue', 'completed', now() - interval '30 days')
      `);

      const body = await pulse(token);
      expect(body.work.silentProjects.total).toBe(1);
      expect(body.work.neverRanProjects.total).toBe(0);
    });

    it('names an issue that has waited on release past the threshold', async () => {
      const { user, project, token } = await member();
      await addIssue({
        projectId: project.id,
        userId: user.id,
        status: 'awaiting_release',
        updatedAgo: '4 days',
      });

      const body = await pulse(token);
      expect(body.work.releaseWaiting.total).toBe(1);
      expect(body.work.releaseWaiting.shown[0]?.status).toBe('awaiting_release');
    });
  });

  describe('the output', () => {
    it('splits the finished issues on merge evidence', async () => {
      const { user, project, token } = await member();
      await addIssue({ projectId: project.id, userId: user.id, status: 'closed', seq: 1, mergedAt: true });
      await addIssue({ projectId: project.id, userId: user.id, status: 'closed', seq: 2 });
      await addIssue({ projectId: project.id, userId: user.id, status: 'dropped', seq: 3 });
      await addIssue({ projectId: project.id, userId: user.id, status: 'closed', seq: 4, reopenCount: 2 });

      const body = await pulse(token);
      expect(body.quality.finished).toEqual({ merged: 1, closedUnmerged: 2, dropped: 1 });
      expect(body.quality.reopened).toEqual({ issues: 1, events: 2 });
    });

    it('keeps a third run kind out of both named lanes', async () => {
      const { user, project, token } = await member();
      await openRun(project.id, 'issue', null, user.id);
      await openRun(project.id, 'system');
      await openRun(project.id, 'interactive');

      const body = await pulse(token);
      expect(body.quality.runFailure.pipeline.total).toBe(1);
      expect(body.quality.runFailure.scheduler.total).toBe(1);
      expect(body.quality.runFailure.other.total).toBe(1);
    });

    it('keeps an unclassified session failure as a row rather than dropping it', async () => {
      const { user, project, token } = await member();
      const runId = await openRun(project.id, 'system');
      for (const reason of [sql`NULL`, sql`'runner_unreachable'`]) {
        await harness.db.execute(sql`
          INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, status, failure_reason)
          VALUES (${randomUUID()}, ${project.id}, ${user.id}, ${runId}, 'failed', ${reason})
        `);
      }

      const body = await pulse(token);
      const reasons = Object.fromEntries(
        body.quality.sessionFailures.map((r) => [r.reason, r.count]),
      );
      expect(reasons.unclassified).toBe(1);
      expect(reasons.runner_unreachable).toBe(1);
    });

    it('counts fix against code jobs and reports a median per job type', async () => {
      const { user, project, token } = await member();
      const runId = await openRun(project.id, 'issue', null, user.id);
      await addJob({ projectId: project.id, runId, userId: user.id, status: 'done', type: 'code' });
      await addJob({ projectId: project.id, runId, userId: user.id, status: 'done', type: 'fix' });
      await harness.db.execute(sql`
        UPDATE jobs SET dispatched_at = queued_at, finished_at = queued_at + interval '30 seconds'
        WHERE project_id = ${project.id}
      `);

      const body = await pulse(token);
      expect(body.quality.rework).toEqual({ fix: 1, code: 1 });
      const fix = body.quality.pipelineFlow.find((r) => r.type === 'fix');
      expect(fix?.count).toBe(1);
      expect(fix?.medianSeconds).toBe(30);
    });
  });

  describe('the flow', () => {
    it('returns twelve weeks and counts a close and its later reopen in both directions', async () => {
      const { user, project, token } = await member();
      const issueId = await addIssue({ projectId: project.id, userId: user.id, status: 'reopen' });
      const event = async (from: string, to: string, ago: string) =>
        harness.db.execute(sql`
          INSERT INTO activity_log (id, issue_id, actor_type, actor_id, action, payload, created_at)
          VALUES (${randomUUID()}, ${issueId}, 'user', ${user.id}, 'issue.statusChanged',
                  ${JSON.stringify({ from, to })}::jsonb, now() - ${ago}::interval)
        `);
      await event('in_progress', 'closed', '3 weeks');
      await event('closed', 'reopen', '1 week');

      const body = await pulse(token);
      expect(body.flow).toHaveLength(12);
      expect(body.flow.reduce((a, w) => a + w.closed, 0)).toBe(1);
      expect(body.flow.reduce((a, w) => a + w.reopened, 0)).toBe(1);
      expect(body.flow.at(-1)?.backlog).toBe(1);
    });
  });

  describe('thresholds', () => {
    it('names every cutoff the surface marks against', async () => {
      const { token } = await member();
      const body = await pulse(token);
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
});
