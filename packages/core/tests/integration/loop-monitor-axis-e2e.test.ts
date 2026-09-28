/**
 * ISS-1273 — the loop monitor declares the axis it sweeps, and counts what that leaves out.
 *
 * Against real Postgres rather than the unit file's mocks: the claim count is a `jsonb` predicate
 * over `issues.session_context`, and a mocked `db.execute` would prove the filter rather than the
 * query. `jobs/loop-monitor.test.ts` keeps the hop contracts.
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

type LoopMonitorModule = typeof import('../../src/jobs/loop-monitor.js');
type AxisModule = typeof import('../../src/jobs/loop-monitor-axis.js');

describe('ISS-1273 loop-monitor axis declaration', () => {
  let harness: TestDatabase;
  let mods: LoopMonitorModule;
  let axis: AxisModule;

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
    mods = (await import('../../src/jobs/loop-monitor.js')) as unknown as LoopMonitorModule;
    axis = (await import('../../src/jobs/loop-monitor-axis.js')) as unknown as AxisModule;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  /** One issue carrying a claim of the given age and status. */
  async function claimedIssue(
    projectId: string,
    args: { issSeq: number; status: string; holder: string | null; ageHours: number },
  ): Promise<void> {
    const lease =
      args.holder === null
        ? sql`'{}'::jsonb`
        : sql`jsonb_build_object('lease', jsonb_build_object(
              'holder', ${args.holder}::text,
              'renewedAt', to_jsonb(now() - make_interval(hours => ${args.ageHours}::int)),
              'minutes', 60))`;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id,
                          session_context, merged_at)
      VALUES (${randomUUID()}, ${projectId}, ${args.issSeq}, ${`Issue ${args.issSeq}`},
              ${args.status}, 'medium',
              (SELECT created_by FROM projects WHERE id = ${projectId}), ${lease},
              CASE WHEN ${args.status} = 'closed' THEN now() END)
    `);
  }

  it('names the job axis as the one every hop it runs sweeps', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);

    const tick = await mods.runLoopMonitor(new Date(), { projectId: project.id });
    expect(tick.axis).toBe('job');
    expect(tick.outOfAxis.sweptBy).toBe('pipeline/idle-issues.ts');
  });

  // The blind spot has a size: every hop above starts from a `jobs` row, and a claim opens none.
  it('counts the live claims none of its hops reaches, and only those', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    await claimedIssue(project.id, {
      issSeq: 1,
      status: 'in_progress',
      holder: 'iss-1273-live',
      ageHours: 0,
    });
    await claimedIssue(project.id, {
      issSeq: 2,
      status: 'in_progress',
      holder: 'iss-1273-expired',
      ageHours: 5,
    });
    await claimedIssue(project.id, {
      issSeq: 3,
      status: 'closed',
      holder: 'iss-1273-terminal',
      ageHours: 0,
    });
    await claimedIssue(project.id, {
      issSeq: 4,
      status: 'in_progress',
      holder: null,
      ageHours: 0,
    });

    const tick = await mods.runLoopMonitor(new Date(), { projectId: project.id });
    expect(tick.outOfAxis.claimHeldIssues).toBe(1);
  });

  it('reads no claim as nothing outside its axis, rather than as nothing to say', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    await claimedIssue(project.id, {
      issSeq: 5,
      status: 'in_progress',
      holder: null,
      ageHours: 0,
    });

    const tick = await mods.runLoopMonitor(new Date(), { projectId: project.id });
    expect(tick.outOfAxis).toEqual({ claimHeldIssues: 0, sweptBy: 'pipeline/idle-issues.ts' });
  });

  // ISS-1273 — `projects/health-routes.ts` is the reader that lets this count be judged at a
  // deployment at all; it reads several projects at once, so the count has to stay per project
  // rather than summing the box. A shared count would make one busy project read as every
  // project being busy, which is the same "a number that means two things" defect again.
  it('counts each project separately where several are read in one call', async () => {
    const owner = await createTestUser(harness.db);
    const busy = await createTestProject(harness.db, owner.id);
    const quiet = await createTestProject(harness.db, owner.id);
    for (const issSeq of [11, 12]) {
      await claimedIssue(busy.id, {
        issSeq,
        status: 'in_progress',
        holder: `iss-${issSeq}-live`,
        ageHours: 0,
      });
    }
    await claimedIssue(quiet.id, {
      issSeq: 13,
      status: 'in_progress',
      holder: 'iss-13-expired',
      ageHours: 5,
    });

    const counts = await axis.countClaimHeldIssuesByProject([busy.id, quiet.id]);
    expect(counts.get(busy.id)).toBe(2);
    expect(counts.get(quiet.id)).toBe(0);
  });

  it('answers zero for a project it was asked about and found nothing for', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const counts = await axis.countClaimHeldIssuesByProject([project.id]);
    expect(counts.get(project.id)).toBe(0);
    expect(counts.has(project.id)).toBe(true);
  });

  it('asked about nothing, queries nothing and answers an empty map', async () => {
    expect((await axis.countClaimHeldIssuesByProject([])).size).toBe(0);
  });
});
