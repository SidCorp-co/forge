/**
 * ISS-1228 round 12 — a run a box opened over issues names each issue's title, as a job run names
 * its one issue's: judge-31 read "ISS-2 Completed" on the runs tab's closed runs with nothing to
 * say what the work was. Against real Postgres, through the list and the summary readers.
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

describe('a group run names its issues by title (ISS-1228)', () => {
  let harness: TestDatabase;
  let mods: RollupModule;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
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

  let ownerId: string;

  async function project(): Promise<string> {
    ownerId = (await createTestUser(harness.db)).id;
    return (await createTestProject(harness.db, ownerId)).id;
  }

  async function issue(projectId: string, seq: number, title: string): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO issues (project_id, iss_seq, title, status, created_by_id)
      VALUES (${projectId}::uuid, ${seq}, ${title}, 'in_progress', ${ownerId}::uuid)
    `);
  }

  async function groupRun(projectId: string, group: string[]): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, metadata, finished_at)
      VALUES (${runId}, ${projectId}::uuid, NULL, 'system', 'completed',
              ${JSON.stringify({ type: 'run_session', runIssues: [], runGroup: group })}::jsonb, now())
    `);
    return runId;
  }

  async function listed(runId: string) {
    const { pipelineRuns } = await import('../../src/db/schema.js');
    const { db } = await import('../../src/db/client.js');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(rows).toHaveLength(1);
    const [item] = await mods.listItemsFromRows(rows);
    return item;
  }

  it("gives each group key its issue's title in the run's own project", async () => {
    const p = await project();
    await issue(p, 2, 'Rename the export column');
    await issue(p, 3, 'Drop the stale index');
    const runId = await groupRun(p, ['ISS-2', 'ISS-3']);

    expect((await listed(runId))?.groupTitles).toEqual({
      'ISS-2': 'Rename the export column',
      'ISS-3': 'Drop the stale index',
    });
    expect((await mods.loadPipelineRunSummary(runId))?.groupTitles).toEqual({
      'ISS-2': 'Rename the export column',
      'ISS-3': 'Drop the stale index',
    });
  });

  it('names no title for a key no issue of the project has, nor one another project holds', async () => {
    const p = await project();
    const other = await project();
    await issue(other, 2, 'Not this project');
    const runId = await groupRun(p, ['ISS-2']);

    expect((await listed(runId))?.groupTitles).toEqual({});
  });

  it('names nothing for a run opened over no group', async () => {
    const p = await project();
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${p}::uuid, 'system', 'completed')
    `);
    expect((await listed(runId))?.groupTitles).toEqual({});
  });
});
