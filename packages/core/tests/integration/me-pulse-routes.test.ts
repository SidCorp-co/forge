/**
 * ISS-988 — `GET /api/me/pulse` liveness, against real Postgres.
 *
 * The one figure the old dashboard existed to get wrong — a run at `running`
 * with nothing working it — is an anti-join from `pipeline_runs` to live `jobs`,
 * and a mocked db exercises none of it. The idle clock that coalesces four job
 * timestamps and falls back to the issue's own is the same shape.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestUser, truncateAll } from '../helpers/index.js';
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

describe('GET /api/me/pulse — liveness (ISS-988) · scope', () => {
  it('401s an unauthenticated request', async () => {
    const res = await h.app.request('/api/me/pulse');
    expect(res.status).toBe(401);
  });

  it('answers an empty pulse for a caller who can see no project', async () => {
    const user = await createTestUser(h.harness.db);
    await h.harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`,
    );
    const body = await seed.pulse(await h.signUserToken(user.id));
    expect(body.work.buckets).toEqual({
      open: 0,
      inProgress: 0,
      awaitingRelease: 0,
      humanBlocked: 0,
    });
    expect(body.liveness.silenceSeconds).toBeNull();
  });

  it('leaves out a project the caller cannot see', async () => {
    const mine = await seed.member();
    const theirs = await seed.member();
    await seed.addIssue({ projectId: theirs.project.id, userId: theirs.user.id, status: 'open' });
    await seed.addIssue({
      projectId: mine.project.id,
      userId: mine.user.id,
      status: 'open',
      seq: 2,
    });

    const body = await seed.pulse(mine.token);
    expect(body.work.buckets.open).toBe(1);
    expect(body.work.perProject.map((p) => p.id)).toEqual([mine.project.id]);
  });

  it('narrows to one organization when orgId names it', async () => {
    const mine = await seed.member();
    await seed.addIssue({ projectId: mine.project.id, userId: mine.user.id, status: 'open' });
    const body = await seed.pulse(mine.token, `?orgId=${randomUUID()}`);
    expect(body.work.perProject).toEqual([]);
    expect(body.work.buckets.open).toBe(0);
  });
});

describe('GET /api/me/pulse — liveness (ISS-988) · liveness is counted off jobs, never off run status', () => {
  it('counts a running run with no live job as claimed-but-empty', async () => {
    const { user, project, token } = await seed.member();
    const runId = await seed.openRun(project.id, 'issue', null, user.id);
    await seed.addJob({ projectId: project.id, runId, userId: user.id, status: 'done' });

    const body = await seed.pulse(token);
    expect(body.liveness.stuckRuns.total).toBe(1);
    expect(body.liveness.stuckRuns.shown[0]?.runId).toBe(runId);
    expect(body.liveness.jobsRunning).toBe(0);
    expect(body.work.perProject[0]?.stuckRuns).toBe(1);
  });

  it('leaves a running run with a live job out of the stuck count', async () => {
    const { user, project, token } = await seed.member();
    const runId = await seed.openRun(project.id, 'issue', null, user.id);
    await seed.addJob({ projectId: project.id, runId, userId: user.id, status: 'running' });

    const body = await seed.pulse(token);
    expect(body.liveness.stuckRuns.total).toBe(0);
    expect(body.liveness.jobsRunning).toBe(1);
  });

  it('leaves a run out of the stuck count on a `held` job alone', async () => {
    const { user, project, token } = await seed.member();
    const runId = await seed.openRun(project.id, 'issue', null, user.id);
    await seed.addJob({ projectId: project.id, runId, userId: user.id, status: 'held' });

    const body = await seed.pulse(token);
    expect(body.liveness.stuckRuns.total).toBe(0);
    expect(body.liveness.jobsHeld).toBe(1);
  });

  it('separates queued from running and names the live jobs it counts', async () => {
    const { user, project, token } = await seed.member();
    const runId = await seed.openRun(project.id, 'issue', null, user.id);
    await seed.addJob({ projectId: project.id, runId, userId: user.id, status: 'queued' });
    await seed.addJob({ projectId: project.id, runId, userId: user.id, status: 'dispatched' });

    const body = await seed.pulse(token);
    expect(body.liveness.jobsQueued).toBe(1);
    expect(body.liveness.jobsRunning).toBe(1);
    expect(body.liveness.liveJobs.total).toBe(2);
    expect(body.liveness.liveJobs.shown).toHaveLength(2);
  });

  it('dates the silence from the newest job activity and fills every heartbeat day', async () => {
    const { user, project, token } = await seed.member();
    const runId = await seed.openRun(project.id, 'issue', null, user.id);
    await seed.addJob({
      projectId: project.id,
      runId,
      userId: user.id,
      status: 'done',
      queuedAgo: '3 days',
    });

    const body = await seed.pulse(token);
    expect(body.liveness.silenceSeconds).toBeGreaterThan(2 * 86_400);
    expect(body.liveness.heartbeat).toHaveLength(30);
    expect(body.liveness.heartbeat.at(-1)?.issueRuns).toBe(1);
    expect(body.liveness.heartbeat[0]?.issueRuns).toBe(0);
  });
});

describe('GET /api/me/pulse — liveness (ISS-988) · an issue in flight that nothing is working', () => {
  it('counts an idle in_progress issue with no live job as abandoned', async () => {
    const { user, project, token } = await seed.member();
    await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      updatedAgo: '17 hours',
    });

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(1);
    expect(body.work.abandoned.shown[0]?.issueRef).toBe('ISS-1');
    expect(body.work.perProject[0]?.abandonedIssues).toBe(1);
  });

  // cm:guard `jobs.issue_id` is nullable and carries ON DELETE SET NULL, so a live job reachable only through its RUN must still count as work in flight — reading `jobs.issue_id` alone reports a worked issue as abandoned, the exact inverse of this figure (ISS-988).
  it('leaves an issue alone whose live job is linked only through its run', async () => {
    const { user, project, token } = await seed.member();
    const issueId = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      updatedAgo: '30 days',
    });
    const runId = await seed.openRun(project.id, 'issue', issueId);
    await seed.addJob({
      projectId: project.id,
      runId,
      userId: user.id,
      status: 'running',
      issueId: null,
      queuedAgo: '30 days',
    });

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(0);
    expect(body.liveness.stuckRuns.total).toBe(0);
  });

  it('leaves an in_progress issue inside the idle threshold alone', async () => {
    const { user, project, token } = await seed.member();
    await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      updatedAgo: '1 minute',
    });

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(0);
  });

  it('leaves an in_progress issue with a live job alone however old it is', async () => {
    const { user, project, token } = await seed.member();
    const issueId = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      updatedAgo: '30 days',
    });
    const runId = await seed.openRun(project.id, 'issue', issueId);
    await seed.addJob({
      projectId: project.id,
      runId,
      userId: user.id,
      status: 'running',
      issueId,
    });

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(0);
  });

  it('dates an in_progress issue that never carried a job from the issue itself', async () => {
    const { user, project, token } = await seed.member();
    await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      updatedAgo: '5 days',
    });

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(1);
    expect(body.work.abandoned.shown[0]?.ageSeconds).toBeGreaterThan(4 * 86_400);
  });
});
