/**
 * ISS-1022 — the abandoned-issue read after the `OR` became two indexed arms.
 *
 * Every case here is an equivalence claim, not a new behaviour: the rewrite
 * moved the staleness test into SQL, capped the row set and split one
 * disjunction over a LEFT JOIN into two `UNION ALL` arms, and each of those is
 * a way to change which issues are named while every existing suite stays
 * green. So the cases are the four shapes a job can have against an issue —
 * direct only, run only, both at once, and neither — plus the cap, the totals
 * and the idle clock.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PULSE_THRESHOLDS } from '../../src/me/pulse-types.js';
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

/** A run that names no issue, so a job under it is reachable by its own `issue_id` alone. */
const unlinkedRun = async (projectId: string) => {
  const id = randomUUID();
  await h.harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
    VALUES (${id}, ${projectId}, NULL, 'pm', 'running', now())
  `);
  return id;
};

const finishJob = async (jobId: string, ago: string) => {
  await h.harness.db.execute(sql`
    UPDATE jobs SET finished_at = now() - ${ago}::interval, status = 'done' WHERE id = ${jobId}
  `);
};

describe('ISS-1022 · the abandoned read reaches a job through either arm', () => {
  it('names an issue whose only job is reachable through jobs.issue_id', async () => {
    const { user, project, token } = await seed.member();
    const issue = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      seq: seed.nextSeq(),
    });
    const run = await unlinkedRun(project.id);
    const job = await seed.addJob({
      projectId: project.id,
      runId: run,
      userId: user.id,
      status: 'done',
      issueId: issue,
      queuedAgo: '10 hours',
    });
    await finishJob(job, '9 hours');

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(1);
    expect(body.work.abandoned.shown[0]?.documentId).toBe(issue);
  });

  it("names an issue whose only job is reachable through its run's issue_id", async () => {
    const { user, project, token } = await seed.member();
    const issue = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      seq: seed.nextSeq(),
    });
    const run = await seed.openRun(project.id, 'issue', issue);
    const job = await seed.addJob({
      projectId: project.id,
      runId: run,
      userId: user.id,
      status: 'done',
      issueId: null,
      queuedAgo: '10 hours',
    });
    await finishJob(job, '9 hours');

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(1);
    expect(body.work.abandoned.shown[0]?.documentId).toBe(issue);
  });

  it('counts a job whose own issue is one and whose run names another for both of them', async () => {
    const { user, project, token } = await seed.member();
    const direct = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      seq: seed.nextSeq(),
    });
    const viaRun = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      seq: seed.nextSeq(),
    });
    const run = await seed.openRun(project.id, 'issue', viaRun);
    const job = await seed.addJob({
      projectId: project.id,
      runId: run,
      userId: user.id,
      status: 'done',
      issueId: direct,
      queuedAgo: '10 hours',
    });
    await finishJob(job, '9 hours');

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(2);
    expect(body.work.abandoned.shown.map((r) => r.documentId).sort()).toEqual(
      [direct, viaRun].sort(),
    );
  });

  it('counts an issue once when the same job matches both arms', async () => {
    const { user, project, token } = await seed.member();
    const issue = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      seq: seed.nextSeq(),
    });
    const run = await seed.openRun(project.id, 'issue', issue);
    const job = await seed.addJob({
      projectId: project.id,
      runId: run,
      userId: user.id,
      status: 'done',
      issueId: issue,
      queuedAgo: '10 hours',
    });
    await finishJob(job, '9 hours');

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(1);
    expect(body.work.abandoned.shown).toHaveLength(1);
    expect(body.work.perProject[0]?.abandonedIssues).toBe(1);
  });
});

describe('ISS-1022 · the abandoned read keeps the idle clock and the liveness test it had', () => {
  it('takes the idle clock from the jobs even when issues.updated_at is later', async () => {
    const { user, project, token } = await seed.member();
    const issue = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      seq: seed.nextSeq(),
      updatedAgo: '1 minute',
    });
    const run = await unlinkedRun(project.id);
    const job = await seed.addJob({
      projectId: project.id,
      runId: run,
      userId: user.id,
      status: 'done',
      issueId: issue,
      queuedAgo: '10 hours',
    });
    await finishJob(job, '9 hours');

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(1);
    const age = body.work.abandoned.shown[0]?.ageSeconds ?? 0;
    expect(age).toBeGreaterThan(8 * 3600);
    expect(age).toBeLessThan(10 * 3600);
  });

  it('takes the idle clock from issues.updated_at for an issue that never carried a job', async () => {
    const { user, project, token } = await seed.member();
    await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      seq: seed.nextSeq(),
      updatedAgo: '5 hours',
    });

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(1);
    const age = body.work.abandoned.shown[0]?.ageSeconds ?? 0;
    expect(age).toBeGreaterThan(4 * 3600);
    expect(age).toBeLessThan(6 * 3600);
  });

  it('leaves an issue out while a live job is reachable through jobs.issue_id alone', async () => {
    const { user, project, token } = await seed.member();
    const issue = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      seq: seed.nextSeq(),
      updatedAgo: '5 hours',
    });
    const run = await unlinkedRun(project.id);
    await seed.addJob({
      projectId: project.id,
      runId: run,
      userId: user.id,
      status: 'running',
      issueId: issue,
      queuedAgo: '4 hours',
    });

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(0);
  });

  it("leaves an issue out while a live job is reachable through its run's issue_id alone", async () => {
    const { user, project, token } = await seed.member();
    const issue = await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      seq: seed.nextSeq(),
      updatedAgo: '5 hours',
    });
    const run = await seed.openRun(project.id, 'issue', issue);
    await seed.addJob({
      projectId: project.id,
      runId: run,
      userId: user.id,
      status: 'running',
      issueId: null,
      queuedAgo: '4 hours',
    });

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(0);
  });
});

describe('ISS-1022 · the abandoned read is bounded without lying about the total', () => {
  it('caps the identities at identityCap while total and the per-project count see every stale issue', async () => {
    const { user, project, token } = await seed.member();
    const over = PULSE_THRESHOLDS.identityCap + 7;
    for (let i = 0; i < over; i++) {
      await seed.addIssue({
        projectId: project.id,
        userId: user.id,
        status: 'in_progress',
        seq: seed.nextSeq(),
        updatedAgo: `${i + 2} hours`,
      });
    }

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(over);
    expect(body.work.abandoned.shown).toHaveLength(PULSE_THRESHOLDS.identityCap);
    expect(body.work.perProject[0]?.abandonedIssues).toBe(over);
  });

  it('excludes an issue that is idle but has not crossed the threshold', async () => {
    const { user, project, token } = await seed.member();
    await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'in_progress',
      seq: seed.nextSeq(),
      updatedAgo: '30 minutes',
    });

    const body = await seed.pulse(token);
    expect(body.work.abandoned.total).toBe(0);
  });

  it('caps the release-waiting identities while its total still counts every waiting issue', async () => {
    const { user, project, token } = await seed.member();
    const over = PULSE_THRESHOLDS.identityCap + 3;
    for (let i = 0; i < over; i++) {
      await seed.addIssue({
        projectId: project.id,
        userId: user.id,
        status: 'awaiting_release',
        seq: seed.nextSeq(),
        updatedAgo: `${i + 2} days`,
      });
    }

    const body = await seed.pulse(token);
    expect(body.work.releaseWaiting.total).toBe(over);
    expect(body.work.releaseWaiting.shown).toHaveLength(PULSE_THRESHOLDS.identityCap);
  });

  it('selects release-waiting rows against the caller clock, not the database clock', async () => {
    const { user, project } = await seed.member();
    await seed.addIssue({
      projectId: project.id,
      userId: user.id,
      status: 'awaiting_release',
      seq: seed.nextSeq(),
      updatedAgo: '10 days',
    });

    const now = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000 + 60_000);
    const { readPulseWork } = await import('../../src/me/pulse-work.js');
    const work = await readPulseWork([project.id], PULSE_THRESHOLDS, now);
    expect(work.releaseWaiting.total).toBe(0);
    expect(work.releaseWaiting.shown).toEqual([]);
  });
});
