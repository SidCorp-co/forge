/**
 * ISS-786 [Epic] — the `VISION: state-never-lies` write-side evidence guard
 * against real Postgres.
 *
 * This file drove a composed A→C→B→D walk until ISS-895 removed the staged
 * lane and three of the four guards with it: A and C read
 * `skill_registrations` to decide whether a stage was live, and D
 * (`stage-stall-guard.ts`) paused a run when one STAGE looped — neither
 * question exists in a lane whose whole walk is one step. What survives is B:
 * the writer refuses `developed` with no recorded code evidence, and fails
 * open when the read itself cannot succeed. Both properties need a real DB —
 * the unit suite mocks the query builder.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-786 state-integrity — work-evidence guard on a real DB', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  });

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function insertIssue(args: {
    projectId: string;
    ownerId: string;
    status: string;
    plan?: string | null;
  }): Promise<{ id: string; reopenCount: number }> {
    const rows = await harness.db.execute<{ id: string; reopen_count: number }>(sql`
      INSERT INTO issues (project_id, title, status, created_by_id, plan)
      VALUES (${args.projectId}, 'state-integrity walk', ${args.status}, ${args.ownerId}, ${args.plan ?? null})
      RETURNING id, reopen_count
    `);
    const row = rows[0] as { id: string; reopen_count: number };
    return { id: row.id, reopenCount: row.reopen_count };
  }

  it('refuses `developed` with zero code evidence, then allows it once a branch is recorded', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);

    const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');

    const issue = await insertIssue({
      projectId: project.id,
      ownerId: owner.id,
      status: 'approved',
      plan: 'do the thing',
    });
    const actor = { type: 'device' as const, id: device.id, ownerId: owner.id };

    await expect(
      transitionIssueStatus(
        { id: issue.id, projectId: project.id, status: 'approved', reopenCount: 0 },
        'developed',
        actor,
      ),
    ).rejects.toMatchObject({ code: 'NO_WORK_EVIDENCE' });

    // Recording a branch (the direct-ship marker `work-evidence.ts` reads) is
    // enough real evidence to unblock the same transition.
    await harness.db.execute(sql`
      UPDATE issues SET session_context = ${JSON.stringify({ branch: 'ISS-786-fix' })}::jsonb
      WHERE id = ${issue.id}
    `);
    const developed = await transitionIssueStatus(
      { id: issue.id, projectId: project.id, status: 'approved', reopenCount: 0 },
      'developed',
      actor,
    );
    expect(developed.status).toBe('developed');
  });

  // cm:guard fail-open is the property, not an accident: a read that CANNOT succeed must return the safe default rather than throw, or one broken query freezes every write on the issue. The probe is an executor that throws, because a ghost id is not the failing case — an issue with no rows behind it has no evidence, which is the rule firing correctly, and asserting null there would have proved nothing.
  it('fails open: a read that throws returns null instead of propagating', async () => {
    const { checkTransitionEvidence } = await import('../../src/issues/transition-evidence.js');
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const issue = await insertIssue({
      projectId: project.id,
      ownerId: owner.id,
      status: 'approved',
    });
    const broken = {
      select: () => {
        throw new Error('simulated read failure');
      },
    } as unknown as NonNullable<Parameters<typeof checkTransitionEvidence>[0]['executor']>;

    await expect(
      checkTransitionEvidence({
        issue: { id: issue.id, projectId: project.id },
        toStatus: 'developed',
        agency: 'agent',
        skip: false,
        executor: broken,
      }),
    ).resolves.toBeNull();
  });
});
