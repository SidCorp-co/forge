/**
 * ISS-789 — `liveJobs` on both run-list surfaces, against real Postgres.
 *
 * Shipped in 65bb8a0b and immediately wrong in production: the MCP list returned
 * `liveJobs: 0` for runs that `forge_project_pipeline_runs get` reported as
 * having a `dispatched` job. Typecheck cannot catch a subquery that compiles and
 * counts the wrong rows, and the consumer-side tests mocked the number, so only
 * a real query proves it. The two surfaces compute the count differently (batched
 * loader vs correlated subquery), which is exactly why both are asserted here —
 * and cross-checked against `jobCounts`, the pre-existing independent path.
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

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  pipelineRunsListHandler: typeof import('../../src/mcp/tools/forge-pipeline-runs.js').pipelineRunsListHandler;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  pipelineRunsGetHandler: typeof import('../../src/mcp/tools/forge-pipeline-runs.js').pipelineRunsGetHandler;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  listItemsFromRows: typeof import('../../src/pipeline/runs-rollup.js').listItemsFromRows;
};

describe('run liveJobs E2E (ISS-789)', () => {
  let harness: TestDatabase;
  let mods: Mods;

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

    const mcp = await import('../../src/mcp/tools/forge-pipeline-runs.js');
    const rollup = await import('../../src/pipeline/runs-rollup.js');
    mods = {
      pipelineRunsListHandler: mcp.pipelineRunsListHandler,
      pipelineRunsGetHandler: mcp.pipelineRunsGetHandler,
      listItemsFromRows: rollup.listItemsFromRows,
    } as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  // cm:why job type is `code`, not `pm` — a partial unique index (jobs_pm_per_project_unique_idx) allows only one live pm job per project, so a pm fixture cannot express a multi-job run
  async function seed(jobStatuses: string[]) {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${project.id}, NULL, 'pm', 'running', now())
    `);
    for (const status of jobStatuses) {
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, type, status, pipeline_run_id,
                          payload, queued_at, created_by)
        VALUES (${randomUUID()}, ${project.id}, NULL, 'code', ${status}, ${runId},
                '{}'::jsonb, now(), ${owner.id})
      `);
    }
    return { runId, projectId: project.id, device, owner };
  }

  async function liveViaMcp(device: unknown, projectId: string): Promise<number | undefined> {
    // biome-ignore lint/suspicious/noExplicitAny: handler takes the real Device row
    const res = (await mods.pipelineRunsListHandler(device as any, { projectId } as never)) as {
      runs: { liveJobs?: number }[];
    };
    return res.runs[0]?.liveJobs;
  }

  async function liveViaRest(runId: string): Promise<number | undefined> {
    const { pipelineRuns } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const rows = await harness.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    // biome-ignore lint/suspicious/noExplicitAny: harness db row type matches RunRow
    const items = await mods.listItemsFromRows(rows as any);
    return (items[0] as { liveJobs?: number } | undefined)?.liveJobs;
  }

  // cm:guard the production bug this file exists for — a run with one dispatched job reported liveJobs 0 while the independent jobCounts path reported {dispatched: 1}
  it('counts a dispatched job on BOTH surfaces, agreeing with jobCounts', async () => {
    const s = await seed(['dispatched']);
    const got = await mods.pipelineRunsGetHandler(
      { kind: 'device', device: s.device } as never,
      { runId: s.runId } as never,
    );
    expect((got as { jobCounts: Record<string, number> }).jobCounts.dispatched).toBe(1);

    await expect(liveViaMcp(s.device, s.projectId)).resolves.toBe(1);
    await expect(liveViaRest(s.runId)).resolves.toBe(1);
  });

  it.each([['queued'], ['running']])('counts a %s job on both surfaces', async (status) => {
    const s = await seed([status]);
    await expect(liveViaMcp(s.device, s.projectId)).resolves.toBe(1);
    await expect(liveViaRest(s.runId)).resolves.toBe(1);
  });

  it.each([['done'], ['failed'], ['cancelled']])(
    'does not count a terminal %s job',
    async (status) => {
      const s = await seed([status]);
      await expect(liveViaMcp(s.device, s.projectId)).resolves.toBe(0);
      await expect(liveViaRest(s.runId)).resolves.toBe(0);
    },
  );

  it('counts only the non-terminal ones in a mixed run', async () => {
    const s = await seed(['done', 'failed', 'dispatched', 'queued', 'done']);
    await expect(liveViaMcp(s.device, s.projectId)).resolves.toBe(2);
    await expect(liveViaRest(s.runId)).resolves.toBe(2);
  });

  it('reports 0, not null, for a run with no jobs at all', async () => {
    const s = await seed([]);
    await expect(liveViaMcp(s.device, s.projectId)).resolves.toBe(0);
    await expect(liveViaRest(s.runId)).resolves.toBe(0);
  });

  it('does not bleed another run job count into this one', async () => {
    const s = await seed(['dispatched']);
    const otherRun = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${otherRun}, ${s.projectId}, NULL, 'pm', 'running', now())
    `);
    for (let i = 0; i < 3; i++) {
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, type, status, pipeline_run_id,
                          payload, queued_at, created_by)
        VALUES (${randomUUID()}, ${s.projectId}, NULL, 'code', 'running', ${otherRun},
                '{}'::jsonb, now(), ${s.owner.id})
      `);
    }
    await expect(liveViaRest(s.runId)).resolves.toBe(1);
    await expect(liveViaRest(otherRun)).resolves.toBe(3);
  });
});
