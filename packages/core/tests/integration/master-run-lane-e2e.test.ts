/**
 * ISS-1335 — a resident master's own run says what it is on every surface that lists runs.
 *
 * Against real Postgres and the real `ensureMasterSession` / `closeMasterSession`, because what
 * separates a healthy master from an orphan is a correlated read over `agent_sessions.kind` and
 * its terminal statuses, and the master's run staying `running` after its session ends is a
 * property of the writers, not of a fixture. `pipeline/runs-lane.test.ts` covers the sentences.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type McpPrincipal = import('../../src/middleware/require-pat.js').McpPrincipal;
type MasterModule = typeof import('../../src/devices/master-session.js');
type RollupModule = typeof import('../../src/pipeline/runs-rollup.js');
type McpModule = typeof import('../../src/mcp/tools/forge-pipeline-runs.js');
type SchemaModule = typeof import('../../src/db/schema.js');

interface ResidentMasterShape {
  sessionId: string;
  name: string | null;
  lastHeartbeatAt: string | null;
}

describe('ISS-1335 a resident master run reads as a master', () => {
  let harness: TestDatabase;
  let master: MasterModule;
  let rollup: RollupModule;
  let mcp: McpModule;
  let schema: SchemaModule;

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
    await registerIntegrationsForTest();
    master = await import('../../src/devices/master-session.js');
    rollup = await import('../../src/pipeline/runs-rollup.js');
    mcp = await import('../../src/mcp/tools/forge-pipeline-runs.js');
    schema = await import('../../src/db/schema.js');
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);
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
    return { owner, project, device, principal };
  }

  async function openMaster(projectId: string, deviceId: string) {
    const registered = await master.ensureMasterSession({
      deviceId,
      projectId,
      name: 'forge-master-judgeproj',
    });
    const [row] = await harness.db
      .select({ runId: schema.agentSessions.pipelineRunId })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, registered.sessionId));
    if (!row?.runId) throw new Error('ensureMasterSession wrote no run id on its session');
    return { sessionId: registered.sessionId, runId: row.runId };
  }

  async function restRow(runId: string) {
    const rows = await harness.db
      .select()
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, runId));
    const [item] = await rollup.listItemsFromRows(rows);
    if (!item) throw new Error(`the REST list returned no row for ${runId}`);
    return item as typeof item & { residentMaster?: ResidentMasterShape | null };
  }

  async function mcpRow(principal: McpPrincipal, projectId: string, runId: string) {
    const res = (await mcp.pipelineRunsListHandler(principal, { projectId })) as {
      runs: Array<Record<string, unknown>>;
    };
    const row = res.runs.find((r) => r.id === runId);
    if (!row) throw new Error(`the MCP list returned no row for ${runId}`);
    return row;
  }

  /** A live session of another kind on the master's run: it must never stand in for the master. */
  async function liveNonMasterSession(projectId: string, deviceId: string, runId: string) {
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, kind, status, pipeline_run_id,
                                  last_heartbeat_at)
      VALUES (${randomUUID()}, ${projectId}, ${deviceId}, 'pipeline', 'running', ${runId}, now())
    `);
  }

  it('lists a live master run on the master lane, naming its terminal and why it holds no step', async () => {
    const { project, device } = await seed();
    const { sessionId, runId } = await openMaster(project.id, device.id);

    const row = await restRow(runId);
    expect(row.kind).toBe('system');
    expect(row.status).toBe('running');
    expect(row.lane).toBe('master');
    expect(row.step.source).toBe('none');
    expect(row.step.detail).toContain('resident master `forge-master-judgeproj`');
    expect(row.step.detail).toContain('dispatches issues rather than taking steps');
    expect(row.group.detail).toContain('a resident master');
    expect(row.group.detail).not.toBe('this run was not opened over a group of issues');
    expect(row.residentMaster?.sessionId).toBe(sessionId);
    expect(row.residentMaster?.name).toBe('forge-master-judgeproj');
    expect(row.residentMaster?.lastHeartbeatAt).toBeTruthy();
  });

  it('gives the single-run summary the same master lane and resident master as the list', async () => {
    const { project, device } = await seed();
    const { runId } = await openMaster(project.id, device.id);

    const summary = (await rollup.loadPipelineRunSummary(runId)) as
      | (Awaited<ReturnType<RollupModule['loadPipelineRunSummary']>> & {
          residentMaster?: ResidentMasterShape | null;
        })
      | null;
    const listed = await restRow(runId);
    expect(summary?.lane).toBe('master');
    expect(summary?.step.detail).toBe(listed.step.detail);
    expect(summary?.residentMaster).toEqual(listed.residentMaster);
  });

  it('reads a master run whose session ended as held by nothing, even beside a live non-master session', async () => {
    const { project, device } = await seed();
    const { sessionId, runId } = await openMaster(project.id, device.id);
    await liveNonMasterSession(project.id, device.id, runId);
    await master.closeMasterSession({
      deviceId: device.id,
      sessionId,
      reason: 'resident session is gone',
    });

    const row = await restRow(runId);
    expect(row.status).toBe('running');
    expect(row.lane).toBe('master');
    expect(row.lastSessionBeatAt).not.toBeNull();
    expect(row.residentMaster).toBeNull();
    expect(row.step.detail).toContain('no master session on it is live');
    expect(row.step.detail).toContain('nothing holds it');
    expect(row.step.detail).not.toContain('forge-master-judgeproj');
  });

  it('leaves an issueless system run with no master metadata on the system lane, word for word', async () => {
    const { project } = await seed();
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, metadata)
      VALUES (${runId}, ${project.id}, NULL, 'system', 'running',
              ${JSON.stringify({ source: 'jobs.create', type: 'code' })}::jsonb)
    `);

    const row = await restRow(runId);
    expect(row.lane).toBe('system');
    expect(row.residentMaster).toBeNull();
    expect(row.group.detail).toBe('this run was not opened over a group of issues');
    expect(row.step.detail).toBe(
      'nothing has stamped a step on this run, and it is on neither the job nor the run-session lane, so neither of their step writers ever runs for it',
    );
  });

  it('carries the same lane and resident master on the MCP list as on the REST list', async () => {
    const { project, device, principal } = await seed();
    const live = await openMaster(project.id, device.id);
    const orphanId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${orphanId}, ${project.id}, NULL, 'system', 'running')
    `);

    for (const runId of [live.runId, orphanId]) {
      const viaMcp = await mcpRow(principal, project.id, runId);
      const viaRest = await restRow(runId);
      expect(viaMcp.lane).toBe(viaRest.lane);
      expect(viaMcp.residentMaster).toEqual(viaRest.residentMaster);
      expect(viaMcp).not.toHaveProperty('metadata');
    }
    expect((await mcpRow(principal, project.id, live.runId)).lane).toBe('master');
    expect((await mcpRow(principal, project.id, orphanId)).residentMaster).toBeNull();

    await master.closeMasterSession({
      deviceId: device.id,
      sessionId: live.sessionId,
      reason: 'resident session is gone',
    });
    expect((await mcpRow(principal, project.id, live.runId)).residentMaster).toBeNull();
  });
});
