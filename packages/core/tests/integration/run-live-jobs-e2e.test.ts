/**
 * ISS-789 — `liveJobs` on all three run surfaces, against real Postgres.
 *
 * Shipped in 65bb8a0b and immediately wrong in production: the MCP list returned
 * `liveJobs: 0` for runs that `forge_project_pipeline_runs get` reported as
 * having a `dispatched` job. Typecheck cannot catch a subquery that compiles and
 * counts the wrong rows, and the consumer-side tests mocked the number, so only
 * a real query proves it. The surfaces compute the count differently (MCP
 * correlated subquery, batched loader for the list, and the single-run detail
 * rollup, which for the whole of ISS-789's first half returned a hard-coded 0
 * because its spread of `rowToListItem` was never overridden) — which is exactly
 * why all three are asserted here, cross-checked against `jobCounts`, the
 * pre-existing independent path.
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

type McpPrincipal = import('../../src/middleware/require-pat.js').McpPrincipal;

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  pipelineRunsListHandler: typeof import('../../src/mcp/tools/forge-pipeline-runs.js').pipelineRunsListHandler;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  pipelineRunsGetHandler: typeof import('../../src/mcp/tools/forge-pipeline-runs.js').pipelineRunsGetHandler;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  listItemsFromRows: typeof import('../../src/pipeline/runs-rollup.js').listItemsFromRows;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  loadPipelineRunSummary: typeof import('../../src/pipeline/runs-rollup.js').loadPipelineRunSummary;
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
      loadPipelineRunSummary: rollup.loadPipelineRunSummary,
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
    const principal: McpPrincipal = {
      kind: 'pat',
      agency: 'human',
      userId: owner.id,
      tokenId: randomUUID(),
      scopes: ['read', 'write'],
      projectIds: null,
      boundProjectId: null,
      machine: null,
    };
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
    return { runId, projectId: project.id, principal, owner };
  }

  // cm:guard pass the REAL principal type, never a cast — these calls used to hand `pipelineRunsListHandler` a `devices` row behind `as any`, so when ISS-931 changed the parameter to `McpPrincipal` typecheck stayed silent and every case in this file failed in CI with `NOT_FOUND` out of `assertPrincipalIsMember` reading an undefined `userId`.
  async function liveViaMcp(
    principal: McpPrincipal,
    projectId: string,
  ): Promise<number | undefined> {
    const res = (await mods.pipelineRunsListHandler(principal, { projectId })) as {
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

  async function liveViaDetail(runId: string): Promise<number | undefined> {
    const summary = await mods.loadPipelineRunSummary(runId);
    return summary?.liveJobs;
  }

  // cm:guard the production bug this file exists for — a run with one dispatched job reported liveJobs 0 while the independent jobCounts path reported {dispatched: 1}
  it('counts a dispatched job on all three surfaces, agreeing with jobCounts', async () => {
    const s = await seed(['dispatched']);
    const got = await mods.pipelineRunsGetHandler(s.principal, { runId: s.runId });
    expect((got as { jobCounts: Record<string, number> }).jobCounts.dispatched).toBe(1);

    await expect(liveViaMcp(s.principal, s.projectId)).resolves.toBe(1);
    await expect(liveViaRest(s.runId)).resolves.toBe(1);
    await expect(liveViaDetail(s.runId)).resolves.toBe(1);
  });

  it.each([['queued'], ['running']])('counts a %s job on all three surfaces', async (status) => {
    const s = await seed([status]);
    await expect(liveViaMcp(s.principal, s.projectId)).resolves.toBe(1);
    await expect(liveViaRest(s.runId)).resolves.toBe(1);
    await expect(liveViaDetail(s.runId)).resolves.toBe(1);
  });

  it.each([['done'], ['failed'], ['cancelled']])(
    'does not count a terminal %s job',
    async (status) => {
      const s = await seed([status]);
      await expect(liveViaMcp(s.principal, s.projectId)).resolves.toBe(0);
      await expect(liveViaRest(s.runId)).resolves.toBe(0);
      await expect(liveViaDetail(s.runId)).resolves.toBe(0);
    },
  );

  it('counts only the non-terminal ones in a mixed run', async () => {
    const s = await seed(['done', 'failed', 'dispatched', 'queued', 'done']);
    await expect(liveViaMcp(s.principal, s.projectId)).resolves.toBe(2);
    await expect(liveViaRest(s.runId)).resolves.toBe(2);
    await expect(liveViaDetail(s.runId)).resolves.toBe(2);
  });

  it('reports 0, not null, for a run with no jobs at all', async () => {
    const s = await seed([]);
    await expect(liveViaMcp(s.principal, s.projectId)).resolves.toBe(0);
    await expect(liveViaRest(s.runId)).resolves.toBe(0);
    await expect(liveViaDetail(s.runId)).resolves.toBe(0);
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
    await expect(liveViaDetail(s.runId)).resolves.toBe(1);
    await expect(liveViaDetail(otherRun)).resolves.toBe(3);
  });

  // cm:guard the two surfaces must be asserted on the SAME run in one test, not only in separate ones — the detail rollup returned a constant 0 while the list returned the truth, and every per-surface assertion passed the whole time. Only comparing them catches a divergence that each half reports consistently.
  it('detail and list agree on the same run, so no reader can be shown two answers', async () => {
    const s = await seed(['running', 'queued', 'done']);
    const [viaList, viaDetail] = await Promise.all([liveViaRest(s.runId), liveViaDetail(s.runId)]);
    expect(viaDetail).toBe(viaList);
    expect(viaDetail).toBe(2);
  });
});
