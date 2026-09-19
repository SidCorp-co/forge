/**
 * ISS-1022 — `retry_rescues_since` against the `retry_rescues` view it bounds.
 *
 * The claim under test is equivalence, and the way this could be wrong is
 * specific: the view filters its OUTPUT by project and time, while the function
 * seeds its recursion's ANCHOR with the same two. Those are the same row set
 * only because `project_id` and `rescued_at` are carried from the anchor
 * through the recursive term and never taken from the parent it walks to. A
 * chain whose failed ancestor lives in another project is the case that would
 * expose it, so it is the first one here.
 *
 * The three argument shapes the callers depend on are asserted too: a null
 * project list means every project, an empty one means none, and `since` is
 * inclusive.
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

const insertRun = async (projectId: string): Promise<string> => {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${id}, ${projectId}, 'system', 'completed', now())
  `);
  return id;
};

const seedJob = async (input: {
  projectId: string;
  runId: string;
  status: 'done' | 'failed';
  retryOf?: string;
  failureReason?: string;
  finishedAgo?: string;
}): Promise<string> => {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (
      id, project_id, pipeline_run_id, type, status, payload, created_by, retry_of,
      failure_kind, failure_reason, finished_at
    )
    VALUES (
      ${id}, ${input.projectId}, ${input.runId}, 'code', ${input.status}, '{}'::jsonb,
      (SELECT created_by FROM projects WHERE id = ${input.projectId}),
      ${input.retryOf ?? null}, NULL, ${input.failureReason ?? null},
      now() - ${input.finishedAgo ?? '1 hour'}::interval
    )
  `);
  return id;
};

type Row = { rescued_job_id: string; project_id: string; failure_reason: string };

const viaView = async (projectIds: string[], sinceDays: number) => [
  ...(await harness.db.execute<Row>(sql`
      SELECT rescued_job_id, project_id, failure_reason FROM retry_rescues
      WHERE project_id IN (${sql.join(
        projectIds.map((p) => sql`${p}`),
        sql`, `,
      )})
        AND rescued_at >= now() - (${sinceDays}::int * interval '1 day')
      ORDER BY rescued_job_id
    `)),
];

const viaFunction = async (projectIds: string[] | null, since: string) => [
  ...(await harness.db.execute<Row>(sql`
      SELECT rescued_job_id, project_id, failure_reason
      FROM retry_rescues_since(
        ${
          projectIds === null
            ? sql`NULL::uuid[]`
            : sql`ARRAY[${sql.join(
                projectIds.map((p) => sql`${p}`),
                sql`, `,
              )}]::uuid[]`
        },
        ${sql.raw(since)}
      )
      ORDER BY rescued_job_id
    `)),
];

describe('ISS-1022 retry_rescues_since', () => {
  it('reports a chain whose failed ancestor is in another project under the rescued job own project, both ways', async () => {
    const owner = await createTestUser(harness.db);
    const a = await createTestProject(harness.db, owner.id);
    const b = await createTestProject(harness.db, owner.id);
    const runA = await insertRun(a.id);
    const runB = await insertRun(b.id);

    const ancestorInB = await seedJob({
      projectId: b.id,
      runId: runB,
      status: 'failed',
      failureReason: 'the original failure, filed under B',
      finishedAgo: '3 hours',
    });
    const rescuedInA = await seedJob({
      projectId: a.id,
      runId: runA,
      status: 'done',
      retryOf: ancestorInB,
      finishedAgo: '2 hours',
    });

    const fromView = await viaView([a.id], 30);
    const fromFn = await viaFunction([a.id], "now() - interval '30 days'");
    expect(fromView).toEqual(fromFn);
    expect(fromFn).toHaveLength(1);
    expect(fromFn[0]?.rescued_job_id).toBe(rescuedInA);
    expect(fromFn[0]?.project_id).toBe(a.id);
    expect(fromFn[0]?.failure_reason).toBe('the original failure, filed under B');

    expect(await viaFunction([b.id], "now() - interval '30 days'")).toEqual([]);
    expect(await viaView([b.id], 30)).toEqual([]);
  });

  it('agrees with the view on a two-deep chain whose deepest failure is in another project', async () => {
    const owner = await createTestUser(harness.db);
    const a = await createTestProject(harness.db, owner.id);
    const b = await createTestProject(harness.db, owner.id);
    const runA = await insertRun(a.id);
    const runB = await insertRun(b.id);

    const oldest = await seedJob({
      projectId: b.id,
      runId: runB,
      status: 'failed',
      failureReason: 'the oldest failure',
      finishedAgo: '5 hours',
    });
    const middle = await seedJob({
      projectId: a.id,
      runId: runA,
      status: 'failed',
      retryOf: oldest,
      failureReason: 'a later failure',
      finishedAgo: '4 hours',
    });
    await seedJob({
      projectId: a.id,
      runId: runA,
      status: 'done',
      retryOf: middle,
      finishedAgo: '3 hours',
    });

    const fromView = await viaView([a.id], 30);
    expect(fromView).toEqual(await viaFunction([a.id], "now() - interval '30 days'"));
    expect(fromView[0]?.failure_reason).toBe('the oldest failure');
    expect(fromView[0]?.project_id).toBe(a.id);
  });

  it('includes a rescue whose finished_at falls exactly on since', async () => {
    const owner = await createTestUser(harness.db);
    const p = await createTestProject(harness.db, owner.id);
    const run = await insertRun(p.id);
    const failed = await seedJob({
      projectId: p.id,
      runId: run,
      status: 'failed',
      failureReason: 'boundary',
      finishedAgo: '49 hours',
    });
    const rescued = await seedJob({
      projectId: p.id,
      runId: run,
      status: 'done',
      retryOf: failed,
      finishedAgo: '48 hours',
    });

    const [row] = await harness.db.execute<Row>(sql`
      SELECT rescued_job_id, project_id, failure_reason
      FROM retry_rescues_since(
        ARRAY[${p.id}]::uuid[],
        (SELECT finished_at FROM jobs WHERE id = ${rescued})
      )
    `);
    expect(row?.rescued_job_id).toBe(rescued);
  });

  it('answers every project for a null list and no rows at all for an empty one', async () => {
    const owner = await createTestUser(harness.db);
    const a = await createTestProject(harness.db, owner.id);
    const b = await createTestProject(harness.db, owner.id);
    for (const p of [a, b]) {
      const run = await insertRun(p.id);
      const failed = await seedJob({
        projectId: p.id,
        runId: run,
        status: 'failed',
        failureReason: 'either',
        finishedAgo: '3 hours',
      });
      await seedJob({
        projectId: p.id,
        runId: run,
        status: 'done',
        retryOf: failed,
        finishedAgo: '2 hours',
      });
    }

    const all = await viaFunction(null, "now() - interval '30 days'");
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.project_id))).toEqual(new Set([a.id, b.id]));

    expect(await viaFunction([], "now() - interval '30 days'")).toEqual([]);
  });

  it('drops a rescue that finished before the window, as the view filter did', async () => {
    const owner = await createTestUser(harness.db);
    const p = await createTestProject(harness.db, owner.id);
    const run = await insertRun(p.id);
    const failed = await seedJob({
      projectId: p.id,
      runId: run,
      status: 'failed',
      failureReason: 'old',
      finishedAgo: '41 days',
    });
    await seedJob({
      projectId: p.id,
      runId: run,
      status: 'done',
      retryOf: failed,
      finishedAgo: '40 days',
    });

    expect(await viaFunction([p.id], "now() - interval '30 days'")).toEqual([]);
    expect(await viaView([p.id], 30)).toEqual([]);
    expect(await viaFunction([p.id], "now() - interval '90 days'")).toHaveLength(1);
    expect(await viaView([p.id], 90)).toHaveLength(1);
  });
});
