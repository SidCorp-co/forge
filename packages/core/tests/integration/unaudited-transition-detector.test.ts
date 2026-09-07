/**
 * ISS-884 — the interventions ruler, against real Postgres.
 *
 * The undercount this suite exists for cannot be reproduced with a mocked db:
 * it is a `psql` hand writing `jobs.status` directly, which by definition never
 * reaches any TypeScript this repo could stub. So every assertion here runs the
 * flip as raw SQL on a real connection, exactly as an operator would.
 *
 * Both directions are asserted deliberately. A ruler that undercounts and one
 * that overcounts are equally useless, so the audited flip and the ordinary
 * non-terminal traffic each get a zero-row assertion of their own.
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

type Mods = {
  applyKernelTransition: typeof import('../../src/lifecycle/transition.js').applyKernelTransition;
};

describe('unaudited transition detector (ISS-884)', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let projectId: string;
  let ownerId: string;
  let issueId: string;
  let runId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    mods = (await import('../../src/lifecycle/transition.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    const project = await createTestProject(harness.db, owner.id);
    projectId = project.id;
    issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, created_by_id, title, description, status)
      VALUES (${issueId}, ${projectId}, ${ownerId}, 'ISS-884 fixture', 'fixture', 'open')
    `);
    runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now())
    `);
  });

  async function insertJob(status = 'queued'): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status,
                        payload, queued_at)
      VALUES (${id}, ${projectId}, ${issueId}, ${runId}, ${ownerId}, 'code', ${status},
              '{}'::jsonb, now())
    `);
    return id;
  }

  async function detected(): Promise<
    Array<{
      entity: string;
      entity_id: string;
      from_status: string | null;
      to_status: string;
      db_user: string;
    }>
  > {
    const rows = await harness.db.execute(sql`
      SELECT entity, entity_id, from_status, to_status, db_user
      FROM unaudited_transitions ORDER BY detected_at
    `);
    return rows as unknown as Array<{
      entity: string;
      entity_id: string;
      from_status: string | null;
      to_status: string;
      db_user: string;
    }>;
  }

  it('records a job terminal flip written by raw SQL, naming both statuses and the db role', async () => {
    const jobId = await insertJob('running');

    await harness.db.execute(sql`UPDATE jobs SET status = 'cancelled' WHERE id = ${jobId}`);

    const rows = await detected();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'job',
      entity_id: jobId,
      from_status: 'running',
      to_status: 'cancelled',
    });
    expect(rows[0]?.db_user).toBeTruthy();
  });

  it('records a run terminal flip written by raw SQL', async () => {
    await harness.db.execute(
      sql`UPDATE pipeline_runs SET status = 'cancelled' WHERE id = ${runId}`,
    );

    const rows = await detected();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: 'run', entity_id: runId, to_status: 'cancelled' });
  });

  it('records NOTHING when the same flip goes through applyKernelTransition', async () => {
    const jobId = await insertJob('running');

    await mods.applyKernelTransition(harness.db as never, {
      entity: 'job',
      to: 'cancelled',
      fromStatus: 'running',
      where: sql`id = ${jobId} AND status = 'running'` as never,
      actor: { type: 'user', id: ownerId, agency: 'human' },
      reason: 'operator cancel',
      source: 'test',
    });

    expect(await detected()).toHaveLength(0);
    const audit = await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM kernel_transitions WHERE entity_id = ${jobId}
    `);
    expect(Number((audit as unknown as Array<{ n: number }>)[0]?.n)).toBe(1);
  });

  it('records nothing for an ordinary non-terminal job write (queued to dispatched)', async () => {
    const jobId = await insertJob('queued');

    await harness.db.execute(sql`
      UPDATE jobs SET status = 'dispatched', dispatched_at = now() WHERE id = ${jobId}
    `);

    expect(await detected()).toHaveLength(0);
  });

  it('records nothing for an ordinary non-terminal run write (running to paused)', async () => {
    await harness.db.execute(sql`UPDATE pipeline_runs SET status = 'paused' WHERE id = ${runId}`);

    expect(await detected()).toHaveLength(0);
  });

  it('surfaces the detected flip in issue_intervention_events as direct_sql, with its project and issue', async () => {
    const jobId = await insertJob('running');
    await harness.db.execute(sql`UPDATE jobs SET status = 'failed' WHERE id = ${jobId}`);

    const rows = await harness.db.execute(sql`
      SELECT source, project_id, issue_id, detail
      FROM issue_intervention_events WHERE source = 'direct_sql'
    `);
    const events = rows as unknown as Array<{
      source: string;
      project_id: string;
      issue_id: string | null;
      detail: string | null;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.project_id).toBe(projectId);
    expect(events[0]?.issue_id).toBe(issueId);
    expect(events[0]?.detail).toContain('running');
    expect(events[0]?.detail).toContain('failed');
  });
});
