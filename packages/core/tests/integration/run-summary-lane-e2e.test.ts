/**
 * ISS-1273 — a run summary declares the lane it was opened on, its group, and where its step came
 * from, against real Postgres. `pipeline/runs-lane.test.ts` covers the derivation itself; this is
 * the composition, which needs a real `phase_journal` row and a real group run.
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

type RollupModule = typeof import('../../src/pipeline/runs-rollup.js');

describe('ISS-1273 run summary lanes', () => {
  let harness: TestDatabase;
  let mods: RollupModule;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';
    mods = (await import('../../src/pipeline/runs-rollup.js')) as unknown as RollupModule;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const owner = await createTestUser(harness.db);
    return createTestProject(harness.db, owner.id);
  }

  /** A group run as `devices/run-session.ts` opens one: `issue_id` null, group in the metadata. */
  async function groupRun(projectId: string, runIssues: string[]): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, metadata)
      VALUES (${runId}, ${projectId}, NULL, 'system', 'running',
              ${JSON.stringify({ type: 'run_session', runIssues })}::jsonb)
    `);
    return runId;
  }

  async function openPhase(
    projectId: string,
    runId: string,
    phase: string,
    args: { attempt?: number; agoMinutes?: number } = {},
  ): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO phase_journal (id, project_id, run_id, phase, attempt, source, started_at)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${phase}, ${args.attempt ?? 1}, 'agent',
              now() - make_interval(mins => ${args.agoMinutes ?? 0}::int))
    `);
  }

  it('declares the run-session lane and the group, where one issueRef cannot represent it', async () => {
    const project = await seed();
    const runId = await groupRun(project.id, ['ISS-1273', 'ISS-1271']);

    const summary = await mods.loadPipelineRunSummary(runId);
    expect(summary?.lane).toBe('run_session');
    expect(summary?.runIssues).toEqual(['ISS-1273', 'ISS-1271']);
    expect(summary?.issueRef).toBeNull();
  });

  it('takes a run-session run step from the phase its driver has open', async () => {
    const project = await seed();
    const runId = await groupRun(project.id, ['ISS-1273']);
    await openPhase(project.id, runId, 'implement');

    const summary = await mods.loadPipelineRunSummary(runId);
    expect(summary?.currentStep).toBe('implement');
    expect(summary?.step).toEqual({ source: 'phase_journal', step: 'implement', detail: null });
  });

  it('says why it holds no step where the driver has closed its last phase', async () => {
    const project = await seed();
    const runId = await groupRun(project.id, ['ISS-1273']);
    await openPhase(project.id, runId, 'implement');
    await harness.db.execute(
      sql`UPDATE phase_journal SET ended_at = now() WHERE run_id = ${runId}`,
    );

    const summary = await mods.loadPipelineRunSummary(runId);
    expect(summary?.currentStep).toBeNull();
    expect(summary?.step.source).toBe('none');
    expect(summary?.step.detail).toContain('no phase open');
  });

  // ISS-1273 — a driver that never closed an earlier phase leaves two open rows. The newest is
  // the one it is on, the row `phase-journal.ts:resumePoint` would resume at.
  it('takes the newest open phase where a driver left an earlier one open', async () => {
    const project = await seed();
    const runId = await groupRun(project.id, ['ISS-1273']);
    await openPhase(project.id, runId, 'plan', { agoMinutes: 30 });
    await openPhase(project.id, runId, 'implement', { attempt: 2 });

    const summary = await mods.loadPipelineRunSummary(runId);
    expect(summary?.currentStep).toBe('implement');
  });

  // Two open rows stamped at the same instant: the higher attempt is the later round. Inserted
  // newest-first ON PURPOSE — an answer that depended on which row arrived last would return
  // `plan` here and `implement` in the case above, and neither would be a policy.
  it('breaks a tie on attempt, not on the order the rows came back', async () => {
    const project = await seed();
    const runId = await groupRun(project.id, ['ISS-1273']);
    await harness.db.execute(sql`
      INSERT INTO phase_journal (id, project_id, run_id, phase, attempt, source, started_at)
      VALUES (${randomUUID()}, ${project.id}, ${runId}, 'implement', 2, 'agent',
              timestamptz '2026-09-27 10:00:00+00'),
             (${randomUUID()}, ${project.id}, ${runId}, 'plan', 1, 'agent',
              timestamptz '2026-09-27 10:00:00+00')
    `);

    const summary = await mods.loadPipelineRunSummary(runId);
    expect(summary?.currentStep).toBe('implement');
  });

  // The column has no writer on this lane, so a value in it is stale or hand-repaired.
  it('refuses a stale current_step on a run-session run rather than reporting it', async () => {
    const project = await seed();
    const runId = await groupRun(project.id, ['ISS-1273']);
    await harness.db.execute(
      sql`UPDATE pipeline_runs SET current_step = 'code' WHERE id = ${runId}`,
    );

    const summary = await mods.loadPipelineRunSummary(runId);
    expect(summary?.currentStep).toBeNull();
    expect(summary?.step.source).toBe('none');
  });

  it('leaves a job-lane run on its stamped step and its own issue', async () => {
    const project = await seed();
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${issueId}, ${project.id}, 4242, 'A job-lane issue', 'in_progress', 'medium',
              (SELECT created_by FROM projects WHERE id = ${project.id}))
    `);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, current_step)
      VALUES (${runId}, ${project.id}, ${issueId}, 'issue', 'running', 'code')
    `);

    const summary = await mods.loadPipelineRunSummary(runId);
    expect(summary?.lane).toBe('job');
    expect(summary?.runIssues).toEqual([]);
    expect(summary?.step).toEqual({ source: 'run_column', step: 'code', detail: null });
  });
});
