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

describe('ISS-1273 loop-monitor axis declaration', () => {
  let harness: TestDatabase;
  let mods: LoopMonitorModule;

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
});
