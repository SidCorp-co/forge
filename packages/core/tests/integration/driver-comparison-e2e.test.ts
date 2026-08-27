/**
 * The two north-star metrics, against real Postgres.
 *
 * This query decides whether the autonomous driver ships. If it counts the
 * wrong interventions, or rewards a project for closing nothing, the decision
 * it produces is worse than no measurement at all — so the arithmetic is
 * checked against rows, not asserted about.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('driver comparison E2E', () => {
  let harness: TestDatabase;
  let ownerId: string;
  let projectId: string;
  let seq = 0;
  let driverComparison: (a: {
    days: number;
    projectIds: readonly string[];
  }) => Promise<Array<Record<string, unknown>>>;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    ({ driverComparison } = (await import('../../src/pipeline/driver-comparison.js')) as never);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    seq = 0;
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
  });

  async function setMode(mode: string): Promise<void> {
    await harness.db.execute(sql`
      UPDATE projects
      SET agent_config = COALESCE(agent_config, '{}'::jsonb)
                      || ${JSON.stringify({ pipelineConfig: { mode } })}::jsonb
      WHERE id = ${projectId}
    `);
  }

  /** An issue filed `filedMinutesAgo` ago, started `startedMinutesAgo` ago. */
  async function closedIssue(opts: {
    status?: string;
    filedMinutesAgo?: number;
    startedMinutesAgo?: number | null;
    /** Which driver's job the issue carries. `drive` = autonomous. */
    jobType?: 'drive' | 'code';
    /** Write the job even when nothing started it (never dispatched). */
    jobWithoutStart?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    seq += 1;
    const filed = opts.filedMinutesAgo ?? 120;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at, updated_at)
      VALUES (${id}, ${projectId}, ${seq}, ${`i${seq}`}, ${opts.status ?? 'closed'}, ${ownerId},
              now() - make_interval(mins => ${filed}), now())
    `);
    const started = opts.startedMinutesAgo;
    if (started != null || opts.jobWithoutStart) {
      const runId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
        VALUES (${runId}, ${projectId}, ${id}, 'issue', 'completed', now())
      `);
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload,
                          created_by, queued_at, dispatched_at, finished_at)
        VALUES (${randomUUID()}, ${projectId}, ${id}, ${runId}, ${opts.jobType ?? 'drive'},
                'done', '{}'::jsonb, ${ownerId}, now() - make_interval(mins => ${filed}),
                ${started == null ? null : sql`now() - make_interval(mins => ${started})`}, now())
      `);
    }
    return id;
  }

  async function wedge(issueId: string): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO notifications (id, user_id, project_id, issue_id, type, title, created_at)
      VALUES (${randomUUID()}, ${ownerId}, ${projectId}, ${issueId}, 'pipeline_wedge',
              'wedged', now())
    `);
  }

  async function row(): Promise<Record<string, unknown>> {
    const out = await driverComparison({ days: 7, projectIds: [projectId] });
    return out[0] ?? {};
  }

  it('divides interventions by the issues that actually closed', async () => {
    await setMode('autonomous');
    const a = await closedIssue({ startedMinutesAgo: 110 });
    await closedIssue({ startedMinutesAgo: 100 });
    await wedge(a);
    await wedge(a);

    expect(await row()).toMatchObject({
      driver: 'autonomous',
      issuesClosed: 2,
      interventions: 2,
      interventionsPerIssueClosed: 1,
    });
  });

  // cm:guard a project that closed nothing must report null, never 0 — 0 reads as a perfect score, and a driver can win the comparison by never finishing anything
  it('reports null rather than a perfect score when nothing closed', async () => {
    await closedIssue({ status: 'dropped', startedMinutesAgo: 110 });

    expect(await row()).toMatchObject({
      issuesClosed: 0,
      issuesDropped: 1,
      interventionsPerIssueClosed: null,
    });
  });

  it('measures request to running from filing to the first session start', async () => {
    await closedIssue({ filedMinutesAgo: 120, startedMinutesAgo: 110 });

    const r = await row();
    expect(r.medianRequestToRunningSeconds).toBeCloseTo(600, -1);
  });

  // cm:guard an issue nothing ever started must not become a zero wait — averaging it in would make a driver that ignores issues look instant
  it('leaves an issue that never started out of the wait, rather than scoring it zero', async () => {
    await closedIssue({ filedMinutesAgo: 120, startedMinutesAgo: 110 });
    await closedIssue({ filedMinutesAgo: 300, startedMinutesAgo: null, jobWithoutStart: true });

    const r = await row();
    expect(r.issuesClosed).toBe(2);
    expect(r.medianRequestToRunningSeconds).toBeCloseTo(600, -1);
  });

  // cm:guard the driver comes from the JOBS, never from `pipelineConfig.mode` — reading the config means flipping a project relabels every issue it ever closed, and the flip is exactly when someone opens this report
  it('reports the driver that ran, not the mode the project now declares', async () => {
    await setMode('autonomous');
    await closedIssue({ startedMinutesAgo: 110, jobType: 'code' });

    expect((await row()).driver).toBe('staged');
  });

  it('splits a project that switched drivers into one row per driver', async () => {
    await setMode('autonomous');
    await closedIssue({ startedMinutesAgo: 110, jobType: 'code' });
    await closedIssue({ startedMinutesAgo: 100, jobType: 'code' });
    await closedIssue({ startedMinutesAgo: 90, jobType: 'drive' });

    const out = await driverComparison({ days: 7, projectIds: [projectId] });
    expect(out.map((r) => [r.driver, r.issuesClosed])).toEqual([
      ['autonomous', 1],
      ['staged', 2],
    ]);
  });

  it('ignores interventions on issues outside the window', async () => {
    await setMode('autonomous');
    const old = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at, updated_at)
      VALUES (${old}, ${projectId}, 99, 'ancient', 'closed', ${ownerId},
              now() - interval '90 days', now() - interval '89 days')
    `);
    await wedge(old);
    await closedIssue({ startedMinutesAgo: 110 });

    expect(await row()).toMatchObject({ issuesClosed: 1, interventions: 0 });
  });
  // cm:guard the backlog cohort is the whole reason this column exists: on getcontent 2026-08-21 the raw metric read 141.2h for autonomous against staged's 23m purely because the driver was switched on into a 52-issue backlog, and the split was 249.9h before the switch vs 0m after
  it('charges the autonomous driver only for the wait after it existed here', async () => {
    await closedIssue({ filedMinutesAgo: 600, startedMinutesAgo: 500 });
    await closedIssue({ filedMinutesAgo: 600, startedMinutesAgo: 200 });
    await closedIssue({ filedMinutesAgo: 600, startedMinutesAgo: 100 });

    const r = await row();
    expect(r.medianRequestToRunningSeconds).toBeCloseTo(400 * 60, -2);
    expect(r.medianDriverWaitSeconds).toBeCloseTo(300 * 60, -2);
    expect(r.issuesBornUnderDriver).toBe(0);
  });

  it('counts as born under the driver only the issues filed after it arrived', async () => {
    await closedIssue({ filedMinutesAgo: 600, startedMinutesAgo: 500 });
    await closedIssue({ filedMinutesAgo: 50, startedMinutesAgo: 40 });

    expect(await row()).toMatchObject({ issuesClosed: 2, issuesBornUnderDriver: 1 });
  });

  // cm:guard the clamp must be asymmetric or it is not a fix: staged was present for the whole backlog, so an old issue it left sitting IS staged being slow and the two columns have to agree for it
  it('leaves the staged wait untouched in a project that later switched', async () => {
    await closedIssue({ filedMinutesAgo: 600, startedMinutesAgo: 100, jobType: 'code' });
    await closedIssue({ filedMinutesAgo: 600, startedMinutesAgo: 500 });

    const out = await driverComparison({ days: 7, projectIds: [projectId] });
    const staged = out.find((r) => r.driver === 'staged') ?? {};
    expect(staged.medianDriverWaitSeconds).toBe(staged.medianRequestToRunningSeconds);
    expect(staged.medianRequestToRunningSeconds).toBeCloseTo(500 * 60, -2);
  });
});
