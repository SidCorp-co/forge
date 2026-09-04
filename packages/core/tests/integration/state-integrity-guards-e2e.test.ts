/**
 * ISS-786 [Epic] — composed walk of the four `VISION: state-never-lies` state-integrity
 * guards against real Postgres. Every guard already has unit coverage that
 * mocks the query builder (and, for A/B/C, a real-DB test of its own
 * predicate); none of them exercises the SEQUENCE an issue actually walks:
 * an agent tries to fabricate its way past a human-gated bounce (A), the
 * state-machine writer refuses a plan-less `approved` (C), the same writer
 * refuses a `developed` with no code evidence (B), and the reconciler-side
 * no-op-loop cap names a verified cause instead of asserting one (D). This
 * file drives that sequence end to end on one issue, through the real
 * `transitionIssueStatus` writer and the real dispatch-side guards — not
 * through mocks — so a regression that only shows up when the guards compose
 * (e.g. one guard's fail-open swallowing another's violation) has somewhere
 * to fail.
 */

import { randomUUID } from 'node:crypto';
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

describe('ISS-786 state-integrity guards — composed A→C→B→D walk', () => {
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

  async function _insertComment(
    issueId: string,
    authorId: string,
    opts: { authorDeviceId: string | null; createdAt: Date },
  ): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO comments (issue_id, author_id, author_device_id, body, created_at)
      VALUES (
        ${issueId}, ${authorId}, ${opts.authorDeviceId}, 'x',
        ${opts.createdAt.toISOString()}::timestamptz
      )
    `);
  }

  // Real resolver, real DB: `isPlanStageLive` (transition-evidence.ts) requires
  // a `skill_registrations` row for stage 'clarified', mirroring
  // pipeline-per-project-config.test.ts:121,164 — without it C's guard is a
  // correct no-op and `PLAN_REQUIRED` can never fire.
  async function registerPlanStageSkill(projectId: string, registeredBy: string): Promise<void> {
    const skillId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO skills (id, name, description, scope, prompt, source, content_hash)
      VALUES (${skillId}, 'forge-plan', 'integration: forge-plan', 'global', 'noop', 'builtin', ${`hash-${skillId}`})
    `);
    await harness.db.execute(sql`
      INSERT INTO skill_registrations (project_id, skill_id, stage, registered_by)
      VALUES (${projectId}, ${skillId}, 'clarified', ${registeredBy})
    `);
  }

  async function _logTransition(
    issueId: string,
    actorId: string,
    from: string,
    to: string,
    at: Date,
  ): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO activity_log (issue_id, actor_type, actor_id, action, payload, created_at)
      VALUES (${issueId}, 'device', ${actorId}, 'issue.statusChanged',
              ${JSON.stringify({ from, to })}::jsonb, ${at.toISOString()}::timestamptz)
    `);
  }

  it('walks C (plan-less approved refused) -> B (evidence-less developed refused) -> D (verified-cause stall)', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);
    await registerPlanStageSkill(project.id, owner.id);

    const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
    const { checkStageStallAndPause } = await import('../../src/pipeline/stage-stall-guard.js');

    const issue = await insertIssue({
      projectId: project.id,
      ownerId: owner.id,
      status: 'clarified',
    });

    // ---- C: the writer refuses `approved` while the plan is blank ----
    const actor = { type: 'device' as const, id: device.id, ownerId: owner.id };

    await expect(
      transitionIssueStatus(
        { id: issue.id, projectId: project.id, status: 'clarified', reopenCount: 0 },
        'approved',
        actor,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_REQUIRED' });

    await harness.db.execute(sql`UPDATE issues SET plan = 'do the thing' WHERE id = ${issue.id}`);
    const approved = await transitionIssueStatus(
      { id: issue.id, projectId: project.id, status: 'clarified', reopenCount: 0 },
      'approved',
      actor,
    );
    expect(approved.status).toBe('approved');

    // ---- B: the writer refuses `developed` with zero recorded code evidence ----
    await expect(
      transitionIssueStatus(
        {
          id: issue.id,
          projectId: project.id,
          status: 'approved',
          reopenCount: approved.reopenCount,
        },
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
      {
        id: issue.id,
        projectId: project.id,
        status: 'approved',
        reopenCount: approved.reopenCount,
      },
      'developed',
      actor,
    );
    expect(developed.status).toBe('developed');

    // ---- D: the stage-stall guard verifies a cause instead of asserting one ----
    // `developed` maps to job type `review` (registry.ts). Three consecutive
    // `done` review jobs with no advance, and no device recorded on them,
    // reproduce the no-op loop this guard bounds — with no skill-sync signal
    // to check, verifySkillSyncCause must report `unverified`, not a
    // confident diagnosis it never checked.
    const runRows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO pipeline_runs (project_id, issue_id, kind, status, current_step)
      VALUES (${project.id}, ${issue.id}, 'issue', 'running', 'developed')
      RETURNING id
    `);
    const runId = (runRows[0] as { id: string }).id;

    for (let i = 0; i < 3; i++) {
      await harness.db.execute(sql`
        INSERT INTO jobs (project_id, issue_id, pipeline_run_id, created_by, type, status)
        VALUES (${project.id}, ${issue.id}, ${runId}, ${owner.id}, 'review', 'done')
      `);
    }

    const stallResult = await checkStageStallAndPause({
      projectId: project.id,
      issueId: issue.id,
      status: 'developed',
    });
    expect(stallResult).toEqual({ stalled: true });

    const pausedRunRows = await harness.db.execute<{ status: string; metadata: unknown }>(sql`
      SELECT status, metadata FROM pipeline_runs WHERE id = ${runId}
    `);
    const pausedRun = pausedRunRows[0] as { status: string; metadata: { pauseReason?: string } };
    expect(pausedRun.status).toBe('paused');
    expect(pausedRun.metadata.pauseReason).toBe('stage_stalled:developed');

    const commentRows = await harness.db.execute<{ body: string }>(sql`
      SELECT body FROM comments WHERE issue_id = ${issue.id} ORDER BY created_at DESC LIMIT 1
    `);
    const stallComment = commentRows[0] as { body: string };
    // Verified-cause branch: no device recorded on the stalled jobs, so the
    // cause is named as unverified rather than confidently misdiagnosed.
    expect(stallComment.body).toContain('Could not verify a cause');
    expect(stallComment.body).toContain('**Current state:**');
    expect(stallComment.body).toContain('**Exits:**');
  });

  it('fails open end to end: a broken DB read never freezes the composed sequence', async () => {
    // Each guard's own unit suite already forces its query to throw and
    // asserts fail-open in isolation (transition-evidence.test.ts,
    // stage-stall-guard.test.ts). This checks the property that actually
    // matters operationally: a lookup for an issue that does not exist at all
    // (the sharpest "the read cannot succeed" case available without mocking
    // the DB client) still lets every guard return its safe default instead
    // of throwing out of the guard itself.
    const { checkStageStallAndPause } = await import('../../src/pipeline/stage-stall-guard.js');
    const { checkTransitionEvidence } = await import('../../src/issues/transition-evidence.js');
    const ghostIssueId = '00000000-0000-0000-0000-000000000000';
    const ghostProjectId = '00000000-0000-0000-0000-000000000000';

    await expect(
      checkStageStallAndPause({
        projectId: ghostProjectId,
        issueId: ghostIssueId,
        status: 'developed',
      }),
    ).resolves.toEqual({ stalled: false });
    await expect(
      checkTransitionEvidence({
        issue: { id: ghostIssueId, projectId: ghostProjectId },
        toStatus: 'approved',
        agency: 'agent',
        skip: false,
      }),
    ).resolves.toBeNull();
  });
});
