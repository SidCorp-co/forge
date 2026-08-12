import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-826 retry_rescues', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function insertRun(projectId: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
      VALUES (${id}, ${projectId}, 'system', 'completed', now())
    `);
    return id;
  }

  async function seedJob(input: {
    projectId: string;
    pipelineRunId: string;
    status: 'done' | 'failed';
    retryOf?: string;
    failureKind?: 'infra' | 'timeout';
    failureReason?: string;
  }): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, pipeline_run_id, type, status, payload, created_by, retry_of,
        failure_kind, failure_reason, finished_at
      )
      VALUES (
        ${id}, ${input.projectId}, ${input.pipelineRunId}, 'code', ${input.status}, '{}'::jsonb,
        (SELECT created_by FROM projects WHERE id = ${input.projectId}),
        ${input.retryOf ?? null}, ${input.failureKind ?? null}, ${input.failureReason ?? null}, now()
      )
    `);
    return id;
  }

  it('counts a rescued chain once and attributes it to its original failure reason', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const runId = await insertRun(project.id);
    const original = await seedJob({
      projectId: project.id,
      pipelineRunId: runId,
      status: 'failed',
      failureKind: 'infra',
      failureReason: 'hooks_path',
    });
    const secondFailure = await seedJob({
      projectId: project.id,
      pipelineRunId: runId,
      status: 'failed',
      retryOf: original,
      failureKind: 'timeout',
      failureReason: 'transient_timeout',
    });
    await seedJob({
      projectId: project.id,
      pipelineRunId: runId,
      status: 'done',
      retryOf: secondFailure,
    });

    const rows = await harness.db.execute<{
      failure_kind: string | null;
      failure_reason: string;
    }>(sql`
      SELECT failure_kind, failure_reason
      FROM retry_rescues
      WHERE project_id = ${project.id}
    `);

    expect(rows).toEqual([{ failure_kind: 'infra', failure_reason: 'hooks_path' }]);
  });

  it('excludes unrescued chains and first-attempt successes', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const runId = await insertRun(project.id);
    await seedJob({
      projectId: project.id,
      pipelineRunId: runId,
      status: 'failed',
      failureKind: 'infra',
      failureReason: 'never_rescued',
    });
    await seedJob({ projectId: project.id, pipelineRunId: runId, status: 'done' });

    const rows = await harness.db.execute<{ rescues: number }>(sql`
      SELECT count(*)::int AS rescues
      FROM retry_rescues
      WHERE project_id = ${project.id}
    `);

    expect(Number(rows[0]?.rescues)).toBe(0);
  });
});
