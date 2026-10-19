/**
 * ISS-1228 round 17 (judge-47) — the runs tab read an untaken, a taken and a sent run Running where the
 * Ops drawer read Queued. Core answers one reading for a run, the same on the MCP list and get, the
 * REST list and the one-run read, and an attempt a box holds before starting names that box.
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

describe('one reading per run, on every surface (ISS-1228 round 17)', () => {
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

  async function seed(jobStatuses: string[]) {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const principal: McpPrincipal = {
      kind: 'pat',
      agency: 'human',
      agentUserId: null,
      userId: owner.id,
      tokenId: randomUUID(),
      scopes: ['read', 'write'],
      projectIds: null,
      boundProjectId: null,
      deviceId: null,
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

  async function readings(s: Awaited<ReturnType<typeof seed>>): Promise<unknown[]> {
    const listed = (await mods.pipelineRunsListHandler(s.principal, {
      projectId: s.projectId,
    })) as {
      runs: { id: string; reading?: unknown }[];
    };
    const got = (await mods.pipelineRunsGetHandler(s.principal, { runId: s.runId })) as {
      reading?: unknown;
    };
    const { pipelineRuns } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const rows = await harness.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, s.runId));
    // biome-ignore lint/suspicious/noExplicitAny: harness db row type matches RunRow
    const [item] = await mods.listItemsFromRows(rows as any);
    const summary = await mods.loadPipelineRunSummary(s.runId);
    return [
      listed.runs.find((r) => r.id === s.runId)?.reading,
      got.reading,
      (item as { reading?: unknown }).reading,
      summary?.reading,
    ];
  }

  it.each([
    [['queued'], 'queued'],
    [['dispatched'], 'starting'],
    [['queued', 'dispatched'], 'starting'],
    [['queued', 'running'], 'running'],
    [['done', 'failed'], null],
  ])('reads a run whose jobs are %j as %s on every surface', async (statuses, reading) => {
    const s = await seed(statuses);
    expect(await readings(s)).toEqual([reading, reading, reading, reading]);
  });

  it('reads a run whose queued job a box has taken as starting, its attempt naming that box', async () => {
    const s = await seed(['queued']);
    const device = await createTestDevice(harness.db, s.owner.id, { name: 'box-taker' });
    const master = randomUUID();
    const masterRun = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${masterRun}, ${s.projectId}, NULL, 'pm', 'running', now())
    `);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title, started_at)
      VALUES (${master}, ${s.projectId}::uuid, ${device.id}::uuid, ${masterRun}, 'master', 'running', 'a master', now())
    `);
    await harness.db.execute(sql`
      UPDATE jobs SET held_by = ${master}::uuid, held_at = now() WHERE pipeline_run_id = ${s.runId}
    `);
    expect(await readings(s)).toEqual(['starting', 'starting', 'starting', 'starting']);
    const summary = await mods.loadPipelineRunSummary(s.runId);
    expect(summary?.attempts[0]?.takenBy).toEqual({ deviceId: device.id, deviceName: 'box-taker' });
  });

  it("names the box the taken job's own session was opened on, where it has one", async () => {
    const s = await seed(['queued']);
    const holderBox = await createTestDevice(harness.db, s.owner.id, { name: 'box-master' });
    const jobBox = await createTestDevice(harness.db, s.owner.id, { name: 'box-job' });
    const master = randomUUID();
    const own = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title)
      VALUES (${master}, ${s.projectId}::uuid, ${holderBox.id}::uuid, ${s.runId}, 'master', 'running', 'a master'),
             (${own}, ${s.projectId}::uuid, ${jobBox.id}::uuid, ${s.runId}, 'pipeline', 'queued', 'the job')
    `);
    await harness.db.execute(sql`
      UPDATE jobs SET held_by = ${master}::uuid, held_at = now(), agent_session_id = ${own}::uuid
       WHERE pipeline_run_id = ${s.runId}
    `);
    const summary = await mods.loadPipelineRunSummary(s.runId);
    expect(summary?.attempts[0]?.takenBy).toEqual({ deviceId: jobBox.id, deviceName: 'box-job' });
  });

  it('names no taker on an attempt nobody holds', async () => {
    const s = await seed(['queued']);
    const summary = await mods.loadPipelineRunSummary(s.runId);
    expect(summary?.attempts[0]?.takenBy).toBeNull();
  });
});
